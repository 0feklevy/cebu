/**
 * Serve-time injection: the LOCAL-DISK branch, and its parity with the cloud branch.
 *
 * WHY THIS FILE EXISTS. `sim-public.controller.ts:207-211` carries this comment:
 *
 *     PARITY (audited divergence): entry HTML must get the same serve-time boot-snippet
 *     transform as the cloud path — the local early-return skipped it, so minimal-UI
 *     sims flashed their full UI ONLY in local dev, hiding the exact bug the snippet
 *     exists to kill.
 *
 * The divergence was found and fixed. Nothing guards it. `sim-public.test.ts` mocks the storage
 * adapter with a plain object specifically so that `storage instanceof LocalStorageAdapter` is
 * false and the CLOUD path runs — so the local branch, and the parity between the two, had no
 * test at all. A bug that was fixed without a regression test is a bug with a scheduled return
 * date, and this one is invisible in CI by construction: it only ever appears in local dev.
 *
 * PHASE 0 RELEVANCE (`md-files/ADR-ACTION-RECORDING-SEMANTICS.md` §6.3). The action-recording
 * design puts an authoring bootstrap through this exact injection point, and its whole reason for
 * choosing serve time over publication time is that an ALREADY-STORED revision then gains the
 * capability with no rebuild and no change to its stored bytes. That claim needs to be true on
 * both storage paths, and it needs to keep being true. This file is the Phase-0 proof of it:
 *
 *   - a legacy-shaped stored document — no gate, no snippet, old inline bridge, i.e. what an old
 *     revision's bytes actually look like — is transformed on the way out;
 *   - the bytes ON DISK are untouched, so the transform is genuinely serve-time;
 *   - both branches produce byte-identical HTML for identical stored input.
 *
 * `LOCAL_STORAGE_DIR` is read once, at module load of `localStoragePaths.ts`, so it is set before
 * any import here — hence the dynamic imports in `beforeAll` rather than static ones at the top.
 *
 * MUTATION-PROVEN, 2026-08-25. The audited bug was reinstated — the local branch's
 * `injectSimBootSnippet(raw)` replaced with `raw` — and the suites were re-run:
 *
 *   this file            →  2 failed (local injection, and parity)
 *   sim-public.test.ts   →  24 passed, ALL GREEN
 *
 * which is the whole point: the existing suite cannot see this regression, because its storage
 * mock is deliberately shaped to take the other branch.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// ── The adapter the controller sees, switchable per app ───────────────────────

const mocks = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock('../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => mocks.current,
}));

// Keep the SimulationService graph (db, LLM SDKs) out of a controller unit test, exactly as
// sim-public.test.ts does. Only the content-type map is reached from this route.
vi.mock('../../services/simulation/SimulationService.js', () => ({
  getSimulationContentType: (path: string) =>
    (path.endsWith('.html') || path.endsWith('.htm')) ? 'text/html; charset=utf-8' : 'application/octet-stream',
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const KEY = 'simulations/proj-legacy/sim-legacy/index.html';

/**
 * A document shaped like an OLD stored revision: no rAF gate, no boot snippet, and the pre-v2.1
 * inline bridge. Nothing about it has been regenerated. If serve-time injection reaches this, it
 * reaches anything already in the bucket.
 */
const LEGACY_STORED_HTML = [
  '<!doctype html>',
  '<html>',
  '<head><title>an old sim</title></head>',
  '<body>',
  '  <div class="controls">FULL UI</div>',
  '  <input type="range" id="speed" min="0" max="10" value="3">',
  '  <script>/* sim-bridge v2 (inline, pre-2.1) */ window.startScript = function () {};</script>',
  '</body>',
  '</html>',
].join('\n');

let baseDir = '';
let localApp: FastifyInstance;
let cloudApp: FastifyInstance;
let injectSimBootSnippet: (html: string) => string;
let LocalStorageAdapter: new () => unknown;

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'sim-public-parity-'));
  process.env.LOCAL_STORAGE_DIR = baseDir;

  const onDisk = join(baseDir, KEY);
  mkdirSync(dirname(onDisk), { recursive: true });
  writeFileSync(onDisk, LEGACY_STORED_HTML, 'utf8');

  // Imported AFTER LOCAL_STORAGE_DIR is set — localStoragePaths.ts resolves it at module load.
  const controller = await import('../sim-public.controller.js');
  injectSimBootSnippet = controller.injectSimBootSnippet;
  ({ LocalStorageAdapter } = await import('../../services/storage/LocalStorageAdapter.js'));

  const build = async (adapter: unknown): Promise<FastifyInstance> => {
    mocks.current = adapter;
    const app = Fastify();
    await controller.registerSimPublicRoutes(app);
    await app.ready();
    return app;
  };

  // The local branch is selected by `storage instanceof LocalStorageAdapter` — so this has to be
  // a real instance, not a shape. The constructor refuses to run in production; NODE_ENV is
  // `test` here, which is the same refusal the real dev path relies on.
  localApp = await build(new LocalStorageAdapter());
  // A plain object fails the instanceof and takes the cloud path, as sim-public.test.ts does.
  cloudApp = await build({
    readObject: async () => Buffer.from(LEGACY_STORED_HTML, 'utf8'),
    getPublicUrl: (k: string) => `https://cdn.example.test/${k}`,
  });
});

afterAll(async () => {
  await localApp?.close();
  await cloudApp?.close();
  if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  delete process.env.LOCAL_STORAGE_DIR;
});

/** Both apps share one mocked adapter slot, so point it at the right one before each request. */
async function serve(which: 'local' | 'cloud'): Promise<string> {
  if (which === 'local') {
    mocks.current = new LocalStorageAdapter();
    const res = await localApp.inject({ method: 'GET', url: `/sim-public/${KEY}` });
    expect(res.statusCode, 'local branch must serve the document').toBe(200);
    return res.body;
  }
  mocks.current = {
    readObject: async () => Buffer.from(LEGACY_STORED_HTML, 'utf8'),
    getPublicUrl: (k: string) => `https://cdn.example.test/${k}`,
  };
  const res = await cloudApp.inject({ method: 'GET', url: `/sim-public/${KEY}` });
  expect(res.statusCode, 'cloud branch must serve the document').toBe(200);
  return res.body;
}

describe('serve-time injection reaches an already-stored revision', () => {
  it('the local-disk branch injects the boot snippet into legacy entry HTML', async () => {
    const body = await serve('local');
    expect(LEGACY_STORED_HTML).not.toContain('data-simboot');   // it was not there to begin with
    expect(body).toContain('data-simboot');
    expect(body).toContain('__simBootHide');
  });

  it('the cloud branch does the same', async () => {
    const body = await serve('cloud');
    expect(body).toContain('data-simboot');
  });

  it('PARITY: both branches return byte-identical HTML for identical stored bytes', async () => {
    // The assertion the audited divergence needed and never got. Comparing the two RESPONSES,
    // not each against the helper, is what makes it a parity test: a future change that alters
    // one branch's transform fails here even if that change is internally consistent.
    expect(await serve('local')).toBe(await serve('cloud'));
  });

  it('the transform is serve-time only — the stored bytes are untouched', async () => {
    await serve('local');
    await serve('local');
    // This is the property the whole serve-time-bootstrap decision rests on: an old revision
    // gains the capability with no rebuild, and its immutable bytes stay exactly as published.
    expect(readFileSync(join(baseDir, KEY), 'utf8')).toBe(LEGACY_STORED_HTML);
  });

  it('injection is idempotent, so a second capability can be added beside it later', async () => {
    // The authoring bootstrap will be a SECOND serve-time injection at this same point. That
    // composes only if each transform is a no-op on its own output.
    const once = injectSimBootSnippet(LEGACY_STORED_HTML);
    expect(injectSimBootSnippet(once)).toBe(once);
    expect(once.split('data-simboot').length - 1).toBe(1);
  });

  it('the sim\'s own markup survives intact — injection adds, it does not rewrite', async () => {
    const body = await serve('local');
    expect(body).toContain('<input type="range" id="speed" min="0" max="10" value="3">');
    expect(body).toContain('/* sim-bridge v2 (inline, pre-2.1) */');
    expect(body).toContain('<title>an old sim</title>');
  });
});
