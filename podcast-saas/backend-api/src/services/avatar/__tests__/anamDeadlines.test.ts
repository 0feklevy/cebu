/**
 * Every Anam call has an operation-specific deadline and is cancellable.
 *
 * Not one call to the vendor passed a `signal`. Verified against a non-responding socket, a bare
 * fetch was still pending after 12 seconds — and a start holds a request, a database connection
 * and the viewer's popup open for the whole of it. services/course/transcript.ts:30-36 already had
 * the right shape (AbortController + a timer that aborts, cleared on completion); this pins the
 * same shape on the avatar path.
 *
 * The mint is deliberately different from the reads: it is a NON-IDEMPOTENT POST. After an
 * ambiguous timeout the vendor may well have minted a token that we never saw, so retrying could
 * mint twice (double billing, and a second session slot held until it expires). The GETs may be
 * retried freely; the mint must fail fast and let the caller decide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getSessionToken, getPersona, listAnamResource, upsertVideoPersona,
  invalidateAnamLlmCache, ANAM_ENV, ANAM_TIMEOUTS,
} from '../anamService.js';

/** A vendor that never answers. Resolves only when the caller's signal aborts. */
function mockHangingFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = vi.fn((url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;   // no deadline wired → the promise hangs, and the test times out
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  }) as typeof fetch;
  return { calls };
}

const savedTimeouts = { ...ANAM_TIMEOUTS };

describe('Anam calls — deadlines and cancellation', () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { ...ANAM_ENV };

  beforeEach(() => {
    ANAM_ENV.ANAM_API_KEY = 'test-key-1234567890';
    ANAM_ENV.ANAM_AVATAR_ID = 'env-avatar-1';
    ANAM_ENV.ANAM_VOICE_ID = 'env-voice-1';
    ANAM_ENV.ANAM_LLM_ID = 'llm-default-1';
    // Short deadlines keep the suite fast; production values live in anamService.
    Object.assign(ANAM_TIMEOUTS, { read: 40, mint: 40, write: 40, upload: 40 });
    invalidateAnamLlmCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Object.assign(ANAM_ENV, savedEnv);
    Object.assign(ANAM_TIMEOUTS, savedTimeouts);
    invalidateAnamLlmCache();
  });

  it('a hanging mint fails with a gateway-timeout status instead of holding the request open', async () => {
    mockHangingFetch();
    const started = Date.now();
    await expect(getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' }))
      .rejects.toMatchObject({ status: 504 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('the mint is NOT retried after an ambiguous timeout (a retry could mint twice)', async () => {
    const { calls } = mockHangingFetch();
    await expect(getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' })).rejects.toBeTruthy();
    expect(calls.filter((u) => u.includes('/auth/session-token'))).toHaveLength(1);
  });

  it('a hanging persona read resolves to null rather than hanging the caller', async () => {
    mockHangingFetch();
    await expect(getPersona('persona-1')).resolves.toBeNull();
  });

  it('a hanging resource listing gives up and returns what it has', async () => {
    mockHangingFetch();
    await expect(listAnamResource('avatars')).resolves.toEqual({ data: [] });
  });

  it('a hanging persona upsert fails fast and does NOT fall back to a create (that would duplicate the persona)', async () => {
    const { calls } = mockHangingFetch();
    await expect(upsertVideoPersona('einstein', { avatarId: 'a1', voiceId: 'v1', llmId: 'llm-1' }, undefined, 'persona-existing'))
      .rejects.toMatchObject({ status: 504 });
    expect(calls.filter((u) => u.includes('/personas'))).toHaveLength(1);
  });

  it('every Anam request carries an abort signal', async () => {
    const seen: Array<boolean> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seen.push(Boolean(init?.signal));
      return new Response(JSON.stringify({ sessionToken: 'tok', data: [], id: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    await getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' });
    await getPersona('persona-1');
    await listAnamResource('voices');
    await upsertVideoPersona('einstein', { avatarId: 'a1', voiceId: 'v1', llmId: 'llm-1' });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every(Boolean)).toBe(true);
  });

  it('a timer is cleared on the happy path (no dangling abort timers keep the process awake)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ sessionToken: 'tok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    await getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
