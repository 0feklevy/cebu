/**
 * Anam session tokens are single-use per stream: reusing one whose session was already consumed
 * makes the engine refuse the WebSocket. getSessionToken nevertheless cached the minted token for
 * six seconds keyed ONLY on the persona config + API key — a CONFIG-GLOBAL cache. Every viewer of a
 * given video produces the same persona config, so two people opening the same public video within
 * six seconds of each other were handed the SAME token, and the second one's stream was refused.
 *
 * The dedupe it was there for (a double-mounted popup asking twice) does not need a config-global
 * cache; it needs a per-popup-open key, which is what services/avatar/startIdempotency.ts provides.
 * Here we pin that the service itself never reuses a token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSessionToken, invalidateAnamLlmCache, ANAM_ENV } from '../anamService.js';

function mockMintSequence(tokens: string[]): { mints: number } {
  const counter = { mints: 0 };
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/auth/session-token')) {
      const token = tokens[Math.min(counter.mints, tokens.length - 1)];
      counter.mints += 1;
      return new Response(JSON.stringify({ sessionToken: token }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return counter;
}

describe('getSessionToken — no config-global token reuse', () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { ...ANAM_ENV };

  beforeEach(() => {
    ANAM_ENV.ANAM_API_KEY = 'test-key-1234567890';
    ANAM_ENV.ANAM_AVATAR_ID = 'env-avatar-1';
    ANAM_ENV.ANAM_VOICE_ID = 'env-voice-1';
    ANAM_ENV.ANAM_LLM_ID = 'llm-default-1';
    invalidateAnamLlmCache();
  });
  afterEach(() => { globalThis.fetch = realFetch; Object.assign(ANAM_ENV, savedEnv); invalidateAnamLlmCache(); });

  it('two identical back-to-back requests each mint their own token', async () => {
    const counter = mockMintSequence(['tok-a', 'tok-b']);
    const cfg = { avatarId: 'a1', voiceId: 'v1', systemPrompt: 'You are Albert.' };
    const first = await getSessionToken('einstein', cfg);
    const second = await getSessionToken('einstein', cfg);
    expect(counter.mints).toBe(2);
    expect(first.token).toBe('tok-a');
    expect(second.token).toBe('tok-b');
  });

  it('two concurrent viewers of the SAME stateful persona each mint their own token', async () => {
    const counter = mockMintSequence(['tok-1', 'tok-2']);
    const cfg = { personaId: 'persona-shared' };
    const [a, b] = await Promise.all([getSessionToken('einstein', cfg), getSessionToken('einstein', cfg)]);
    expect(counter.mints).toBe(2);
    expect(a.token).not.toBe(b.token);
  });
});
