// Regression: a stale Anam personaId (deleted/recreated in the dashboard, or
// created under a different key) must not hard-fail the avatar. getSessionToken
// retries ONCE with an ephemeral avatar+voice persona carrying the same brain.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSessionToken, ANAM_ENV } from '../anamService.js';

type Call = { url: string; body: Record<string, unknown> };

function mockFetchSequence(responses: Array<{ status: number; json: unknown }>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const STALE_400 = { status: 400, json: { error: 'invalid_persona_configuration', message: 'Persona not found or unavailable' } };
const TOKEN_200 = { status: 200, json: { sessionToken: 'tok-live' } };

describe('getSessionToken — stale persona ephemeral fallback', () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { ...ANAM_ENV };

  beforeEach(() => {
    ANAM_ENV.ANAM_API_KEY = 'test-key-1234567890';
    ANAM_ENV.ANAM_AVATAR_ID = 'env-avatar-1';
    ANAM_ENV.ANAM_VOICE_ID = 'env-voice-1';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Object.assign(ANAM_ENV, savedEnv);
  });

  it('retries ephemeral (same brain, env avatar+voice) when the saved personaId is stale', async () => {
    const calls = mockFetchSequence([STALE_400, TOKEN_200]);
    const info = await getSessionToken('einstein', {
      personaId: `dead-${Date.now()}-a`,
      systemPrompt: 'You are Albert.',
      greeting: 'Hello there',
    });
    expect(info.token).toBe('tok-live');
    expect(calls).toHaveLength(2);
    const first = calls[0].body.personaConfig as Record<string, unknown>;
    const retry = calls[1].body.personaConfig as Record<string, unknown>;
    expect(first.personaId).toMatch(/^dead-/);
    expect(retry.personaId).toBeUndefined();
    expect(retry.avatarId).toBe('env-avatar-1');
    expect(retry.voiceId).toBe('env-voice-1');
    expect(retry.systemPrompt).toContain('You are Albert.');
    expect(retry.initialMessage).toBe('Hello there');
  });

  it('cfg avatar/voice choices win over the env defaults in the fallback', async () => {
    const calls = mockFetchSequence([STALE_400, TOKEN_200]);
    await getSessionToken('einstein', {
      personaId: `dead-${Date.now()}-b`,
      avatarId: 'cfg-avatar-9',
      voiceId: 'cfg-voice-9',
    });
    const retry = calls[1].body.personaConfig as Record<string, unknown>;
    expect(retry.avatarId).toBe('cfg-avatar-9');
    expect(retry.voiceId).toBe('cfg-voice-9');
  });

  it('surfaces the original 400 when the fallback also fails', async () => {
    const calls = mockFetchSequence([STALE_400, STALE_400]);
    await expect(getSessionToken('einstein', { personaId: `dead-${Date.now()}-c` }))
      .rejects.toThrow(/Anam API error \(400\)/);
    expect(calls).toHaveLength(2);
  });

  it('does not retry on unrelated 400s', async () => {
    const calls = mockFetchSequence([{ status: 400, json: { error: 'bad_request', message: 'something else' } }]);
    await expect(getSessionToken('einstein', { personaId: `dead-${Date.now()}-d` }))
      .rejects.toThrow(/Anam API error \(400\)/);
    expect(calls).toHaveLength(1);
  });

  it('does not retry when no avatar/voice fallback exists', async () => {
    ANAM_ENV.ANAM_AVATAR_ID = '';
    ANAM_ENV.ANAM_VOICE_ID = '';
    const calls = mockFetchSequence([STALE_400]);
    await expect(getSessionToken('einstein', { personaId: `dead-${Date.now()}-e` }))
      .rejects.toThrow(/Anam API error \(400\)/);
    expect(calls).toHaveLength(1);
  });
});
