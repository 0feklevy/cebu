// Film 1 · Scene 10 — the zoom-out inside the product: the capture profile's OWN "Welcome to Flow
// Video" clone in the editor, framed tight on the timeline's live-window blocks (one hovered so it
// glows), then a slow pull-back until the whole editor reads. ~8 s. Camera move = a transform on
// <body> (setZoom/pullBack); the product is untouched.
import { settle, openEditor, setZoom, pullBack, easeMove, V3_VIEWPORT, WELCOME_CLONE } from '../shot-utils.mjs';

export default {
  id: 'f1-s7-zoomout',
  film: 1,
  scene: '7',
  kind: 'editor',
  duration: 8,
  viewport: V3_VIEWPORT,
  cursor: false,                                        // a drawn cursor would slide under the body transform
  async run(page, api) {
    await openEditor(page, api, WELCOME_CLONE);
    await settle(page, 1500);

    const tl = await page.locator('[data-tour="timeline"]').boundingBox();
    const blocks = page.locator('[data-tour="timeline"] [role="group"][aria-label^="SIM"]');
    await blocks.first().waitFor({ timeout: 20000 });
    const n = await blocks.count();
    // Frame on the middle of the SIM blocks.
    let minX = Infinity, maxX = -Infinity, cy = tl.y + tl.height * 0.5;
    for (let i = 0; i < n; i++) { const b = await blocks.nth(i).boundingBox(); if (!b) continue; minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x + b.width); cy = b.y + b.height / 2; }
    const cx = (minX + maxX) / 2;

    await setZoom(page, 1.7, cx, cy);
    await settle(page, 500);
    // Hover the first SIM block (position re-read under the transform) so it lights up.
    const hb = await blocks.first().boundingBox();
    await easeMove(page, hb.x + hb.width / 2, hb.y + hb.height / 2, { ms: 500 });
    api.mark('start');
    await settle(page, 1300);
    api.mark('pullback');
    await pullBack(page, { from: 1.7, to: 1, cx, cy, ms: 5000 });
    api.mark('wide');
    await settle(page, 1800);
    api.mark('end');
    return { trim: { from: 'start', to: 'end', padBefore: 0.3 }, note: `${n} SIM blocks on the clone's timeline` };
  },
};
