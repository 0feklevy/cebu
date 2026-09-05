// Records license-clean "lesson footage" clips from the kit sims (1080p webm via Playwright).
// Usage: node record-sim-footage.mjs <simsBaseUrl> <outDir> — re-run any time the sims change.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const base = process.argv[2] ?? 'http://127.0.0.1:4180';
const out = process.argv[3] ?? './out';
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] });

async function record(name, url, durMs, direct) {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: out, size: { width: 1920, height: 1080 } },
  });
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await direct(p);
  await p.waitForTimeout(durMs);
  const v = p.video();
  await ctx.close();
  const path = await v.path();
  console.log(JSON.stringify({ name, path }));
}

// Clip A — murmuration "lesson footage": panel hidden, choreographed pointer + scatter beats.
await record('murmuration-footage', base + '/murmuration/index.html', 34000, async (p) => {
  await p.addStyleTag({ content: '#panel,#hint{display:none!important}' });
  (async () => {
    try {
      const path = [[500,540],[900,400],[1300,600],[960,700],[600,350]];
      for (let round = 0; round < 4; round++) {
        for (const [x, y] of path) { await p.mouse.move(x, y, { steps: 40 }); await p.waitForTimeout(1400); }
        if (round === 1) { await p.evaluate(() => window.MurmurationSim.scatter()); }
        if (round === 2) { await p.evaluate(() => window.MurmurationSim.set('cohesion', 1.7)); }
      }
    } catch { /* context closed at cut */ }
  })();
});

// Clip B — wave-lab b-roll: sources appear, frequency sweeps, antiphase flips.
await record('wave-lab-broll', base + '/wave-lab/index.html', 22000, async (p) => {
  await p.addStyleTag({ content: '#panel,#hint{display:none!important}' });
  (async () => {
    try {
      await p.waitForTimeout(2500);
      await p.evaluate(() => window.WaveLabSim.addSourceAt(0.3, 0.6));
      await p.waitForTimeout(3000);
      for (let f = 1.6; f <= 3.2; f += 0.2) { await p.evaluate((v) => window.WaveLabSim.set('frequency', v), f); await p.waitForTimeout(700); }
      await p.evaluate(() => window.WaveLabSim.togglePhase());
      await p.waitForTimeout(4000);
      await p.evaluate(() => window.WaveLabSim.addSourceAt(0.7, 0.35));
    } catch { /* context closed at cut */ }
  })();
});

await browser.close();
