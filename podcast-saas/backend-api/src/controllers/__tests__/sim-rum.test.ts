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

import { registerSimRumRoutes } from '../sim-rum.controller.js';
import { SIM_RUM_VERSION } from 'shared/src/sim/rumEvents';

async function app() {
  const f = Fastify();
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

beforeEach(() => { vi.clearAllMocks(); h.ingest.mockResolvedValue({ stored: 1 }); });

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
