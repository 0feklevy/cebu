/**
 * observability-007 — a retry loop that logs nothing is a latency bug you cannot see.
 *
 * `fetchWithRetry` is the only thing standing between this API and transient object-storage
 * failures (HTTP/2 GOAWAY, connection resets, 5xx). It could burn four attempts and ~1.75s of wall
 * clock on every single request and the logs would look identical to a healthy system; when it
 * finally gave up, the throw surfaced somewhere else entirely with no record of what it had been
 * fighting.
 *
 * REDACTION IS THE CONSTRAINT. Every production caller passes a PRESIGNED url —
 * `services/video/runVideoTranscode.ts`, `services/export/LinearAssembler.ts` and
 * `scripts/verify-storage.ts` all hand it a signed S3/R2 link whose query string carries
 * `X-Amz-Credential` and `X-Amz-Signature`. Logging `input` would put a working, time-limited
 * download/upload credential in the log on every retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: log }));

const { fetchWithRetry } = await import('../fetchWithRetry.js');

const SIGNED =
  'https://bucket.r2.cloudflarestorage.com/videos/abc.mp4' +
  '?X-Amz-Credential=AKIAEXAMPLE%2F20260818%2Fauto%2Fs3%2Faws4_request' +
  '&X-Amz-Signature=DEADBEEFSIGNATUREVALUE';

function res(status: number): Response {
  return { status, ok: status < 400 } as unknown as Response;
}

/**
 * Everything handed to any logger method, as one string.
 *
 * Errors are expanded by hand: `JSON.stringify(new Error('x'))` is `{}` because `message` and
 * `stack` are not enumerable, and pino's standard error serializer DOES emit both. A redaction
 * assertion built on plain stringify would therefore pass while the real logger printed a secret
 * that had ended up in an error message.
 */
function logged(): string {
  return JSON.stringify(
    [log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls, log.debug.mock.calls],
    (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack, ...v } : v),
  );
}
function payloads(): Array<Record<string, unknown>> {
  return [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls, ...log.debug.mock.calls]
    .map((c) => c[0] as Record<string, unknown>);
}

const realFetch = globalThis.fetch;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { globalThis.fetch = realFetch; });

describe('fetchWithRetry logging', () => {
  it('says nothing on a first-try success — this runs on every request', async () => {
    globalThis.fetch = vi.fn(async () => res(200)) as unknown as typeof fetch;
    await fetchWithRetry(SIGNED, undefined, { baseDelayMs: 0 });
    expect(logged(), 'a healthy fetch should not produce log volume').toBe(JSON.stringify([[], [], [], []]));
  });

  it('records each retry of a transient 5xx, with the attempt number and the status', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => (++n < 3 ? res(503) : res(200))) as unknown as typeof fetch;
    const out = await fetchWithRetry(SIGNED, undefined, { retries: 3, baseDelayMs: 0 });
    expect(out.status).toBe(200);
    const retries = log.warn.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(retries.length, 'the retries left no trace').toBe(2);
    expect(retries[0].attempt).toBe(0);
    expect(retries[0].status).toBe(503);
    expect(retries[1].attempt).toBe(1);
  });

  it('records a retry of a thrown network error, and what the error was', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      if (++n === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return res(200);
    }) as unknown as typeof fetch;
    await fetchWithRetry(SIGNED, undefined, { retries: 2, baseDelayMs: 0 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('socket hang up');
  });

  it('says so when it eventually SUCCEEDS after retrying — a slow-but-working dependency', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => (++n < 2 ? res(500) : res(200))) as unknown as typeof fetch;
    await fetchWithRetry(SIGNED, undefined, { retries: 3, baseDelayMs: 0 });
    expect(log.info, 'a request that only worked on the second try looks perfectly healthy').toHaveBeenCalled();
    const recovered = log.info.mock.calls[0][0] as Record<string, unknown>;
    expect(recovered.attempts).toBe(2);
  });

  it('logs the eventual FAILURE at error level before it throws', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('GOAWAY'); }) as unknown as typeof fetch;
    await expect(fetchWithRetry(SIGNED, undefined, { retries: 2, baseDelayMs: 0 })).rejects.toThrow('GOAWAY');
    expect(log.error, 'giving up entirely was invisible').toHaveBeenCalled();
    const failure = log.error.mock.calls[0][0] as Record<string, unknown>;
    expect(failure.attempts).toBe(3); // the first try plus two retries
  });

  it('logs when it returns a 5xx it has run out of retries for', async () => {
    // It does not throw here — it hands the 5xx back and the caller decides. That is the case
    // most likely to be misread downstream as "the storage returned an error once".
    globalThis.fetch = vi.fn(async () => res(502)) as unknown as typeof fetch;
    const out = await fetchWithRetry(SIGNED, undefined, { retries: 2, baseDelayMs: 0 });
    expect(out.status).toBe(502);
    const exhausted = payloads().find((p) => p.status === 502 && p.attempts === 3);
    expect(exhausted, 'exhausting the retries on a 5xx produced no summary line').toBeTruthy();
  });

  it('NEVER logs the presigned query string — it is a working credential', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    await expect(fetchWithRetry(SIGNED, { method: 'PUT' }, { retries: 2, baseDelayMs: 0 })).rejects.toThrow();
    const all = logged();
    expect(all, 'the AWS signature reached the logs').not.toContain('DEADBEEFSIGNATUREVALUE');
    expect(all, 'the AWS credential reached the logs').not.toContain('AKIAEXAMPLE');
    expect(all).not.toContain('X-Amz-');
    // …while still saying enough to know WHICH dependency is failing.
    expect(all).toContain('bucket.r2.cloudflarestorage.com');
    expect(all).toContain('/videos/abc.mp4');
    expect(payloads()[0].method).toBe('PUT');
  });

  it('handles a URL object and a malformed input without throwing from the logging itself', async () => {
    globalThis.fetch = vi.fn(async () => res(500)) as unknown as typeof fetch;
    await fetchWithRetry(new URL(SIGNED), undefined, { retries: 1, baseDelayMs: 0 });
    expect(logged()).not.toContain('DEADBEEFSIGNATUREVALUE');
    vi.clearAllMocks();
    await fetchWithRetry('not a url at all?token=SECRET', undefined, { retries: 1, baseDelayMs: 0 });
    expect(logged(), 'the fallback path leaked the query').not.toContain('SECRET');
  });
});
