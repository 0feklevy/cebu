'use client';

/**
 * WHAT THE AVATAR CONNECT IS ALLOWED TO SPEND, AND THE ORIGIN IT SPENDS IT ON.
 *
 * ── THE UNCOUNTED HOP ────────────────────────────────────────────────────────
 * `sdk.createClient(sessionToken, { voiceDetection })` used to pass the voice policy
 * and nothing else, which left @anam-ai/js-sdk 4.15.0's own defaults in force for the
 * single slowest call in the product. Read from the vendored package
 * (dist/module/lib/constants.js):
 *
 *     DEFAULT_START_SESSION_MAX_ATTEMPTS        = 3
 *     DEFAULT_START_SESSION_INITIAL_BACKOFF_MS  = 250
 *     DEFAULT_START_SESSION_MAX_BACKOFF_MS      = 2000
 *     DEFAULT_START_SESSION_REQUEST_TIMEOUT_MS  = 10000
 *
 * and CoreApiRestClient.isRetryableError (CoreApiRestClient.js:198) retries EVERY 5xx
 * plus every non-ClientError — which includes the vendor's own 503 "There are no
 * available personas". So a busy vendor silently costs two extra
 * POST /v1/engine/session round trips plus backoff, and an endpoint that accepts the
 * connection and then never answers costs 3 x 10s + backoff = 30,750ms worst case,
 * none of which appeared in any measurement because none of it is ours.
 *
 * ── WHY THE WATCHDOG MADE IT WORSE ───────────────────────────────────────────
 * AvatarConversation's connection watchdog fires at 20s. 20,000 < 30,750, so on a hung
 * endpoint the watchdog ALWAYS won the race: the SDK's real ClientError — the one that
 * says 429 "Concurrency limit reached" or 503 "There are no available personas" — was
 * still inside its retry loop when the component had already replaced the screen with
 * a guess. The invariant this file exists to hold is therefore an ORDERING, not a
 * number: the SDK's worst case must elapse strictly inside the watchdog so the
 * vendor's own diagnosis is what the viewer and the operator see.
 *
 * ── THE POLICY ───────────────────────────────────────────────────────────────
 * 2 attempts, not 3. One retry still absorbs a single transient blip (a dropped
 * connection, one 503 from a persona pool that is refilling), which is what the retry
 * is for; a third attempt against an endpoint that has already failed twice is
 * unlikely to be the one that works and is certain to be the one that blows the
 * budget. 7s per attempt, not 10s: two attempts at 7s plus one backoff is 14,250ms,
 * which leaves 5,750ms of headroom under the watchdog for the signalling and WebRTC
 * phases that follow — phases the watchdog also covers.
 *
 * These numbers are deliberately conservative in the direction of NOT aborting a
 * healthy-but-slow start, because the real distribution of POST /v1/engine/session is
 * not measured yet. connectTelemetry.ts is what will measure it; when it has, this is
 * the one place to retune.
 */

/**
 * The origin @anam-ai/js-sdk 4.15.0 talks to for BOTH the session start
 * (CoreApiRestClient, DEFAULT_API_BASE_URL) and its client metrics
 * (ClientMetrics, DEFAULT_ANAM_METRICS_BASE_URL). Confirmed from the vendored package,
 * not assumed; the suite re-reads the SDK's constant from disk so this cannot drift.
 *
 * The engine host that carries the actual media is NOT here on purpose: it arrives in
 * the startSession response body and is not knowable before the call.
 */
export const ANAM_API_ORIGIN = 'https://api.anam.ai';

export interface AnamSessionStartPolicy {
  retry: { maxAttempts: number; initialBackoffMs: number; maxBackoffMs: number };
  requestTimeoutMs: number;
}

/**
 * Shape matches @anam-ai/js-sdk's `ApiOptions`, so it is passed as `createClient(t, { api })`.
 * Frozen: it is a module singleton handed to every client the page creates (the first
 * connect and every reconnect), and one accidental write would retune all of them.
 */
export const ANAM_SESSION_START_POLICY: AnamSessionStartPolicy = Object.freeze({
  retry: Object.freeze({ maxAttempts: 2, initialBackoffMs: 250, maxBackoffMs: 1_000 }),
  requestTimeoutMs: 7_000,
});

/**
 * Worst-case wall clock CoreApiRestClient.startSession can burn under `policy`, using
 * the SDK's own arithmetic: every attempt times out, and every backoff lands on the
 * high end of its equal-jitter window (computeBackoffDelay, CoreApiRestClient.js:141).
 */
export function worstCaseSessionStartMs(policy: AnamSessionStartPolicy = ANAM_SESSION_START_POLICY): number {
  const attempts = Math.max(1, Math.floor(policy.retry.maxAttempts));
  let total = attempts * Math.max(0, policy.requestTimeoutMs);
  for (let attempt = 1; attempt < attempts; attempt++) {
    total += Math.min(policy.retry.maxBackoffMs, policy.retry.initialBackoffMs * 2 ** (attempt - 1));
  }
  return total;
}

/**
 * How long the component waits for a presented frame before it gives up. Covers the
 * whole connect — session start, signalling, ICE, first frame — so it must be strictly
 * larger than worstCaseSessionStartMs(), which is only the first of those.
 */
export const CONNECT_WATCHDOG_MS = 20_000;

/**
 * Budget for the best-effort pre-connect element prime. It is not a deadline the prime
 * is expected to use: when it works, resume() and play() settle in single-digit
 * milliseconds. It is the bound that stops a promise which never settles at all — a
 * throttled background tab, a UA-suspended AudioContext — from parking the connect
 * behind it forever. See primeVideoElementForAutoplay in AvatarConversation.tsx.
 */
export const PRIME_BUDGET_MS = 1_000;

/**
 * Resolve when `p` settles or when `ms` elapses, whichever is first. Never rejects, so
 * the caller's control flow cannot be diverted by a best-effort step, and never leaves
 * an unhandled rejection behind for a promise that loses the race.
 */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    p.then(() => {}, () => {}).then(() => { clearTimeout(timer); resolve(); });
  });
}

/**
 * Open the TLS connection to the Anam API before the connect needs it.
 *
 * One cold DNS lookup + TCP + TLS handshake to a third-party origin is ~50-200ms, and
 * until now every single first "Ask!" paid it INSIDE the SDK's startSession, where it
 * was invisible and unattributable.
 *
 * Deliberately NOT a static <link> in app/layout.tsx: a preconnect that nobody uses is
 * closed again by Chromium's unused-idle-socket timeout (10s), so a handshake opened at
 * page load is long gone by the time a viewer clicks "Ask!" partway through a video —
 * it would be a handshake per page view for every viewer, and still a cold connect for
 * the few who click. Firing it from the same warm points that already fetch the SDK
 * chunk (AskAvatarButton hover/focus/touch, AvatarPopup open) puts it a full backend
 * round trip ahead of the SDK's first request, which is where it actually pays.
 *
 * Costs nothing billable: no session, no mint, no request to any of our routes.
 */
let preconnected = false;

export function preconnectAnamApi(): void {
  if (preconnected || typeof document === 'undefined') return;
  preconnected = true;
  try {
    // crossOrigin=anonymous matches the connection pool the SDK's own fetch uses: it
    // sends an Authorization header but no cookies, i.e. a non-credentialed CORS
    // request. A preconnect on the credentialed pool would warm the wrong socket.
    const preconnect = document.createElement('link');
    preconnect.rel = 'preconnect';
    preconnect.href = ANAM_API_ORIGIN;
    preconnect.crossOrigin = 'anonymous';
    document.head.appendChild(preconnect);
    // Fallback for the (few) engines that ignore preconnect: at least resolve the name.
    const dns = document.createElement('link');
    dns.rel = 'dns-prefetch';
    dns.href = ANAM_API_ORIGIN;
    document.head.appendChild(dns);
  } catch {
    /* best-effort: a missing handshake costs latency, never correctness */
  }
}

/** Test seam: forget that the handshake was warmed. Not used by product code. */
export function __resetPreconnectForTests(): void {
  preconnected = false;
}
