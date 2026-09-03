/**
 * Proves the production incident against a REAL Fastify instance and the REAL `@fastify/cors`
 * package — no mocks, no hand-rolled `reply` object standing in for either.
 *
 * Every other test of this fix (`audioEdition.voiceStream.test.ts`, `publicOrigins.test.ts`)
 * checks that `hijackedReplyCorsHeaders()` returns what I believe `@fastify/cors` would have
 * done. That is a test against my own model of the library, and the actual bug — an SSE route
 * shipped to production on 2026-09-03 with no `Access-Control-Allow-Origin` header at all — was
 * ALSO a case where the code looked right against a mental model and was wrong in reality. This
 * file removes that gap: it boots a real `fastify()` app, registers the real `cors` plugin, and
 * asks what actually comes back over `app.inject()`.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hijackedReplyCorsHeaders, browserOrigins } from '../publicOrigins.js';

const ENV = { ...process.env };
beforeEach(() => {
  // The real production shape: ONE allowlist (browserOrigins()) feeds both the cors plugin
  // (registered exactly as server.ts registers it) and the hand-written fix. A test that hands
  // the plugin a hardcoded list different from what the fix reads proves nothing about whether
  // the two agree — which is the only thing this file exists to check.
  process.env.NODE_ENV = 'production';
  process.env.BACKEND_API_URL = 'https://api.flowvidco.com';
  process.env.NEXT_PUBLIC_APP_URL = 'https://flowvidco.com';
  delete process.env.ADMIN_ORIGIN;
});
afterEach(() => { process.env = { ...ENV }; });

async function buildApp(withFix: boolean) {
  const app = Fastify();
  await app.register(cors, { origin: browserOrigins(), credentials: true });
  app.get('/hijacked', async (request, reply) => {
    if (withFix) {
      const h = hijackedReplyCorsHeaders(request.headers.origin);
      for (const [k, v] of Object.entries(h)) reply.raw.setHeader(k, v);
    }
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.hijack();
    reply.raw.writeHead(200);
    reply.raw.end('event: done\ndata: {}\n\n');
  });
  app.get('/normal', async () => ({ ok: true }));
  return app;
}

describe('the production incident, reproduced against a real Fastify + real @fastify/cors', () => {
  it('a NORMAL (non-hijacked) route gets Access-Control-Allow-Origin from the plugin, as a control', async () => {
    const app = await buildApp(false);
    const res = await app.inject({ method: 'GET', url: '/normal', headers: { origin: 'https://flowvidco.com' } });
    expect(res.headers['access-control-allow-origin']).toBe('https://flowvidco.com');
    await app.close();
  });

  it('BEFORE THE FIX: a hijacked route drops the header the plugin computed — this is the incident', async () => {
    const app = await buildApp(false);
    const res = await app.inject({ method: 'GET', url: '/hijacked', headers: { origin: 'https://flowvidco.com' } });
    expect(res.headers['content-type']).toBe('text/event-stream');
    // The plugin ran — it just never got to write what it decided, because hijack() skips the
    // pipeline that would have. This is the exact console error the owner reported in production.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('AFTER THE FIX: the hijacked route carries the same header a normal route would have', async () => {
    const app = await buildApp(true);
    const res = await app.inject({ method: 'GET', url: '/hijacked', headers: { origin: 'https://flowvidco.com' } });
    expect(res.headers['access-control-allow-origin']).toBe('https://flowvidco.com');
    expect(res.headers['content-type']).toBe('text/event-stream');
    await app.close();
  });

  it('AFTER THE FIX: an origin outside the allowlist still gets nothing, hijacked or not', async () => {
    const withFix = await buildApp(true);
    const withoutFix = await buildApp(false);
    const a = await withFix.inject({ method: 'GET', url: '/hijacked', headers: { origin: 'https://evil.example.com' } });
    const b = await withoutFix.inject({ method: 'GET', url: '/normal', headers: { origin: 'https://evil.example.com' } });
    expect(a.headers['access-control-allow-origin']).toBeUndefined();
    expect(b.headers['access-control-allow-origin']).toBeUndefined();
    await withFix.close();
    await withoutFix.close();
  });
});
