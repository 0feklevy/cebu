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

import { inArray, lt, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { sim_rum_events } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import type { FieldAggregate } from 'shared/sim/closedLoop';
import {
  normalizeSampleRate, validateBatch,
  type RumBatch, type RumRejection,
} from 'shared/sim/rumEvents';

/** Bounds on retention, mirroring the CHECK in migration 051 so both refuse the same values. */
/**
 * Upper bound on a single batch's reported drop count.
 *
 * An honest client cannot exceed its ring capacity, so anything near this is already a misbehaving
 * or hostile sender. Bounding it here — rather than at int4 — is what keeps the SUM in
 * `fieldAggregates` from being driveable toward an overflow by a caller.
 */
export const RUM_MAX_DROPPED_PER_BATCH = 100_000;

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
/**
 * How long a resolved sample rate is reused before the column is read again.
 *
 * The switch is an incident control, so this is the delay between an operator's UPDATE and the
 * fleet obeying it — short enough to still be "no deploy", long enough that the read cannot be
 * used as a lever. Ten seconds.
 */
export const RUM_RATE_CACHE_MS = 10_000;
let rateCache: { at: number; value: number } | null = null;

/** Test seam; also called when a setting is written so an operator sees the change immediately. */
export function invalidateRumSampleRateCache(): void { rateCache = null; }

export async function resolveRumSampleRate(): Promise<number> {
  const env = process.env.SIM_RUM_SAMPLE_RATE;
  if (env !== undefined && env.trim() !== '') {
    // An unparseable env var normalizes to 0 rather than being ignored in favour of the DB value:
    // someone who set it meant to control this, and the safe reading of a malformed intent is off.
    return normalizeSampleRate(env.trim());
  }
  // CACHED, because this is on the write path of an UNAUTHENTICATED endpoint.
  //
  // The kill switch gates ingestion server-side, which is right — but the gate itself was a
  // database round trip, so a caller could force one query per request against a pool of 10 and
  // starve every other query in the API, including the player's own config build. That is a denial
  // of service delivered through the mechanism meant to make the endpoint safe when it is OFF.
  const now = Date.now();
  if (rateCache && now - rateCache.at < RUM_RATE_CACHE_MS) return rateCache.value;
  try {
    const s = await db.query.admin_settings.findFirst({ columns: { rum_sample_rate: true } });
    const value = normalizeSampleRate(s?.rum_sample_rate ?? 0);
    rateCache = { at: now, value };
    return value;
  } catch {
    // Column not migrated yet, or a DB hiccup. Collect nothing; never surface this to the player.
    // Cached as 0 too: a database in trouble must not also be asked once per inbound request.
    rateCache = { at: now, value: 0 };
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
      //
      // A MISSING TABLE IS NOT AN ERROR. An image that boots before migration 051 is applied has
      // nothing to reap, and logging that hourly at error level trains operators to ignore this
      // line — so the one case where it matters gets missed. Every other failure still shouts.
      const code = (err as { code?: string } | null)?.code;
      if (code === '42P01') {
        logger.debug('sim RUM retention sweep: table not migrated yet, nothing to reap');
        return;
      }
      logger.error({ err }, 'sim RUM retention sweep failed');
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  // RUN ONCE AT START. With only the interval, the first sweep was an hour away — and on a platform
  // that redeploys or recycles instances more often than hourly, retention would never execute at
  // all, which is the one outcome the bounded retention window exists to prevent. Deferred a tick
  // so startup is not blocked on it.
  const kick = setTimeout(run, 0);
  if (typeof kick.unref === 'function') kick.unref();
  return () => { clearInterval(timer); clearTimeout(kick); };
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
  // WHICH ROW CARRIES THE BATCH'S DROP COUNT.
  //
  // Not simply `events[0]`. Both aggregates filter `kind = 'transition' AND total_ms IS NOT NULL`,
  // so filing the count on a failure event — which this player genuinely records — put it on a row
  // no aggregate ever reads, and the count vanished exactly as it did when it was never stored.
  // It goes on the first row that will be counted; if the batch has no countable row the aggregate
  // has no samples for it anyway, and index 0 keeps it visible to any other reader.
  const countableIdx = b.events.findIndex(
    (e) => e.kind === 'transition' && typeof e.durations?.totalMs === 'number',
  );
  const dropIdx = countableIdx >= 0 ? countableIdx : 0;
  const rows = b.events.map((e, i) => ({
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
    // BATCH-LEVEL, SO RECORDED ONCE.
    //
    // `dropped` counts events the client could not send; it describes the BATCH, not each event in
    // it. Writing it on every row made `sum(dropped)` report `dropped x eventCount`: one dropped
    // event in a batch of 100 read back as 100 drops, and `decideBudget` refuses anything past half
    // the sample as 'truncated' — so a single drop disabled field budgets for that package for the
    // entire retention window. The upper bound is far above any honest client (whose ring caps at
    // RUM_RING_CAP) and low enough that no volume of batches can overflow the aggregate.
    dropped: i === dropIdx ? (clampInt(b.dropped, 0, RUM_MAX_DROPPED_PER_BATCH) ?? 0) : 0,
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
/**
 * NO PRODUCTION CALLER TODAY. `fieldAggregates` is what the player path uses, because it answers
 * for a whole project in one grouped query rather than one round trip per package.
 *
 * Kept for operational inspection of a single package, and given the same `catch` as its sibling:
 * without it, wiring this up later would propagate `42P01` (table not migrated) or a numeric
 * overflow straight to the caller, which is exactly the failure mode the sibling exists to avoid.
 */
export async function packagePercentiles(packageRevision: string): Promise<{
  samples: number; p50TotalMs: number | null; p90TotalMs: number | null; p90PrepareMs: number | null;
  dropped: number;
}> {
  try {
  const rows = await db.execute<{
    samples: number; p50: number | null; p90: number | null; p90prep: number | null;
  }>(sql`
    SELECT count(*)::int AS samples,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms)   AS p50,
           percentile_disc(0.9) WITHIN GROUP (ORDER BY total_ms)   AS p90,
           percentile_disc(0.9) WITHIN GROUP (ORDER BY prepare_ms) AS p90prep,
           COALESCE(sum(dropped), 0)::bigint                       AS dropped
      FROM ${sim_rum_events}
     WHERE package_revision = ${packageRevision}
       AND kind = 'transition'
       AND total_ms IS NOT NULL
  `);
  const r = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
  const first = (Array.isArray(r) ? r[0] : undefined) as
    { samples?: number; p50?: number | null; p90?: number | null; p90prep?: number | null;
      dropped?: number } | undefined;
  return {
    samples: Number(first?.samples ?? 0),
    p50TotalMs: numOrNull(first?.p50),
    p90TotalMs: numOrNull(first?.p90),
    p90PrepareMs: numOrNull(first?.p90prep),
    dropped: Number(first?.dropped ?? 0),
  };
  } catch (err) {
    logger.warn({ err, packageRevision }, 'sim RUM package percentiles unavailable');
    return { ...EMPTY_PERCENTILES };
  }
}
const EMPTY_PERCENTILES = {
  samples: 0, p50TotalMs: null, p90TotalMs: null, p90PrepareMs: null, dropped: 0,
} as const;

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


// ─── Priority 8 runtime feature switches (migration 052) ─────────────────────────────────────────

export interface SimRuntimeFlags {
  schedulerMode: 'off' | 'predictive';
  adaptiveQuality: boolean;
  boundarySentinel: boolean;
}

/** Every switch OFF. The value returned whenever anything is unreadable. */
export const SIM_RUNTIME_FLAGS_OFF: SimRuntimeFlags = {
  schedulerMode: 'off', adaptiveQuality: false, boundarySentinel: false,
};

/**
 * Resolve the runtime switches: env override -> admin_settings -> all OFF.
 *
 * Same shape and same failure direction as `resolveRumSampleRate` and `resolveSimPoolMode`. A
 * missing column, an unparseable env var or a database hiccup all resolve to today's behaviour, so
 * no path can enable a viewer-visible feature by accident.
 */
export async function resolveSimRuntimeFlags(): Promise<SimRuntimeFlags> {
  const envMode = (process.env.SIM_SCHEDULER_MODE ?? '').trim().toLowerCase();
  const envAdaptive = (process.env.SIM_ADAPTIVE_QUALITY ?? '').trim().toLowerCase();
  const envSentinel = (process.env.SIM_BOUNDARY_SENTINEL ?? '').trim().toLowerCase();

  // Declared without an initializer: both branches below assign it, so an initial `{}` is dead and
  // reads as a third possible state that does not exist.
  let fromDb: Partial<SimRuntimeFlags>;
  try {
    const s = await db.query.admin_settings.findFirst({
      columns: { sim_scheduler_mode: true, sim_adaptive_quality: true, sim_boundary_sentinel: true },
    });
    fromDb = {
      schedulerMode: s?.sim_scheduler_mode === 'predictive' ? 'predictive' : 'off',
      adaptiveQuality: s?.sim_adaptive_quality === true,
      boundarySentinel: s?.sim_boundary_sentinel === true,
    };
  } catch {
    // Column not migrated yet, or a DB hiccup. Today's behaviour; never surfaced to the player.
    fromDb = {};
  }

  return {
    schedulerMode: envMode === 'predictive' ? 'predictive'
      : envMode === 'off' ? 'off'
      : (fromDb.schedulerMode ?? 'off'),
    adaptiveQuality: envAdaptive === '1' || envAdaptive === 'true' ? true
      : envAdaptive === '0' || envAdaptive === 'false' ? false
      : (fromDb.adaptiveQuality ?? false),
    boundarySentinel: envSentinel === '1' || envSentinel === 'true' ? true
      : envSentinel === '0' || envSentinel === 'false' ? false
      : (fromDb.boundarySentinel ?? false),
  };
}


/**
 * Field aggregates for a set of package revisions, in ONE query.
 *
 * Read on the player's hottest path, so it is a single grouped scan over the indexed
 * (package_revision, kind, created_at) predicate rather than a query per package. Returns an empty
 * map — not an error — when the table is absent or the query fails: the closed loop then falls back
 * to the lab number, which is the behaviour every deployment has today.
 */
export async function fieldAggregates(
  packageRevisions: readonly string[],
  windowDays = 14,
): Promise<Map<string, FieldAggregate>> {
  const out = new Map<string, FieldAggregate>();
  const wanted = [...new Set(packageRevisions.filter((r) => typeof r === 'string' && r.length > 0))];
  if (wanted.length === 0) return out;
  try {
    const cutoff = new Date(Date.now() - windowDays * 86_400_000);
    const res = await db.execute<{
      package_revision: string; samples: number; p50: number | null; p90: number | null; dropped: number;
    }>(sql`
      SELECT package_revision,
             count(*)::int                                        AS samples,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50,
             percentile_disc(0.9) WITHIN GROUP (ORDER BY total_ms) AS p90,
             COALESCE(sum(dropped), 0)::bigint                     AS dropped
        FROM ${sim_rum_events}
       WHERE kind = 'transition'
         AND total_ms IS NOT NULL
         AND created_at >= ${cutoff}
         AND ${inArray(sim_rum_events.package_revision, wanted)}
       GROUP BY package_revision
    `);
    const rows = ((res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])) as {
      package_revision: string; samples: number; p50: number | null; p90: number | null; dropped: number;
    }[];
    for (const r of Array.isArray(rows) ? rows : []) {
      out.set(String(r.package_revision), {
        samples: Number(r.samples ?? 0),
        p50TotalMs: numOrNull(r.p50),
        p90TotalMs: numOrNull(r.p90),
        dropped: Number(r.dropped ?? 0),
      });
    }
  } catch (err) {
    // Table not migrated, or a DB hiccup. An empty map means "no field data", and the loop then
    // uses the lab number — never an error the player has to handle.
    //
    // LOGGED, because silence here is indistinguishable from "no samples yet". A malformed query
    // shipped in this exact catch and disabled field refinement for every project that has a
    // simulation, and nothing anywhere reported it: the viewer was fine, the lab budget was still
    // served, and the only symptom was a feature quietly never doing anything.
    logger.warn({ err, revisions: wanted.length }, 'sim RUM field aggregates unavailable');
    return new Map();
  }
  return out;
}
