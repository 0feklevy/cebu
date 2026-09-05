// Film 1 · Scene 7 — the DEMO public page right after the solar-system window closes: back on the
// film, Ask! button and section markers visible, cursor drifting. Window at [25, 36] on the served
// template. ~10 s; the file starts ~5 s before the return (EDL in: 5).
// Cut keyed to the product's own window exit, not to video.currentTime (see f1-s3-return).
import { settle, openShare, startPlayback, totalOf, scrubTo, waitSimPresented, waitWindowExit, ensurePlaying, easeMove, drift, readTemplate, V3_VIEWPORT } from '../shot-utils.mjs';

export default {
  id: 'f1-s7-return',
  film: 1,
  scene: '7',
  kind: 'viewer',
  duration: 10,
  viewport: V3_VIEWPORT,
  cursor: true,
  async run(page, api) {
    const T = readTemplate();
    await openShare(page, T.demo.shareUrl);
    await startPlayback(page);
    const total = (await totalOf(page)) ?? 79;
    await scrubTo(page, 28, total);                     // into the solar window [25,36]
    await waitSimPresented(page, 25000);
    api.mark('sim-presented');
    await ensurePlaying(page);                          // the window cannot exit while paused
    await easeMove(page, 1200, 600, { ms: 600 });
    const drifting = drift(page, [[1260, 540], [1120, 660], [1330, 620], [1200, 580]], { ms: 2000, pause: 300 });
    await waitWindowExit(page, 45000);
    api.mark('returned');
    await drifting.catch(() => {});
    await drift(page, [[1150, 620], [1300, 560], [1220, 600]], { ms: 1800, pause: 300 });
    api.mark('end');
    await settle(page, 400);
    return {
      trim: { from: Math.max(0, api.marks.returned - 5), to: 'end' },
      note: 'solar window [25,36] on the served template; cut keyed to the window\'s own exit',
    };
  },
};
