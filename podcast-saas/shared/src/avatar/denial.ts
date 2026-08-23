/**
 * What a viewer is told when an avatar call is refused — the last piece of D-14.
 *
 * ── WHY THIS EXISTS BEFORE ENFORCE IS EVER SWITCHED ON ────────────────────────────────────────
 * The avatar budget has an atomic reserve and an async observer, and it runs in `shadow`, so
 * nothing is refused today. The moment `AVATAR_BUDGET_MODE=enforce` is set, a viewer starts getting
 * a bare 429 or 503 and the UI has no way to say why or when to try again. A limiter whose refusals
 * are unreadable does not read as a limit — it reads as the product being broken.
 *
 * ── WHY THE PUBLIC REASON IS COARSER THAN THE INTERNAL ONE ────────────────────────────────────
 * `deniedBy` names the limiter DIMENSION that fired: `ip`, `uid`, `project`, `global`, and so on.
 * That is exactly what an operator needs in a log and exactly what a viewer must not be handed:
 * telling somebody "you were refused because of your IP's hourly bucket" describes the shape of the
 * defence to whoever is probing it, and means nothing to the person who just wanted the avatar to
 * talk.
 *
 * So the wire carries three coarse reasons — busy, limited, unavailable — and the dimension stays
 * in the log line where it belongs.
 */

/** What the viewer is allowed to know. Deliberately coarse — see the header. */
export type AvatarDenialReason =
  /** The platform as a whole is at capacity. Nothing the viewer did; trying later genuinely helps. */
  | 'busy'
  /** This viewer or project has used its share for now. Also fixed by waiting. */
  | 'limited'
  /** The meter itself is unreachable, so the call is refused rather than risked. */
  | 'unavailable';

export interface AvatarDenial {
  /** Kept for every existing client that only reads this field. */
  message: string;
  reason: AvatarDenialReason;
  /** Seconds. Always ≥ 1 — a "retry in 0 seconds" invites an immediate retry and a second refusal. */
  retryAfterSec: number;
}

/**
 * Map an internal `deniedBy` to what the viewer sees.
 *
 * The default is `limited` rather than `unavailable`: an unrecognised dimension is far more likely
 * to be a new per-subject limit than a broken meter, and telling somebody the service is down when
 * they have simply used their share sends them to support instead of to a cup of tea.
 */
export function publicDenialReason(deniedBy: string | null | undefined): AvatarDenialReason {
  // The burst limiter reports `burst:<dimension>`. The prefix says WHICH limiter fired, which is
  // operator detail; the dimension after it is what decides whether this was the viewer's share or
  // the platform's. Strip the prefix and judge the dimension, so `burst:global` reads as busy
  // rather than falling through to the per-subject default.
  const dimension = (deniedBy ?? '').replace(/^burst:/, '');

  // The emergency stop, a dead meter and a broken vendor are the same thing to a viewer: the
  // feature is off, and there is no share of anything they could wait to get back.
  if (dimension === 'meter_unavailable' || dimension === 'kill_switch' || dimension === 'vendor_unavailable') return 'unavailable';
  if (dimension === 'global' || dimension === 'global_concurrency') return 'busy';
  return 'limited';
}

/** Seconds a client should wait, normalised. Never 0, never absurd, never NaN. */
export function normaliseRetryAfter(seconds: number | null | undefined): number {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return 1;
  // An hour is already far longer than any of this product's buckets. A larger number on screen
  // reads as "never" and the viewer leaves rather than waiting. Infinity lands here rather than in
  // the branch above on purpose: it means "a very long time", which is a cap, not a missing value.
  if (seconds > 3600) return 3600;
  if (seconds < 1) return 1;
  return Math.round(seconds);
}

/**
 * The sentence a viewer actually reads.
 *
 * NO NUMBERS BELOW A MINUTE. "Try again in 7 seconds" invites the viewer to count, and being wrong
 * by a second makes the product look broken; "in a moment" is honest at that resolution and cannot
 * be falsified by a clock.
 */
export function avatarDenialCopy(denial: Pick<AvatarDenial, 'reason' | 'retryAfterSec'>): string {
  const secs = normaliseRetryAfter(denial.retryAfterSec);
  const when =
    secs <= 60 ? 'in a moment' :
    secs <= 300 ? 'in a few minutes' :
    'in a little while';

  switch (denial.reason) {
    case 'busy':
      // Says it is not about them. Somebody refused for a reason they cannot influence will try
      // the same thing again immediately unless told otherwise.
      return `The avatar is busy across the platform right now. Try again ${when}.`;
    case 'limited':
      return `You have reached the avatar limit for now. Try again ${when}.`;
    case 'unavailable':
      // Deliberately does NOT promise a time: the meter being unreachable is not a countdown, and
      // a fabricated estimate is the thing that erodes trust in every other message here.
      return 'The avatar is temporarily unavailable. Please try again shortly.';
  }
}

/** Build the body a refused avatar call returns. One place, so the wire shape cannot drift. */
export function avatarDenialBody(input: {
  deniedBy?: string | null;
  retryAfterSec?: number | null;
  message?: string;
}): AvatarDenial {
  const reason = publicDenialReason(input.deniedBy);
  const retryAfterSec = normaliseRetryAfter(input.retryAfterSec);
  return {
    message: input.message ?? avatarDenialCopy({ reason, retryAfterSec }),
    reason,
    retryAfterSec,
  };
}

/**
 * Read a denial back off the wire — the CLIENT half, and the reason it lives in this file rather
 * than in `client-web`: a producer and a parser in two packages drift, and the drift is silent.
 *
 * Returns null for anything that is not recognisably one of ours, and that is the security-relevant
 * part. `client-web` shows a fixed generic string on failure on purpose (ui-ux-205) — server
 * internals and env-var names must never reach a viewer's screen. Rendering `body.message` because
 * it happened to be present would undo that rule for every error a proxy, a WAF or a stack trace
 * can produce.
 *
 * So what makes a body renderable is not that it HAS a message: it is that `reason` is one of the
 * three values this module defines. The copy is then regenerated here from that enum, so what the
 * viewer sees is a string this file produced, never a string the network handed us.
 */
export function parseAvatarDenial(body: unknown): AvatarDenial | null {
  if (typeof body !== 'object' || body === null) return null;
  const reason = (body as { reason?: unknown }).reason;
  if (reason !== 'busy' && reason !== 'limited' && reason !== 'unavailable') return null;

  const retryAfterSec = normaliseRetryAfter((body as { retryAfterSec?: unknown }).retryAfterSec as number);
  // Regenerated, NOT copied from the response. See above.
  return { message: avatarDenialCopy({ reason, retryAfterSec }), reason, retryAfterSec };
}
