/**
 * The RUM ingestion endpoint (Priority 8.9).
 *
 * This route is unauthenticated by necessity — anonymous viewers are most of the traffic, and
 * requiring auth would sample only logged-in users, which is worse than no sample because it looks
 * like data. So every test here is about what a hostile or broken caller can and cannot do, and
 * about the endpoint never becoming a way to hurt the product it measures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const h = vi.hoisted(() => ({
  ingest: vi.fn(async () => ({ stored: 1 })),
  warn: vi.fn(), error: vi.fn(),
}));

vi.mock('../../services/simulation/RumService.js', () => ({ ingestBatch: h.ingest }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: h.warn, error: h.error, debug: vi.fn() },
}));
const rl = vi.hoisted(() => ({ allow: true, calls: [] as string[], args: [] as { max: number; windowMs: number }[] }));
vi.mock('../../lib/rateLimit.js', () => ({
  // The full signature is captured, so a production call with an effectively-infinite limit is
  // visible to the assertions rather than swallowed by a one-argument stub.
  rateLimit: (key: string, max: number, windowMs: number) => {
    rl.calls.push(key); rl.args.push({ max, windowMs }); return rl.allow;
  },
}));

import { registerSimRumRoutes } from '../sim-rum.controller.js';
import { SIM_RUM_VERSION } from 'shared/sim/rumEvents';

async function app() {
  const f = Fastify();
  registerSimRumRoutes(f);
  await f.ready();
  return f;
}

/**
 * The app as PRODUCTION builds it.
 *
 * `server.ts` sets `trustProxy: true`, which makes `request.ip` the leftmost X-Forwarded-For entry
 * — written by the caller. A bare `Fastify()` has it off, so `request.ip` is the socket address and
 * a limiter keyed on it looks perfectly sound. Every spoofing assertion has to run on this one.
 */
async function trustProxyApp() {
  const f = Fastify({ trustProxy: true });
  registerSimRumRoutes(f);
  await f.ready();
  return f;
}

const body = () => ({
  v: SIM_RUM_VERSION, sessionId: 'session-abcdef',
  device: { memoryGb: 8, cores: 8, coarsePointer: false, saveData: false, dpr: 2, poolTier: 'all' },
  events: [{ kind: 'transition', t: 10, packageRevision: 'pkg-abc' }],
  dropped: 0,
});

beforeEach(() => { vi.clearAllMocks(); h.ingest.mockResolvedValue({ stored: 1 }); rl.allow = true; rl.calls.length = 0; rl.args.length = 0; });

describe('POST /sim-rum', () => {
  it('accepts a batch and returns 204 with no body', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/sim-rum', payload: body() });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(h.ingest).toHaveBeenCalledOnce();
  });

  it('returns 204 for a REJECTED batch too', async () => {
    // A client cannot act on a rejection — it has already discarded the events — and distinguishing
    // stored from rejected would hand an attacker a probe for the validator's shape.
    h.ingest.mockResolvedValue({ stored: 0, rejected: 'unknown-version' } as never);
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/sim-rum', payload: { v: 99 } });
    expect(res.statusCode).toBe(204);
    // Operators can see it; viewers cannot.
    expect(h.warn).toHaveBeenCalled();
  });

  it('NEVER 500s when ingestion throws', async () => {
    // A measurement endpoint that can 500 is one that can page someone about data nobody awaits.
    h.ingest.mockRejectedValue(new Error('database on fire'));
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/sim-rum', payload: body() });
    expect(res.statusCode).toBe(204);
    expect(h.error).toHaveBeenCalled();
  });

  it('never caches the response', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/sim-rum', payload: body() });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('allows the cross-origin post the player actually makes', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/sim-rum', payload: body() });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('answers the preflight', async () => {
    const f = await app();
    const res = await f.inject({ method: 'OPTIONS', url: '/sim-rum' });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
    expect(String(res.headers['access-control-allow-headers'])).toContain('content-type');
  });

  it('refuses an oversized body before parsing it', async () => {
    // The bound has to be enforced before allocation, or a hostile caller can make us allocate it.
    const f = await app();
    const huge = { ...body(), pad: 'x'.repeat(300 * 1024) };
    const res = await f.inject({ method: 'POST', url: '/sim-rum', payload: huge });
    expect(res.statusCode).toBe(413);
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('does not throw on a malformed JSON body', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST', url: '/sim-rum',
      headers: { 'content-type': 'application/json' }, payload: '{not json',
    });
    // Fastify's own parser rejects this with a 400; the important claim is that nothing 500s.
    expect(res.statusCode).toBeLessThan(500);
  });

  it('passes the body through unread — validation is the service\'s job, not the route\'s', async () => {
    // One validator, in one place. A second one here would be a second definition of what is
    // acceptable, and the two would drift.
    const f = await app();
    await f.inject({ method: 'POST', url: '/sim-rum', payload: body() });
    expect(h.ingest).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-abcdef' }));
  });
});


describe('rate limiting', () => {
  it('is rate limited PER IP, with a real bound', async () => {
    // Unauthenticated, wildcard CORS: without a limit, any page on the internet could drive
    // unbounded durable growth in the same Postgres the player reads from.
    //
    // Asserting only the key PREFIX would pass for one shared global bucket, where a single
    // attacker starves every honest client and nobody is individually limited. Two different
    // callers must produce two different keys.
    const f = await app();
    await f.inject({ method: 'POST', url: '/sim-rum', payload: body(), remoteAddress: '10.0.0.1' });
    await f.inject({ method: 'POST', url: '/sim-rum', payload: body(), remoteAddress: '10.0.0.2' });
    expect(rl.calls).toHaveLength(2);
    expect(rl.calls[0]).toMatch(/^sim-rum:/);
    expect(rl.calls[0], 'one shared bucket for the whole internet').not.toBe(rl.calls[1]);
    // …and the bound is a real one, not an effectively-infinite placeholder.
    expect(rl.args[0]!.max).toBeGreaterThan(0);
    expect(rl.args[0]!.max).toBeLessThan(1000);
    expect(rl.args[0]!.windowMs).toBeGreaterThanOrEqual(1000);
  });

  it('cannot be given a fresh bucket by forging X-Forwarded-For', async () => {
    // THE REGRESSION. With `trustProxy: true` the caller controls `request.ip`, so a limiter keyed
    // on it is not a weaker bound — it is no bound at all: one forged header per request means
    // every request is the first in its own bucket. And every request past the limiter reaches the
    // ingestion gate, which is a database round trip against a pool of ten.
    const f = await trustProxyApp();
    for (const xff of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      await f.inject({
        method: 'POST', url: '/sim-rum', payload: body(),
        remoteAddress: '10.0.0.9', headers: { 'x-forwarded-for': xff },
      });
    }
    expect(rl.calls).toHaveLength(3);
    expect(new Set(rl.calls).size, 'a forged header minted a new rate-limit bucket').toBe(1);
  });

  it('still separates two genuinely different peers behind a proxy', async () => {
    // The other direction: keying on something constant (a fixed string, the proxy's own address)
    // would pass the test above while collapsing the whole internet into one bucket, where a single
    // caller starves every honest client.
    const f = await trustProxyApp();
    await f.inject({
      method: 'POST', url: '/sim-rum', payload: body(),
      remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    await f.inject({
      method: 'POST', url: '/sim-rum', payload: body(),
      remoteAddress: '10.0.0.2', headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    expect(new Set(rl.calls).size).toBe(2);
  });

  it('drops the batch when the limit is exceeded, still answering 204', async () => {
    // 204 either way: the response must not become a probe for the limiter's shape.
    rl.allow = false;
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/sim-rum', payload: body() });
    expect(res.statusCode).toBe(204);
    expect(h.ingest).not.toHaveBeenCalled();
  });
});
