/**
 * Real-user measurement for the simulation pipeline (Priority 8.9).
 *
 * WHAT THIS IS FOR
 * Priority 8's remaining decisions — how much lead time preparation needs, whether same-package
 * switching is slow enough to justify new protocol machinery, whether moving the section clock to
 * `requestVideoFrameCallback` is worth its risk — are all currently unanswerable, because nothing
 * about performance has ever been measured in the field. This is the smallest honest thing that
 * makes them answerable.
 *
 * DEFAULT OFF, AND SAMPLED
 * The sample rate is a server-controlled number that arrives in the player config. It defaults to
 * ZERO: a viewer sends nothing unless someone deliberately turns it on. That is not only a privacy
 * posture — it is the kill switch. A measurement system that cannot be turned off without a deploy
 * is a liability the first time it misbehaves.
 *
 * SAMPLING IS PER SESSION, NOT PER EVENT
 * Deciding per event would produce a sample where some sessions contributed their fast transitions
 * and not their slow ones, and no percentile computed from that means anything. One coin flip per
 * session keeps every retained session complete.
 *
 * WHAT IS DELIBERATELY NOT COLLECTED
 * No URL, no project or section title, no user identifier, no IP-derived value, no free text. The
 * device fields are coarse buckets rather than raw values — `deviceMemory` is already a coarse
 * browser-side approximation, and rounding it further costs nothing analytically while making the
 * payload far less identifying. Everything here has to be defensible on its own, because a metric
 * nobody can justify collecting is one that eventually gets collected anyway and then leaks.
 */

/** Bumped when the payload SHAPE changes incompatibly. The server refuses an unknown version. */
export const SIM_RUM_VERSION = 1 as const;

export type RumEventKind =
  /** One completed or abandoned section transition, with its measured stages. */
  | 'transition'
  /** A document was admitted to or evicted from the pool. */
  | 'residency'
  /** A bounded failure the viewer was shown (breaker, timeout, context loss). */
  | 'failure';

export interface RumDeviceProfile {
  /** navigator.deviceMemory, already coarse; bucketed further to 1|2|4|8|null. */
  memoryGb: number | null;
  /** navigator.hardwareConcurrency, bucketed to 2|4|8|16|null. */
  cores: number | null;
  /** Coarse pointer — the mobile/touch signal the pool tier already uses. */
  coarsePointer: boolean | null;
  /** navigator.connection.saveData. */
  saveData: boolean | null;
  /** devicePixelRatio, rounded to one decimal. */
  dpr: number | null;
  /**
   * The pool tier this session ran at. Not a device fact, but the thing every duration must be
   * read against — comparing a `single`-tier transition with an `all`-tier one is meaningless.
   */
  poolTier: 'single' | 'window' | 'all' | null;
}

export interface RumEvent {
  kind: RumEventKind;
  /** Milliseconds since the session started. Never a wall-clock time. */
  t: number;
  /** The package these numbers describe. Required — a duration with no package is unusable. */
  packageRevision: string;
  /** Present on `transition`. */
  durations?: {
    totalMs: number | null;
    prepareMs: number | null;
    presentMs: number | null;
    applyMs: number | null;
  };
  /** Present on `transition` — where an abandoned one stopped. */
  furthestStage?: string | null;
  /** Present on `failure`. A short enum-like code, never a message. */
  code?: string;
}

export interface RumBatch {
  v: typeof SIM_RUM_VERSION;
  /** Random per page load. Not persisted, so it cannot link two visits. */
  sessionId: string;
  device: RumDeviceProfile;
  events: RumEvent[];
  /** Events the ring dropped. A truncated sample must never look like a complete one. */
  dropped: number;
}

// ─── Sampling ────────────────────────────────────────────────────────────────────────────────────

/**
 * Decide once, for the whole session.
 *
 * `roll` is injected so this is testable without stubbing Math.random, and so a caller can key the
 * decision off something stable if it ever needs to.
 */
export function shouldSample(rate: number, roll: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  return roll < rate;
}

/**
 * Clamp a sample rate arriving from config.
 *
 * Anything unparseable becomes 0 rather than a default-on value. The failure mode of a bad config
 * must be "collect nothing", never "collect everything from everyone".
 */
export function normalizeSampleRate(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, n);
}

// ─── Device profile ──────────────────────────────────────────────────────────────────────────────

const bucket = (n: unknown, steps: readonly number[]): number | null => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  // Round DOWN so a value never lands in a bucket above its true capability — an over-reported
  // device makes a slow measurement look like it came from a fast machine.
  //
  // A value BELOW the smallest bucket returns 0 rather than that bucket. navigator.deviceMemory
  // legitimately reports 0.25 and 0.5, and hardwareConcurrency can be 1; snapping those up to the
  // first bucket systematically over-reported the weakest devices, which are exactly the ones whose
  // measurements matter most.
  if (n < steps[0]!) return 0;
  let out = steps[0]!;
  for (const s of steps) if (n >= s) out = s;
  return out;
};

export const MEMORY_BUCKETS = [1, 2, 4, 8] as const;
export const CORE_BUCKETS = [2, 4, 8, 16] as const;

export function bucketDevice(raw: {
  deviceMemory?: unknown;
  hardwareConcurrency?: unknown;
  coarsePointer?: boolean | null;
  saveData?: boolean | null;
  dpr?: unknown;
  poolTier?: RumDeviceProfile['poolTier'];
}): RumDeviceProfile {
  return {
    memoryGb: bucket(raw.deviceMemory, MEMORY_BUCKETS),
    cores: bucket(raw.hardwareConcurrency, CORE_BUCKETS),
    coarsePointer: typeof raw.coarsePointer === 'boolean' ? raw.coarsePointer : null,
    saveData: typeof raw.saveData === 'boolean' ? raw.saveData : null,
    dpr: typeof raw.dpr === 'number' && Number.isFinite(raw.dpr) && raw.dpr > 0
      ? Math.round(raw.dpr * 10) / 10
      : null,
    poolTier: raw.poolTier ?? null,
  };
}

// ─── The ring ────────────────────────────────────────────────────────────────────────────────────

export const RUM_RING_CAP = 200;

/**
 * A bounded event buffer that COUNTS what it discards.
 *
 * The existing dev-only telemetry buffer stops recording at 5 000 events and says nothing about it,
 * so a truncated trace is indistinguishable from a short one. Here the oldest event is dropped and
 * the drop is counted, so a batch can always state how much it is missing.
 *
 * Oldest-first rather than newest-first: the interesting events in a stuck session are the recent
 * ones, and a buffer that discarded those would preserve exactly the part nobody needs.
 */
export class RumRing {
  private events: RumEvent[] = [];
  private droppedCount = 0;

  constructor(private readonly cap: number = RUM_RING_CAP) {}

  push(e: RumEvent): void {
    if (this.events.length >= this.cap) {
      this.events.shift();
      this.droppedCount += 1;
    }
    this.events.push(e);
  }

  get size(): number { return this.events.length; }
  get dropped(): number { return this.droppedCount; }

  /** Take everything and reset. The drop count travels WITH the batch it describes. */
  /**
   * Record events lost AFTER draining — a batch the transport refused to send.
   *
   * Without this a failed send was indistinguishable from a successful one: the ring had already
   * been drained, so the next batch reported `dropped: 0` and the sample looked complete. That is
   * exactly the invariant the `dropped` column exists to protect, violated on the client side of
   * the same wire.
   */
  noteDropped(n: number): void {
    if (Number.isFinite(n) && n > 0) this.droppedCount += Math.floor(n);
  }

  drain(): { events: RumEvent[]; dropped: number } {
    const out = { events: this.events, dropped: this.droppedCount };
    this.events = [];
    this.droppedCount = 0;
    return out;
  }
}

// ─── Server-side validation ──────────────────────────────────────────────────────────────────────

export type RumRejection =
  | 'unknown-version' | 'no-events' | 'too-many-events' | 'bad-session' | 'bad-event';

export const RUM_MAX_EVENTS_PER_BATCH = 500;

/**
 * Validate a batch arriving from an untrusted client.
 *
 * This endpoint is unauthenticated by necessity — anonymous viewers are the majority of traffic —
 * so everything here is a bound on what a hostile caller can put in the table. Returns the FIRST
 * rejection rather than all of them: unlike the publication gate, nobody is iterating on a fix.
 */
export function validateBatch(raw: unknown): { ok: true; batch: RumBatch } | { ok: false; reason: RumRejection } {
  const b = raw as Partial<RumBatch> | null;
  if (!b || typeof b !== 'object') return { ok: false, reason: 'bad-event' };
  if (b.v !== SIM_RUM_VERSION) return { ok: false, reason: 'unknown-version' };
  if (typeof b.sessionId !== 'string' || b.sessionId.length < 8 || b.sessionId.length > 128) {
    return { ok: false, reason: 'bad-session' };
  }
  if (!Array.isArray(b.events) || b.events.length === 0) return { ok: false, reason: 'no-events' };
  if (b.events.length > RUM_MAX_EVENTS_PER_BATCH) return { ok: false, reason: 'too-many-events' };

  // The device profile is validated too. `poolTier` reaches a column with a CHECK constraint, and
  // one unrecognised value made the single multi-row INSERT throw — losing the WHOLE batch,
  // silently, because the endpoint always answers 204. A field this layer does not recognise is
  // dropped rather than allowed to destroy every measurement beside it.
  if (b.device !== undefined && b.device !== null) {
    if (typeof b.device !== 'object') return { ok: false, reason: 'bad-event' };
    const tier = (b.device as { poolTier?: unknown }).poolTier;
    if (tier !== undefined && tier !== null
        && tier !== 'single' && tier !== 'window' && tier !== 'all') {
      (b.device as { poolTier?: unknown }).poolTier = null;
    }
  }

  for (const e of b.events) {
    if (!e || typeof e !== 'object') return { ok: false, reason: 'bad-event' };
    if (e.kind !== 'transition' && e.kind !== 'residency' && e.kind !== 'failure') {
      return { ok: false, reason: 'bad-event' };
    }
    if (typeof e.t !== 'number' || !Number.isFinite(e.t) || e.t < 0) {
      return { ok: false, reason: 'bad-event' };
    }
    // A duration with no package is unusable, so it is refused rather than stored as an orphan.
    if (typeof e.packageRevision !== 'string' || e.packageRevision.length === 0
        || e.packageRevision.length > 64) {
      return { ok: false, reason: 'bad-event' };
    }
    if (e.code !== undefined && (typeof e.code !== 'string' || e.code.length > 64)) {
      return { ok: false, reason: 'bad-event' };
    }
  }
  return { ok: true, batch: b as RumBatch };
}
