import { createHmac } from 'crypto';

/**
 * Cost control for the three BILLABLE avatar endpoints, in the two layers that can act before the
 * vendor is called: a per-process burst shield (this file) and a durable weighted meter in
 * Postgres (AvatarBudgetService.ts). This file also owns the weights, the subject hashing and the
 * kill switch, because those are shared by both layers.
 *
 * NOTHING HERE IMPORTS `db` OR `drizzle-orm`. The request path must be able to decide "burst-limit
 * this call" without a database in the process at all; only the durable layer needs one, and it is
 * reached through a guarded dynamic import (see avatarBudgetRuntime.ts) precisely so that a
 * database that is absent, mocked or broken degrades the meter rather than the endpoint.
 */

export type AvatarOp = 'start' | 'visual' | 'image' | 'memory';

/** The layers a reservation is taken against. Order is the order they are checked. */
export type AvatarDimension = 'ip' | 'uid' | 'jti' | 'project' | 'owner' | 'global';

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/**
 * ── WEIGHTS ────────────────────────────────────────────────────────────────────────────────
 * One unit ≈ one minute of vendor avatar session ≈ the cheapest billable step on this surface.
 * A request is emphatically NOT one unit; the audit's finding was that the old counter treated
 * `image/analyze` (which can run two gpt-image-1 renders) exactly like a no-op. Each weight below
 * is the WORST CASE fan-out of the handler, read off the service it calls:
 *
 *   start  — anamService.getSessionToken mints a vendor session. Billing is per session MINUTE and
 *            `/avatar/end` is a no-op the server must not trust (a client that never calls it, or
 *            lies, costs the same as one that does). So a start reserves the worst-case session
 *            length UP FRONT and never gets it back early. AVATAR_SESSION_WORST_CASE_MIN and this
 *            weight are the same number for that reason.
 *   visual — visualService.analyzeVisual: one classify completion, then on a miss one
 *            simulation-generation completion with a large output, plus a storage write.
 *   image  — imageService.analyzeAndGenerateImage: one classify completion, then a low-quality
 *            gpt-image-1 render, a dall-e-3 render if that fails (a SECOND paid render), and then
 *            a high-quality 1536x1024 render. Worst case is one completion and two renders, which
 *            is why it is five times `visual` and not equal to it.
 *   memory — memoryService.extractAndSaveFacts: TWO OpenAI completions per accepted POST, both
 *            small (4,000 input chars, max_tokens 300). It was found unmetered — no capability, no
 *            kill switch, no burst shield, no reservation of any kind — by the adversarial review
 *            of this very subsystem, on the same controller D-03 was opened for. Cheaper per call
 *            than the others, which is exactly why it is worth weighting rather than exempting:
 *            "small" without a cap is still unbounded.
 */
export function unitsFor(op: AvatarOp): number {
  switch (op) {
    case 'start': return envInt('AVATAR_UNITS_START', worstCaseSessionMinutes());
    case 'visual': return envInt('AVATAR_UNITS_VISUAL', 6);
    case 'image': return envInt('AVATAR_UNITS_IMAGE', 30);
    case 'memory': return envInt('AVATAR_UNITS_MEMORY', 2);
  }
}

/** Worst-case billable length of a vendor session, in minutes — what a start reserves. */
export function worstCaseSessionMinutes(): number {
  return Math.max(1, envInt('AVATAR_SESSION_WORST_CASE_MIN', 60));
}

/**
 * ── CALIBRATION ────────────────────────────────────────────────────────────────────────────
 * The numbers below are derived, not guessed, but the input they are derived FROM is an estimate
 * and every one of them is env-overridable for that reason.
 *
 * The unit of reasoning is one viewer opening the avatar once and using it:
 *     1 start (60) + ~6 visuals (6 each) + ~2 images (30 each)  ≈  156 units.
 *
 * Everything else follows from that figure, and the shape of each layer matters more than its
 * value: `ip` has to tolerate a whole NAT'd classroom, `uid` only has to tolerate one human, and
 * `global` is the platform's own blast radius rather than anyone's fair share.
 *
 * Deliberately NOT tighter: a limit that turns away the second viewer behind a school's single
 * public address is a worse outage than the spend it prevents, and public playback not breaking is
 * the requirement these limits are subordinate to.
 */
export function burstLimits(): Record<AvatarDimension, number> {
  return {
    // ≈6 fresh viewer sessions per minute from one address — a shared network, not one person.
    ip: envInt('AVATAR_BURST_IP', 1_000),
    // ≈2.5 opens per minute for one signed-in account. No human exceeds this; a script does.
    uid: envInt('AVATAR_BURST_UID', 400),
    // One popup open: a start plus ~4 images, or ~40 visuals, inside a minute.
    jti: envInt('AVATAR_BURST_JTI', 300),
    // ≈38 simultaneous opens on one video per minute.
    project: envInt('AVATAR_BURST_PROJECT', 6_000),
    owner: envInt('AVATAR_BURST_OWNER', 20_000),
    global: envInt('AVATAR_BURST_GLOBAL', 200_000),
  };
}

/** Per-dimension units allowed in one durable (hourly) window, cluster-wide. */
export function hourlyLimits(): Record<AvatarDimension, number> {
  return {
    ip: envInt('AVATAR_HOURLY_IP', 6_000),        // ≈38 viewer sessions/hour from one address
    uid: envInt('AVATAR_HOURLY_UID', 2_000),      // ≈12 sessions/hour for one account
    jti: envInt('AVATAR_HOURLY_JTI', 1_200),      // one popup open, generously
    project: envInt('AVATAR_HOURLY_PROJECT', 60_000),
    owner: envInt('AVATAR_HOURLY_OWNER', 200_000),
    global: envInt('AVATAR_HOURLY_GLOBAL', 3_000_000),
  };
}

/** Concurrent live sessions, counted from leases that expire on their own (see the service). */
export function concurrencyLimits(): { project: number; global: number } {
  return {
    project: envInt('AVATAR_CONCURRENT_PROJECT', 25),
    global: envInt('AVATAR_CONCURRENT_GLOBAL', 200),
  };
}

export const BURST_WINDOW_MS = 60_000;
export const HOUR_MS = 3_600_000;

// ── Subject hashing ─────────────────────────────────────────────────────────────────────────
//
// An IP is personal data and a limiter has no use for the value itself, only for its identity, so
// nothing here — process memory, log line or database row — ever holds one. The salt carries the
// UTC day, so every stored identifier becomes unlinkable to its IP after 24h without anything
// having to delete it: that is what "short-retention HMAC" means here. Project ids and user ids
// are hashed by the same helper so one subject column cannot leak which kind of thing it holds.

function subjectSecret(): string {
  return process.env.AVATAR_SUBJECT_SALT
    || process.env.AVATAR_CAPABILITY_SECRET
    || process.env.AVATAR_MEMORY_SECRET
    || process.env.DATABASE_URL
    || 'insecure-dev-only-secret';
}

/**
 * UTC day bucket — rotates the salt so yesterday's hashes cannot be re-derived from an IP today.
 *
 * Known and accepted consequence: because the subject is part of the ledger's key, the rollover at
 * midnight UTC starts every caller a fresh bucket, so the hour containing it is effectively
 * forgiven. That is the price of not storing the input, it is bounded (one hour, once a day), and
 * it errs toward serving viewers rather than toward refusing them.
 */
export function dayBucket(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Stable-for-a-day, non-reversible id for a limiter subject. Never store the raw value. */
export function hashSubject(dimension: AvatarDimension, value: string, now = Date.now()): string {
  return createHmac('sha256', subjectSecret())
    .update(`${dayBucket(now)}|${dimension}|${value}`)
    .digest('base64url')
    .slice(0, 27);
}

// ── Kill switch ─────────────────────────────────────────────────────────────────────────────

/**
 * Env-level global stop for every billable avatar endpoint. Honoured before the capability check,
 * before the limiter and before any read, so a runaway costs nothing while it is engaged.
 * The database-level twin (avatar_budget_state.killed) lives in the meter and binds even in
 * shadow mode — shadow means "do not enforce the BUDGETS", never "ignore the emergency stop".
 */
export function killSwitchEngaged(): boolean {
  const raw = (process.env.AVATAR_KILL_SWITCH || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

// ── Burst shield (per process) ──────────────────────────────────────────────────────────────
//
// This is the OLD in-process per-IP counter, demoted rather than removed. It still resets on
// deploy and is still per-replica — which is exactly why it is no longer the only bound — but it
// is the only layer that can refuse a flood without a database round-trip, so it stays in front.
// Two things changed: it consumes WEIGHTED units rather than counting requests, and it is layered
// over every dimension rather than the IP alone.

interface Bucket { units: number; resetAt: number }
const buckets = new Map<string, Bucket>();

export interface BurstSubject { dimension: AvatarDimension; subject: string; limit: number }

export interface BurstVerdict {
  allowed: boolean;
  /** Which layer refused, for telemetry and for the response body. */
  deniedBy?: AvatarDimension;
  /** Seconds until the refusing window rolls over. Always ≥ 1 when denied. */
  retryAfterSec: number;
}

/**
 * Reserve `units` against every subject at once, all-or-nothing: a request refused by ANY layer
 * consumes from none of them, so a caller cannot burn down another dimension's budget by making
 * requests it already knows will be refused.
 */
export function burstReserve(subjects: BurstSubject[], units: number, now = Date.now()): BurstVerdict {
  const touched: Array<{ key: string; bucket: Bucket }> = [];
  for (const s of subjects) {
    const key = `${s.dimension}:${s.subject}`;
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { units: 0, resetAt: now + BURST_WINDOW_MS };
      buckets.set(key, bucket);
    }
    if (bucket.units + units > s.limit) {
      return { allowed: false, deniedBy: s.dimension, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    touched.push({ key, bucket });
  }
  for (const t of touched) t.bucket.units += units;
  return { allowed: true, retryAfterSec: 0 };
}

/** Test seam: the burst shield is process state, and a suite must be able to start from zero. */
export function resetBurstShield(): void {
  buckets.clear();
}

// Bound memory: drop expired buckets periodically. unref so it never holds the process open.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
}, BURST_WINDOW_MS).unref();
