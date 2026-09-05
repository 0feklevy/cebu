// Film 4 · Scene 1 (and the fallback under seven beats across the films) — the DEMO's public page
// PLAYING: no ▶ poster, progress bar moving. Playback is started through the player's own play
// control; the file begins 1 s later and runs through the film-only stretch after the murmuration
// window (52 s → ~77 s), before the closing doors. ~24 s. The cursor is parked at the frame's edge.
import { settle, openShare, muteAll, totalOf, scrubTo, videoTime, pollUntil, glideClick, easeMove, readTemplate, V3_VIEWPORT } from '../shot-utils.mjs';

export default {
  id: 'f4-s1-public-page',
  film: 4,
  scene: '1',
  kind: 'viewer',
  duration: 24,
  viewport: V3_VIEWPORT,
  cursor: true,
  async run(page, api) {
    const T = readTemplate();
    await openShare(page, T.demo.shareUrl);
    await muteAll(page);
    const total = (await totalOf(page)) ?? 79;
    await scrubTo(page, 53, total).catch(() => {});          // seek (paused) into the film-only tail
    await settle(page, 900);
    await muteAll(page);
    // .first(): the viewer shell renders a play control per player surface, so the bare role query
    // is a strict-mode violation.
    const play = page.getByRole('button', { name: 'Play or pause' }).first();
    await glideClick(page, play, { pauseBefore: 500, pauseAfter: 0, ms: 600 });
    await pollUntil(() => page.evaluate(() => [...document.querySelectorAll('video')].some(v => !v.paused)), { timeoutMs: 8000, intervalMs: 100, label: 'video playing' });
    await settle(page, 1000);
    api.mark('start');
    await easeMove(page, 1590, 890, { ms: 900 });             // cursor out of the way; controls fade on idle
    await pollUntil(async () => ((await videoTime(page)) ?? 0) >= 77, { timeoutMs: 40000, intervalMs: 150, label: 't ≥ 77' });
    api.mark('end');
    return { trim: { from: 'start', to: 'end' }, note: 'playing 53→77 s of the demo (film only, no window)' };
  },
};
