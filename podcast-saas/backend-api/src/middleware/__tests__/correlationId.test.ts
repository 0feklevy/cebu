/**
 * observability-003 — the request half: one id per request, visible to every line the request
 * emits, echoed to the caller, and never trusted blindly from the caller.
 *
 * Driven against a REAL Fastify instance, because the load-bearing claim is a framework fact: the
 * AsyncLocalStorage scope opened in an `onRequest` hook must still be in effect inside the route
 * handler and inside anything the handler awaits. Asserting that the hook calls `als.run` would
 * prove nothing about that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({ logger: log }));

const { registerCorrelationId, CORRELATION_HEADER } = await import('../correlationId.js');
const { currentCorrelationId } = await import('../../lib/requestContext.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function appWith(handler: () => Promise<unknown> | unknown) {
  const app = Fastify({ logger: false });
  registerCorrelationId(app);
  app.get('/thing/:id', async () => handler());
  app.get('/health', async () => handler());
  app.get('/health/ready', async () => handler());
  await app.ready();
  return app;
}

beforeEach(() => { log.info.mockClear(); log.warn.mockClear(); log.error.mockClear(); log.debug.mockClear(); });

describe('per-request correlation id', () => {
  it('is visible inside the handler without the handler being passed anything', async () => {
    let seen: string | undefined;
    const app = await appWith(async () => {
      seen = currentCorrelationId();
      return { ok: true };
    });
    const res = await app.inject({ method: 'GET', url: '/thing/1' });
    expect(res.statusCode).toBe(200);
    expect(seen, 'the handler ran outside any correlation scope').toMatch(UUID_RE);
    await app.close();
  });

  it('survives awaits and setImmediate inside the handler — the inline job driver depends on it', async () => {
    const seen: Array<string | undefined> = [];
    const app = await appWith(async () => {
      seen.push(currentCorrelationId());
      await new Promise((r) => setTimeout(r, 1));
      seen.push(currentCorrelationId());
      await new Promise<void>((r) => setImmediate(r));
      seen.push(currentCorrelationId());
      return { ok: true };
    });
    await app.inject({ method: 'GET', url: '/thing/1' });
    expect(new Set(seen).size, `ids drifted within one request: ${JSON.stringify(seen)}`).toBe(1);
    expect(seen[0]).toMatch(UUID_RE);
    await app.close();
  });

  it('echoes the id to the caller so a bug report can name it', async () => {
    let seen: string | undefined;
    const app = await appWith(() => { seen = currentCorrelationId(); return { ok: true }; });
    const res = await app.inject({ method: 'GET', url: '/thing/1' });
    expect(res.headers[CORRELATION_HEADER]).toBe(seen);
    await app.close();
  });

  it('gives concurrent requests different ids', async () => {
    const seen: string[] = [];
    const app = await appWith(async () => {
      const id = currentCorrelationId()!;
      await new Promise((r) => setTimeout(r, 5));
      seen.push(id);
      expect(currentCorrelationId()).toBe(id);
      return { ok: true };
    });
    await Promise.all([
      app.inject({ url: '/thing/1' }),
      app.inject({ url: '/thing/2' }),
      app.inject({ url: '/thing/3' }),
    ]);
    expect(new Set(seen).size).toBe(3);
    await app.close();
  });

  it('NEVER adopts a caller-supplied id as its own — the id is minted here', async () => {
    // deploy/nginx/nginx.conf sets neither `X-Request-Id` nor strips it, so this header arrives
    // straight from the public internet. Adopting it hands an attacker the log's join key: pin one
    // value on a flood and every line collapses into a single thread exactly when the log matters
    // most, or reuse a value seen elsewhere and interleave with someone else's request. This is the
    // same class of mistake as `trustProxy: true` (see config/trustProxy.ts) — trusting a
    // caller-chosen value — and the fix costs nothing.
    let seen: string | undefined;
    const app = await appWith(() => { seen = currentCorrelationId(); return { ok: true }; });
    const res = await app.inject({ url: '/thing/1', headers: { 'x-request-id': 'client-abc-123' } });
    expect(seen, 'the caller chose our correlation id').not.toBe('client-abc-123');
    expect(seen).toMatch(UUID_RE);
    expect(res.headers[CORRELATION_HEADER]).toBe(seen);
    await app.close();
  });

  it('still records the caller\'s own id alongside, so a client-side trace joins', async () => {
    const app = await appWith(() => ({ ok: true }));
    await app.inject({ url: '/thing/1', headers: { 'x-request-id': 'client-abc-123' } });
    await app.close();
    const line = log.info.mock.calls.find((c) => String(c[1]).includes('request'));
    const payload = line![0] as Record<string, unknown>;
    expect(payload.clientRequestId, 'the caller-side id is nowhere in the log').toBe('client-abc-123');
    expect(payload.cid).not.toBe('client-abc-123');
  });

  it('drops an inbound id that would forge a log record rather than recording it', async () => {
    const app = await appWith(() => ({ ok: true }));
    const forged = ['evil ', String.fromCharCode(10), 'level=50'].join('');
    await app.inject({ url: '/thing/1', headers: { 'x-correlation-id': forged } });
    await app.inject({ url: '/thing/1', headers: { 'x-request-id': 'x'.repeat(500) } });
    await app.close();
    const serialized = JSON.stringify(log.info.mock.calls);
    expect(serialized, 'a caller-supplied newline reached a log field').not.toContain('level=50');
    expect(serialized).not.toContain('x'.repeat(200));
    for (const call of log.info.mock.calls) {
      expect((call[0] as Record<string, unknown>).clientRequestId).toBeUndefined();
    }
  });

  it('omits clientRequestId entirely when the caller sent none', async () => {
    const app = await appWith(() => ({ ok: true }));
    await app.inject({ url: '/thing/1' });
    await app.close();
    const line = log.info.mock.calls.find((c) => String(c[1]).includes('request'));
    expect(Object.keys(line![0] as Record<string, unknown>)).not.toContain('clientRequestId');
  });
});

describe('request completion line', () => {
  it('logs one line per request with the id, route, status and duration', async () => {
    const app = await appWith(() => ({ ok: true }));
    await app.inject({ url: '/thing/1' });
    await app.close();
    const line = log.info.mock.calls.find((c) => String(c[1]).includes('request'));
    expect(line, 'no request-completion line was logged — nothing joins a request to its job logs').toBeTruthy();
    const payload = line![0] as Record<string, unknown>;
    expect(payload.cid).toMatch(UUID_RE);
    expect(payload.method).toBe('GET');
    expect(payload.statusCode).toBe(200);
    expect(typeof payload.durationMs).toBe('number');
  });

  it('NEVER logs the query string — SSE streams carry the Firebase id token in ?token=', async () => {
    // client-web/components/SectionEditor.tsx puts the caller's id token in the query because
    // EventSource cannot send an Authorization header. A completion line that logged `request.url`
    // would write a live credential to the log on every stream.
    const app = await appWith(() => ({ ok: true }));
    await app.inject({ url: '/thing/1?token=SUPER-SECRET-ID-TOKEN&foo=bar' });
    await app.close();
    const serialized = JSON.stringify(log.info.mock.calls) + JSON.stringify(log.warn.mock.calls);
    expect(serialized, 'the auth token in ?token= reached the logs').not.toContain('SUPER-SECRET-ID-TOKEN');
    const line = log.info.mock.calls.find((c) => String(c[1]).includes('request'));
    // The matched ROUTE pattern, not the concrete path: one aggregate line per endpoint rather
    // than one bucket per resource id.
    expect((line![0] as Record<string, unknown>).path, 'the endpoint should still be logged').toBe('/thing/:id');
  });

  it('strips the query on a request that matched no route either', async () => {
    // The 404 path has no route pattern to fall back to, so this is the branch that would reach
    // for `request.url` — the one that carries the token.
    const app = await appWith(() => ({ ok: true }));
    await app.inject({ url: '/nope/deep?token=SUPER-SECRET-ID-TOKEN' });
    await app.close();
    const line = log.info.mock.calls.find((c) => String(c[1]).includes('request'));
    const payload = line![0] as Record<string, unknown>;
    expect(payload.statusCode).toBe(404);
    expect(payload.path).toBe('/nope/deep');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('SUPER-SECRET-ID-TOKEN');
  });
});

describe('the health poll must not become the loudest thing in the log', () => {
  it('logs /health at debug, not info', async () => {
    // deploy/docker-compose.yml curls /health on a container healthcheck interval, and the
    // platform load balancer polls it too. At info that is thousands of identical lines a day
    // sitting on top of the events this stream exists to make findable.
    const app = await appWith(() => ({ ok: true }));
    await app.inject({ url: '/health' });
    await app.inject({ url: '/health/ready' });
    await app.close();
    expect(log.info, 'every health poll writes an info line').not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(2);
    expect((log.debug.mock.calls[0][0] as Record<string, unknown>).path).toBe('/health');
  });

  it('still shouts when a health poll comes back 5xx', async () => {
    const app = Fastify({ logger: false });
    registerCorrelationId(app);
    app.get('/health', async (_req, reply) => reply.code(503).send({ status: 'degraded' }));
    await app.ready();
    await app.inject({ url: '/health' });
    await app.close();
    expect(log.warn, 'a failing health check was demoted to debug along with the healthy ones').toHaveBeenCalled();
    expect((log.warn.mock.calls[0][0] as Record<string, unknown>).statusCode).toBe(503);
  });

  it('does not quiet a normal route that merely starts with the same letters', async () => {
    const app = Fastify({ logger: false });
    registerCorrelationId(app);
    app.get('/healthcare/:id', async () => ({ ok: true }));
    await app.ready();
    await app.inject({ url: '/healthcare/7' });
    await app.close();
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
