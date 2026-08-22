/**
 * EVERY ROUTE THE SERVER REGISTERS, ACTUALLY REGISTERED.
 *
 * `audioEdition.controller.ts` shipped `GET`/`POST` on `/api/v1/projects/:id/audio`, which
 * `audio.controller.ts` already owned — the timeline audio feature, a different thing that happens
 * to share an obvious noun. Fastify throws `FST_ERR_DUPLICATED_ROUTE` at registration, so the
 * backend could not boot at all. It reached `main`.
 *
 * NOTHING IN THE SUITE COULD SEE IT. Every controller test mocks the Fastify instance — which is
 * right for testing a handler and blind to this by construction. `release:verify` typechecks,
 * lints, tests and builds production bundles without ever starting a server. The only check that
 * would have caught it is the candidate-image gate, which boots the real image, and it had not yet
 * run successfully.
 *
 * So this registers the controllers against a REAL Fastify instance. It needs no database and no
 * network: the duplicate check happens when the route is declared, which is the whole point.
 */
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';

// The controllers pull in the db and auth modules at import time. Stubbing them keeps this a
// ROUTING test — the thing under test is the route table, not what the handlers do.
vi.mock('../db/index.js', () => ({
  db: { query: new Proxy({}, { get: () => ({ findFirst: async () => null, findMany: async () => [] }) }) },
}));
vi.mock('../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: vi.fn(),
  firebaseAuthOptionalMiddleware: vi.fn(),
}));
vi.mock('../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ getPresignedDownloadUrl: async () => 'https://x', uploadFile: async () => 'k' }),
}));

describe('no two controllers claim the same route', () => {
  it('registers the audio controllers together without a duplicate', async () => {
    // The exact pair that collided. Kept as a named case as well as in the sweep below, because a
    // sweep that silently stops covering something is worse than a test that names it.
    const app = Fastify({ logger: false });
    const { registerAudioRoutes } = await import('../controllers/v1/audio.controller.js');
    const { registerAudioEditionRoutes } = await import('../controllers/v1/audioEdition.controller.js');

    await registerAudioRoutes(app as never);
    await expect(
      registerAudioEditionRoutes(app as never),
      'the audio-edition routes collide with the timeline audio routes — the server cannot boot',
    ).resolves.not.toThrow();
    await app.close();
  });

  it('the audio-edition routes live under their own path', async () => {
    // `/audio` belongs to the timeline feature. This asserts the SEPARATION rather than merely
    // the absence of a throw, so a future move back onto `/audio` fails here with a reason
    // instead of failing at boot in production.
    const app = Fastify({ logger: false });
    const { registerAudioEditionRoutes } = await import('../controllers/v1/audioEdition.controller.js');
    await registerAudioEditionRoutes(app as never);
    await app.ready();

    const table = app.printRoutes({ commonPrefix: false });
    expect(table).toContain('audio-edition');
    // No route may sit at exactly `/api/v1/projects/:id/audio` — the parent path is spoken for.
    expect(table).not.toMatch(/\/api\/v1\/projects\/:id\/audio\s*\(/);
    await app.close();
  });
});

describe('no route is declared twice ANYWHERE', () => {
  /**
   * The pairwise test above covers the two controllers that actually collided. This covers every
   * other pair without registering anything.
   *
   * Booting the whole server in a unit test would need every controller's imports stubbed, which
   * is a lot of mocking for one property — and mocks are how the original bug stayed invisible.
   * The routes here are string literals, so reading them is enough, and it is enough EARLIER:
   * this fails in CI, while the candidate-image gate (which boots the real image and is the only
   * other thing that catches this) fails after a full build.
   */
  const CONTROLLERS = join(new URL('.', import.meta.url).pathname, '..', 'controllers');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__tests__') out.push(...walk(full));
      } else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('every (method, path) pair is registered exactly once', () => {
    const seen = new Map<string, string[]>();
    for (const file of walk(CONTROLLERS)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      let method: string | null = null;
      lines.forEach((line, i) => {
        const m = /app\.(get|post|put|patch|delete)\b/.exec(line);
        if (m) method = m[1].toUpperCase();
        const p = /^\s*'(\/api\/[^']+)',\s*$/.exec(line);
        if (p && method) {
          const key = `${method} ${p[1]}`;
          seen.set(key, [...(seen.get(key) ?? []), `${file.split('/').pop()}:${i + 1}`]);
          method = null;
        }
      });
    }

    const dupes = [...seen.entries()].filter(([, where]) => where.length > 1);
    expect(
      dupes.map(([k, w]) => `${k} — ${w.join(' and ')}`),
      'these routes are declared more than once; Fastify refuses to start on a duplicate',
    ).toEqual([]);

    // A scan that found nothing because the pattern stopped matching would pass silently. This is
    // the same failure the whole file exists to prevent, one level up.
    expect(seen.size, 'the route scan matched nothing — its pattern has drifted').toBeGreaterThan(150);
  });
});
