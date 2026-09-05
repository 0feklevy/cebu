// Solar System smoke — the sim is ES modules, so it is served over a tiny local
// http server (modules don't run from file://). Asserts: 55+fps over 5s at 1080p,
// no console errors, __flowvidReadyForPresent resolves <4s, focus('Jupiter')
// actually moves the camera, #speed input reaches getState().speed, set() drives
// the real DOM controls, tour() runs, reset() restores defaults, package <2MB
// with zero external refs. Proof frames: proof-solar-overview.png (orbits+labels),
// proof-solar-saturn.png (ring), proof-solar-earth.png (clouds + terminator).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const require = createRequire('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json');
const { chromium } = require('playwright');

const SIMS = '/Users/ofeklevy/cebu/podcast-saas/tutorial-kit/sims';
const PKG = `${SIMS}/solar-system`;

const checks = {}; const failed = [];
function assert(name, ok, detail) { checks[name] = { ok: !!ok, detail }; if (!ok) failed.push(name); }

/* ---------------------------------------------------- static package checks */
{
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(PKG);
  const bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);
  assert('package-under-2mb', bytes < 2 * 1024 * 1024, `${(bytes / 1024).toFixed(0)} KB across ${files.length} files`);
  assert('no-texture-images', !files.some(f => /\.(png|jpe?g|webp|gif|ktx2?|basis)$/i.test(f)), 'all textures procedural');
  const sources = files.filter(f => /\.(html|js|css)$/.test(f) && !f.includes('/vendor/'));
  const external = sources.filter(f => /https?:\/\//.test(fs.readFileSync(f, 'utf8').replace(/https?:\/\/[^\s"']*flowvid[^\s"']*/g, '')));
  assert('no-external-refs', external.length === 0, external.map(f => path.basename(f)));
  const bare = [];
  for (const f of sources.filter(f => f.endsWith('.js'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('.') && !m[1].startsWith('/')) bare.push(`${path.basename(f)}:${m[1]}`);
    }
  }
  assert('imports-all-relative', bare.length === 0, bare);
  assert('three-license-present', fs.readFileSync(`${PKG}/vendor/THREE-LICENSE`, 'utf8').includes('MIT License'), 'vendor/THREE-LICENSE');
}

/* --------------------------------------------------------- tiny http server */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(SIMS, decodeURIComponent(req.url.split('?')[0])));
  if (!p.startsWith(SIMS) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  res.end(fs.readFileSync(p));
});
const port = await new Promise((resolve, reject) => {
  let p = 8484;
  const tryListen = () => server.listen(p, '127.0.0.1', () => resolve(p))
    .once('error', e => { if (e.code === 'EADDRINUSE' && p < 8494) { p++; server.removeAllListeners('error'); tryListen(); } else reject(e); });
  tryListen();
});

/* ------------------------------------------------------------------ browser */
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/solar-system/index.html`, { waitUntil: 'domcontentloaded' });
const ready = await page.evaluate(() => Promise.race([
  window.__flowvidReadyForPresent,
  new Promise(r => setTimeout(() => r('timeout'), 8000)),
]));
const readyMs = Date.now() - t0;
assert('ready-under-4s', ready === true && readyMs < 4000, `${readyMs}ms`);

assert('api-shape', await page.evaluate(() =>
  typeof window.SolarSim === 'object' &&
  ['focus', 'tour', 'set', 'reset', 'pause', 'play', 'getState'].every(k => typeof window.SolarSim[k] === 'function') &&
  typeof window.SolarSim.ready?.then === 'function' &&
  typeof window.__flowvidReadyForPresent?.then === 'function'), 'SolarSim methods + ready promises');

const dom = await page.evaluate(() => Object.fromEntries(
  ['speed', 'focus', 'labels', 'orbits', 'tour', 'reset'].map(id => [id, !!document.getElementById(id)])));
assert('static-dom-ids', Object.values(dom).every(Boolean), dom);

const getState = () => page.evaluate(() => window.SolarSim.getState());

/* ------------------------------------------------- proof 1: overview at rest */
await page.waitForTimeout(1400);                       // hud visible, drift barely moved
await page.screenshot({ path: `${SIMS}/proof-solar-overview.png` });

/* --------------------------------------------------------- fps on full scene */
const fps = await page.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now();
  (function tick() {
    n++;
    const dt = performance.now() - t0;
    if (dt < 5000) requestAnimationFrame(tick); else res(n * 1000 / dt);
  })();
}));
assert('fps-55plus', fps >= 55, Math.round(fps * 10) / 10);

/* ------------------------------------------------------------ speed control */
const s0 = (await getState()).speed;
await page.$eval('#speed', el => { el.value = '0.95'; el.dispatchEvent(new Event('input', { bubbles: true })); });
const s1 = (await getState()).speed;
assert('speed-input-changes-state', s1 !== s0 && s1 > 20, `${s0} -> ${s1}`);

await page.evaluate(() => window.SolarSim.set({ speed: 2.6, labels: false, orbits: false }));
const domAfterSet = await page.evaluate(() => ({
  slider: parseFloat(document.getElementById('speed').value),
  labels: document.getElementById('labels').checked,
  orbits: document.getElementById('orbits').checked,
}));
const st2 = await getState();
assert('set-drives-dom', Math.abs(st2.speed - 2.6) < 0.05 && domAfterSet.labels === false &&
  domAfterSet.orbits === false && st2.labels === false && st2.orbits === false,
  JSON.stringify({ domAfterSet, state: { speed: st2.speed, labels: st2.labels, orbits: st2.orbits } }));
await page.evaluate(() => window.SolarSim.set({ labels: true, orbits: true }));

/* -------------------------------------------------- focus flight: Jupiter */
const c0 = (await getState()).camera;
await page.evaluate(() => window.SolarSim.focus('Jupiter'));
await page.waitForTimeout(2600);
const stJ = await getState();
const dJ = Math.hypot(stJ.camera.x - c0.x, stJ.camera.y - c0.y, stJ.camera.z - c0.z);
assert('focus-jupiter-moves-camera', dJ > 40 && stJ.focus === 'Jupiter', `delta ${Math.round(dJ)} world units`);

/* ------------------------------------------------------- proof 2: Saturn */
await page.evaluate(() => window.SolarSim.set({ speed: 0.05 }));
await page.evaluate(() => window.SolarSim.focus('Saturn'));
await page.waitForTimeout(3200);
await page.screenshot({ path: `${SIMS}/proof-solar-saturn.png` });

/* -------------------------------------------------------- proof 3: Earth */
await page.evaluate(() => window.SolarSim.focus('Earth'));
await page.waitForTimeout(3200);
await page.screenshot({ path: `${SIMS}/proof-solar-earth.png` });

/* ---------------------------------------------------------------- tour() */
const tourOk = await page.evaluate(() => { try { window.SolarSim.tour(); return true; } catch (e) { return String(e); } });
await page.waitForTimeout(600);
const touring = (await getState()).touring;
await page.waitForTimeout(3400);
assert('tour-runs', tourOk === true && touring === true, `started=${tourOk} touring=${touring}`);

/* ---------------------------------------------------------------- reset() */
await page.evaluate(() => window.SolarSim.reset());
await page.waitForTimeout(400);
const stR = await getState();
assert('reset-defaults', Math.abs(stR.speed - 2.61) < 0.15 && stR.labels === true && stR.orbits === true &&
  stR.focus === 'Overview' && stR.paused === false && stR.touring === false, JSON.stringify(stR));

/* ------------------------------------------------------------- pause/play */
await page.evaluate(() => window.SolarSim.pause());
const p0 = (await getState()).tDays;
await page.waitForTimeout(400);
const p1 = (await getState()).tDays;
await page.evaluate(() => window.SolarSim.play());
await page.waitForTimeout(400);
const p2 = (await getState()).tDays;
assert('pause-freezes-time', p0 === p1 && p2 > p1, `${p0} / ${p1} / ${p2}`);

assert('no-console-errors', errors.length === 0, errors.slice(0, 4));

console.log(JSON.stringify({
  verdict: failed.length ? `FAIL: ${failed.join(', ')}` : 'PASS',
  fps: Math.round(fps * 10) / 10,
  readyMs,
  checks,
}, null, 2));
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
