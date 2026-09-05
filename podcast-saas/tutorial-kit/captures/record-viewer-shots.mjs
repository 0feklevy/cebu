// Round-2 VIEWER shots on the live template's public share (no auth). v2: navigation goes
// through the PRODUCT's transport (start click + progress-bar scrubs) — element-level seeks
// bypass the segment machinery and record a paused poster (v1's failure).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const T = JSON.parse(readFileSync(join(HERE, '../seeding/TEMPLATE.json'), 'utf8'));
const OUT = join(HERE, 'out');
const manifest = JSON.parse(readFileSync(join(OUT, 'MANIFEST.json'), 'utf8'));
const save = () => writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });

async function shot(id, film, scene, run, opts = {}) {
  process.stdout.write(`● ${id} … `);
  const ctx = await browser.newContext({
    viewport: opts.viewport ?? { width: 1920, height: 1080 },
    recordVideo: { dir: OUT, size: opts.viewport ?? { width: 1920, height: 1080 } },
    ...(opts.mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
  });
  const p = await ctx.newPage();
  try {
    await run(p);
    const v = p.video();
    await ctx.close();
    renameSync(await v.path(), join(OUT, `${id}.webm`));
    manifest[id] = { file: join(OUT, `${id}.webm`), film, scene, recordedAt: new Date().toISOString() };
    save();
    console.log('done');
  } catch (e) {
    await ctx.close().catch(() => {});
    manifest[id] = { error: String(e).slice(0, 250), at: new Date().toISOString() };
    save();
    console.log('FAILED:', String(e).slice(0, 160));
  }
}

/** Start playback like a human: click the visible video/big-play once, muted first via JS. */
async function start(p) {
  await p.evaluate(() => { for (const v of document.querySelectorAll('video')) v.muted = true; });
  const vid = p.locator('video').first();
  await vid.click({ timeout: 8000, position: { x: 480, y: 300 } }).catch(() => {});
  await p.waitForTimeout(1200);
  const playing = await p.evaluate(() => [...document.querySelectorAll('video')].some(v => !v.paused));
  if (!playing) await vid.click({ timeout: 4000 }).catch(() => {});
  await p.waitForTimeout(800);
}

/** Scrub via the product's progress bar to a GLOBAL second (virtual timeline aware). */
async function scrubTo(p, globalSec, totalSec) {
  const bar = await p.evaluate(() => {
    const cands = [...document.querySelectorAll('div,input')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 800 && r.height >= 2 && r.height < 30 && r.y > innerHeight * 0.75;
    });
    const el = cands.at(-1);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y + r.height / 2, w: r.width };
  });
  if (!bar) throw new Error('no progress bar found');
  await p.mouse.move(bar.x + bar.w * 0.5, bar.y - 30);        // wake controls
  await p.waitForTimeout(400);
  await p.mouse.click(bar.x + bar.w * (globalSec / totalSec), bar.y);
  await p.waitForTimeout(600);
}

const share = T.demo.shareUrl;
// virtual total: teaser + murm + film2 + solar + orbit (+galton gap) — read live once
async function totalOf(p) {
  return p.evaluate(() => {
    const m = [...document.querySelectorAll('*')].map(e => e.childElementCount === 0 ? e.textContent?.trim() : '').find(t => /^\d+:\d\d\s*\/\s*\d+:\d\d$/.test(t || ''));
    if (!m) return null;
    const [, tot] = m.split('/');
    const [mm, ss] = tot.trim().split(':').map(Number);
    return mm * 60 + ss;
  });
}

// f4-s1: the public page playing, clean
await shot('f4-s1-public-page', 4, '1', async (p) => {
  await p.goto(share, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);
  await start(p);
  await scrubTo(p, 6, (await totalOf(p)) ?? 285).catch(() => {});
  await p.waitForTimeout(9000);
});

// f4-s2: TOUCH — reach the ORBIT section (scrub into film2's last second → solar → back → orbit)
await shot('f4-s2-orbit-touch', 4, '2', async (p) => {
  await p.goto(share, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);
  await start(p);
  const total = (await totalOf(p)) ?? 285;
  await scrubTo(p, 233.5, total);            // just before film2's end (72+30+133=235)
  await p.waitForTimeout(7000);              // ends → solar presents
  await p.getByRole('button', { name: /go back to video/i }).click({ timeout: 8000 });
  await p.waitForTimeout(4200);              // virtual advance → ORBIT
  const box = await p.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].find(x => x.getBoundingClientRect().width > 300 && getComputedStyle(x).visibility !== 'hidden');
    const r = f?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  });
  if (!box) throw new Error('no presented sim iframe to touch');
  const cx = box.x + box.w * 0.35, cy = box.y + box.h * 0.6;
  await p.mouse.move(cx, cy, { steps: 20 });
  await p.mouse.down();
  await p.mouse.move(cx + 130, cy - 110, { steps: 45 });
  await p.waitForTimeout(700);
  await p.mouse.up();
  await p.waitForTimeout(4500);
  await p.mouse.move(box.x + box.w * 0.7, box.y + box.h * 0.4, { steps: 25 });
  await p.mouse.down();
  await p.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.75, { steps: 40 });
  await p.mouse.up();
  await p.waitForTimeout(5000);
});

// f4-s4: CHOOSE — the doors over the last live sim; hover then pick "Viewer Superpowers"
await shot('f4-s4-branching', 4, '4', async (p) => {
  await p.goto(share, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);
  await start(p);
  const total = (await totalOf(p)) ?? 285;
  await scrubTo(p, 233.5, total);
  await p.waitForTimeout(7000);
  for (let i = 0; i < 3; i++) {
    const btn = p.getByRole('button', { name: /go back to video/i });
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click({ timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(3200);
  }
  const card = p.getByText('Viewer Superpowers', { exact: false }).first();
  await card.waitFor({ state: 'visible', timeout: 8000 });
  await card.hover().catch(() => {});
  await p.waitForTimeout(1200);
  await card.click();
  await p.waitForTimeout(5500);
});

// f5-s5: phone frame — start, watch, roll into the murm section, tap the flock
await shot('f5-s5-phone', 5, '5', async (p) => {
  await p.goto(share, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(5000);
  await p.evaluate(() => { for (const v of document.querySelectorAll('video')) v.muted = true; });
  await p.touchscreen.tap(195, 300);
  await p.waitForTimeout(1500);
  const total = (await totalOf(p)) ?? 285;
  await scrubTo(p, 69.5, total).catch(() => {});
  await p.waitForTimeout(8000);
  const box = await p.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].find(x => x.getBoundingClientRect().width > 150);
    const r = f?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  });
  if (box) { await p.touchscreen.tap(box.x + box.w / 2, box.y + box.h / 2).catch(() => {}); await p.waitForTimeout(4500); }
  else await p.waitForTimeout(4000);
}, { viewport: { width: 390, height: 844 }, mobile: true });

// f1-s7: the handoff — teaser's last seconds roll into the glowing murm section
await shot('f1-s7-zoomout', 1, '7', async (p) => {
  await p.goto(share, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);
  await start(p);
  const total = (await totalOf(p)) ?? 285;
  await scrubTo(p, 65, total);
  await p.waitForTimeout(13000);
});

await browser.close();
console.log('viewer shots v2 complete');
