// Film 1 · Beat 1 — "This looks like a video."
//
// A dead-ordinary shared video playing on its public page: play bar ticking, calm, a trap. Shot on
// the DOORS project (`One Link, Three Doors`), the one seeded project with NO simulation sections,
// so the page is a plain video the whole way through — the demo's own page cannot supply this beat,
// because the demo project IS this film and every moment of it plays inside one of its own windows.
//
// The stretch is chosen from the master, not guessed: `film5.SCRATCH.mp4` is a screen recording of
// the editor around 12 s, and a full-frame Wave Lab ripple from ~22 s to ~42 s (mean luma ~87
// throughout). This sits inside that band.
//
// Stillness is the point: no cursor motion, no interaction. The pointer is parked over the control
// bar before the take so the page chrome the beat needs — the Ask! pill and the section-free
// progress bar — stays in frame, and then it does not move again.
import { settle, openShare, startPlayback, totalOf, scrubTo, isPlaying, presentedSim, progressBar, videoTime, holdWithChrome, pollUntil, readTemplate, V3_VIEWPORT } from '../shot-utils.mjs';

const START_SEC = 26;          // inside the wave-lab stretch (22-42 s of the master)
const HOLD_SEC = 9.5;

export default {
  id: 'f1-s1-ordinary-video',
  film: 1,
  scene: '1',
  kind: 'viewer',
  duration: 10,
  viewport: V3_VIEWPORT,
  cursor: false,                                   // no drawn pointer: the frame must read as a plain video
  async run(page, api) {
    const T = readTemplate();
    const doors = T.niche.find((n) => n.key === 'doors');
    if (!doors?.shareUrl) throw new Error('no doors project in TEMPLATE.json');
    if ((doors.windows?.length ?? 0) > 0) throw new Error('the doors project now has live windows — it is no longer a plain video');

    await openShare(page, doors.shareUrl);
    const total = (await totalOf(page)) ?? doors.video.duration_sec;
    await scrubTo(page, START_SEC, total);
    await startPlayback(page);                     // Space; never a click on the frame
    await pollUntil(() => isPlaying(page), { timeoutMs: 10000, intervalMs: 150, label: 'the film rolling' });

    // Park the pointer on the control bar so the chrome stays up, then leave it alone.
    const bar = await progressBar(page);
    if (bar) { await page.mouse.move(bar.x + bar.w * 0.5, bar.y + 24); page.__fvMouse = { x: bar.x + bar.w * 0.5, y: bar.y + 24 }; }
    await settle(page, 700);

    if (await presentedSim(page)) throw new Error('a live window is presented — this beat must be a plain video');
    const t0 = await videoTime(page);
    api.mark('start');
    await holdWithChrome(page, HOLD_SEC * 1000);        // chrome stays up; nothing visibly moves
    api.mark('end');
    const chromeUp = await page.evaluate(() => !!document.querySelector('.viewer-root.controls-visible'));
    const t1 = await videoTime(page);
    const advanced = (t1 ?? 0) - (t0 ?? 0);
    if (advanced < HOLD_SEC * 0.6) throw new Error(`the play head barely moved (${advanced.toFixed(1)}s in ${HOLD_SEC}s) — the bar would not read as ticking`);
    return {
      trim: { from: 'start', to: 'end' },
      note: `doors share page, plain video ${t0?.toFixed(1)}→${t1?.toFixed(1)}s of the master (wave-lab stretch), play head advanced ${advanced.toFixed(1)}s, chrome ${chromeUp ? 'in frame throughout' : 'HIDDEN at the cut'}, no sim sections on this project`,
    };
  },
};
