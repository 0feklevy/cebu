// Film 2 · Scenes 11-12 — the tutorial's OWN project ("Tour the Solar System", STAGE2) with its
// solar window block selected and the "Generate mini model" card open (the verbatim prompt f2-s4
// just generated), framed tight on the card, then a slow pull-back to the whole editor. ~8 s.
// Run AFTER f2-s4-this-moment (which leaves that section generated + saved) and BEFORE the montage
// (which clears the project's sections again).
// PRODUCT REALITY: the section editor is a centred modal (SectionEditor.tsx:1901, 90vw × ≤820px)
// with the card in its LEFT column; the timeline strip shows under the modal's bottom edge.
// Not shot on the Welcome clone: its solar section's preview no longer boots (stuck on the sim's
// "FORMING THE SOLAR SYSTEM…" screen for 30 s+, twice) after the bridge generated for it earlier
// today — recorded in the report; the clone itself is left untouched.
import { settle, readStage2, openEditor, openBlock, revealCard, setZoom, pullBack, pollUntil, V3_VIEWPORT } from '../shot-utils.mjs';

/**
 * True while the Solar System package's boot screen is actually ON SCREEN.
 *
 * Must test VISIBILITY, not presence: the package leaves its "FORMING THE SOLAR SYSTEM…" node in
 * the DOM after the scene renders, so an innerText match reports a dead preview over a perfectly
 * live one (this shot was filed "still booting" while its own frames showed Saturn and Uranus).
 */
async function simBooting(page) {
  for (const f of page.frames()) {
    try {
      const visible = await f.evaluate(() => {
        const el = [...document.querySelectorAll('*')]
          .find((e) => e.childElementCount === 0 && /FORMING THE SOLAR SYSTEM/i.test(e.textContent ?? ''));
        if (!el) return false;
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
      });
      if (visible) return true;
    } catch { /* detached */ }
  }
  return false;
}

export default {
  id: 'f2-s9-zoomout',
  film: 2,
  scene: '9',
  kind: 'editor',
  duration: 8,
  viewport: V3_VIEWPORT,
  cursor: false,
  async run(page, api) {
    const { tourProjectId } = readStage2();
    if (!tourProjectId) throw new Error('no tourProjectId in STAGE2.json');
    await openEditor(page, api, tourProjectId);
    await settle(page, 1200);

    await openBlock(page, 'SIM', { glide: false });   // selected → Edit Section
    const title = await revealCard(page);
    await settle(page, 1500);
    const booted = await pollUntil(async () => !(await simBooting(page)), { timeoutMs: 30000, intervalMs: 500, label: 'sim preview booted' })
      .then(() => true).catch(() => false);
    await settle(page, 1200);

    const tb = await title.boundingBox();
    const cx = tb.x + tb.width / 2 + 40, cy = tb.y + 190;    // the card body (prompt + switches)
    await setZoom(page, 1.5, cx, cy);
    await settle(page, 400);
    api.mark('start');
    await settle(page, 1400);
    api.mark('pullback');
    await pullBack(page, { from: 1.5, to: 1, cx, cy, ms: 5000 });
    api.mark('wide');
    await settle(page, 1800);
    api.mark('end');
    return { trim: { from: 'start', to: 'end', padBefore: 0.3 }, note: booted ? 'sim preview booted before the move' : 'PREVIEW STILL BOOTING after 30 s (black pane with "FORMING THE SOLAR SYSTEM…")' };
  },
};
