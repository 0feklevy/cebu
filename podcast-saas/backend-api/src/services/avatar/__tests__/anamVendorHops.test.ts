/**
 * Vendor round trips on the /avatar/start path.
 *
 * Every assertion here counts CALLS to api.anam.ai, because that is what the viewer feels: each
 * hop is a sequential 200-600ms wait in front of a spinner. Four separate defects were each
 * costing at least one hop:
 *
 *   B2               — resolveDefaultLlmId() was awaited unconditionally, and the STATEFUL fast
 *                      path (the path a healthy project takes on every open) throws the result
 *                      away. Unpinned ANAM_LLM_ID, or any BYOK key, made that a GET /llms crawl.
 *   anam-backend-010 — a persona deleted in the Anam dashboard is invisible to the LOCAL
 *                      fingerprint check, so every open paid a doomed stateful mint plus an
 *                      ephemeral rebuild — two hops, forever.
 *   anam-backend-005 — the base character persona was fetched even when the video already pinned
 *                      an avatar AND a voice, because the `!cfg.llmId` disjunct is true for every
 *                      config that does not hand-pick an LLM (i.e. all of them).
 *   anam-backend-007 — listAnamResource pages sequentially with no cache at all.
 *
 * PERSONA_MAP is frozen from process.env at module load, so the base character persona id is
 * stubbed before the import — without it entry.personaId is '' and the anam-backend-005 hop
 * cannot happen at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const BASE_PERSONA = vi.hoisted(() => {
  process.env.ANAM_PERSONA_ID_EINSTEIN = 'base-persona-1';
  return 'base-persona-1';
});

import {
  getSessionToken, listAnamResource, invalidateAnamLlmCache, ANAM_ENV,
} from '../anamService.js';

interface Call { url: string; method: string; body: Record<string, unknown> }
type Reply = { status: number; json: unknown };

/** Route by URL + body rather than by sequence: these tests vary how many hops happen, which is
 *  exactly what a positional mock cannot express. */
function mockAnam(handler: (url: string, method: string, body: Record<string, unknown>) => Reply): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>; } catch { /* multipart */ }
    calls.push({ url: u, method, body });
    const r = handler(u, method, body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const TOKEN_200: Reply = { status: 200, json: { sessionToken: 'tok-live' } };
const STALE_400: Reply = { status: 400, json: { error: 'invalid_persona_configuration', message: 'Persona not found or unavailable' } };
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** A healthy account: a base persona with a full avatar/voice/brain, one hosted LLM, one avatar,
 *  one voice. `mint` decides what the session-token POST answers for a given persona config. */
function account(mint: (pc: Record<string, unknown>) => Reply = () => TOKEN_200) {
  return (url: string, _method: string, body: Record<string, unknown>): Reply => {
    if (url.includes('/auth/session-token')) return mint((body.personaConfig ?? {}) as Record<string, unknown>);
    if (url.includes(`/personas/${BASE_PERSONA}`)) return { status: 200, json: { id: BASE_PERSONA, avatarId: 'base-av', voiceId: 'base-vo', llmId: 'base-llm' } };
    if (url.includes('/llms')) return { status: 200, json: { data: [{ id: 'llm-hosted-1' }] } };
    if (url.includes('/avatars')) return { status: 200, json: { data: [{ id: 'acct-av', displayName: 'Acct', imageUrl: 'https://example.invalid/a.png' }] } };
    if (url.includes('/voices')) return { status: 200, json: { data: [{ id: 'acct-vo', displayName: 'Acct' }] } };
    return { status: 404, json: {} };
  };
}

const urls = (calls: Call[], needle: string) => calls.filter((c) => c.url.includes(needle));
const mints = (calls: Call[]) => urls(calls, '/auth/session-token');
const pc = (c: Call) => c.body.personaConfig as Record<string, unknown>;

const realFetch = globalThis.fetch;
const savedEnv = { ...ANAM_ENV };

beforeEach(() => {
  ANAM_ENV.ANAM_API_KEY = 'test-key-1234567890';
  ANAM_ENV.ANAM_AVATAR_ID = 'env-avatar-1';
  ANAM_ENV.ANAM_VOICE_ID = 'env-voice-1';
  ANAM_ENV.ANAM_LLM_ID = 'llm-pinned-1';
  invalidateAnamLlmCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(ANAM_ENV, savedEnv);
  invalidateAnamLlmCache();
});

// ── anam-backend-010 ────────────────────────────────────────────────────────────
// The stale persona is DETECTED today and then forgotten, so the next open rediscovers it the
// expensive way. These pin (a) that the discovery is reported to the caller at all — nothing
// outside anamService can currently see it — and (b) that a second open does not pay for it again.
describe('a vendor-deleted persona is repaired, not rediscovered on every open', () => {
  it('reports the unusable stored persona to the caller so the record can be repaired durably', async () => {
    const calls = mockAnam(account((p) => (p.personaId === 'p-dead-1' ? STALE_400 : TOKEN_200)));
    const info = await getSessionToken('einstein', { personaId: 'p-dead-1' });
    expect(info.token).toBe('tok-live');
    expect(mints(calls)).toHaveLength(2);                 // the doomed one, then the rebuild
    expect(info.personaRepair).toEqual({ personaId: 'p-dead-1', reason: 'stale-400', discovered: true });
  });

  it('a brainless (legacy-minting) stored persona is reported the same way', async () => {
    const calls = mockAnam(account((p) => (p.personaId === 'p-legacy-1'
      ? { status: 200, json: { sessionToken: jwt({ type: 'legacy' }) } }
      : { status: 200, json: { sessionToken: jwt({ type: 'ephemeral' }) } })));
    const info = await getSessionToken('einstein', { personaId: 'p-legacy-1' });
    expect(mints(calls)).toHaveLength(2);
    expect(info.personaRepair).toEqual({ personaId: 'p-legacy-1', reason: 'legacy-token', discovered: true });
  });

  it('the SECOND open of the same dead persona skips the doomed mint entirely', async () => {
    const calls = mockAnam(account((p) => (p.personaId === 'p-dead-2' ? STALE_400 : TOKEN_200)));
    await getSessionToken('einstein', { personaId: 'p-dead-2' });
    expect(mints(calls)).toHaveLength(2);

    calls.length = 0;
    const info = await getSessionToken('einstein', { personaId: 'p-dead-2' });
    expect(info.token).toBe('tok-live');
    expect(mints(calls)).toHaveLength(1);                 // one hop, not two
    expect(pc(mints(calls)[0]).personaId).toBeUndefined();
    expect(info.personaRepair).toEqual({ personaId: 'p-dead-2', reason: 'stale-400', discovered: false });
  });

  it('remembering one dead persona does not condemn a different, healthy one', async () => {
    const calls = mockAnam(account((p) => (p.personaId === 'p-dead-3' ? STALE_400 : TOKEN_200)));
    await getSessionToken('einstein', { personaId: 'p-dead-3' });
    calls.length = 0;
    const info = await getSessionToken('einstein', { personaId: 'p-healthy-3' });
    expect(mints(calls)).toHaveLength(1);
    expect(pc(mints(calls)[0]).personaId).toBe('p-healthy-3');   // still minted statefully
    expect(info.personaRepair).toBeUndefined();
  });

  it('does NOT skip the stateful mint when no complete ephemeral persona can be built', async () => {
    // No env avatar/voice, no base persona, no account avatars/voices — the ephemeral rebuild is
    // impossible, so the doomed mint is still this start's only chance and must not be skipped.
    ANAM_ENV.ANAM_AVATAR_ID = '';
    ANAM_ENV.ANAM_VOICE_ID = '';
    const bare = (url: string, _m: string, body: Record<string, unknown>): Reply => {
      if (url.includes('/auth/session-token')) {
        return (body.personaConfig as Record<string, unknown>).personaId === 'p-dead-4' ? STALE_400 : TOKEN_200;
      }
      return { status: 200, json: { data: [] } };
    };
    mockAnam(bare);
    await expect(getSessionToken('einstein', { personaId: 'p-dead-4' })).rejects.toThrow(/Anam API error \(400\)/);

    const calls2 = mockAnam(bare);
    await expect(getSessionToken('einstein', { personaId: 'p-dead-4' })).rejects.toThrow(/Anam API error \(400\)/);
    expect(mints(calls2)).toHaveLength(1);
    expect(pc(mints(calls2)[0]).personaId).toBe('p-dead-4');
  });
});

// ── B2 ──────────────────────────────────────────────────────────────────────────
describe('the stateful fast path resolves no LLM it will not use', () => {
  it('makes no GET /llms when the persona config is a pure stateful { personaId }', async () => {
    ANAM_ENV.ANAM_LLM_ID = '';        // unpinned deploy, or any BYOK key: the crawl is not free
    const calls = mockAnam(account());
    const info = await getSessionToken('einstein', { personaId: 'p-fast' });
    expect(info.token).toBe('tok-live');
    expect(urls(calls, '/llms')).toHaveLength(0);
    expect(calls).toHaveLength(1);    // exactly ONE vendor hop: the mint
  });

  it('still resolves the account LLM on the ephemeral path that actually needs it', async () => {
    ANAM_ENV.ANAM_LLM_ID = '';
    const calls = mockAnam(account());
    await getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' });
    expect(urls(calls, '/llms')).toHaveLength(1);
    expect(pc(mints(calls)[0]).llmId).toBe('llm-hosted-1');
  });
});

// ── anam-backend-005 ────────────────────────────────────────────────────────────
describe('the base character persona is fetched only when something is missing', () => {
  it('is not fetched when the video pins both an avatar and a voice', async () => {
    const calls = mockAnam(account());
    await getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' });
    expect(urls(calls, `/personas/${BASE_PERSONA}`)).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('is still fetched when the voice is missing (that is what it is for)', async () => {
    const calls = mockAnam(account());
    await getSessionToken('einstein', { avatarId: 'a1' });
    expect(urls(calls, `/personas/${BASE_PERSONA}`)).toHaveLength(1);
    expect(pc(mints(calls)[0]).voiceId).toBe('base-vo');
  });

  it('falls back to the base persona brain when nothing else supplies one', async () => {
    ANAM_ENV.ANAM_LLM_ID = '';
    const noLlms = (url: string, m: string, b: Record<string, unknown>): Reply =>
      (url.includes('/llms') ? { status: 200, json: { data: [] } } : account()(url, m, b));
    const calls = mockAnam(noLlms);
    await getSessionToken('einstein', { avatarId: 'a1', voiceId: 'v1' });
    expect(pc(mints(calls)[0]).llmId).toBe('base-llm');
  });
});

// ── anam-backend-007 ────────────────────────────────────────────────────────────
describe('account listings are cached', () => {
  it('serves a repeat listing of the same kind from cache', async () => {
    const calls = mockAnam(account());
    const first = await listAnamResource('avatars');
    const second = await listAnamResource('avatars');
    expect(second).toEqual(first);
    expect(urls(calls, '/avatars')).toHaveLength(1);
  });

  it('caches per kind and per key, not globally', async () => {
    const calls = mockAnam(account());
    await listAnamResource('avatars');
    await listAnamResource('voices');
    await listAnamResource('avatars', 'a-different-byok-key');
    expect(urls(calls, '/avatars')).toHaveLength(2);
    expect(urls(calls, '/voices')).toHaveLength(1);
  });

  it('does NOT cache a listing that ended on a vendor error (a degraded answer must not stick)', async () => {
    const calls = mockAnam(() => ({ status: 500, json: { error: 'upstream' } }));
    await expect(listAnamResource('avatars')).resolves.toEqual({ data: [] });
    await expect(listAnamResource('avatars')).resolves.toEqual({ data: [] });
    expect(urls(calls, '/avatars')).toHaveLength(2);
  });

  it('{ fresh: true } bypasses the cache and refreshes it (the settings pickers need this)', async () => {
    const calls = mockAnam(account());
    await listAnamResource('llms');
    await listAnamResource('llms', undefined, { fresh: true });
    expect(urls(calls, '/llms')).toHaveLength(2);
    await listAnamResource('llms');
    expect(urls(calls, '/llms')).toHaveLength(2);   // the fresh read re-armed the entry
  });

  it('invalidateAnamLlmCache drops the listing cache too (ops seam after a dashboard edit)', async () => {
    const calls = mockAnam(account());
    await listAnamResource('voices');
    invalidateAnamLlmCache();
    await listAnamResource('voices');
    expect(urls(calls, '/voices')).toHaveLength(2);
  });
});
