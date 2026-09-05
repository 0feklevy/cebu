// Film 2 · Scene 4 — the "Generate mini model" card: pick Simulation, choose the package, describe the
// moment, flip Simple UI + Auto Script, ✦ Generate with AI, and WAIT for the result on camera.
//
// The sim NAME is a constant so the later re-run with the real Solar System package is a
// one-line change (the solar sim is still being built; Orbit Lab validates the rig now).
import { settle, readStage2, beatClock, dismissTour, tokenSniffer, openSectionEditor, pollUntil, generateAndWait, clearSections, ensureTitle } from '../shot-utils.mjs';

const SIM_NAME = 'Solar System'; // solar landed — re-anchored per owner steer
const PROMPT = 'Give viewers the planets — let them speed up time and fly to any world';

export default {
  id: 'f2-s4-this-moment',
  film: 2,
  scene: '4',
  kind: 'editor-flow',
  duration: 90,
  async run(page, api) {
    const beat = beatClock(this.id);
    const { tourProjectId } = readStage2();
    if (!tourProjectId) throw new Error('run f2-s2a first: no tourProjectId in STAGE2.json');

    const getTok = tokenSniffer(page); // attach before goto
    await page.goto(`${api.APP}/projects/${tourProjectId}/editor`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
    await dismissTour(page);
    const tok = await getTok();
    if (!tok) throw new Error('no Bearer token sniffed');

    // Off-camera prep: recreate the marked section FRESH. A previous take leaves a generated
    // bridge + conversation on the row, and the stream endpoint then replays it instantly —
    // the on-camera "wait for the AI" beat needs a first-time generation.
    await ensureTitle(api, tok, tourProjectId, 'Tour the Solar System');
    await clearSections(api, tok, tourProjectId);
    const vres = await fetch(`${api.API}/api/v1/projects/${tourProjectId}/videos`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const vbody = await vres.json();
    const videos = Array.isArray(vbody) ? vbody : vbody.videos ?? [];
    if (!videos.length) throw new Error('tour project has no video');
    const cres = await fetch(`${api.API}/api/v1/projects/${tourProjectId}/sections`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ video_file_id: videos[0].id, start_sec: 7.5, end_sec: 22.5, type: 'video' }),
    });
    if (!cres.ok) throw new Error(`section re-create failed: ${cres.status}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
    await dismissTour(page);
    await settle(page);

    await openSectionEditor(page, ['VIDEO', 'SIM']);
    await settle(page);
    beat.mark('editor-open');

    // Type: Simulation
    await page.getByRole('button', { name: 'Simulation', exact: true }).click();
    await settle(page, 800);
    beat.mark('type-simulation');

    // Package dropdown — wait for the sim to be status=ready (only ready sims are listed).
    const sel = page.locator('[data-tour="sec-sim-select"] select');
    await sel.waitFor({ timeout: 10000 });
    await pollUntil(async () => {
      const labels = await sel.locator('option').allTextContents();
      return labels.some((l) => l.trim() === SIM_NAME);
    }, { timeoutMs: 60000, intervalMs: 3000, label: `"${SIM_NAME}" in the package dropdown` });
    await sel.selectOption({ label: SIM_NAME });
    await settle(page, 800);
    beat.mark('package-picked');

    // 1 · Describe it — the exact prompt, typed at human speed (cleared first: a re-run may
    // find the aborted attempt's text already in the box).
    const ta = page.locator('textarea[id^="sim-prompt-"]');
    await ta.waitFor({ timeout: 10000 });
    await ta.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await api.typeSlow(page, PROMPT);
    await settle(page, 700);
    beat.mark('prompt-typed');

    // Flip ON Simple UI, then Auto Script — the flip lands ON on camera either way.
    for (const label of ['Simple UI', 'Auto Script']) {
      const sw = page.locator('button[role="switch"]').filter({ hasText: label }).first();
      if ((await sw.getAttribute('aria-checked')) === 'true') { await sw.click(); await settle(page, 500); }
      await sw.click();
      if ((await sw.getAttribute('aria-checked')) !== 'true') throw new Error(`${label} did not end ON`);
      await settle(page, 700);
    }
    beat.mark('switches-on');

    // ✦ Generate with AI — a real LLM call; the wait is the beat.
    beat.mark('generate-click');
    await generateAndWait(page, { timeoutMs: 120000 });
    beat.mark('generated');
    await settle(page, 3000); // hold on the result
    beat.flush();
  },
};
