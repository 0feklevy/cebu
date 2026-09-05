// Film 1 · Scene 3 — the DEMO public page in the seconds right after the kinesin live window
// auto-returns to the film: the section marker on the progress bar, the film swelling back.
// The window sits at [4, 15] on the served template. ~7 s, cursor drifting.
//
// The cut is keyed off the PRODUCT's own exit (the presented sim iframe going away), not off
// video.currentTime — during a live window the film's own clock is not a reliable trigger, and
// polling it is what made an earlier take time out with the shot itself working fine.
import { settle, openShare, startPlayback, totalOf, scrubTo, waitSimPresented, waitWindowExit, ensurePlaying, easeMove, drift, readTemplate, V3_VIEWPORT } from '../shot-utils.mjs';

export default {
  id: 'f1-s3-return',
  film: 1,
  scene: '3',
  kind: 'viewer',
  duration: 7,
  viewport: V3_VIEWPORT,
  cursor: true,
  async run(page, api) {
    const T = readTemplate();
    await openShare(page, T.demo.shareUrl);
    await startPlayback(page);
    const total = (await totalOf(page)) ?? 79;
    await scrubTo(page, 7.5, total);                    // into the kinesin window [4,15]
    await waitSimPresented(page, 25000);
    api.mark('sim-presented');
    await ensurePlaying(page);                          // the window cannot exit while paused
    await easeMove(page, 1180, 620, { ms: 600 });
    // Drift while the window plays out; the return is the beat.
    const drifting = drift(page, [[1240, 560], [1150, 640], [1300, 600], [1200, 560]], { ms: 1800, pause: 250 });
    await waitWindowExit(page, 45000);
    api.mark('returned');
    await drifting.catch(() => {});
    await drift(page, [[1120, 620], [1280, 580]], { ms: 1700, pause: 300 });
    api.mark('end');
    await settle(page, 400);
    return {
      // ~2.5 s of the window still up, then the return and the film continuing (EDL in: 2).
      trim: { from: Math.max(0, api.marks.returned - 2.5), to: 'end' },
      note: 'kinesin window [4,15] on the served template; cut keyed to the window\'s own exit',
    };
  },
};
