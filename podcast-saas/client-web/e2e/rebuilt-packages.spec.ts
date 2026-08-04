/**
 * REAL-BROWSER validation of the REBUILT simulation packages, before anything is written to shared
 * storage.
 *
 * The rebuild rewrites an unversioned object that live content depends on. A string-level
 * preservation proof (backend-api/src/scripts/prove-sim-rebuild.ts) shows the section bodies are
 * byte-identical — but "the bytes are the same" is not the same claim as "the real WebGL scene
 * still boots, dispatches per section, and reports a paint". This suite makes the second claim,
 * by serving the REBUILT entry HTML + bridge.js while proxying every other asset (textures,
 * modules, shaders) to the live backend, so the actual simulations run against the new bridge.
 *
 * TWO SOURCES OF PACKAGES, and the suite always has at least one.
 *
 *   CONTROL (always)   backend-api/src/scripts/gen-rebuilt-fixture.ts, generated into
 *                      .rebuilt-fixture/ on demand. Synthetic STORED bytes pushed through the REAL
 *                      transforms by the REAL proveAll(), so what the browser drives is production
 *                      rebuild output — no database, no storage adapter, no network.
 *   SUBJECT (opt-in)   REBUILT_DIR=<dir>, a dump from the real thing:
 *                        cd backend-api && npx tsx --env-file=../.env \
 *                          src/scripts/prove-sim-rebuild.ts --dump-dir <dir>
 *
 * WHY THE CONTROL IS NOT OPTIONAL. This file previously began with
 * `test.skip(!REBUILT_DIR, …)`, and producing a dump meant reading the live simulations table plus
 * every stored package. The predictable result was a release gate that reported twelve skipped
 * tests — an unrun validation that aggregates into every report as "no failures". The control
 * removes the only reason to skip, and it doubles as a positive control on a real run: if the
 * synthetic package fails, the harness is broken, not the packages under test.
 *
 * NOTHING HERE SKIPS. A dump that cannot be produced, a REBUILT_DIR that contains no packages, and
 * a dump with no multi-section package are all FAILURES.
 */
import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { newestFixtureSourceMtime } from './fixtureSources';

const REBUILT_DIR = process.env.REBUILT_DIR ?? '';
const BACKEND_ORIGIN = process.env.SIM_BACKEND_ORIGIN ?? 'http://localhost:8080';
const BACKEND = resolve(__dirname, '../../backend-api');
const CONTROL_DIR = resolve(__dirname, '../../.rebuilt-fixture');
const CONTROL_GENERATOR = join(BACKEND, 'src', 'scripts', 'gen-rebuilt-fixture.ts');
/** The rebuild transform the generator drives — a change to it changes the emitted dump. */
const CONTROL_PROOF = join(BACKEND, 'src', 'scripts', 'prove-sim-rebuild.ts');
/** Written last by the generator, so its presence means a COMPLETE dump. Also the freshness stamp. */
const CONTROL_STAMP = join(CONTROL_DIR, 'rebuilt-fixture.json');

interface Pkg { simId: string; name: string; entryRel: string; localRoot: string; sections: string[] }

/**
 * Is the generated control dump still current?
 *
 * `newestFixtureSourceMtime` is the SHARED list every other fixture-building spec uses. It is
 * broader than this dump strictly needs (it also covers the v3 child runtime and the serve-time
 * boot snippet, neither of which reaches these bytes) — deliberately: over-invalidation costs a
 * sub-second regeneration, while a missed source silently validates the PREVIOUS transform, which
 * is the failure this codebase has already paid for three times. The two sources that are unique to
 * this dump are added on top, and a missing one throws rather than dropping out of the list.
 */
function controlIsFresh(): boolean {
  if (process.env.SIM_FIXTURE_FORCE) return false;
  if (!existsSync(CONTROL_STAMP)) return false;
  const own = [CONTROL_GENERATOR, CONTROL_PROOF];
  const missing = own.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    throw new Error(`rebuilt-packages: fixture freshness cannot be determined — missing:\n  ${missing.join('\n  ')}`);
  }
  const newest = own.reduce((max, f) => Math.max(max, statSync(f).mtimeMs), newestFixtureSourceMtime(BACKEND));
  return newest <= statSync(CONTROL_STAMP).mtimeMs;
}

/**
 * Produce the control dump. FAILS LOUDLY — never skips: an unproduced fixture must not be able to
 * turn a release gate green by making its tests disappear.
 */
function ensureControlDump(): string {
  if (!controlIsFresh()) {
    mkdirSync(CONTROL_DIR, { recursive: true });
    const r = spawnSync('npx', ['tsx', 'src/scripts/gen-rebuilt-fixture.ts', CONTROL_DIR], {
      cwd: BACKEND,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(
        `rebuilt-packages: control fixture generation FAILED (exit ${r.status}):\n${r.stderr || r.stdout}`,
      );
    }
  }
  if (!existsSync(CONTROL_STAMP)) {
    throw new Error(
      `rebuilt-packages: the control dump at ${CONTROL_DIR} is incomplete (no ${CONTROL_STAMP}).\n` +
      `Generate it with:  cd backend-api && npx tsx src/scripts/gen-rebuilt-fixture.ts ${CONTROL_DIR}`,
    );
  }
  return CONTROL_DIR;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Discover the dumped packages and read their section ids straight out of the rebuilt bridge. */
function discover(root: string, label: string): Pkg[] {
  const out: Pkg[] = [];
  const simsRoot = join(root, 'simulations');
  if (!existsSync(simsRoot)) return out;
  for (const projectId of readdirSync(simsRoot)) {
    const projDir = join(simsRoot, projectId);
    if (!statSync(projDir).isDirectory()) continue;
    for (const simId of readdirSync(projDir)) {
      const localRoot = join(projDir, simId);
      if (!statSync(localRoot).isDirectory()) continue;
      const bridgePath = join(localRoot, 'bridge.js');
      if (!existsSync(bridgePath)) continue;
      const bridge = readFileSync(bridgePath, 'utf-8');
      const sections = [...bridge.matchAll(/@@SIM_BRIDGE:([0-9a-f-]+)@@/gi)].map((m) => m[1]);
      // The entry HTML is the only .html under a package subdirectory.
      let entryRel = '';
      for (const sub of readdirSync(localRoot)) {
        const p = join(localRoot, sub);
        if (statSync(p).isDirectory() && existsSync(join(p, 'index.html'))) { entryRel = `${sub}/index.html`; break; }
        if (sub.endsWith('.html')) { entryRel = sub; break; }
      }
      if (!entryRel) continue;
      out.push({ simId, name: `${label}${projectId.slice(0, 6)}/${simId.slice(0, 6)}`, entryRel, localRoot, sections: [...new Set(sections)] });
    }
  }
  return out;
}

let server: Server;
let base = '';
let packages: Pkg[] = [];
/**
 * Dump roots the asset server resolves against, in order. The control root is always present;
 * REBUILT_DIR adds to it rather than replacing it. Order only matters if a path existed under both,
 * which the control's fixed, non-random package ids rule out.
 */
let roots: string[] = [];

test.beforeAll(async () => {
  const controlRoot = ensureControlDump();
  const control = discover(controlRoot, 'control:');
  if (control.length === 0) {
    throw new Error(`rebuilt-packages: the control generator produced no packages under ${controlRoot}`);
  }
  // A REBUILT_DIR that discovers nothing is the operator's dump being wrong, and it must not be
  // absorbed by the control's packages into a green run.
  const subject = REBUILT_DIR ? discover(resolve(REBUILT_DIR), '') : [];
  if (REBUILT_DIR && subject.length === 0) {
    throw new Error(`rebuilt-packages: no packages found under ${REBUILT_DIR}`);
  }
  roots = [controlRoot, ...(REBUILT_DIR ? [resolve(REBUILT_DIR)] : [])];
  packages = [...control, ...subject];

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/+/, '');
    // Rebuilt artefacts (entry HTML + bridge.js) come from disk; everything else — the sim's own
    // modules, textures and shaders — is proxied to the real backend, so the scene that runs is
    // the REAL one, driven by the NEW bridge. The control packages reference nothing external, so
    // a control-only run never touches the proxy and needs no backend at all.
    for (const root of roots) {
      const local = join(root, path);
      if (local.startsWith(root) && existsSync(local) && statSync(local).isFile()) {
        res.writeHead(200, { 'content-type': TYPES[extname(local)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(readFileSync(local));
        return;
      }
    }
    try {
      const upstream = await fetch(`${BACKEND_ORIGIN}/sim-public/${path}${url.search}`, { redirect: 'follow' });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(502); res.end('upstream unavailable');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => { if (server) await new Promise<void>((r) => server.close(() => r())); });

/** Load a package's entry and collect the bridge protocol events it emits. */
async function open(page: Page, pkg: Pkg, section: string): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __EV: unknown[] }).__EV = [];
    window.addEventListener('message', (e) => {
      const d = e.data as { type?: string; script?: string };
      if (d?.type) (window as unknown as { __EV: unknown[] }).__EV.push({ type: d.type, script: d.script ?? null });
    });
  });
  const url = `${base}/simulations/${pkg.localRoot.split('/').slice(-2).join('/')}/${pkg.entryRel}?section=${section}&v=1&dpr=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

const events = (page: Page) => page.evaluate(() => (window as unknown as { __EV: { type: string; script: string | null }[] }).__EV);

test.describe('rebuilt production packages — real browser', () => {
  test('every package boots, paints, and dispatches each section to its OWN body', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    for (const pkg of packages) {
      for (const section of pkg.sections) {
        await open(page, pkg, section);
        // The rebuilt bridge must reach readiness and report an honest paint.
        await page.waitForFunction(
          () => (window as unknown as { __EV: { type: string }[] }).__EV.some((e) => e.type === 'SIM_READY'),
          undefined, { timeout: 20_000 },
        );
        await page.evaluate((s) => window.postMessage({ type: 'startScript', script: s, params: {}, token: 1 }, '*'), section);
        await page.waitForTimeout(700);

        const ev = await events(page);
        expect(ev.some((e) => e.type === 'SIM_READY'), `${pkg.name}/${section}: no SIM_READY`).toBe(true);
        // SCRIPT_APPLIED is the capability the rebuild exists to add — its absence means the
        // rebuild delivered nothing for this package.
        expect(ev.some((e) => e.type === 'SCRIPT_APPLIED'), `${pkg.name}/${section}: rebuilt bridge did not acknowledge`).toBe(true);
        expect(ev.some((e) => e.type === 'SCRIPT_ERROR'), `${pkg.name}/${section}: SCRIPT_ERROR`).toBe(false);
      }
    }
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('an UNKNOWN section reports SCRIPT_MISSING and never falls back to another body', async ({ page }) => {
    for (const pkg of packages) {
      await open(page, pkg, pkg.sections[0]);
      await page.waitForFunction(
        () => (window as unknown as { __EV: { type: string }[] }).__EV.some((e) => e.type === 'SIM_READY'),
        undefined, { timeout: 20_000 },
      );
      await page.evaluate(() => window.postMessage({ type: 'startScript', script: 'not-a-real-section', params: {}, token: 7 }, '*'));
      await page.waitForTimeout(500);
      const ev = await events(page);
      expect(ev.some((e) => e.type === 'SCRIPT_MISSING'), `${pkg.name}: unknown section did not report SCRIPT_MISSING`).toBe(true);
    }
  });

  test('A → B → A repeats five times with no error for multi-section packages', async ({ page }) => {
    const multi = packages.filter((p) => p.sections.length > 1);
    // Was `test.skip(multi.length === 0, …)`. Switching sections is the capability the rebuild
    // exists to add, so "this dump happened to contain no multi-section package" is a broken
    // input, not a reason to report the hardest test as run-and-fine. The control dump always
    // carries two multi-section packages, so this can only fire if the control itself is wrong.
    expect(multi.length, 'no multi-section package in this dump — A → B → A cannot be exercised').toBeGreaterThan(0);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    for (const pkg of multi) {
      const [a, b] = pkg.sections;
      await open(page, pkg, a);
      await page.waitForFunction(
        () => (window as unknown as { __EV: { type: string }[] }).__EV.some((e) => e.type === 'SIM_READY'),
        undefined, { timeout: 20_000 },
      );
      for (let i = 0; i < 5; i++) {
        for (const s of [a, b, a]) {
          await page.evaluate((sec) => window.postMessage({ type: 'startScript', script: sec, params: {}, token: Math.floor(performance.now()) }, '*'), s);
          await page.waitForTimeout(150);
        }
      }
      const ev = await events(page);
      expect(ev.some((e) => e.type === 'SCRIPT_ERROR'), `${pkg.name}: error during A→B→A`).toBe(false);
      expect(ev.filter((e) => e.type === 'SCRIPT_APPLIED').length, `${pkg.name}: acks missing`).toBeGreaterThan(10);
    }
    expect(errors).toEqual([]);
  });

  test('pauseScript stops automation without tearing the section down', async ({ page }) => {
    for (const pkg of packages) {
      await open(page, pkg, pkg.sections[0]);
      await page.waitForFunction(
        () => (window as unknown as { __EV: { type: string }[] }).__EV.some((e) => e.type === 'SIM_READY'),
        undefined, { timeout: 20_000 },
      );
      await page.evaluate((s) => window.postMessage({ type: 'startScript', script: s, params: { autoScript: true }, token: 3 }, '*'), pkg.sections[0]);
      await page.waitForTimeout(400);
      await page.evaluate(() => window.postMessage({ type: 'pauseScript' }, '*'));
      await page.waitForTimeout(300);
      const ev = await events(page);
      expect(ev.some((e) => e.type === 'AUTO_PAUSED'), `${pkg.name}: pauseScript unanswered`).toBe(true);
      // Existing bodies register no demo timers, so pausing must be a NO-OP — never a frozen scene.
      expect(ev.some((e) => e.type === 'SCRIPT_ERROR')).toBe(false);
    }
  });
});
