// Film 4 · Scenes 8-9 / Film 5 · Scene 6 — the DEMO share page in a phone frame (390×844, device
// scale 3). Part 1: the film playing, the murmuration window presenting, a tap on the flock, and
// the product's own "Resume video →" to come back. Part 2 (lands ~12 s in, EDL in: 12): the CC
// toggle switching on over the playing film.
//
// TWO THINGS LEARNED ON CAMERA (2026-09-05), both recorded here so the next take keeps them:
//  1. recordVideo.size must EQUAL the viewport. Recording 780×1688 for a 390×844 viewport does not
//     upscale — it pads the frame grey and leaves the page in the top-left corner.
//  2. Tapping a presented sim PAUSES the film (a "Resume video →" button appears). The window then
//     stays up until the viewer resumes, so a shot that taps and then waits for the auto-return
//     waits forever — the earlier take sat in the window for 24 s and landed CC at 28 s.
//
// The Audio-language ("Original") beat is deliberately NOT shot (owner steer 2026-09-05): that row
// renders only when a dub exists — `hasLanguages = audioLanguages.length > 0 && onLanguageChange`
// (ControlsBar.tsx:102, rendered :270-292) — and the demo has none, so any shot of it would be
// staged. There is no true shot of that beat on this data.
import { settle, openShare, muteAll, totalOf, scrubTo, waitSimPresented, waitSimGone, ensurePlaying, pollUntil, readTemplate } from '../shot-utils.mjs';

export default {
  id: 'f5-s5-phone',
  film: 5,
  scene: '5',
  kind: 'viewer-mobile',
  duration: 16,
  viewport: { width: 390, height: 844 },
  videoSize: { width: 390, height: 844 },
  contextOptions: { isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  cursor: false,
  async run(page, api) {
    const T = readTemplate();
    await openShare(page, T.demo.shareUrl);
    await muteAll(page);
    await settle(page, 500);

    api.mark('start');
    await page.touchscreen.tap(195, 300);                     // play
    await settle(page, 1200);
    await ensurePlaying(page);
    api.mark('playing');
    const total = (await totalOf(page)) ?? 79;
    await scrubTo(page, 46, total).catch(() => {});           // inside the murmuration window [45,52]
    const sim = await waitSimPresented(page, 20000);
    api.mark('flock-presented');
    await settle(page, 1100);
    await page.touchscreen.tap(sim.x + sim.w * 0.5, sim.y + sim.h * 0.55);   // steer the flock (pauses the film)
    api.mark('tap-flock');
    await settle(page, 1600);

    // Come back the way the product asks — the window will not exit while the film is paused.
    const resume = page.getByRole('button', { name: /resume video|go back to video/i }).first();
    await resume.tap({ timeout: 8000 }).catch(() => {});
    api.mark('resume');
    await waitSimGone(page, 20000).catch(() => {});
    await ensurePlaying(page);
    api.mark('returned');

    // Part 2 at ~12 s (EDL in: 12): CC on, over the playing film.
    while (api.now() - api.marks.start < 11.4) await page.waitForTimeout(120);
    const cc = page.getByRole('button', { name: 'Closed captions', exact: true });
    try { await cc.tap({ trial: true, timeout: 2000 }); }
    catch { await page.touchscreen.tap(195, 800); await settle(page, 700); }   // wake the controls (low, NOT on the frame: a frame tap pauses the film)
    api.mark('cc-reach');
    await cc.tap({ timeout: 8000 });
    const on = await pollUntil(() => cc.getAttribute('aria-pressed').then((v) => v === 'true'),
      { timeoutMs: 8000, intervalMs: 150, label: 'CC pressed' }).then(() => true).catch(() => false);
    api.mark('cc-on');
    await settle(page, 3000);                                 // hold on the caption line
    api.mark('end');
    const playing = await page.evaluate(() => [...document.querySelectorAll('video')].some((v) => !v.paused && v.duration));
    return {
      trim: { from: 'start', to: 'end', padBefore: 0.2 },
      note: `${on ? 'CC toggled ON (aria-pressed=true)' : 'CC TAPPED BUT aria-pressed NEVER TURNED TRUE — check the frames'}; film ${playing ? 'playing' : 'PAUSED'} at the cut. Audio-language beat not shot: no dub exists for the demo, so the row cannot render`,
    };
  },
};
