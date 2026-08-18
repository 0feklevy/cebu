/**
 * observability-003 — the correlation id itself.
 *
 * The claim being pinned: every log line emitted while serving one request carries the SAME id,
 * without the emitting code knowing the id exists. That is the only shape that actually joins a
 * controller, a background job and a vendor call, because the vendor helper (`fetchWithRetry`) and
 * the job handlers take no request object and never will.
 *
 * So the mechanism is an AsyncLocalStorage scope plus a pino `mixin`, and this file tests both
 * halves: the scope's propagation rules, and the fact that `logger.ts` is actually wired to read it
 * (a mixin that exists but is not passed to pino is a decorative one).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pinoMock = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  factory: vi.fn((opts: Record<string, unknown>) => {
    pinoMock.calls.push(opts);
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }),
}));

vi.mock('pino', () => ({ default: pinoMock.factory }));

const { runWithCorrelationId, currentCorrelationId, newCorrelationId, sanitizeCorrelationId } =
  await import('../requestContext.js');

describe('correlation scope', () => {
  it('has no id outside a scope', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('exposes the id to everything called inside the scope, however deep', async () => {
    const id = newCorrelationId();
    const seen: Array<string | undefined> = [];
    await runWithCorrelationId(id, async () => {
      seen.push(currentCorrelationId());
      await new Promise((r) => setTimeout(r, 1));
      seen.push(currentCorrelationId());          // survives an await
      await new Promise<void>((r) => setImmediate(r));
      seen.push(currentCorrelationId());          // survives setImmediate — the inline job driver
      await Promise.resolve().then(() => { seen.push(currentCorrelationId()); });
    });
    expect(seen).toEqual([id, id, id, id]);
    expect(currentCorrelationId()).toBeUndefined(); // and does not leak back out
  });

  it('keeps concurrent requests apart', async () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    const [seenA, seenB] = await Promise.all([
      runWithCorrelationId(a, async () => { await new Promise((r) => setTimeout(r, 5)); return currentCorrelationId(); }),
      runWithCorrelationId(b, async () => { await new Promise((r) => setTimeout(r, 1)); return currentCorrelationId(); }),
    ]);
    expect(seenA).toBe(a);
    expect(seenB).toBe(b);
    expect(a).not.toBe(b);
  });

  it('mints distinct ids', () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});

describe('sanitizeCorrelationId', () => {
  it('accepts an inbound id that is plainly an id', () => {
    expect(sanitizeCorrelationId('4f2c9d1e-0a3b-4c5d-8e6f-7a8b9c0d1e2f')).toBe('4f2c9d1e-0a3b-4c5d-8e6f-7a8b9c0d1e2f');
    expect(sanitizeCorrelationId('req_abc-123.4:5')).toBe('req_abc-123.4:5');
  });

  it('refuses anything that could forge a log line or bloat it', () => {
    // A caller-supplied header lands in every structured line for the request; newlines and
    // unbounded length are the two ways that becomes an attack rather than a convenience.
    for (const bad of ['a\nb', 'a\r\nb', 'x'.repeat(129), '', ' ', 'has space', '<script>', undefined, null, 42, {}]) {
      expect(sanitizeCorrelationId(bad as unknown), String(bad)).toBeUndefined();
    }
  });
});

describe('logger wiring', () => {
  beforeEach(() => { pinoMock.calls.length = 0; });

  // NOTE: deliberately no `vi.resetModules()`. Resetting gives `logger.js` a FRESH copy of
  // `requestContext.js` — a second AsyncLocalStorage — so the mixin would read a different store
  // than the scope this file opens, and the test would fail while production is correct. The
  // single-instance assumption is the real one: both modules are singletons in the running server.
  it('pino is constructed with a mixin that stamps the current correlation id', async () => {
    await import('../logger.js');
    expect(pinoMock.calls.length, 'logger.ts did not construct pino').toBe(1);
    const opts = pinoMock.calls[0];
    expect(typeof opts.mixin, 'logger.ts passes no mixin — nothing stamps the correlation id').toBe('function');
    const mixin = opts.mixin as () => Record<string, unknown>;
    expect(mixin(), 'a log outside any request must not invent an id').toEqual({});
    const id = newCorrelationId();
    const inside = await runWithCorrelationId(id, async () => mixin());
    expect(inside, 'a log inside a request scope must carry that request id').toEqual({ cid: id });
  });
});
