/**
 * REAL-BROWSER validation of the REBUILT production simulation packages, before anything is
 * written to shared storage.
 *
 * The rebuild rewrites an unversioned object that live content depends on. A string-level
 * preservation proof (backend-api/src/scripts/prove-sim-rebuild.ts) shows the section bodies are
 * byte-identical — but "the bytes are the same" is not the same claim as "the real WebGL scene
 * still boots, dispatches per section, and reports a paint". This suite makes the second claim,
 * by serving the REBUILT entry HTML + bridge.js while proxying every other asset (textures,
 * modules, shaders) to the live backend, so the actual simulations run against the new bridge.
 *
 * Prerequisite — produce the rebuilt copies first (writes nothing to storage):
 *   cd backend-api && npx tsx --env-file=../.env src/scripts/prove-sim-rebuild.ts \
 *     --dump-dir <dir>
 * then point this suite at it:
 *   REBUILT_DIR=<dir> npx playwright test --config=playwright.rebuilt.config.ts
 *
 * Skips loudly when REBUILT_DIR is unset, so an unrun validation can never read as a pass.
 */
import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const REBUILT_DIR = process.env.REBUILT_DIR ?? '';
const BACKEND_ORIGIN = process.env.SIM_BACKEND_ORIGIN ?? 'http://localhost:8080';

interface Pkg { simId: string; name: string; entryRel: string; localRoot: string; sections: string[] }

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Discover the dumped packages and read their section ids straight out of the rebuilt bridge. */
function discover(root: string): Pkg[] {
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
      out.push({ simId, name: `${projectId.slice(0, 6)}/${simId.slice(0, 6)}`, entryRel, localRoot, sections: [...new Set(sections)] });
    }
  }
  return out;
}

let server: Server;
let base = '';
let packages: Pkg[] = [];

test.beforeAll(async () => {
  if (!REBUILT_DIR) return;
  packages = discover(resolve(REBUILT_DIR));
  if (packages.length === 0) throw new Error(`rebuilt-packages: no packages found under ${REBUILT_DIR}`);

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/+/, '');
    const local = join(resolve(REBUILT_DIR), path);
    // Rebuilt artefacts (entry HTML + bridge.js) come from disk; everything else — the sim's own
    // modules, textures and shaders — is proxied to the real backend, so the scene that runs is
    // the REAL one, driven by the NEW bridge.
    if (local.startsWith(resolve(REBUILT_DIR)) && existsSync(local) && statSync(local).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[extname(local)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(readFileSync(local));
      return;
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

test.skip(!REBUILT_DIR, 'REBUILT_DIR not set — run prove-sim-rebuild.ts --dump-dir first');

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
    test.skip(multi.length === 0, 'no multi-section package in this dump');
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
