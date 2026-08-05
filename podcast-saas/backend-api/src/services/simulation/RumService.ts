/**
 * RUM ingestion, sample-rate resolution and retention (Priority 8.9).
 *
 * FAILURE ISOLATION IS THE POINT
 * This is a measurement system attached to the product's hottest read path. It must be impossible
 * for it to degrade playback: every read here is wrapped so that a missing column, a slow query or
 * a full disk resolves to "collect nothing" rather than to an error the player surfaces. The rule
 * throughout is that RUM failing is invisible to viewers and visible to operators, never the
 * reverse.
 *
 * DEFAULT OFF, EVERY WAY IN
 * `resolveRumSampleRate` returns 0 unless something explicitly says otherwise, and each of its three
 * layers fails closed: an unparseable env var is ignored, a missing column is 0, a DB error is 0.
 * There is no code path that turns collection on by accident.
 */

import { lt, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { sim_rum_events } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import {
  normalizeSampleRate, validateBatch,
  type RumBatch, type RumRejection,
} from 'shared/src/sim/rumEvents';

/** Bounds on retention, mirroring the CHECK in migration 051 so both refuse the same values. */
export const RUM_RETENTION_MIN_DAYS = 1;
export const RUM_RETENTION_MAX_DAYS = 365;
export const RUM_RETENTION_DEFAULT_DAYS = 30;

/**
 * The effective sample rate: env override → admin_settings → 0.
 *
 * Exactly the shape of `resolveSimPoolMode`, including the try/catch, which exists because a newly
 * migrated column must never be able to break the player on an image that boots before the
 * migration lands. The difference is the default: pool mode defaults to its useful value, this
 * defaults to OFF.
 */
export async function resolveRumSampleRate(): Promise<number> {
  const env = process.env.SIM_RUM_SAMPLE_RATE;
  if (env !== undefined && env.trim() !== '') {
    // An unparseable env var normalizes to 0 rather than being ignored in favour of the DB value:
    // someone who set it meant to control this, and the safe reading of a malformed intent is off.
    return normalizeSampleRate(env.trim());
  }
  try {
    const s = await db.query.admin_settings.findFirst({ columns: { rum_sample_rate: true } });
    return normalizeSampleRate(s?.rum_sample_rate ?? 0);
  } catch {
    // Column not migrated yet, or a DB hiccup. Collect nothing; never surface this to the player.
    return 0;
  }
}

export async function resolveRumRetentionDays(): Promise<number> {
  try {
    const s = await db.query.admin_settings.findFirst({ columns: { rum_retention_days: true } });
    const n = Number(s?.rum_retention_days ?? RUM_RETENTION_DEFAULT_DAYS);
    if (!Number.isFinite(n)) return RUM_RETENTION_DEFAULT_DAYS;
    return Math.min(RUM_RETENTION_MAX_DAYS, Math.max(RUM_RETENTION_MIN_DAYS, Math.round(n)));
  } catch {
    return RUM_RETENTION_DEFAULT_DAYS;
  }
}

export interface IngestResult {
  stored: number;
  rejected?: RumRejection | 'collection-disabled';
}

/**
 * How often the retention sweep runs while the process is alive.
 *
 * Retention is stated in the migration as part of the schema rather than an intention, so the
 * sweeper has to actually exist. An hour is far more often than a day-granularity window needs,
 * and cheap: the predicate is a single indexed range delete.
 */
export const RUM_REAP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Start the retention sweep. Returns a stop function.
 *
 * `unref` so a pending timer never holds the process open — a measurement sweep must not be the
 * reason a deploy fails to drain.
 */
export function startRumRetentionSweep(intervalMs = RUM_REAP_INTERVAL_MS): () => void {
  const run = (): void => {
    void reapRumEvents().catch((err: unknown) => {
      // Swallowed: nothing downstream waits on this, and a failing sweep must not take a process
      // down over data nobody is reading yet.
      logger.error({ err }, 'sim RUM retention sweep failed');
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * Store one validated batch.
 *
 * The rows are inserted in ONE statement. A per-row insert would turn a 500-event batch into 500
 * round trips against a table nobody is waiting on, which is how a measurement system becomes the
 * reason the database is busy.
 */
export async function ingestBatch(raw: unknown): Promise<IngestResult> {
  // THE KILL SWITCH GATES THE WRITE PATH, not only the client.
  //
  // The route is registered unconditionally so the switch needs no deploy, and the client sends
  // nothing at rate 0 — but the endpoint is unauthenticated, so "no honest client sends" is not the
  // same as "nothing is stored". Without this, any caller could persist rows on every deployment
  // (all of which sit at rate 0) and poison the per-package percentiles the rest of Priority 8 is
  // designed to consume.
  if ((await resolveRumSampleRate()) <= 0) return { stored: 0, rejected: 'collection-disabled' };

  const parsed = validateBatch(raw);
  if (!parsed.ok) return { stored: 0, rejected: parsed.reason };

  const b: RumBatch = parsed.batch;
  const rows = b.events.map((e) => ({
    session_id: b.sessionId,
    package_revision: e.packageRevision,
    kind: e.kind,
    // Clamped rather than rejected: a single absurd offset in an otherwise good batch should cost
    // that field, not the whole batch. The DDL CHECK is the backstop if this ever regresses.
    t_ms: clampInt(e.t, 0, 2 ** 31 - 1) ?? 0,
    total_ms: clampInt(e.durations?.totalMs, 0, 2 ** 31 - 1),
    prepare_ms: clampInt(e.durations?.prepareMs, 0, 2 ** 31 - 1),
    present_ms: clampInt(e.durations?.presentMs, 0, 2 ** 31 - 1),
    apply_ms: clampInt(e.durations?.applyMs, 0, 2 ** 31 - 1),
    furthest_stage: trunc(e.furthestStage, 32),
    failure_code: trunc(e.code, 64),
    device_memory_gb: clampInt(b.device?.memoryGb, 0, 1024),
    device_cores: clampInt(b.device?.cores, 0, 1024),
    coarse_pointer: typeof b.device?.coarsePointer === 'boolean' ? b.device.coarsePointer : null,
    save_data: typeof b.device?.saveData === 'boolean' ? b.device.saveData : null,
    dpr: typeof b.device?.dpr === 'number' && Number.isFinite(b.device.dpr) ? b.device.dpr : null,
    pool_tier: b.device?.poolTier ?? null,
  }));

  await db.insert(sim_rum_events).values(rows);
  return { stored: rows.length };
}

/** Delete measurements past the retention window. Returns how many rows went. */
export async function reapRumEvents(now: Date = new Date()): Promise<number> {
  const days = await resolveRumRetentionDays();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const deleted = await db
    .delete(sim_rum_events)
    .where(lt(sim_rum_events.created_at, cutoff))
    .returning({ id: sim_rum_events.id });
  if (deleted.length > 0) {
    logger.info({ deleted: deleted.length, days }, 'sim RUM retention sweep');
  }
  return deleted.length;
}

/**
 * Percentiles for one package, computed in the database.
 *
 * `percentile_disc` and not `percentile_cont`: the discrete form returns a value that actually
 * occurred, matching the nearest-rank choice the client-side summary makes. Two percentile
 * definitions over one dataset is the same class of mistake as two derivations of one identity.
 */
export async function packagePercentiles(packageRevision: string): Promise<{
  samples: number; p50TotalMs: number | null; p90TotalMs: number | null; p90PrepareMs: number | null;
}> {
  const rows = await db.execute<{
    samples: number; p50: number | null; p90: number | null; p90prep: number | null;
  }>(sql`
    SELECT count(*)::int AS samples,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms)   AS p50,
           percentile_disc(0.9) WITHIN GROUP (ORDER BY total_ms)   AS p90,
           percentile_disc(0.9) WITHIN GROUP (ORDER BY prepare_ms) AS p90prep
      FROM ${sim_rum_events}
     WHERE package_revision = ${packageRevision}
       AND kind = 'transition'
       AND total_ms IS NOT NULL
  `);
  const r = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
  const first = (Array.isArray(r) ? r[0] : undefined) as
    { samples?: number; p50?: number | null; p90?: number | null; p90prep?: number | null } | undefined;
  return {
    samples: Number(first?.samples ?? 0),
    p50TotalMs: numOrNull(first?.p50),
    p90TotalMs: numOrNull(first?.p90),
    p90PrepareMs: numOrNull(first?.p90prep),
  };
}

/** A genuine 0 must survive: `Number(v) || null` turned it into null when the driver returned text. */
const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

function clampInt(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function trunc(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}
