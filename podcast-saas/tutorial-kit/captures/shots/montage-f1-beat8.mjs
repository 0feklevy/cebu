// Film 1 · Beat 8 — five ≈2.5 s montage sub-cuts, all real product gestures in ONE editor session
// on the capture profile's scratch "Tour the Solar System" project (sections cleared off camera
// first, as f2-s4 does), plus the Share sheet on the Welcome clone (whose header still reads
// "Create link"). The driver cuts the raw take into:
//   montage-1-drop      captures/props/solar-system.zip dropped into the Library (overlay → card)
//   montage-2-mark      a drag across the V1 clip marks a section → Edit Section opens
//   montage-3-card      the Generate mini model card with a prompt (typing in progress)
//   montage-4-generate  ✦ Generate with AI pressed → generating
//   montage-5-share     Create link → "Share this video" sheet
// The card flow follows the editor's pacing (CARD_PACING); the cuts are windows on it.
// PRODUCT REALITY on "drop a sim onto the timeline": nothing in the editor drags a library sim onto
// the timeline (only audio cards drag, to A2 — VideoEditor.tsx:1793); sims are dropped INTO the
// library and attached to a section from the section editor's Simulation select. Shot as such.
import { join } from 'node:path';
import { settle, readStage2, dismissTour, tokenSniffer, trackRects, dragMouse, pollUntil, clearSections, ensureTitle, glideClick, glideTo, easeMove, revealCard, setSwitch, clickGenerate, awaitGeneration, saveSection, typeSlowKeys, CARD_PACING, V3_VIEWPORT, WELCOME_CLONE } from '../shot-utils.mjs';

const PROMPT = 'Give viewers the planets — let them speed up time and fly to any world';

export default {
  id: 'montage',
  film: 1,
  scene: '8',
  kind: 'editor-flow',
  duration: 13,
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

    // Off camera: a clean V1 for the marking beat.
    await ensureTitle(api, tok, tourProjectId, 'Tour the Solar System');
    await clearSections(api, tok, tourProjectId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
    await dismissTour(page);
    await pollUntil(async () => (await trackRects(page))?.clip, { timeoutMs: 60000, intervalMs: 2000, label: 'V1 clip block' });
    await settle(page, 800);

    // ── 1 · drop the Solar System package into the Library ──
    // Wait on the CARD COUNT, not on a name: the uploader names a bundle from its own manifest
    // (or the file stem), so a name match can miss a card that really did land. Every simulation
    // card carries exactly one "Rename simulation" button (VideoEditor library panel).
    const lib = page.locator('[data-tour="library"]');
    const simCards = lib.locator('[title="Rename simulation"]');
    const simsBefore = await simCards.count();
    await glideTo(page, lib, { pause: 300, ms: 700, dy: -60 });
    api.mark('drop');
    await api.dropFiles(page, '[data-tour="library"]', [
      { name: 'solar-system.zip', type: 'application/zip', path: join(api.propsDir, 'solar-system.zip') },
    ]);
    await pollUntil(async () => (await simCards.count()) > simsBefore, { timeoutMs: 90000, intervalMs: 300, label: `a new simulation card (had ${simsBefore})` });
    api.mark('card-landed');
    await settle(page, 1200);

    // ── 2 · mark a section on the timeline ──
    const { clip } = await trackRects(page);
    const y = clip.y + clip.h / 2;
    await easeMove(page, clip.x + clip.w * 0.15, y, { ms: 800 });
    await settle(page, 350);
    api.mark('mark');
    await dragMouse(page, clip.x + clip.w * 0.15, y, clip.x + clip.w * 0.60, y, 16, 75);
    page.__fvMouse = { x: clip.x + clip.w * 0.60, y };
    await page.getByText('Edit Section', { exact: true }).waitFor({ timeout: 10000 });
    api.mark('section-open');
    await settle(page, 1200);

    // ── 3 · the Generate mini model card with a prompt (paced) ──
    await glideClick(page, page.getByRole('button', { name: 'Simulation', exact: true }), { pauseBefore: 400, pauseAfter: 500 });
    const sel = page.locator('[data-tour="sec-sim-select"] select');
    await sel.waitFor({ timeout: 10000 });
    await pollUntil(async () => (await sel.locator('option').allTextContents()).some((l) => l.trim() === 'Solar System'), { timeoutMs: 60000, intervalMs: 2000, label: '"Solar System" in the package dropdown' });
    await glideTo(page, sel, { pause: 300 });
    await sel.selectOption({ label: 'Solar System' });
    await settle(page, 500);
    await revealCard(page);
    await setSwitch(page, 'simple', false);
    await setSwitch(page, 'auto', false);
    api.mark('card-shown');
    await settle(page, CARD_PACING.holdCard);
    const ta = page.locator('textarea[id^="sim-prompt-"]');
    await glideClick(page, ta, { pauseBefore: 350, pauseAfter: 200 });
    api.mark('typing');
    const head = PROMPT.slice(0, Math.floor(PROMPT.length * 0.4));
    await typeSlowKeys(page, head, CARD_PACING.typeMs);
    api.mark('card');                                                  // the montage-3 window opens mid-typing
    await typeSlowKeys(page, PROMPT.slice(head.length), CARD_PACING.typeMs);
    api.mark('typed');
    await settle(page, CARD_PACING.afterType);
    await setSwitch(page, 'simple', true, { glide: true });
    api.mark('minimal-ui');
    await settle(page, CARD_PACING.afterSimple - 650);
    await setSwitch(page, 'auto', true, { glide: true });
    api.mark('auto-script');
    await settle(page, CARD_PACING.afterAuto - 650);

    // ── 4 · Generate with AI ──
    api.mark('generate');
    await clickGenerate(page);
    api.mark('generating');
    await settle(page, CARD_PACING.holdGenerating);
    api.mark('generate-end');
    const gen = await awaitGeneration(page, 180000);
    api.mark('generated');
    await saveSection(page).catch(() => {});

    // ── 5 · Share sheet → Create link (on the Welcome clone, which has no link yet) ──
    await page.goto(`${api.APP}/projects/${WELCOME_CLONE}/editor`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
    await dismissTour(page);
    await settle(page, 1000);
    await easeMove(page, 1000, 300, { ms: 300 });
    const share = page.locator('header').getByRole('button', { name: /^(Create link|Share)$/ });
    const label = (await share.textContent())?.trim();
    api.mark('share');
    await glideClick(page, share, { pauseBefore: 600, pauseAfter: 0, ms: 800 });
    await page.getByText('Share this video', { exact: true }).waitFor({ timeout: 15000 });
    api.mark('sheet');
    await settle(page, 2500);
    api.mark('share-end');

    const m = api.marks;
    return {
      cuts: [
        { id: 'montage-1-drop', from: 'drop', to: Math.min(m['card-landed'] + 0.7, m.drop + 3.2), note: 'solar-system.zip dropped into the Library (the product has no library→timeline sim drag)' },
        { id: 'montage-2-mark', from: 'mark', to: m.mark + 2.6 },
        { id: 'montage-3-card', from: 'card', to: m.card + 2.6 },
        { id: 'montage-4-generate', from: 'generate', to: m.generate + 2.7, note: gen.ok ? 'generation completed after the cut' : `GENERATION FAILED after the cut: ${gen.error}` },
        { id: 'montage-5-share', from: 'share', to: m.share + 2.6, note: `header button read "${label}"` },
      ],
    };
  },
};
