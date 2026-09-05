// Dump the kinesin package's control panel so a boot-hide list can name real selectors instead of
// guessing: every element inside the control card with its tag, id, classes and text.
//   node probe-kinesin-panel.mjs
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
const win = T.demo.windows.find((w) => w.sim === 'kinesin');
const url = win?.simulation_url ?? T.demo.sims.kinesin.entry_file;
console.log('url:', url);

const ctx = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), {
  channel: 'chrome', args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1920, height: 1080 },
});
for (const p of ctx.pages()) await p.close().catch(() => {});
const page = await ctx.newPage();
await page.bringToFront();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const dump = await page.evaluate(() => {
  const sel = (el) => {
    if (el.id) return `#${el.id}`;
    const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean);
    return cls.length ? `${el.tagName.toLowerCase()}.${cls.join('.')}` : el.tagName.toLowerCase();
  };
  const card = document.querySelector('.control-card') ?? document.body;
  const rows = [];
  const walk = (el, depth) => {
    if (depth > 4) return;
    for (const child of el.children) {
      const r = child.getBoundingClientRect();
      rows.push({
        depth,
        sel: sel(child),
        tag: child.tagName.toLowerCase(),
        id: child.id || null,
        cls: (child.className || '').toString().slice(0, 60),
        text: (child.innerText || child.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        box: { w: Math.round(r.width), h: Math.round(r.height) },
      });
      walk(child, depth + 1);
    }
  };
  walk(card, 0);
  return { cardSel: sel(card), rows };
});
console.log('card:', dump.cardSel);
for (const r of dump.rows) console.log(`${'  '.repeat(r.depth)}${r.sel.padEnd(34)} ${r.tag.padEnd(8)} ${String(r.box.w) + 'x' + r.box.h} | ${r.text}`);
await ctx.close();
