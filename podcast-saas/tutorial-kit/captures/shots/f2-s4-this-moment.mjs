// Film 2 · Scene 4 — the owner's thesis beat on the tutorial's OWN project ("Tour the Solar System",
// STAGE2 tourProjectId): a fresh video section is opened, type → Simulation, the Solar System
// package is picked, the "Generate mini model" card appears, HOLD, the script's verbatim prompt is
// typed, Minimal UI then Auto script are flipped, ✦ Generate with AI — held on the generating state.
// Editor's pacing (CARD_PACING). The section is recreated fresh off camera (as before) so the
// generation is a true first run; the generation finishes after the cut and the state is saved.
import { settle, readStage2, dismissTour, tokenSniffer, openBlock, revealCard, setSwitch, glideClick, glideTo, easeMove, pollUntil, clearSections, ensureTitle, cardBeat, V3_VIEWPORT } from '../shot-utils.mjs';

const SIM_NAME = 'Solar System';
const PROMPT = 'Give viewers the planets — let them speed up time and fly to any world';

export default {
  id: 'f2-s4-this-moment',
  film: 2,
  scene: '4',
  kind: 'editor-flow',
  duration: 24,
  viewport: V3_VIEWPORT,
  cursor: true,
  async run(page, api) {
    const { tourProjectId } = readStage2();
    if (!tourProjectId) throw new Error('no tourProjectId in STAGE2.json');

    const getTok = tokenSniffer(page);
    await page.goto(`${api.APP}/projects/${tourProjectId}/editor`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
    await dismissTour(page);
    const tok = await getTok();
    if (!tok) throw new Error('no Bearer token sniffed');

    // Off camera: a FRESH marked section (a re-run on an unchanged section replays the stored bridge instantly).
    await ensureTitle(api, tok, tourProjectId, 'Tour the Solar System');
    await clearSections(api, tok, tourProjectId);
    const vres = await fetch(`${api.API}/api/v1/projects/${tourProjectId}/videos`, { headers: { Authorization: `Bearer ${tok}` } });
    const vbody = await vres.json();
    const videos = Array.isArray(vbody) ? vbody : vbody.videos ?? [];
    if (!videos.length) throw new Error('tour project has no video');
    const cres = await fetch(`${api.API}/api/v1/projects/${tourProjectId}/sections`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ video_file_id: videos[0].id, start_sec: 7.5, end_sec: 22.5, type: 'video' }),
    });
    if (!cres.ok) throw new Error(`section re-create failed: ${cres.status}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
    await dismissTour(page);
    await settle(page);

    // On camera.
    await easeMove(page, 700, 420, { ms: 300 });
    api.mark('start');
    await openBlock(page, 'VIDEO');                                   // (a) the section opens…
    api.mark('editor-open');
    await glideClick(page, page.getByRole('button', { name: 'Simulation', exact: true }), { pauseBefore: 450, pauseAfter: 600 });
    api.mark('type-simulation');                                      // …type "Simulation" picked
    const sel = page.locator('[data-tour="sec-sim-select"] select');
    await sel.waitFor({ timeout: 10000 });
    await pollUntil(async () => (await sel.locator('option').allTextContents()).some((l) => l.trim() === SIM_NAME),
      { timeoutMs: 60000, intervalMs: 2000, label: `"${SIM_NAME}" in the package dropdown` });
    await glideTo(page, sel, { pause: 500 });
    await sel.selectOption({ label: SIM_NAME });
    api.mark('package-picked');
    await revealCard(page);
    await setSwitch(page, 'simple', false);
    await setSwitch(page, 'auto', false);

    const gen = await cardBeat(page, api, PROMPT);                    // (b) typing, (c) switches + Generate
    return {
      trim: { from: 'start', to: 'held', padBefore: 0.3 },
      note: gen.ok ? 'generation completed after the cut' : `GENERATION FAILED after the cut: ${gen.error}`,
    };
  },
};
