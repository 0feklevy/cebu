// One-off DOM probe: what the editor's timeline/library actually expose for automation.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const stage = JSON.parse(readFileSync(join(HERE, 'STAGE.json'), 'utf8'));
const browser = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), {
  channel: 'chrome', viewport: { width: 1920, height: 1080 },
});
const p = await browser.newPage();
await p.goto(`http://localhost:3000/projects/${stage.projectId}/editor`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);
const info = await p.evaluate(() => {
  const pick = (sel) => [...document.querySelectorAll(sel)].slice(0, 12).map(e => ({
    tag: e.tagName, id: e.id || undefined, cls: (e.className || '').toString().slice(0, 90),
    testid: e.getAttribute('data-testid') || undefined, text: (e.textContent || '').trim().slice(0, 40),
    rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(e.getBoundingClientRect()),
  }));
  return {
    url: location.href,
    testids: [...document.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')).slice(0, 60),
    lanes: pick('[class*="lane"],[data-lane],[class*="track"]'),
    library: pick('[class*="library" i],[class*="Library"]').slice(0, 6),
    buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 40),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
