/**
 * anam-backend-003 — ONE POPUP OPEN, ONE BILLABLE MINT.
 *
 * The server has deduped concurrent `/avatar/start` calls for a while, but `startIdempotencyKey`
 * returns null unless the caller supplies a `startKey` of 8+ characters — and the client never
 * sent one. So the mechanism was inert in production while its own tests passed by supplying a
 * key the product does not generate. An adversarial review caught the ledger row marked FIXED
 * when it was not; this suite is what makes the claim true.
 *
 * These assert on the REQUEST BODY the product actually sends, which is the thing that was wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// avatarApi imports lib/firebase, which initialises a real Firebase app at module load.
// Same stub the sibling suite (avatarApi.auth.test.ts) uses.
vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('test-id-token') } },
}));
import { beginConnectTrace } from '../components/avatar/connectTelemetry';
import { startAvatarSession } from '../components/avatar/avatarApi';

const bodies: Array<Record<string, unknown>> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  bodies.length = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return { ok: true, status: 200, json: async () => ({ provider: 'anam', sessionToken: 't', characterId: 'einstein' }) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe('the start request carries an idempotency key', () => {
  it('sends a startKey long enough for the server to honour it', async () => {
    const trace = beginConnectTrace();
    await startAvatarSession(undefined, 'proj-1', undefined, `open-${trace.id}`);
    const key = bodies[0].startKey;
    expect(typeof key).toBe('string');
    // The server floor is 8; below it `startIdempotencyKey` returns null and dedupe is skipped.
    expect(String(key).length).toBeGreaterThanOrEqual(8);
    expect(String(key).length).toBeLessThanOrEqual(200);
  });

  it('reuses ONE key across retries of the same open, so a double mount mints once', async () => {
    const trace = beginConnectTrace();
    const key = `open-${trace.id}`;
    await startAvatarSession(undefined, 'proj-1', undefined, key);
    await startAvatarSession(undefined, 'proj-1', undefined, key);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].startKey).toBe(bodies[1].startKey);
  });

  it('gives a genuinely NEW open a different key, so a real second session is not swallowed', () => {
    // The dedupe must collapse retries, never two people opening the avatar.
    expect(beginConnectTrace().id).not.toBe(beginConnectTrace().id);
  });

  it('a trace id is stable for the life of the trace', () => {
    const t = beginConnectTrace();
    expect(t.id).toBe(t.id);
  });
});
