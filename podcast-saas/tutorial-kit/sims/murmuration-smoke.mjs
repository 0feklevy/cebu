// Murmuration 3D smoke — adapted from the demo-sims-smoke pattern (and orbit-smoke).
// Asserts: 60fps ±10 over 5s at 1080p, every control responds (real pointer drags),
// API contract (set/scatter/reset/pause/play/getState), scatter visibly disperses
// (lit-pixel spread), pointer attract shifts the flock centroid toward the cursor,
// __flowvidReadyForPresent resolves, no console errors, package < 60KB, no CDN refs.
// Proof frames: proof-murm3d-1.png (mid-flock) and proof-murm3d-2.png (during scatter).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json');
const { chromium } = require('playwright');

const DIR = '/Users/ofeklevy/cebu/podcast-saas/tutorial-kit/sims';
const url = `file://${DIR}/murmuration/index.html`;

const checks = {}; const failed = [];
function assert(name, ok, detail) { checks[name] = { ok: !!ok, detail }; if (!ok) failed.push(name); }

// Static package checks: total size, and nothing loaded from the network.
{
  const files = ['index.html', 'styles.css', 'js/flock.js', 'js/render.js', 'js/input.js', 'js/api.js'];
  const bytes = files.reduce((a, f) => a + fs.statSync(`${DIR}/murmuration/${f}`).size, 0);
  assert('package-under-60kb', bytes < 60 * 1024, `${bytes} bytes across ${files.length} files`);
  const html = fs.readFileSync(`${DIR}/murmuration/index.html`, 'utf8');
  assert('no-external-deps', !/(src|href)=["']https?:/i.test(html), 'all script/style refs relative');
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url);
await page.waitForTimeout(400);

assert('api-shape', await page.evaluate(() =>
  typeof window.MurmurationSim === 'object' &&
  ['set', 'scatter', 'reset', 'pause', 'play', 'getState'].every(k => typeof window.MurmurationSim[k] === 'function') &&
  typeof window.__flowvidReadyForPresent === 'function'), 'MurmurationSim methods + ready hook is a function');

const ready = await page.evaluate(() => Promise.race([
  window.__flowvidReadyForPresent().then(() => true),
  new Promise(r => setTimeout(() => r('timeout'), 4000)),
]));
assert('ready-hook-resolves', ready === true, ready);

const dom = await page.evaluate(() => Object.fromEntries(
  ['cohesion', 'alignment', 'separation', 'speed', 'scatter', 'trails', 'reset']
    .map(id => [id, !!document.getElementById(id)])));
assert('static-dom-ids', Object.values(dom).every(Boolean), dom);

await page.waitForTimeout(2000); // let the flock organise

// fps over 5s at 1080p with the full default scene (trails on).
const fps = await page.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now();
  (function tick() {
    n++;
    const dt = performance.now() - t0;
    if (dt < 5000) requestAnimationFrame(tick); else res(n * 1000 / dt);
  })();
}));
assert('fps-60±10', fps >= 50 && fps <= 75, Math.round(fps * 10) / 10);

await page.screenshot({ path: `${DIR}/proof-murm3d-1.png` }); // mid-flock, trails on

// --- helpers ---------------------------------------------------------------
async function dragSlider(sel, frac) { // frac <0 / >1 overshoots to the ends
  const bb = await page.locator(sel).boundingBox();
  const y = bb.y + bb.height / 2;
  await page.mouse.move(bb.x + bb.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width * frac, y, { steps: 8 });
  await page.mouse.up();
}
const getState = () => page.evaluate(() => window.MurmurationSim.getState());
// Lit-pixel stats straight off the canvas (downscaled): centroid + spread in 1080p px.
const stats = () => page.evaluate(() => {
  const c = document.getElementById('stage');
  const sw = 480, sh = 270, t = document.createElement('canvas');
  t.width = sw; t.height = sh;
  const g = t.getContext('2d', { willReadFrequently: true });
  g.drawImage(c, 0, 0, sw, sh);
  const d = g.getImageData(0, 0, sw, sh).data;
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4, b = d[i] * 0.35 + d[i + 1] * 0.5 + d[i + 2] * 0.15;
    if (b > 60) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; }
  }
  if (!n) return { n: 0, cx: 0, cy: 0, spread: 0 };
  const mx = sx / n, my = sy / n;
  return { n, cx: mx * 4, cy: my * 4,
    spread: Math.sqrt(Math.max(0, sxx / n - mx * mx) + Math.max(0, syy / n - my * my)) * 4 };
});

// --- every control responds (real pointer input) ---------------------------
await dragSlider('#cohesion', 1.02);
let st = await getState();
assert('drag-cohesion', st.cohesion >= 1.7, st.cohesion);
await dragSlider('#alignment', -0.02);
await dragSlider('#separation', -0.02);
await dragSlider('#speed', 1.02);
st = await getState();
assert('drag-alignment', st.alignment <= 0.3, st.alignment);
assert('drag-separation', st.separation <= 0.35, st.separation);
assert('drag-speed', st.speed >= 1.7, st.speed);
await page.click('#trails');
st = await getState();
assert('trails-toggle', st.trails === false, st.trails);
await page.evaluate(() => window.MurmurationSim.set('speed', 1.25));
st = await getState();
assert('api-set', Math.abs(st.speed - 1.25) < 1e-9, st.speed);
await page.click('#reset');
st = await getState();
assert('reset-defaults', st.cohesion === 1 && st.alignment === 1 && st.separation === 1.2
  && st.speed === 1 && st.boids >= 250 && st.running === true, JSON.stringify(st));

// --- pointer attract in 3D: centroid converges on the cursor ---------------
await page.waitForTimeout(900); // respawned flock settles (trails still off: clean pixels)
const AX = 620, AY = 660;
await page.mouse.move(AX, AY, { steps: 30 });
await page.waitForTimeout(250);
const a0 = await stats();
await page.waitForTimeout(2000);
const a1 = await stats();
const d0 = Math.hypot(a0.cx - AX, a0.cy - AY), d1 = Math.hypot(a1.cx - AX, a1.cy - AY);
assert('pointer-attract-3d', a1.n > 25 && d1 < Math.max(150, d0 * 0.8),
  { d0: Math.round(d0), d1: Math.round(d1), n0: a0.n, n1: a1.n });

// --- scatter() visibly disperses (API path + pixel-spread state check) -----
const s0 = await stats();
await page.evaluate(() => window.MurmurationSim.scatter());
await page.waitForTimeout(650);
const s1 = await stats();
assert('scatter-disperses', s1.spread > s0.spread * 1.3,
  { before: Math.round(s0.spread), after: Math.round(s1.spread) });
st = await getState();
assert('state-after-scatter', st.running === true && st.boids >= 250, JSON.stringify(st));

// --- proof 2: trails back on, real #scatter click, frame mid-burst ---------
await page.evaluate(() => window.MurmurationSim.set('trails', true));
st = await getState();
assert('api-set-trails', st.trails === true, st.trails);
await page.waitForTimeout(2600); // re-gather, rebuild streaks
await page.mouse.move(1050, 480, { steps: 25 });
await page.waitForTimeout(1200);
await page.click('#scatter');
await page.waitForTimeout(450);
await page.screenshot({ path: `${DIR}/proof-murm3d-2.png` }); // during scatter, trails on

// --- pause freezes the frame; play resumes ---------------------------------
const thumb = () => page.evaluate(() => {
  const c = document.getElementById('stage'), t = document.createElement('canvas');
  t.width = 128; t.height = 72;
  t.getContext('2d').drawImage(c, 0, 0, 128, 72);
  return t.toDataURL();
});
await page.evaluate(() => window.MurmurationSim.pause());
await page.waitForTimeout(150);
st = await getState();
const f0 = await thumb();
await page.waitForTimeout(350);
const f1 = await thumb();
assert('pause-freezes', st.running === false && f0 === f1, `running=${st.running} frozen=${f0 === f1}`);
await page.evaluate(() => window.MurmurationSim.play());
await page.waitForTimeout(350);
const f2 = await thumb();
st = await getState();
assert('play-resumes', st.running === true && f2 !== f1, `running=${st.running} moving=${f2 !== f1}`);

assert('no-console-errors', errors.length === 0, errors);

console.log(JSON.stringify({
  verdict: failed.length ? `FAIL: ${failed.join(', ')}` : 'PASS',
  fps: Math.round(fps * 10) / 10,
  checks,
}, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
