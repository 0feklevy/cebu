// Film-capture-only kinesin footage (owner-approved 2026-09-05; NEVER seeded).
// Serves the private dist locally and records two 1080p clips:
//   k1-beauty.webm  — slow cinematic walk, ALL chrome hidden (teaser S1)
//   k2-viewer.webm  — cursor enters, drags the cycle slider, orbits camera (teaser S2)
// Structure note: setup() is AWAITED (a swallowed addStyleTag rejection cost one re-shoot);
// only the long pointer choreography runs detached so the recording clock keeps rolling.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { readFileSync, statSync, renameSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const DIST = '/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/dist';
const OUT = join(HERE, 'footage');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((rq, rs) => {
  const p = join(DIST, decodeURIComponent(new URL(rq.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html');
  try {
    statSync(p);
    rs.setHeader('content-type', MIME[extname(p)] ?? 'application/octet-stream');
    rs.end(readFileSync(p));
  } catch { rs.statusCode = 404; rs.end(); }
});
await new Promise(r => server.listen(4190, '127.0.0.1', r));

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] });

async function record(name, durMs, setup, motion, opts = {}) {
  const W = opts.width ?? 1920;
  const ctx = await browser.newContext({
    viewport: { width: W, height: 1080 },
    recordVideo: { dir: OUT, size: { width: W, height: 1080 } },
  });
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:4190/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof window.MolecularMotorSim?.getState === 'function'
    || window.__flowvidReadyForPresent === true, { timeout: 45000 }).catch(() => {});
  await p.waitForTimeout(3500);
  await setup(p);                       // FAILS LOUDLY — a hidden panel is the whole point
  if (motion) motion(p).catch(() => {});
  await p.waitForTimeout(durMs);
  const v = p.video();
  await ctx.close();
  const raw = await v.path();
  const dest = join(OUT, `${name}.webm`);
  renameSync(raw, dest);
  console.log(name, dest);
}

// Clip 1 — beauty. The audit build PAINTS its panel into the WebGL canvas (DOM hiding is
// futile), so the take records WIDE (2280) and assembly crops the left 1920 — native pixels,
// no panel, no upscale.
await record('k1-beauty', 16000, async (p) => {
  await p.addStyleTag({ content: 'body{cursor:none} #learning-panel,aside,header,nav{display:none!important}' });
  await p.evaluate(() => {
    const s = window.MolecularMotorSim;
    s?.setPlaybackRate?.(0.55);
    s?.play?.();
  });
}, null, { width: 2280 });

// Clip 2 — the viewer's hand: panel visible, audit eyebrow kept hidden by an observer.
await record('k2-viewer', 14000, async (p) => {
  await p.evaluate(() => {
    const hide = () => {
      for (const el of document.querySelectorAll('#learning-panel *')) {
        if (el.children.length === 0 && /ASSET\s*PROOF/i.test(el.textContent || '')) {
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      }
    };
    hide();
    new MutationObserver(hide).observe(document.body, { subtree: true, childList: true });
  });
}, async (p) => {
  const slider = await p.$('#timeline');
  if (slider) {
    const b = await slider.boundingBox();
    if (b) {
      await p.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2, { steps: 30 });
      await p.mouse.down();
      await p.mouse.move(b.x + b.width * 0.75, b.y + b.height / 2, { steps: 90 });
      await p.mouse.move(b.x + b.width * 0.4, b.y + b.height / 2, { steps: 70 });
      await p.mouse.up();
    }
  }
  await p.mouse.move(960, 520, { steps: 25 });
  await p.mouse.down();
  await p.mouse.move(1250, 460, { steps: 80 });
  await p.mouse.move(1050, 560, { steps: 60 });
  await p.mouse.up();
});

await browser.close();
server.close();
