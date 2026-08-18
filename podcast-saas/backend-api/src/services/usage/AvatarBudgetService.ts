import { HOUR_MS, type AvatarDimension, type AvatarOp } from './avatarBudget.js';

/**
 * The durable half of avatar cost control: a weighted meter in Postgres, so a limit means the same
 * thing on every replica and survives a deploy. The per-process burst shield in avatarBudget.ts is
 * still in front of this; this layer is what makes the numbers real.
 *
 * ── WHY POSTGRES AND WHY BEFORE THE VENDOR CALL ────────────────────────────────────────────
 * The audit's finding was not "the limit is too high", it was that the only limit was an
 * in-process per-IP counter: reset by every deploy, private to one replica, and blind to what the
 * request actually costs. Spend has to be RESERVED — committed before the money is spent, not
 * recorded after — because the recording path is exactly what a failure skips.
 *
 * ── THE ONE STATEMENT THAT MATTERS ────────────────────────────────────────────────────────
 * Each dimension is reserved by a single statement whose UPDATE is conditional:
 *
 *     INSERT … SELECT … WHERE <units> <= <limit>
 *     ON CONFLICT … DO UPDATE SET units = units + EXCLUDED.units
 *                          WHERE units + EXCLUDED.units <= <limit>
 *     RETURNING units
 *
 * No row returned means the reservation was refused. Postgres takes a row lock for the duration of
 * the DO UPDATE, so two concurrent reservations against one bucket serialise and cannot both see
 * the pre-increment total — a read-then-write in application code can and does.
 *
 * The `WHERE <units> <= <limit>` on the INSERT source is not decoration. Without it a request
 * whose own weight already exceeds the limit sails through against an EMPTY bucket, because the
 * DO UPDATE clause it would have failed never runs. That is the single most likely way to write
 * this wrong, and avatarBudgetMeter.integration.test.ts refuses it.
 *
 * ── EVERY NUMERIC PARAMETER IS CAST. THIS IS LOAD-BEARING. ────────────────────────────────
 * A bare placeholder compared against another bare placeholder — `WHERE $1 <= $2` — has no column
 * to infer a type from, so Postgres resolves both as `text` and compares them as STRINGS. `5 <=
 * 10` is then FALSE, because '5' sorts after '1'. Written without the `::int` casts this meter
 * refuses every reservation it is ever asked for: in enforce mode that is a total outage of the
 * avatar, and in shadow mode it is a log full of denials that would never have happened. It is
 * invisible to any test that only checks that an OVER-limit call is refused, which is why the
 * integration suite asserts the admitted case and the recorded total as well.
 *
 * ── WHAT IS EXACT AND WHAT IS NOT ─────────────────────────────────────────────────────────
 * The unit ledger is exact under concurrency, per the row lock above. The CONCURRENCY leases are
 * not: they are gated on a count() taken in the same READ COMMITTED snapshot, so N transactions
 * arriving together can each see room and land, overshooting by up to N-1. That is deliberate —
 * making it exact costs a global serialisation point on the hot path, and the leases are a coarse
 * safety bound on live vendor sessions, not the money limit. The money limit is the ledger.
 *
 * ── NO STATIC drizzle-orm / db IMPORT ─────────────────────────────────────────────────────
 * `sql` is imported inside the query path, not at module top level, so importing this file can
 * never make a request handler depend on the database driver resolving. avatarBudgetRuntime.ts
 * explains the rest of that guard.
 */

export type BudgetMode = 'off' | 'shadow' | 'enforce';

/**
 * Rollout control for the METER.
 *
 *   off     — never touch the database.
 *   shadow  — reserve and record exactly as in enforce, but never refuse the caller on a budget.
 *             The default: the meter must be able to prove its numbers against real traffic before
 *             its numbers can turn a viewer away. The DATABASE kill switch still binds here.
 *   enforce — refusals are real, and a meter that cannot be consulted refuses (fail closed).
 */
export function budgetMode(): BudgetMode {
  const raw = (process.env.AVATAR_BUDGET_MODE || '').trim().toLowerCase();
  return raw === 'enforce' || raw === 'off' ? raw : 'shadow';
}

export interface BudgetTx { execute(query: unknown): Promise<unknown> }
export interface BudgetDb { transaction<T>(fn: (tx: BudgetTx) => Promise<T>): Promise<T> }

export interface ReserveDimension { dimension: AvatarDimension; subject: string; limit: number }

export interface ReserveLease {
  /** Capability jti, or a synthesised per-start id. The lease is keyed by it, so one popup open
   *  that starts five times holds ONE lease rather than five. */
  jti: string;
  /** Hashed project subject — the same value used for the project ledger dimension. */
  projectSubject: string;
  /** Worst-case billable session length. `/avatar/end` never shortens it. */
  ttlMs: number;
  perProject: number;
  global: number;
}

export interface ReserveInput {
  op: AvatarOp;
  units: number;
  dimensions: ReserveDimension[];
  lease?: ReserveLease;
  now?: number;
}

export interface ReserveOutcome {
  allowed: boolean;
  /** A dimension name, or `concurrency`, or `kill_switch`. */
  deniedBy?: string;
  retryAfterSec: number;
  /** Set when the platform kill switch row is engaged — binds in shadow mode too. */
  killed?: boolean;
}

/** Sentinel used to roll the transaction back without surfacing as an error. */
class Refused extends Error {
  constructor(readonly deniedBy: string, readonly retryAfterSec: number, readonly killed = false) {
    super(`avatar budget refused: ${deniedBy}`);
  }
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

/** Start of the hour bucket, computed here so a test controls it rather than the database clock. */
export function windowStartMs(now: number): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS;
}

function retryAfterForWindow(now: number): number {
  return Math.max(1, Math.ceil((windowStartMs(now) + HOUR_MS - now) / 1000));
}

/**
 * Reserve weighted cost for one billable avatar call. Resolves to a refusal rather than throwing;
 * a genuine database failure DOES throw, so the caller can apply its own fail-closed policy.
 */
export async function reserveAvatarSpend(db: BudgetDb, input: ReserveInput): Promise<ReserveOutcome> {
  const { sql } = await import('drizzle-orm');
  const now = input.now ?? Date.now();
  const windowStart = new Date(windowStartMs(now));

  try {
    await db.transaction(async (tx) => {
      // The database-level kill switch, read first so an engaged switch costs one SELECT and
      // nothing else. It binds in shadow mode as well — see budgetMode().
      const state = rowsOf(await tx.execute(
        sql`SELECT killed FROM avatar_budget_state WHERE id = 1`,
      )) as Array<{ killed?: boolean }>;
      if (state[0]?.killed) throw new Refused('kill_switch', 60, true);

      for (const d of input.dimensions) {
        const kept = rowsOf(await tx.execute(sql`
          INSERT INTO avatar_cost_ledger (dimension, subject, window_start, units)
          SELECT ${d.dimension}, ${d.subject}, ${windowStart}::timestamptz, ${input.units}::int
           WHERE ${input.units}::int <= ${d.limit}::int
          ON CONFLICT (dimension, subject, window_start) DO UPDATE
             SET units = avatar_cost_ledger.units + EXCLUDED.units, updated_at = now()
           WHERE avatar_cost_ledger.units + EXCLUDED.units <= ${d.limit}::int
          RETURNING units
        `));
        if (kept.length === 0) throw new Refused(d.dimension, retryAfterForWindow(now));
      }

      const lease = input.lease;
      if (lease) {
        const expiresAt = new Date(now + lease.ttlMs);
        const nowTs = new Date(now);
        const taken = rowsOf(await tx.execute(sql`
          INSERT INTO avatar_session_leases (jti, project_subject, expires_at)
          SELECT ${lease.jti}, ${lease.projectSubject}, ${expiresAt}::timestamptz
           WHERE (SELECT count(*) FROM avatar_session_leases
                   WHERE expires_at > ${nowTs}::timestamptz AND project_subject = ${lease.projectSubject}
                     AND jti <> ${lease.jti}) < ${lease.perProject}::int
             AND (SELECT count(*) FROM avatar_session_leases
                   WHERE expires_at > ${nowTs}::timestamptz AND jti <> ${lease.jti}) < ${lease.global}::int
          ON CONFLICT (jti) DO UPDATE
             SET expires_at = GREATEST(avatar_session_leases.expires_at, EXCLUDED.expires_at)
          RETURNING jti
        `));
        if (taken.length === 0) {
          throw new Refused('concurrency', Math.max(1, Math.ceil(lease.ttlMs / 1000 / 10)));
        }
      }
    });
  } catch (err) {
    if (err instanceof Refused) {
      return { allowed: false, deniedBy: err.deniedBy, retryAfterSec: err.retryAfterSec, killed: err.killed };
    }
    throw err;
  }
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * Drop rows nothing can read any more. Not called from the request path — see the runtime wrapper,
 * which throttles it — because a sweep on a billable request is latency the viewer pays for.
 */
export async function sweepAvatarMeter(db: BudgetDb, now = Date.now()): Promise<void> {
  const { sql } = await import('drizzle-orm');
  const ledgerCutoff = new Date(now - 2 * 24 * HOUR_MS);
  const leaseCutoff = new Date(now - 24 * HOUR_MS);
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM avatar_cost_ledger WHERE window_start < ${ledgerCutoff}::timestamptz`);
    await tx.execute(sql`DELETE FROM avatar_session_leases WHERE expires_at < ${leaseCutoff}::timestamptz`);
  });
}

/** Read the current usage for one bucket. Test/ops helper; never on the request path. */
export async function readAvatarUsage(
  db: BudgetDb,
  dimension: AvatarDimension,
  subject: string,
  now = Date.now(),
): Promise<number> {
  const { sql } = await import('drizzle-orm');
  const windowStart = new Date(windowStartMs(now));
  const rows = await db.transaction(async (tx) => rowsOf(await tx.execute(
    sql`SELECT units FROM avatar_cost_ledger
         WHERE dimension = ${dimension} AND subject = ${subject}
           AND window_start = ${windowStart}::timestamptz`,
  )) as Array<{ units?: number }>);
  return Number(rows[0]?.units ?? 0);
}
