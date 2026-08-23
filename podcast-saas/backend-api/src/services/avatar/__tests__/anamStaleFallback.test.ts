// Regression: a stale Anam personaId (deleted/recreated in the dashboard, or
// created under a different key) must not hard-fail the avatar. getSessionToken
// retries ONCE with an ephemeral avatar+voice persona carrying the same brain.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSessionToken, resolveDefaultLlmId, invalidateAnamLlmCache, ANAM_ENV } from '../anamService.js';

type Call = { url: string; body: Record<string, unknown> };

function mockFetchSequence(responses: Array<{ status: number; json: unknown }>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
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
    // Pin a brain (the intended production config) so the token is v4 non-legacy and no
    // dynamic GET /llms round-trip perturbs the mocked fetch sequence.
    ANAM_ENV.ANAM_LLM_ID = 'llm-default-1';
    invalidateAnamLlmCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Object.assign(ANAM_ENV, savedEnv);
    invalidateAnamLlmCache();
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
    expect(retry.llmId).toBe('llm-default-1');   // the brain is baked in ⇒ non-legacy token
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

  it('does not retry when no avatar/voice fallback exists (env unset AND the account listing offers none)', async () => {
    ANAM_ENV.ANAM_AVATAR_ID = '';
    ANAM_ENV.ANAM_VOICE_ID = '';
    // The 400 body is reused for the GET /avatars + /voices live-default probes too,
    // so the account resolves no fallback either. Only ONE mint may happen.
    const calls = mockFetchSequence([STALE_400]);
    await expect(getSessionToken('einstein', { personaId: `dead-${Date.now()}-e` }))
      .rejects.toThrow(/Anam API error \(400\)/);
    expect(calls.filter((c) => c.url.includes('/auth/session-token'))).toHaveLength(1);
  });
});

// The core v4 fix: an ephemeral session-token persona ALWAYS carries an llmId (brain), so
// Anam never mints a "legacy" token the browser SDK rejects.
describe('getSessionToken — every ephemeral persona carries a brain (no legacy tokens)', () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { ...ANAM_ENV };

  beforeEach(() => {
    ANAM_ENV.ANAM_API_KEY = 'test-key-1234567890';
    ANAM_ENV.ANAM_AVATAR_ID = 'env-avatar-1';
    ANAM_ENV.ANAM_VOICE_ID = 'env-voice-1';
    ANAM_ENV.ANAM_LLM_ID = '';
    invalidateAnamLlmCache();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    Object.assign(ANAM_ENV, savedEnv);
    invalidateAnamLlmCache();
  });

  it('bakes the env-pinned llmId into an ephemeral (avatar+voice) persona', async () => {
    ANAM_ENV.ANAM_LLM_ID = 'llm-pinned-9';
    const calls = mockFetchSequence([TOKEN_200]);
    await getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' });
    const pc = calls.at(-1)!.body.personaConfig as Record<string, unknown>;
    expect(pc.avatarId).toBe('a1');
    expect(pc.voiceId).toBe('v1');
    expect(pc.llmId).toBe('llm-pinned-9');
    expect(pc.personaId).toBeUndefined();
  });

  it('resolves a default llmId from GET /llms when ANAM_LLM_ID is unset (never CUSTOMER_CLIENT_V1)', async () => {
    const llms = { status: 200, json: { data: [{ id: 'CUSTOMER_CLIENT_V1' }, { id: 'llm-hosted-abc' }] } };
    const calls = mockFetchSequence([llms, TOKEN_200]);
    await getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' });
    expect(calls[0].url).toContain('/llms');
    const pc = calls.at(-1)!.body.personaConfig as Record<string, unknown>;
    expect(pc.llmId).toBe('llm-hosted-abc');
  });

  it('applies the env pin ONLY to the server key; a BYOK key resolves from its own account', async () => {
    ANAM_ENV.ANAM_LLM_ID = 'llm-env-server';
    // Server key (no arg) → env pin, no fetch.
    expect(await resolveDefaultLlmId()).toBe('llm-env-server');
    // BYOK key (a different Anam account) must NOT inherit the server env id — resolve via GET /llms.
    const calls = mockFetchSequence([{ status: 200, json: { data: [{ id: 'user-llm-1' }] } }]);
    expect(await resolveDefaultLlmId('byok-user-key-xyz')).toBe('user-llm-1');
    expect(calls[0].url).toContain('/llms');
  });

  it('never resolves to CUSTOMER_CLIENT_V1 (that would mute the avatar) — errors instead', async () => {
    ANAM_ENV.ANAM_LLM_ID = '';
    mockFetchSequence([{ status: 200, json: { data: [{ id: 'CUSTOMER_CLIENT_V1' }] } }]);
    await expect(getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' }))
      .rejects.toThrow(/No Anam LLM|brain/i);
  });

  it('attaches the knowledge RAG tool + inline knowledge to ephemeral personas (video knowledge survives the fallback)', async () => {
    ANAM_ENV.ANAM_LLM_ID = 'llm-pinned-9';
    const calls = mockFetchSequence([TOKEN_200]);
    await getSessionToken('einstein', {
      avatarId: 'a-k1', voiceId: 'v-k1',
      knowledge: 'VIDEO TRANSCRIPT TEXT', knowledgeToolId: 'tool-rag-1', toolIds: ['tool-end-call'],
    });
    const pc = calls.at(-1)!.body.personaConfig as Record<string, unknown>;
    expect(pc.toolIds).toEqual(['tool-rag-1', 'tool-end-call']);
    expect(String(pc.systemPrompt)).toContain('VIDEO TRANSCRIPT TEXT');
  });

  it('retries a 400 mint once WITHOUT toolIds (knowledge still rides inline in the prompt)', async () => {
    ANAM_ENV.ANAM_LLM_ID = 'llm-pinned-9';
    const calls = mockFetchSequence([
      { status: 400, json: { error: 'bad_request', message: 'toolIds not allowed here' } },
      TOKEN_200,
    ]);
    const info = await getSessionToken('einstein', { avatarId: 'a-k2', voiceId: 'v-k2', knowledge: 'K', knowledgeToolId: 'tool-rag-2' });
    expect(info.token).toBe('tok-live');
    const mints = calls.filter((c) => c.url.includes('/auth/session-token'));
    expect(mints).toHaveLength(2);
    const retry = mints[1].body.personaConfig as Record<string, unknown>;
    expect(retry.toolIds).toBeUndefined();
    expect(String(retry.systemPrompt)).toContain('K');
  });

  it('an ephemeral persona with no resolvable brain throws a config error (never mints a legacy token)', async () => {
    ANAM_ENV.ANAM_LLM_ID = '';
    mockFetchSequence([{ status: 200, json: { data: [] } }]);   // GET /llms empty → defaultLlmId ''
    await expect(getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' }))
      .rejects.toThrow(/No Anam LLM|brain/i);
  });
});

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('getSessionToken — legacy (brainless) tokens are never handed to the browser', () => {
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

  it('a 200 "legacy" token from a brainless stored persona triggers the ephemeral rebuild', async () => {
    const calls = mockFetchSequence([
      { status: 200, json: { sessionToken: jwt({ type: 'legacy' }) } },    // stateful mint → legacy
      { status: 200, json: { sessionToken: jwt({ type: 'ephemeral' }) } }, // ephemeral rebuild → ok
    ]);
    const info = await getSessionToken('einstein', { personaId: 'p-legacy-rebuild' });
    expect(info.token).toBe(jwt({ type: 'ephemeral' }));
    expect(calls).toHaveLength(2);
    const retry = calls[1].body.personaConfig as Record<string, unknown>;
    expect(retry.personaId).toBeUndefined();
    expect(retry.avatarId).toBe('env-avatar-1');
    expect(retry.llmId).toBe('llm-default-1');
  });

  it('a legacy token with no ephemeral fallback throws a clear error (never returned)', async () => {
    ANAM_ENV.ANAM_AVATAR_ID = '';
    ANAM_ENV.ANAM_VOICE_ID = '';
    mockFetchSequence([{ status: 200, json: { sessionToken: jwt({ type: 'legacy' }) } }]);
    // Distinct, static personaId — the module-level tokenCache is keyed by config, so a
    // Date.now() id can collide with the sibling test in the same millisecond (full-suite run).
    await expect(getSessionToken('einstein', { personaId: 'p-legacy-nofallback' }))
      .rejects.toThrow(/legacy session token/i);
  });
});
