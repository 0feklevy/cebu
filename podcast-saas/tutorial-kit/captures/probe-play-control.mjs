// Why does playback not resume after a progress-bar seek? Try each mechanism in turn and report
// which one actually moves the film: the controls-bar button, a frame click, the space key, and
// (as a control, never used in a shot) video.play() from JS.
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

const ctx = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), {
  channel: 'chrome', args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1600, height: 900 },
});
for (const p of ctx.pages()) await p.close().catch(() => {});
const page = await ctx.newPage();
await page.bringToFront();
await page.goto(T.demo.shareUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.evaluate(() => { for (const v of document.querySelectorAll('video')) v.muted = true; });

const state = () => page.evaluate(() => {
  const vids = [...document.querySelectorAll('video')].filter((v) => v.duration);
  const v = vids.find((x) => !x.paused) ?? vids[0];
  return { n: vids.length, t: v ? Math.round(v.currentTime * 10) / 10 : null, paused: v ? v.paused : null, ready: v?.readyState, net: v?.networkState };
});
const btnInfo = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /play or pause/i.test(x.getAttribute('aria-label') ?? ''));
  if (!b) return null;
  const r = b.getBoundingClientRect(); const cs = getComputedStyle(b);
  const mid = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    opacity: cs.opacity, vis: cs.visibility, pe: cs.pointerEvents, disabled: b.disabled,
    topmost: mid === b || b.contains(mid), topTag: mid?.tagName, topCls: (mid?.className || '').toString().slice(0, 60) };
});

console.log('initial       ', await state());
console.log('play button   ', await btnInfo());

// 1 · press play from the start (no seek)
await page.getByRole('button', { name: 'Play or pause' }).first().click({ timeout: 5000 }).catch((e) => console.log('  click threw:', String(e).slice(0, 80)));
await page.waitForTimeout(1500);
console.log('after play    ', await state());

// 2 · seek with the progress bar while playing
const bar = await page.evaluate(() => {
  const c = [...document.querySelectorAll('div,input')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > innerWidth * 0.5 && r.height >= 2 && r.height < 30 && r.y > innerHeight * 0.75;
  }).at(-1);
  const r = c?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y + r.height / 2, w: r.width } : null;
});
await page.mouse.move(bar.x + bar.w * 0.3, bar.y - 30);
await page.waitForTimeout(400);
await page.mouse.click(bar.x + bar.w * (20 / 79), bar.y);
await page.waitForTimeout(1500);
console.log('after seek→20 ', await state(), await btnInfo());

// 3 · if paused, try each recovery in turn
if ((await state()).paused) {
  await page.getByRole('button', { name: 'Play or pause' }).first().click({ timeout: 5000 }).catch((e) => console.log('  click threw:', String(e).slice(0, 80)));
  await page.waitForTimeout(1200);
  console.log('after btn     ', await state());
}
if ((await state()).paused) {
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  console.log('after space   ', await state());
}
if ((await state()).paused) {
  await page.locator('video').first().click({ position: { x: 200, y: 200 } }).catch(() => {});
  await page.waitForTimeout(1200);
  console.log('after frame   ', await state());
}
if ((await state()).paused) {
  await page.evaluate(() => { const v = [...document.querySelectorAll('video')].find((x) => x.duration); return v?.play?.(); }).catch(() => {});
  await page.waitForTimeout(1200);
  console.log('after js play ', await state(), '(control only — shots must not use this)');
}

// 4 · does it keep rolling, and do window iframes appear on the way to 25s?
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(1000);
  const s = await state();
  const frames = await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => {
    const r = f.getBoundingClientRect(); const cs = getComputedStyle(f);
    let o = 1, n = f; while (n && n.nodeType === 1) { o *= Number(getComputedStyle(n).opacity || 1); n = n.parentElement; }
    return `${Math.round(r.width)}x${Math.round(r.height)} own=${cs.opacity} eff=${Math.round(o * 100) / 100} cv=${f.checkVisibility ? f.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : '?'} ${(f.src || '').slice(-40)}`;
  }));
  console.log(`  t=${s.t} paused=${s.paused} iframes=${frames.length}`, frames);
}
await ctx.close();
