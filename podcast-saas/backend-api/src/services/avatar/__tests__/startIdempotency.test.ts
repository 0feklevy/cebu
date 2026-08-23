/**
 * Idempotency for /avatar/start, keyed the only way that is safe.
 *
 * The thing being deduped is ONE popup opening twice (a double-mounted client asking for a token
 * twice in a row) — not "two requests that happen to describe the same video". So the key is a
 * value the CLIENT generates once per popup open, scoped to the project and the caller. Two
 * viewers, two popups, two projects, or two callers never collide, so they never share a token,
 * which matters because an Anam session token is single-use per stream.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startIdempotencyKey, withStartIdempotency, resetStartIdempotency } from '../startIdempotency.js';

const OPEN_A = 'popup-open-3f7c1b0a-1111';
const OPEN_B = 'popup-open-3f7c1b0a-2222';
const PROJECT = '11111111-2222-4333-8444-555555555555';

describe('startIdempotencyKey — scoping', () => {
  it('is null without a usable client key (so the request always mints fresh)', () => {
    expect(startIdempotencyKey({ projectId: PROJECT, callerId: 'ip-1', startKey: undefined })).toBeNull();
    expect(startIdempotencyKey({ projectId: PROJECT, callerId: 'ip-1', startKey: '' })).toBeNull();
    expect(startIdempotencyKey({ projectId: PROJECT, callerId: 'ip-1', startKey: 'short' })).toBeNull();
    expect(startIdempotencyKey({ projectId: PROJECT, callerId: 'ip-1', startKey: 'x'.repeat(500) })).toBeNull();
    expect(startIdempotencyKey({ projectId: PROJECT, callerId: 'ip-1', startKey: { evil: true } })).toBeNull();
  });

  it('separates different popup opens, callers and projects', () => {
    const base = { projectId: PROJECT, callerId: 'ip-1', startKey: OPEN_A };
    const key = startIdempotencyKey(base)!;
    expect(key).not.toBeNull();
    expect(startIdempotencyKey({ ...base, startKey: OPEN_B })).not.toBe(key);
    expect(startIdempotencyKey({ ...base, callerId: 'ip-2' })).not.toBe(key);
    expect(startIdempotencyKey({ ...base, projectId: '99999999-2222-4333-8444-555555555555' })).not.toBe(key);
    expect(startIdempotencyKey(base)).toBe(key);
  });

  it('does not embed the client key in the derived value', () => {
    expect(startIdempotencyKey({ projectId: PROJECT, callerId: 'ip-1', startKey: OPEN_A })).not.toContain(OPEN_A);
  });
});

describe('withStartIdempotency — single-flight within one popup open', () => {
  beforeEach(() => resetStartIdempotency());
  afterEach(() => vi.restoreAllMocks());

  it('a null key never dedupes', async () => {
    let n = 0;
    const a = await withStartIdempotency(null, async () => ++n);
    const b = await withStartIdempotency(null, async () => ++n);
    expect([a.value, b.value]).toEqual([1, 2]);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
  });

  it('two concurrent calls with the same key share ONE result', async () => {
    const key = startIdempotencyKey({ projectId: PROJECT, callerId: 'ip-1', startKey: OPEN_A });
    let n = 0;
    const [a, b] = await Promise.all([
      withStartIdempotency(key, async () => `tok-${++n}`),
      withStartIdempotency(key, async () => `tok-${++n}`),
    ]);
    expect(n).toBe(1);
    expect(a.value).toBe(b.value);
    expect(a.replayed !== b.replayed).toBe(true);   // exactly one of them is the replay
  });

  it('the 15s fetch retry joins the in-flight mint and its result remains replayable through the 30s watchdog', async () => {
    const key = startIdempotencyKey({ projectId: PROJECT, callerId: 'ip-1', startKey: OPEN_A });
    const startedAt = 1_000_000;
    let now = startedAt;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    let runs = 0;
    let finish!: (token: string) => void;
    const mint = new Promise<string>((resolve) => { finish = resolve; });
    const first = withStartIdempotency(key, async () => {
      runs += 1;
      return mint;
    });

    // AvatarPopup retries the fetch at half of CONNECT_WATCHDOG_MS (30s). This used to land nine
    // seconds after the 6s entry had been swept and start a second mint.
    now = startedAt + 15_000;
    const retry = withStartIdempotency(key, async () => `unexpected-${++runs}`);
    expect(runs).toBe(1);

    finish('tok-one-open');
    const [initial, joined] = await Promise.all([first, retry]);
    expect(initial.value).toBe('tok-one-open');
    expect(joined).toEqual({ value: 'tok-one-open', replayed: true });

    // A response lost after the mint completed can be retried anywhere inside the same watchdog
    // without exchanging the single-use token for a second one.
    now = startedAt + 30_000;
    const replay = await withStartIdempotency(key, async () => `unexpected-${++runs}`);
    expect(replay).toEqual({ value: 'tok-one-open', replayed: true });
    expect(runs).toBe(1);
  });

  it('different keys never share a result', async () => {
    const k1 = startIdempotencyKey({ projectId: PROJECT, callerId: 'viewer-1', startKey: OPEN_A });
    const k2 = startIdempotencyKey({ projectId: PROJECT, callerId: 'viewer-2', startKey: OPEN_A });
    let n = 0;
    const [a, b] = await Promise.all([
      withStartIdempotency(k1, async () => `tok-${++n}`),
      withStartIdempotency(k2, async () => `tok-${++n}`),
    ]);
    expect(a.value).not.toBe(b.value);
    expect(n).toBe(2);
  });

  it('a failed start is never replayed — the retry really retries', async () => {
    const key = startIdempotencyKey({ projectId: PROJECT, callerId: 'ip-1', startKey: OPEN_A });
    await expect(withStartIdempotency(key, async () => { throw new Error('vendor 502'); })).rejects.toThrow('vendor 502');
    const retry = await withStartIdempotency(key, async () => 'tok-after-retry');
    expect(retry.value).toBe('tok-after-retry');
    expect(retry.replayed).toBe(false);
  });
});
