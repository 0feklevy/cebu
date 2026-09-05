// Film 4 · Scene 1, and the "back on the public page" bed under films 3, 4 and 5 (the four-power
// grid, the close) — the public page simply PLAYING, long enough for the EDLs' `in` offsets.
//
// Shot on the DOORS project, not the demo: the demo master is itself a screen recording of this
// product, so its first half is an editor with an empty project and a preview pane — the opposite
// of "an ordinary shared page". The doors project has no simulation sections, and its master runs a
// full-frame Wave Lab ripple from ~22 s to ~42 s (luma ~87), which is what this take covers.
//
// Playback starts with Space (a click on the play control times out on its stability check; a click
// on the frame inside a live window would pause the film). The pointer is parked on the control bar
// so the page chrome stays in frame, and then stays put.
import { settle, openShare, startPlayback, totalOf, scrubTo, isPlaying, presentedSim, progressBar, videoTime, holdWithChrome, pollUntil, readTemplate, V3_VIEWPORT } from '../shot-utils.mjs';

const START_SEC = 21.5;        // the wave-lab stretch; ends ~43.5 s, before the master darkens at ~46 s
const HOLD_SEC = 22;

export default {
  id: 'f4-s1-public-page',
  film: 4,
  scene: '1',
  kind: 'viewer',
  duration: 23,
  viewport: V3_VIEWPORT,
  cursor: false,
  async run(page, api) {
    const T = readTemplate();
    const doors = T.niche.find((n) => n.key === 'doors');
    if (!doors?.shareUrl) throw new Error('no doors project in TEMPLATE.json');

    await openShare(page, doors.shareUrl);
    const total = (await totalOf(page)) ?? doors.video.duration_sec;
    await scrubTo(page, START_SEC, total);
    await startPlayback(page);
    await pollUntil(() => isPlaying(page), { timeoutMs: 10000, intervalMs: 150, label: 'the film rolling' });

    const bar = await progressBar(page);
    if (bar) { await page.mouse.move(bar.x + bar.w * 0.5, bar.y + 24); page.__fvMouse = { x: bar.x + bar.w * 0.5, y: bar.y + 24 }; }
    await settle(page, 700);
    if (await presentedSim(page)) throw new Error('a live window is presented — this bed must be a plain video');

    const t0 = await videoTime(page);
    api.mark('start');
    await holdWithChrome(page, HOLD_SEC * 1000);        // chrome stays up; nothing visibly moves
    api.mark('end');
    const chromeUp = await page.evaluate(() => !!document.querySelector('.viewer-root.controls-visible'));
    const t1 = await videoTime(page);
    const advanced = (t1 ?? 0) - (t0 ?? 0);
    if (advanced < HOLD_SEC * 0.6) throw new Error(`the play head barely moved (${advanced.toFixed(1)}s in ${HOLD_SEC}s)`);
    return {
      trim: { from: 'start', to: 'end' },
      note: `doors share page playing ${t0?.toFixed(1)}→${t1?.toFixed(1)}s of the master (wave-lab stretch), play head advanced ${advanced.toFixed(1)}s, chrome ${chromeUp ? 'in frame throughout' : 'HIDDEN at the cut'}`,
    };
  },
};
