// Film 2 · Scene 1 — the opener: the DEMO's public share page inside the SOLAR-SYSTEM window (the
// live planets over the film, ~26 s), framed tight on the planets, then a pull-back that reveals
// the page around the player (controls, section markers, Ask!). ~7 s.
//
// The window is verified BY IDENTITY, not by clock: seeking into a window does not always swap the
// presented layer, and an earlier take recorded the kinesin motor at 0:26 with the film paused
// behind a ▶ overlay. This one waits until the presented iframe is the demo's solarSystem package
// AND the film is rolling, and it enters the window by playing into it rather than scrubbing on
// top of another window's layer.
import { settle, openShare, muteAll, ensurePlaying, totalOf, scrubTo, waitSimPresentedMatching, setZoom, pullBack, readTemplate, V3_VIEWPORT } from '../shot-utils.mjs';

export default {
  id: 'f2-s1-pullback',
  film: 2,
  scene: '1',
  kind: 'viewer',
  duration: 7,
  viewport: V3_VIEWPORT,
  cursor: false,
  async run(page, api) {
    const T = readTemplate();
    const solarId = T.demo.sims.solarSystem.id;
    await openShare(page, T.demo.shareUrl);
    await muteAll(page);
    const total = (await totalOf(page)) ?? 79;
    // Land in the film-only gap BEFORE the solar window [25,36] (the kinesin window ends at 15),
    // then play into it — so the layer swap is the product's own, not a seek across two windows.
    await scrubTo(page, 21, total).catch(() => {});
    await ensurePlaying(page);
    await settle(page, 600);
    const sim = await waitSimPresentedMatching(page, solarId, { timeoutMs: 40000 });
    api.mark('sim-presented');
    await page.mouse.move(sim.x + sim.w * 0.5, sim.y + sim.h * 0.92); // pointer parked low, off the planets
    await settle(page, 1400);

    const cx = sim.x + sim.w / 2, cy = sim.y + sim.h / 2;
    await setZoom(page, 1.35, cx, cy);
    await settle(page, 400);
    api.mark('start');
    await settle(page, 1400);
    api.mark('pullback');
    await pullBack(page, { from: 1.35, to: 1, cx, cy, ms: 4000 });
    api.mark('wide');
    await settle(page, 1500);
    api.mark('end');
    const playing = await page.evaluate(() => [...document.querySelectorAll('video')].some((v) => !v.paused && v.duration));
    return { trim: { from: 'start', to: 'end', padBefore: 0.2 }, note: `solar window presented by identity; film ${playing ? 'playing' : 'PAUSED'} at the cut` };
  },
};
