// Orbit Lab smoke: fps, API contract, drag-launch, vectors, present hook, console cleanliness.
import { createRequire } from 'node:module';
const require = createRequire('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json');
const { chromium } = require('playwright');

const url = 'file:///Users/ofeklevy/cebu/podcast-saas/tutorial-kit/sims/orbit-lab/index.html';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url);
await page.waitForTimeout(300);

const ready = await page.evaluate(() => Promise.race([
  window.__flowvidReadyForPresent.then(() => true),
  new Promise(r => setTimeout(() => r('timeout'), 3000)),
]));

// fps over 3s
const fps = await page.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now();
  (function tick() { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res(n / 3); })();
}));

// API + state
const s0 = await page.evaluate(() => window.OrbitSim.getState());
// demo autolaunched after 1.4s? wait then count
await page.waitForTimeout(3200);
const s1 = await page.evaluate(() => window.OrbitSim.getState());

// drag-launch
await page.mouse.move(500, 300); await page.mouse.down();
await page.mouse.move(560, 420, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(400);
const s2 = await page.evaluate(() => window.OrbitSim.getState());

// set() through API reflects in state + control
await page.evaluate(() => window.OrbitSim.set({ gravity: 2.0, vectors: true }));
const s3 = await page.evaluate(() => ({ g: window.OrbitSim.getState().gravity, dom: document.getElementById('gravity').value }));

await page.evaluate(() => window.OrbitSim.set({ gravity: 1.0 }));
await page.evaluate(() => window.OrbitSim.reset());
await page.evaluate(() => window.OrbitSim.demo());
await page.waitForTimeout(7000);
await page.screenshot({ path: 'proof-orbit-1.png' });
await page.evaluate(() => window.OrbitSim.set({ preset: 'binary' }));
await page.evaluate(() => window.OrbitSim.demo());
await page.waitForTimeout(6500);
// mid-aim frame: prediction dots + velocity arrow visible
await page.mouse.move(420, 640); await page.mouse.down();
await page.mouse.move(520, 520, { steps: 6 });
await page.screenshot({ path: 'proof-orbit-2.png' });
await page.mouse.up();

console.log(JSON.stringify({ ready, fps: Math.round(fps), bodiesAtStart: s0.bodies,
  afterAutoDemo: s1.bodies, afterDrag: s2.bodies, setReflects: s3, errors }, null, 2));
await browser.close();
