// LIVE-WINDOW PLATES — real simulation footage to sit under the window beats, replacing
// assembly/plates/under-window.mp4 (a black plate that leaves ~23 s of film 1 pure black whenever
// the film is watched as a FILE rather than inside the product).
//
// One take, four cuts, full-frame 1920×1080 on each package's own public URL — the plate sits under
// the whole picture, so full-frame beats a window-shaped crop. Every plate is MOTION for its whole
// length, driven through each simulation's own controls (probe-sims.mjs mapped them):
//
//   plate-kinesin      ≥10 s  camera orbit + the Cycle-position slider swept back and forth
//   plate-solar        ≥10 s  time-lapse pushed up, camera flown to Jupiter and back out, orbit drag
//   plate-murmuration  ≥ 9 s  pointer swept through the flock, Scatter, re-form
//   plate-orbitlab     ≥14 s  two planets launched by drag-and-release, falling into orbit
//
// No drawn cursor (Chromium's screencast records no pointer, so these are clean), no product
// chrome (the package URL has none), and each cut is gated on `waitUntilBright` so a plate can
// never open on a black frame. The sims' own control cards stay: they are part of the simulation a
// viewer sees in the window, not product chrome.
import { settle, readTemplate, waitUntilBright, easeMove, PLATE_VIEWPORT } from '../shot-utils.mjs';

/** Grab a range input's thumb where it actually sits and drag it to `frac` of the track, slowly. */
async function sweepRange(page, index, frac, { ms = 1500 } = {}) {
  const r = page.locator('input[type=range]').nth(index);
  const box = await r.boundingBox();
  if (!box) return;
  const y = box.y + box.height / 2;
  const min = Number((await r.getAttribute('min')) ?? 0);
  const max = Number((await r.getAttribute('max')) ?? 1);
  const val = Number((await r.inputValue()) ?? min);
  const span = (max - min) || 1;
  const startX = box.x + box.width * Math.max(0, Math.min(1, (val - min) / span));
  const targetX = box.x + box.width * Math.max(0, Math.min(1, frac));
  await page.mouse.move(startX, y);
  await page.mouse.down();
  const steps = Math.max(8, Math.round(ms / 60));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + ((targetX - startX) * i) / steps, y);
    await page.waitForTimeout(ms / steps);
  }
  await page.mouse.up();
  page.__fvMouse = { x: targetX, y };
}

/** A slow drag across the canvas — camera orbit in the 3D sims, flock steering in murmuration. */
async function dragCanvas(page, x1, y1, x2, y2, { ms = 1800, hold = true } = {}) {
  await easeMove(page, x1, y1, { ms: 400 });
  if (hold) await page.mouse.down();
  const steps = Math.max(10, Math.round(ms / 60));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
    await page.waitForTimeout(ms / steps);
  }
  if (hold) await page.mouse.up();
  page.__fvMouse = { x: x2, y: y2 };
}

export default {
  id: 'plates',
  film: 1,
  scene: 'plate',
  kind: 'sim-plate',
  duration: 60,
  viewport: PLATE_VIEWPORT,
  videoSize: PLATE_VIEWPORT,
  cursor: false,
  async run(page, api) {
    const T = readTemplate();
    const powers = T.niche.find((n) => n.key === 'powers');
    const urlOf = (proj, key) => proj.windows?.find((w) => w.sim === key)?.simulation_url ?? proj.sims?.[key]?.entry_file;
    const luma = {};

    // ── 1 · KINESIN (needs ≥10 s) ──
    await page.goto(urlOf(T.demo, 'kinesin'), { waitUntil: 'domcontentloaded' });
    luma.kinesin = await waitUntilBright(page, { min: 8, timeoutMs: 45000 });
    await settle(page, 600);
    api.mark('kinesin');
    await dragCanvas(page, 760, 640, 1020, 540, { ms: 2600 });          // orbit the camera
    await sweepRange(page, 0, 0.95, { ms: 3000 });                      // Cycle position → forward
    await sweepRange(page, 0, 0.15, { ms: 3000 });                      // …and back
    await dragCanvas(page, 900, 520, 720, 600, { ms: 2200 });           // settle the camera
    await settle(page, 800);
    api.mark('kinesin-end');

    // ── 2 · SOLAR SYSTEM (≥10 s) ──
    await page.goto(urlOf(T.demo, 'solarSystem'), { waitUntil: 'domcontentloaded' });
    luma.solar = await waitUntilBright(page, { min: 6, timeoutMs: 45000 });
    await settle(page, 900);
    api.mark('solar');
    await sweepRange(page, 0, 0.85, { ms: 2200 });                      // Time lapse up: orbits move
    const focus = page.locator('select').first();
    await focus.selectOption({ label: 'Jupiter' }).catch(() => {});     // the camera flies to it
    await settle(page, 3200);
    await dragCanvas(page, 900, 560, 1120, 500, { ms: 2000 });          // parallax while it orbits
    await focus.selectOption({ label: 'Overview' }).catch(() => {});
    await settle(page, 3000);
    api.mark('solar-end');

    // ── 3 · MURMURATION (≥9 s) ──
    await page.goto(urlOf(T.demo, 'murmuration'), { waitUntil: 'domcontentloaded' });
    luma.murmuration = await waitUntilBright(page, { min: 4, timeoutMs: 45000 });
    await settle(page, 600);
    api.mark('murmuration');
    await dragCanvas(page, 500, 700, 1100, 400, { ms: 2600, hold: false });   // the flock follows the pointer
    await dragCanvas(page, 1100, 400, 700, 620, { ms: 2200, hold: false });
    await page.getByRole('button', { name: 'Scatter' }).click({ force: true }).catch(() => {});
    await settle(page, 2600);                                            // scatter, then re-form
    await dragCanvas(page, 700, 620, 1000, 520, { ms: 2400, hold: false });
    await settle(page, 600);
    api.mark('murmuration-end');

    // ── 4 · ORBIT LAB (≥14 s) ──
    await page.goto(urlOf(powers, 'orbitLab'), { waitUntil: 'domcontentloaded' });
    luma.orbitlab = await waitUntilBright(page, { min: 4, timeoutMs: 45000 });
    await settle(page, 700);
    api.mark('orbitlab');
    await dragCanvas(page, 620, 430, 780, 520, { ms: 1600 });            // launch: the drag is its velocity
    await settle(page, 4200);                                            // it falls into orbit
    await dragCanvas(page, 1250, 700, 1060, 600, { ms: 1600 });          // a second planet
    await settle(page, 4600);
    await sweepRange(page, 1, 0.6, { ms: 1400 });                        // nudge Time speed
    await settle(page, 2600);
    api.mark('orbitlab-end');

    const m = api.marks;
    const cut = (id, from, to, min) => ({ id, from, to: Math.max(to, from + min), film: 1, scene: 'plate' });
    return {
      cuts: [
        // NOTE: no plate-kinesin here. Standalone, the kinesin package shows its full panel —
        // including the "ASSET PROOF" eyebrow the owner objected to in the teaser's hook. That
        // plate is recorded THROUGH the demo window, where the section's Minimal UI hides it:
        // captures/shots/plate-kinesin.mjs. The kinesin leg above still runs so the take's timing
        // is unchanged, and its footage is simply not cut.
        { ...cut('plate-solar', m.solar, m['solar-end'], 10), note: `full-frame solar package, time-lapse up + flight to Jupiter (mean luma at start ${luma.solar})` },
        { ...cut('plate-murmuration', m.murmuration, m['murmuration-end'], 9), note: `full-frame murmuration package, pointer sweep + Scatter + re-form (mean luma at start ${luma.murmuration})` },
        { ...cut('plate-orbitlab', m.orbitlab, m['orbitlab-end'], 14), note: `full-frame orbit-lab package, two planets launched by drag (mean luma at start ${luma.orbitlab})` },
      ],
    };
  },
};
