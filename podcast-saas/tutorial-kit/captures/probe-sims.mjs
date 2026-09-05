// What controls does each seeded simulation package actually expose? Needed to script real motion
// for the window plates (sliders, buttons, selects, canvas size) instead of guessing.
//   node probe-sims.mjs
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

const powers = T.niche.find((n) => n.key === 'powers');
const targets = [
  ['kinesin', T.demo.windows.find((w) => w.sim === 'kinesin')?.simulation_url ?? T.demo.sims.kinesin.entry_file],
  ['solar', T.demo.windows.find((w) => w.sim === 'solarSystem')?.simulation_url ?? T.demo.sims.solarSystem.entry_file],
  ['murmuration', T.demo.windows.find((w) => w.sim === 'murmuration')?.simulation_url ?? T.demo.sims.murmuration.entry_file],
  ['orbitlab', powers?.windows?.[0]?.simulation_url ?? powers?.sims?.orbitLab?.entry_file],
];

const ctx = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), {
  channel: 'chrome', args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1920, height: 1080 },
});
for (const p of ctx.pages()) await p.close().catch(() => {});
const page = await ctx.newPage();
await page.bringToFront();

for (const [key, url] of targets) {
  console.log(`\n=== ${key}\n${url}`);
  if (!url) { console.log('  (no url)'); continue; }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const info = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const labelOf = (el) => {
      const id = el.id && document.querySelector(`label[for="${el.id}"]`);
      return (id?.textContent || el.closest('label')?.textContent || el.getAttribute('aria-label') || el.previousElementSibling?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    };
    return {
      canvases: [...document.querySelectorAll('canvas')].map(box),
      ranges: [...document.querySelectorAll('input[type=range]')].map((r) => ({ label: labelOf(r), min: r.min, max: r.max, value: r.value, step: r.step, box: box(r) })),
      buttons: [...document.querySelectorAll('button')].map((b) => ({ text: (b.textContent || '').trim().slice(0, 28), box: box(b) })).filter((b) => b.box.w > 0),
      selects: [...document.querySelectorAll('select')].map((s) => ({ label: labelOf(s), options: [...s.options].map((o) => o.text).slice(0, 12), box: box(s) })),
      checkboxes: [...document.querySelectorAll('input[type=checkbox]')].map((c) => ({ label: labelOf(c), checked: c.checked, box: box(c) })),
      panels: [...document.querySelectorAll('div,section,aside')].filter((d) => { const r = d.getBoundingClientRect(); return r.width > 150 && r.width < 520 && r.height > 120 && getComputedStyle(d).backgroundColor !== 'rgba(0, 0, 0, 0)'; }).slice(0, 3).map((d) => ({ cls: (d.className || '').toString().slice(0, 40), id: d.id, box: box(d) })),
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
    };
  });
  console.log(JSON.stringify(info, null, 1));
}
await ctx.close();
