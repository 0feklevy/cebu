// LIVE-WINDOW PLATE · kinesin — with the panel the owner asked for: the cycle slider and Pause,
// and no "ASSET PROOF" dev label.
//
// PREFERRED PATH: record the simulation as its window presents it, so the section's own Minimal UI
// does the hiding. That is attempted first and is what should be used once the seeding populates a
// hide list.
//
// WHY THE FALLBACK EXISTS (verified 2026-09-05, not assumed): the served share config carries
// `simple_ui: true` for every simulation section but NO hide list — there is no ui-hidden field in
// the payload at all — so the viewer emits `#simboot={"hide":[]}` and Simple UI hides nothing. The
// window therefore shows the full panel, ASSET PROOF included. Until the seeding fills that list,
// this shot uses the product's OWN boot-hide mechanism (`shared/src/sim/simUrl.ts:105`) on the
// section's own package URL, naming the selectors the section's prompt describes in words.
//
// Either way the shot ASSERTS the result — no ASSET PROOF, only the cycle slider, Pause kept — so
// it cannot quietly record the dev label again.
import { settle, openShare, startPlayback, totalOf, scrubTo, waitSimPresentedMatching, presentedSim,
  waitUntilBright, easeMove, readTemplate, PLATE_VIEWPORT } from '../shot-utils.mjs';

const MIN_MOTION_SEC = 15;        // ≥14 s required, plus headroom for the trim

// Everything except the Cycle-position slider and Pause (selectors from probe-kinesin-panel.mjs).
const HIDE = ['.section-heading', '#motor-control', '#restart', '#reset-camera',
  'label.range-field:has(#presentation-rate)', '#advanced-background-control'];

/**
 * The panel state that matters, read inside whichever document is showing the sim.
 * A real function, NOT a string: `evaluate("() => …")` evaluates the string as an expression and
 * hands back the function itself, so the caller gets undefined and every assertion below silently
 * has nothing to check.
 */
const panelProbe = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const labelOf = (el) => (el.closest('label')?.innerText || el.previousElementSibling?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return {
    assetProof: [...document.querySelectorAll('*')].some((e) => e.childElementCount === 0 && /ASSET\s*PROOF/i.test(e.textContent ?? '') && vis(e)),
    ranges: [...document.querySelectorAll('input[type=range]')].filter(vis).map(labelOf),
    buttons: [...document.querySelectorAll('button')].filter(vis).map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20)).filter(Boolean),
    hash: location.hash.slice(0, 140),
  };
};

function assertClean(panel, where) {
  if (panel.assetProof) throw new Error(`"ASSET PROOF" is visible ${where} (hash: ${panel.hash})`);
  if (!panel.ranges.some((r) => /cycle position/i.test(r))) throw new Error(`the Cycle-position slider is not visible ${where} (ranges: ${panel.ranges.join('|') || 'none'})`);
  if (panel.ranges.some((r) => /teaching/i.test(r))) throw new Error(`the Teaching-playback slider is still visible ${where}`);
  if (!panel.buttons.some((b) => /pause|play/i.test(b))) throw new Error(`Pause is not visible ${where} (buttons: ${panel.buttons.join('|') || 'none'})`);
}

export default {
  id: 'plate-kinesin',
  film: 1,
  scene: 'plate',
  kind: 'sim-plate',
  duration: 20,
  viewport: PLATE_VIEWPORT,
  videoSize: PLATE_VIEWPORT,
  cursor: false,
  async run(page, api) {
    const T = readTemplate();                      // re-read: a seeding run rotates every id
    const kin = T.demo.sims.kinesin;
    const win = T.demo.windows.find((w) => w.sim === 'kinesin');
    if (!kin?.id || !win) throw new Error('no kinesin window in TEMPLATE.json');

    // ── Preferred: through the window ──
    let box = null, target = null, via = 'window';
    await openShare(page, T.demo.shareUrl);
    const total = (await totalOf(page)) ?? T.demo.video.duration_sec;
    await scrubTo(page, Math.max(0, win.start_sec - 2), total);
    await startPlayback(page);
    box = await waitSimPresentedMatching(page, kin.id, { timeoutMs: 45000 }).catch(() => null);
    if (box) {
      const frame = page.frames().find((f) => f.url().includes(kin.id));
      const panel = frame ? await frame.evaluate(panelProbe) : null;
      if (panel && !panel.assetProof) { target = frame; }
      else api.mark('window-panel-unclean');       // recorded in the note below
    }

    // ── Fallback: the section's own package URL with the product's boot-hide applied ──
    if (!target) {
      const base = win.simulation_url ?? kin.entry_file;
      const u = new URL(base);
      const author = u.hash.replace(/^#/, '').replace(/(^|&)simboot=[^&]*/g, '$1').replace(/^&|&$/g, '');
      const simboot = 'simboot=' + encodeURIComponent(JSON.stringify({ hide: HIDE }));
      u.hash = author ? `${author}&${simboot}` : simboot;
      via = 'package URL + boot-hide';
      await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
      target = page.mainFrame();
      box = { x: 0, y: 0, w: PLATE_VIEWPORT.width, h: PLATE_VIEWPORT.height };
    }

    await waitUntilBright(page, { min: 8, timeoutMs: 45000 });
    await settle(page, 600);
    const panel = await target.evaluate(panelProbe);
    assertClean(panel, `via the ${via}`);
    api.mark('verified');

    // ── Drive it: the motor walks, the camera moves ──
    const cx = box.x + box.w * 0.42, cy = box.y + box.h * 0.62;
    const orbit = async (x1, y1, x2, y2, ms) => {
      await easeMove(page, x1, y1, { ms: 300 });
      await page.mouse.down();
      const steps = Math.max(12, Math.round(ms / 60));
      for (let i = 1; i <= steps; i++) { await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps); await page.waitForTimeout(ms / steps); }
      await page.mouse.up();
    };
    const sweepCycle = async (frac, ms) => {
      const r = await target.evaluate(() => {
        const el = document.querySelector('#timeline') ?? document.querySelector('input[type=range]');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height, v: Number(el.value), min: Number(el.min || 0), max: Number(el.max || 1) };
      });
      if (!r) return false;
      const y = box.y + r.y + r.h / 2;
      const startX = box.x + r.x + r.w * ((r.v - r.min) / ((r.max - r.min) || 1));
      const targetX = box.x + r.x + r.w * Math.max(0, Math.min(1, frac));
      await page.mouse.move(startX, y);
      await page.mouse.down();
      const steps = Math.max(10, Math.round(ms / 60));
      for (let i = 1; i <= steps; i++) { await page.mouse.move(startX + ((targetX - startX) * i) / steps, y); await page.waitForTimeout(ms / steps); }
      await page.mouse.up();
      return true;
    };

    api.mark('start');
    await orbit(cx, cy, cx + 260, cy - 110, 2600);       // in the window this also pauses the film, holding it open
    const swept = await sweepCycle(0.95, 3400);
    await settle(page, 300);
    await sweepCycle(0.12, 3400);
    await settle(page, 300);
    await orbit(cx + 180, cy - 60, cx - 60, cy + 60, 2600);
    await sweepCycle(0.6, 2200);
    while (api.now() - api.marks.start < MIN_MOTION_SEC) {
      await orbit(cx, cy, cx + 150, cy - 70, 1500);
      await orbit(cx + 150, cy - 70, cx, cy, 1500);
    }
    api.mark('end');

    const stillUp = via === 'window' ? !!(await presentedSim(page)) : null;
    return {
      trim: { from: 'start', to: 'end' },
      note: `kinesin plate via the ${via}; panel = ranges[${panel.ranges.join('|')}] buttons[${panel.buttons.join('|')}], no ASSET PROOF${swept ? '' : ' (cycle slider not draggable — orbit only)'}` +
        (via === 'window' ? `; window ${stillUp ? 'still presented' : 'closed before the cut'}` : '; NOTE the served section carries simple_ui=true with an EMPTY hide list, so the window itself would have shown the dev label'),
    };
  },
};
