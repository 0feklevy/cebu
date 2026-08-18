/**
 * Resilient fetch for transient network failures talking to object storage / external
 * hosts — e.g. HTTP/2 "GOAWAY" frames (undici reuses an HTTP/2 connection the server
 * has decided to close), connection resets, or transient 5xx. Retries with backoff;
 * never retries deterministic 4xx.
 *
 * observability-007 — IT NOW SAYS WHAT IT IS DOING. With the default settings this can spend four
 * attempts and ~1.75 s inside one call, and it used to do that in complete silence: a storage
 * backend degrading from "instant" to "works on the third try" was indistinguishable from a
 * healthy one, and the eventual throw surfaced in some caller with no record of what it had been
 * fighting. Four events are now emitted, and no more than four:
 *
 *   retry     (warn)  — one per attempt that failed and will be retried
 *   recovered (info)  — succeeded, but not on the first attempt
 *   exhausted (warn)  — out of retries, returning the 5xx to the caller
 *   failed    (error) — out of retries after a thrown error; rethrowing
 *
 * A first-attempt success logs NOTHING. This runs on the hot path of every export and transcode
 * download; making the healthy case chatty would bury the signal.
 *
 * THE URL IS NEVER LOGGED WHOLE. Every production caller passes a PRESIGNED url — see
 * `services/video/runVideoTranscode.ts`, `services/export/LinearAssembler.ts`,
 * `scripts/verify-storage.ts` — whose query string carries `X-Amz-Credential` and
 * `X-Amz-Signature`. Those are live, time-limited credentials for the object. Only host and
 * pathname go into the log, which is all an operator needs to name the failing dependency.
 *
 * The correlation id is not a parameter here and never will be: the pino mixin
 * (lib/logger.ts + lib/requestContext.ts) stamps it, so these lines join the request or job that
 * caused them without this function knowing such a thing exists.
 */
import { logger } from './logger.js';

/** Host and path of the target, with the query string (and therefore any signature) removed. */
function target(input: string | URL): { host: string; path: string } {
  try {
    const url = input instanceof URL ? input : new URL(input);
    return { host: url.host, path: url.pathname };
  } catch {
    // Not absolute (or not a URL at all). Keep only what precedes the query, so a caller that
    // passes something unexpected still cannot push a secret into the log through this path.
    const raw = String(input);
    const cut = raw.indexOf('?');
    return { host: '', path: cut === -1 ? raw : raw.slice(0, cut) };
  }
}

export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const baseDelay = opts.baseDelayMs ?? 250;
  const where = { method: init?.method ?? 'GET', ...target(input) };
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, init);
      if (res.status >= 500 && attempt < retries) {
        const delayMs = baseDelay * 2 ** attempt;
        logger.warn({ evt: 'fetch_retry', ...where, attempt, retries, status: res.status, delayMs }, 'fetch: retrying after 5xx');
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (res.status >= 500) {
        // Out of retries, but this is a Response, not a throw — the caller decides what a 5xx
        // means. Without this line the only trace of N failed attempts is the caller's own error.
        logger.warn({ evt: 'fetch_exhausted', ...where, attempts: attempt + 1, status: res.status }, 'fetch: giving up, returning 5xx to caller');
      } else if (attempt > 0) {
        logger.info({ evt: 'fetch_recovered', ...where, attempts: attempt + 1, status: res.status }, 'fetch: succeeded after retry');
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delayMs = baseDelay * 2 ** attempt;
        logger.warn({ evt: 'fetch_retry', ...where, attempt, retries, err, delayMs }, 'fetch: retrying after network error');
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
    }
  }
  logger.error({ evt: 'fetch_failed', ...where, attempts: retries + 1, err: lastErr }, 'fetch: failed after all retries');
  throw lastErr;
}
