import {
  burstLimits, burstReserve, concurrencyLimits, hourlyLimits, killSwitchEngaged,
  unitsFor, worstCaseSessionMinutes,
  type AvatarDimension, type AvatarOp, type BurstSubject,
} from './avatarBudget.js';
import { budgetMode, type BudgetMode, type ReserveDimension } from './AvatarBudgetService.js';

/**
 * The single entry point a request handler uses to buy the right to spend money on the avatar.
 *
 * It layers the two mechanisms in the only order that is safe: the process-local burst shield
 * first (no I/O, refuses a flood before it can queue on the database), then the durable weighted
 * meter. A refusal at either layer means the vendor is never called.
 *
 * ── WHY THE DATABASE IS REACHED BY DYNAMIC IMPORT ──────────────────────────────────────────
 * The meter must be able to fail without taking the endpoint's other defences with it. Importing
 * `db` and `drizzle-orm` at module top level would make this file — and therefore the avatar
 * controller — refuse to LOAD wherever those modules are absent or stubbed, turning "the meter is
 * unavailable" into "the route does not exist". So the handle is resolved lazily and probed
 * (`typeof db.transaction === 'function'`) BEFORE the service that needs the driver is imported at
 * all. What "unavailable" then means is a policy decision, and it is the one the ruling demands:
 * fail closed in enforce mode, degrade to the burst shield in shadow.
 */

export interface SpendVerdict {
  allowed: boolean;
  /** HTTP status to send when `allowed` is false. */
  status: 429 | 503;
  /** Seconds for the Retry-After header. Always ≥ 1 when denied. */
  retryAfterSec: number;
  /** Which layer refused: `burst:<dimension>`, a dimension name, `concurrency`, `kill_switch`, or `meter_unavailable`. */
  deniedBy?: string;
  /** True when the durable meter actually answered. False means only the burst shield ran. */
  metered: boolean;
  /** What the meter WOULD have refused while running in shadow mode. */
  shadowDeniedBy?: string;
}

export interface SpendRequest {
  op: AvatarOp;
  /** Hashed subjects, already passed through hashSubject(). Missing layers are simply not metered. */
  subjects: Partial<Record<AvatarDimension, string>>;
  /** Identity of the lease a start takes out. Omit for the non-session ops. */
  leaseJti?: string;
  now?: number;
}

const ALLOWED: SpendVerdict = { allowed: true, status: 429, retryAfterSec: 0, metered: false };

let lastSweepAt = 0;
const SWEEP_EVERY_MS = 10 * 60_000;

async function resolveDb(): Promise<import('./AvatarBudgetService.js').BudgetDb | null> {
  try {
    const mod = await import('../../db/index.js');
    const db = (mod as { db?: unknown }).db as { transaction?: unknown } | undefined;
    if (!db || typeof db.transaction !== 'function') return null;
    return db as unknown as import('./AvatarBudgetService.js').BudgetDb;
  } catch {
    return null;
  }
}

function dimensionsFor(subjects: SpendRequest['subjects']): ReserveDimension[] {
  const limits = hourlyLimits();
  const out: ReserveDimension[] = [];
  for (const dimension of ['ip', 'uid', 'jti', 'project', 'owner', 'global'] as AvatarDimension[]) {
    const subject = subjects[dimension];
    if (subject) out.push({ dimension, subject, limit: limits[dimension] });
  }
  return out;
}

function burstSubjectsFor(subjects: SpendRequest['subjects']): BurstSubject[] {
  const limits = burstLimits();
  const out: BurstSubject[] = [];
  for (const dimension of ['ip', 'uid', 'jti', 'project', 'owner', 'global'] as AvatarDimension[]) {
    const subject = subjects[dimension];
    if (subject) out.push({ dimension, subject, limit: limits[dimension] });
  }
  return out;
}

/**
 * Buy the right to make one billable avatar call. Never throws: every failure resolves to a
 * verdict, because a handler that has to try/catch its own rate limiter will eventually forget to.
 */
export async function reserveAvatarSpend(req: SpendRequest): Promise<SpendVerdict> {
  const now = req.now ?? Date.now();
  const units = unitsFor(req.op);

  // The env kill switch is checked before anything else so an engaged switch costs nothing at all.
  if (killSwitchEngaged()) {
    return { allowed: false, status: 503, retryAfterSec: 60, deniedBy: 'kill_switch', metered: false };
  }

  const burst = burstReserve(burstSubjectsFor(req.subjects), units, now);
  if (!burst.allowed) {
    return {
      allowed: false, status: 429, retryAfterSec: burst.retryAfterSec,
      deniedBy: `burst:${burst.deniedBy}`, metered: false,
    };
  }

  const mode: BudgetMode = budgetMode();
  if (mode === 'off') return { ...ALLOWED };

  const db = await resolveDb();
  if (!db) return unavailable(mode);

  let outcome;
  try {
    const service = await import('./AvatarBudgetService.js');
    outcome = await service.reserveAvatarSpend(db, {
      op: req.op,
      units,
      dimensions: dimensionsFor(req.subjects),
      lease: req.leaseJti && req.subjects.project
        ? {
            jti: req.leaseJti,
            projectSubject: req.subjects.project,
            ttlMs: worstCaseSessionMinutes() * 60_000,
            perProject: concurrencyLimits().project,
            global: concurrencyLimits().global,
          }
        : undefined,
      now,
    });
    scheduleSweep(db, now);
  } catch {
    return unavailable(mode);
  }

  if (outcome.allowed) return { allowed: true, status: 429, retryAfterSec: 0, metered: true };

  // The kill switch row binds regardless of mode — see AvatarBudgetService.budgetMode().
  if (outcome.killed) {
    return {
      allowed: false, status: 503, retryAfterSec: outcome.retryAfterSec,
      deniedBy: 'kill_switch', metered: true,
    };
  }
  if (mode === 'shadow') {
    return { allowed: true, status: 429, retryAfterSec: 0, metered: true, shadowDeniedBy: outcome.deniedBy };
  }
  return {
    allowed: false, status: 429, retryAfterSec: outcome.retryAfterSec,
    deniedBy: outcome.deniedBy, metered: true,
  };
}

/**
 * FAIL CLOSED. A billable call whose cost cannot be reserved must not be made: the whole point of
 * reserving before spending is that an unrecorded spend is unbounded. In shadow mode the meter is
 * explicitly not the authority yet, so an outage there degrades to the burst shield instead.
 */
function unavailable(mode: BudgetMode): SpendVerdict {
  if (mode === 'enforce') {
    return {
      allowed: false, status: 503, retryAfterSec: 5, deniedBy: 'meter_unavailable', metered: false,
    };
  }
  return { allowed: true, status: 429, retryAfterSec: 0, metered: false, shadowDeniedBy: 'meter_unavailable' };
}

/** Housekeeping runs after the response, at most once per process per SWEEP_EVERY_MS. */
function scheduleSweep(db: import('./AvatarBudgetService.js').BudgetDb, now: number): void {
  if (now - lastSweepAt < SWEEP_EVERY_MS) return;
  lastSweepAt = now;
  void (async () => {
    try {
      const service = await import('./AvatarBudgetService.js');
      await service.sweepAvatarMeter(db, now);
    } catch { /* housekeeping is best-effort by construction */ }
  })();
}

/** Test seam. The sweep throttle is process state and a suite must start from zero. */
export function resetAvatarSpendRuntime(): void {
  lastSweepAt = 0;
}
