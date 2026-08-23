/**
 * THE REAL END-TO-END PROOF that the pipeline shape is real (task requirement). Opt-in — it needs a
 * browser download — via CAPTURE_REAL=1. It:
 *
 *   1. builds a GENUINELY ANIMATED WebGL sim, wrapped with the REAL `__SIM_RAF_GATE__` extracted
 *      from the on-disk fixture (.sim-fixture/modern) — so the exact document-start-shim-vs-gate
 *      ordering hazard is exercised in a real browser, not a mock;
 *   2. serves it on loopback (as production serves a package, §0.2 shape);
 *   3. drives it with the real PlaywrightScreenshotBackend — real Chrome, the JS virtual clock, the
 *      v2 handshake, per-frame screenshots;
 *   4. asserts real PNG frames land on disk, the count is exactly round(dur×fps), the WebGL renderer
 *      was recorded, and the REAL sanity gate PASSES on the real frames;
 *   5. proves determinism (same configHash ⇒ byte-identical frames) AND seed-dependence (a different
 *      configHash ⇒ different frames, via the seeded Math.random jitter).
 *
 * Playwright is NOT resolvable from backend-api, so it is resolved from client-web's install and the
 * chromium launcher + executable are injected. If the browser or the fixture cannot be found, this
 * test FAILS LOUDLY with what was tried — it never silently skips a requested real run.
 *
 * WHY NOT the .sim-fixture packages directly for the gate PASS: they render a static 10×10 black
 * canvas + a colour-changing div — real v2, but no animated canvas — so they cannot demonstrate the
 * canvas-delta half of the gate. The animated sim below IS a real sim (real gate, real v2 handshake,
 * real WebGL, real rendering); only its scene is authored to actually move, which is the point.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { createHash as sha } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPlaywrightScreenshotBackend, type ChromiumLike } from '../playwrightScreenshotBackend.js';

const ENABLED = process.env.CAPTURE_REAL === '1';
const D = ENABLED ? describe : describe.skip;

const REPO_ROOT = resolve(process.cwd(), '..');
const MODERN_FIXTURE = resolve(REPO_ROOT, '.sim-fixture/modern/index.html');

/** Pull the REAL rAF gate block out of a shipped fixture so we inject production gate bytes. */
function extractRealRafGate(): string {
  if (!existsSync(MODERN_FIXTURE)) {
    throw new Error(
      `CAPTURE_REAL: the fixture ${MODERN_FIXTURE} is missing — needed for the REAL rAF gate bytes.\n` +
        `Generate it:  cd backend-api && npx tsx src/scripts/gen-sim-fixture.ts ../.sim-fixture`,
    );
  }
  const html = readFileSync(MODERN_FIXTURE, 'utf8');
  const m = /<!-- sim-raf-gate v\d+ -->[\s\S]*?<!-- \/sim-raf-gate -->/.exec(html);
  if (!m) throw new Error(`CAPTURE_REAL: could not find the rAF gate block in ${MODERN_FIXTURE}`);
  return m[0];
}

/** A real animated WebGL sim: dark background + a bright rect that MOVES with virtual time, plus a
 *  seeded-random jitter (so the configHash seed provably changes the pixels). Speaks v2. */
function buildAnimatedSimHtml(width: number, height: number): string {
  const gate = extractRealRafGate();
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${gate}
<style>
  html, body { margin: 0; padding: 0; background: #101018; overflow: hidden; }
  #scene { display: block; width: ${width}px; height: ${height}px; }
  .controls { position: fixed; left: 8px; top: 8px; z-index: 9; }
</style>
</head>
<body>
  <div class="controls"><input type="range" min="0" max="100" value="50"></div>
  <canvas id="scene" width="${width}" height="${height}"></canvas>
  <script>
  (function () {
    var canvas = document.getElementById('scene');
    // preserveDrawingBuffer:true so the gate-region can be read back (spec constraint — plan §4).
    var gl = canvas.getContext('webgl', { preserveDrawingBuffer: true }) ||
             canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
    var W = canvas.width, H = canvas.height;
    var jitter = Math.random();               // seeded by the injected PRNG → deterministic per configHash
    function draw(ts) {
      if (!gl) return;
      var t = ts / 1000;
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0.06, 0.06, 0.10, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      var bw = Math.max(8, Math.floor(W * 0.18));
      var x = Math.floor((Math.sin(t * 2.0) * 0.5 + 0.5) * (W - bw)) + Math.floor(jitter * 12);
      if (x < 0) x = 0; if (x > W - bw) x = W - bw;
      gl.scissor(x, Math.floor(H * 0.25), bw, Math.floor(H * 0.5));
      gl.clearColor(0.95, 0.35 + 0.5 * (Math.sin(t * 3.0) * 0.5 + 0.5), 0.15, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
    }
    function loop(ts) { draw(ts); requestAnimationFrame(loop); }
    requestAnimationFrame(loop);              // wrapped by the gate → posts SIM_PAINTED on first frame

    var readyFired = false;
    function fireReady() {
      if (readyFired) return;
      readyFired = true;
      if (window.parent) window.parent.postMessage({ type: 'SIM_READY' }, '*');
    }
    window.addEventListener('message', function (e) {
      var d = (e && e.data) || {};
      if (d.type === 'startScript') {
        if (d.params && d.params.simpleUi) {
          var c = document.querySelector('.controls');
          if (c) c.style.display = 'none';
        }
        if (window.parent) window.parent.postMessage({ type: 'SCRIPT_APPLIED', script: d.script, token: d.token }, '*');
      } else if (d.type === 'PING_SIM_READY') {
        if (window.parent) window.parent.postMessage({ type: 'SIM_READY' }, '*');
      }
    });
    fireReady();
  })();
  </script>
</body>
</html>`;
}

/** Resolve Playwright's chromium from client-web's install and find an EXISTING chromium binary. */
async function resolveChromium(): Promise<{ launcher: ChromiumLike; executablePath: string }> {
  const req = createRequire(resolve(REPO_ROOT, 'client-web/package.json'));
  let pwPath: string;
  try {
    pwPath = req.resolve('@playwright/test');
  } catch {
    pwPath = req.resolve('playwright');
  }
  const pw: any = await import(pathToFileURL(pwPath).href);
  const launcher: ChromiumLike = pw.chromium ?? pw.default?.chromium;
  if (!launcher) throw new Error('CAPTURE_REAL: could not obtain the chromium launcher from Playwright');

  let exe = process.env.PLAYWRIGHT_CHROMIUM_PATH || '';
  if (!exe) {
    try {
      const maybe = (launcher as { executablePath?: () => string }).executablePath;
      exe = maybe ? maybe.call(launcher) : '';
    } catch {
      exe = '';
    }
  }
  if (!exe || !existsSync(exe)) {
    // The pinned revision may not be the one installed — find any installed Chrome-for-Testing.
    const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
    let found = '';
    if (existsSync(cache)) {
      for (const d of readdirSync(cache)) {
        if (!d.startsWith('chromium-') || d.includes('headless')) continue;
        const cand = join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (existsSync(cand)) { found = cand; break; }
      }
    }
    if (!found) {
      throw new Error(
        `CAPTURE_REAL: no usable Chromium executable found. Tried Playwright's executablePath ("${exe}") and ` +
          `the ms-playwright cache at ${cache}. Install one: (cd client-web && npx playwright install chromium), ` +
          `or set PLAYWRIGHT_CHROMIUM_PATH.`,
      );
    }
    exe = found;
  }
  return { launcher, executablePath: exe };
}

const hashFile = (p: string): string => sha('sha256').update(readFileSync(p)).digest('hex');

async function frameHashes(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.png')).sort();
  return names.map((n) => hashFile(join(dir, n)));
}

D('PlaywrightScreenshotBackend — real capture', () => {
  const WIDTH = 200;
  const HEIGHT = 150;
  const FPS = 30;
  const DUR = 0.5; // 15 frames
  let server: Server;
  let origin = '';
  const cleanupDirs: string[] = [];
  let chromium: { launcher: ChromiumLike; executablePath: string };

  beforeAll(async () => {
    chromium = await resolveChromium();
    const body = Buffer.from(buildAnimatedSimHtml(WIDTH, HEIGHT), 'utf8');
    server = createServer((req, res) => {
      const path = (req.url || '/').split('?')[0].split('#')[0];
      if (path === '/index.html' || path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-cache' });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    for (const d of cleanupDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  });

  const capture = async (configHash: string, simpleUi = true) => {
    const backend = createPlaywrightScreenshotBackend({
      launcher: chromium.launcher,
      executablePath: chromium.executablePath,
      headless: true,
      keepFrames: true,
    });
    const result = await backend.captureSection({
      servedSimUrl: `${origin}/index.html?section=demo&v=1#simboot=%7B%22hide%22%3A%5B%5D%7D`,
      sectionId: 'demo',
      simpleUi,
      autoScript: true,
      uiHide: simpleUi ? ['.controls'] : [],
      durationSec: DUR,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      configHash,
      posterKey: 'poster/demo',
    });
    if (result.framesDir) cleanupDirs.push(result.framesDir);
    return result;
  };

  it('renders a real sim, emits exactly round(dur×fps) PNG frames, and the sanity gate PASSES', async () => {
    const result = await capture('config-hash-alpha');

    expect(result.frameCount).toBe(Math.round(DUR * FPS)); // 15
    expect(result.framesDir).toBeTruthy();

    const names = (await readdir(result.framesDir!)).filter((n) => n.endsWith('.png'));
    expect(names.length).toBe(result.frameCount);
    // Frames are real, non-trivial PNGs.
    const firstPng = readFileSync(join(result.framesDir!, names.sort()[0]));
    expect(firstPng.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(firstPng.length).toBeGreaterThan(200);

    expect(result.rendererString.length).toBeGreaterThan(0); // WebGL context + renderer recorded
    expect(result.gate).toBe('passed');
    expect(result.reason).toBeUndefined();
    console.log(`[CAPTURE_REAL] gate=${result.gate} renderer="${result.rendererString}" frames=${result.frameCount}`);
  }, 120_000);

  it('is deterministic (same configHash ⇒ byte-identical frames) and seed-dependent (different ⇒ different)', async () => {
    const a1 = await capture('config-hash-repeat');
    const a2 = await capture('config-hash-repeat');
    const b = await capture('config-hash-OTHER');

    const h1 = await frameHashes(a1.framesDir!);
    const h2 = await frameHashes(a2.framesDir!);
    const hb = await frameHashes(b.framesDir!);

    expect(h1.length).toBe(15);
    expect(h1).toEqual(h2); // determinism: identical seed + virtual clock ⇒ identical bytes
    expect(hb).not.toEqual(h1); // the seeded Math.random jitter actually moves the pixels
  }, 180_000);
});
