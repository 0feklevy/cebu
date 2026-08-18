/**
 * The two failure paths that logged NOTHING (observability-001).
 *
 * THE MECHANISM
 * `server.ts` builds Fastify with `logger: false` — deliberately, so the app logs through the
 * shared pino instance in `lib/logger.ts` rather than Fastify's own. With logging disabled,
 * Fastify does not give the request a logger that writes somewhere quieter; it installs
 * `abstract-logging`, whose every method is literally `function noop () {}`. So
 * `request.log.error(...)` is not "a log at a level nobody reads" — it is a function call that
 * does nothing at all, forever, on any transport.
 *
 * Two real 5xx paths were written that way: the thumbnail-prompt enhancer's upstream failure and
 * the project-duplication insert failure. Both deliberately return a GENERIC message to the
 * client so provider detail is not leaked — which makes the server-side log the only place the
 * real cause was ever going to appear, and it was being discarded.
 *
 * This suite pins all three halves:
 *   1. the mechanism — under this app's own Fastify config, `request.log.error` is a no-op;
 *   2. the behaviour — the failure path really does emit through the shared logger;
 *   3. the wiring — no `request.log.*` call is reintroduced anywhere while `logger` stays false.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TRUST_PROXY_HOPS } from '../../../config/trustProxy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', '..');

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  editableProject: vi.fn(),
  enhanceThumbnailPrompt: vi.fn(),
}));

vi.mock('../../../lib/logger.js', () => ({ logger: mocks.logger }));
vi.mock('../../../db/index.js', () => ({
  db: {
    query: { projects: { findFirst: vi.fn(async () => undefined) } },
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
  },
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: vi.fn(async (request: { dbUser?: unknown }) => {
    request.dbUser = { id: 'user-1', email: 'a@b.c', is_anonymous: false };
  }),
  firebaseAuthOptionalMiddleware: vi.fn(async () => {}),
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: mocks.editableProject,
  projectsEditableByWhere: vi.fn(() => undefined),
}));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({ getStorageAdapter: vi.fn(() => ({})) }));
vi.mock('../../../services/storage/uploadWithFallback.js', () => ({ uploadWithFallback: vi.fn() }));
vi.mock('../../../services/storage/deleteWithFallback.js', () => ({
  deleteWithFallback: vi.fn(), deleteWithPrefixFallback: vi.fn(),
}));
vi.mock('../../../services/video/hlsRetention.js', () => ({ deleteHlsRetirementRowsForVideo: vi.fn() }));
vi.mock('../../../services/llm/systemAi.js', () => ({ getOpenAIClient: vi.fn(() => ({})) }));
vi.mock('../../../services/llm/ContentModerationService.js', () => ({ moderateGenerationInput: vi.fn(async () => {}) }));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: vi.fn() }));
vi.mock('../../../services/generateAiThumbnail.js', () => ({
  enhanceThumbnailPrompt: mocks.enhanceThumbnailPrompt,
}));

import { registerProjectRoutes } from '../projects.controller.js';

const PROJECT = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  mocks.logger.error.mockClear();
  mocks.editableProject.mockReset();
  mocks.enhanceThumbnailPrompt.mockReset();
});

describe('the mechanism', () => {
  it('request.log.error IS a no-op under this app`s own Fastify configuration', async () => {
    // Built the way server.ts builds it. If this ever stops being a no-op, the finding is moot
    // and this suite should be revisited — but until then, nothing may route errors through it.
    const app = Fastify({ logger: false, trustProxy: TRUST_PROXY_HOPS });
    let captured: unknown;
    app.get('/probe', async (request) => {
      captured = request.log.error;
      return { ok: true };
    });
    await app.inject({ method: 'GET', url: '/probe' });
    await app.close();

    expect(typeof captured).toBe('function');
    expect(
      String(captured).replace(/\s+/g, ' '),
      'Fastify installs abstract-logging when logging is disabled — this writes nowhere',
    ).toMatch(/function noop \(\) \{ ?\}/);
  });
});

describe('the failure paths actually emit', () => {
  it('logs the real upstream error when enhance-thumbnail-prompt fails', async () => {
    mocks.editableProject.mockResolvedValue({ id: PROJECT });
    mocks.enhanceThumbnailPrompt.mockRejectedValue(new Error('upstream 503 from the image model'));

    const app = Fastify({ logger: false, trustProxy: TRUST_PROXY_HOPS });
    await registerProjectRoutes(app);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/projects/${PROJECT}/enhance-thumbnail-prompt`,
      payload: { prompt: 'a cat' },
    });
    await app.close();

    // The client is told nothing useful ON PURPOSE, which is exactly why the log must exist.
    expect(res.statusCode).toBe(502);
    expect(res.json().message).not.toMatch(/upstream 503/);

    expect(mocks.logger.error, 'the only record of the real cause was discarded').toHaveBeenCalledTimes(1);
    const [payload, message] = mocks.logger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect((payload.err as Error).message).toBe('upstream 503 from the image model');
    expect(payload.projectId).toBe(PROJECT);
    expect(message).toMatch(/enhance-thumbnail-prompt/);
  });
});

describe('the wiring', () => {
  const files = (function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '_archive' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, acc);
      else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) acc.push(full);
    }
    return acc;
  })(SRC);

  it('server.ts still disables Fastify`s own logger — the premise of this suite', () => {
    const code = readFileSync(join(SRC, 'server.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(/logger:\s*false/);
  });

  it('nothing in src routes a log through request.log / reply.log', () => {
    const offenders = files.filter((f) => {
      const code = readFileSync(f, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      return /\b(request|req|reply|res)\.log\.(error|warn|info|debug|fatal|trace)\s*\(/.test(code);
    });
    expect(
      offenders.map((f) => f.slice(SRC.length + 1)),
      'these calls compile, read like logging, and emit nothing — import `logger` instead',
    ).toEqual([]);
  });
});
