// How does the viewer ACTUALLY expose a presented live window?
//
// Two capture bugs came from guessing: an own-opacity check said a window was up forever (the
// product fades a parent layer), and a checkVisibility+effective-opacity check said one was never
// up at all. Print the truth: for ~40 s of playback across the demo's windows, sample every
// iframe's geometry, own opacity, effective (multiplied) opacity, checkVisibility, and the
// video clock, so the detector can be written against what the DOM really does.
//
//   node probe-window-layers.mjs [startSec] [durationSec]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const T = JSON.parse(readFileSync(join(HERE, '../seeding/TEMPLATE.json'), 'utf8'));
const startSec = Number(process.argv[2] ?? 20);
const durSec = Number(process.argv[3] ?? 40);

const ctx = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), {
  channel: 'chrome',
  args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1600, height: 900 },
});
for (const p of ctx.pages()) await p.close().catch(() => {});
const page = await ctx.newPage();
await page.bringToFront();
await page.goto(T.demo.shareUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.evaluate(() => { for (const v of document.querySelectorAll('video')) v.muted = true; });

// Seek with the product's progress bar, then press its play button.
const bar = await page.evaluate(() => {
  const c = [...document.querySelectorAll('div,input')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > innerWidth * 0.5 && r.height >= 2 && r.height < 30 && r.y > innerHeight * 0.75;
  }).at(-1);
  const r = c?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y + r.height / 2, w: r.width } : null;
});
const total = await page.evaluate(() => {
  const s = [...document.querySelectorAll('span')].map((e) => e.textContent?.trim() ?? '');
  const i = s.findIndex((t) => t === '/');
  const t = i > 0 ? s[i + 1] : null;
  if (!t || !/^\d+:\d\d$/.test(t)) return null;
  const [m, sec] = t.split(':').map(Number); return m * 60 + sec;
});
console.log('total =', total);
if (bar && total) { await page.mouse.click(bar.x + bar.w * (startSec / total), bar.y); await page.waitForTimeout(600); }
await page.getByRole('button', { name: 'Play or pause' }).first().click().catch(() => {});
await page.waitForTimeout(800);

const sample = () => page.evaluate(() => {
  const vids = [...document.querySelectorAll('video')].filter((v) => v.duration);
  const v = vids.find((x) => !x.paused) ?? vids[0];
  const effOpacity = (el) => { let o = 1, n = el; while (n && n.nodeType === 1) { o *= Number(getComputedStyle(n).opacity || 1); n = n.parentElement; } return Math.round(o * 100) / 100; };
  return {
    t: v ? Math.round(v.currentTime * 10) / 10 : null,
    paused: v ? v.paused : null,
    frames: [...document.querySelectorAll('iframe')].map((f) => {
      const r = f.getBoundingClientRect(); const cs = getComputedStyle(f);
      return {
        w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
        own: cs.opacity, eff: effOpacity(f), vis: cs.visibility, disp: cs.display,
        checkVis: f.checkVisibility ? f.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) : 'n/a',
        pointer: cs.pointerEvents,
        z: cs.zIndex,
        src: (f.src || '').slice(-46),
      };
    }),
  };
});

const t0 = Date.now();
let last = '';
while (Date.now() - t0 < durSec * 1000) {
  const s = await sample();
  const line = JSON.stringify(s.frames.map((f) => `${f.w}x${f.h} own=${f.own} eff=${f.eff} vis=${f.vis} cv=${f.checkVis} pe=${f.pointer} z=${f.z} ${f.src}`));
  if (line !== last) { console.log(`t=${s.t}s paused=${s.paused}`, JSON.stringify(s.frames, null, 1)); last = line; }
  else console.log(`t=${s.t}s paused=${s.paused} (unchanged)`);
  await page.waitForTimeout(1000);
}
await ctx.close();
