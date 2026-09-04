/**
 * `GET /sim-authoring.js` — the picker's in-document half, served as static bytes.
 *
 * It is unauthenticated on purpose and that is not a shortcut: the script contains no project
 * data and grants nothing on its own. It is inert until an allowlisted parent transfers it a
 * MessagePort, and the transfer is what carries authority. What this file pins is the serving
 * contract around it — the caching that keeps a deployed editor and its in-document half in
 * agreement, and the kill switch that contains a live problem without a deploy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { registerSimPublicRoutes } from '../sim-public.controller.js';
import { SIM_AUTHORING_SCRIPT } from '../../services/simulation/SimAuthoringBootstrap.js';

vi.mock('../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ readObject: vi.fn(), getPublicUrl: vi.fn() }),
}));
vi.mock('../../services/simulation/SimulationService.js', async (orig) => {
  const actual = await orig<typeof import('../../services/simulation/SimulationService.js')>();
  return { ...actual, getSimulationContentType: () => 'application/octet-stream' };
});
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PATH = '/sim-authoring.js';

async function makeApp() {
  const app = Fastify();
  await registerSimPublicRoutes(app);
  await app.ready();
  return app;
}

const originalFlag = process.env.SIM_AUTHORING_DISABLED;
beforeEach(() => { delete process.env.SIM_AUTHORING_DISABLED; });
afterEach(() => {
  if (originalFlag === undefined) delete process.env.SIM_AUTHORING_DISABLED;
  else process.env.SIM_AUTHORING_DISABLED = originalFlag;
});

describe('serving contract', () => {
  it('serves the script as JavaScript, with the headers a cross-origin frame needs', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: PATH });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.body).toContain('__SIM_AUTHORING_ACTIVE__');
    await app.close();
  });

  it('arrives INTACT for a client that offers Accept-Encoding — i.e. every real browser', async () => {
    // The production bug this pins (2026-09-04): the handler used `reply.compress(Buffer…)`,
    // and any request carrying Accept-Encoding got `content-encoding: br|gzip` with a ZERO-BYTE
    // body. The old serving-contract test above never sent the header, so it stayed green while
    // every browser loaded an empty script, `__SIM_AUTHORING_ADOPT__` never came to exist, every
    // authoring CONNECT timed out, and no poster was ever captured anywhere.
    const app = await makeApp();
    for (const ae of ['br', 'gzip', 'br, gzip, deflate']) {
      const res = await app.inject({ method: 'GET', url: PATH, headers: { 'accept-encoding': ae } });
      expect(res.statusCode).toBe(200);
      const body = res.rawPayload;
      expect(body.length, `Accept-Encoding: ${ae} must not empty the body`).toBeGreaterThan(1000);
      // Served plain (no content-encoding), the bytes ARE the script.
      if (!res.headers['content-encoding']) {
        expect(body.toString('utf8')).toContain('__SIM_AUTHORING_ACTIVE__');
      }
    }
    await app.close();
  });

  it('revalidates rather than caching hard — a stale picker would disagree with its editor', async () => {
    // Deliberately `no-cache` + a strong ETag rather than `immutable`. These bytes change with a
    // deploy, and a year-cached picker talking to a newer editor is the same class of bug as a
    // year-cached entry document — which this route's neighbour was already fixed for.
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: PATH });

    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]{40}"$/);
    await app.close();
  });

  it('answers 304 to a matching If-None-Match, with no body', async () => {
    const app = await makeApp();
    const first = await app.inject({ method: 'GET', url: PATH });
    const etag = first.headers['etag'] as string;

    const second = await app.inject({
      method: 'GET', url: PATH, headers: { 'if-none-match': etag },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    expect(second.headers['etag']).toBe(etag);
    await app.close();
  });

  it('the ETag actually describes the bytes it serves', async () => {
    // An ETag computed over anything else would let a changed script keep an old tag, and every
    // browser holding it would never fetch the new one.
    const { createHash } = await import('node:crypto');
    const expected = `"${createHash('sha1').update(SIM_AUTHORING_SCRIPT).digest('hex')}"`;
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: PATH });
    expect(res.headers['etag']).toBe(expected);
    await app.close();
  });
});

describe('the kill switch', () => {
  it('404s when SIM_AUTHORING_DISABLED=1', async () => {
    // The containment path: one env var takes the capability away from every already-served
    // document, with no migration, no republication and no editor deploy.
    process.env.SIM_AUTHORING_DISABLED = '1';
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: PATH });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('and the boot snippet stops advertising the hook', async () => {
    // Both halves, or the switch is a half-measure: a document that still tried to load a route
    // that 404s would log a failed fetch on every single open.
    const { injectSimBootSnippet, resetSimBootSnippetForTest } =
      await import('../sim-public.controller.js');
    const doc = '<html><head></head><body></body></html>';

    resetSimBootSnippetForTest();
    expect(injectSimBootSnippet(doc)).toContain('/sim-authoring.js');

    process.env.SIM_AUTHORING_DISABLED = '1';
    resetSimBootSnippetForTest();
    const off = injectSimBootSnippet(doc);
    expect(off).not.toContain('/sim-authoring.js');
    expect(off).not.toContain('CONNECT');
    // The boot cloak is untouched — the switch turns off authoring, not minimal UI.
    expect(off).toContain('__simBootHide');
  });
});
