// Film 3 · Scene 4 — iteration in English: a follow-up typed into the same This-moment box,
// ✦ Generate with AI, and the "Last generation" card refreshing on camera. The Advanced
// disclosure is opened first because the Last-generation card lives behind it
// (SectionEditor.tsx:2660).
import { settle, beatClock, openEditor, openSectionEditor, generateAndWait } from '../shot-utils.mjs';

const KINESIN_PROJECT = '02d892ff-dea3-4a88-a8a7-2498dbafda1f';
const FOLLOWUP = 'Make the timeline bigger. Hide the background toggle.';

export default {
  id: 'f3-s4-iteration',
  film: 3,
  scene: '4',
  kind: 'editor-flow',
  duration: 90,
  async run(page, api) {
    const beat = beatClock(this.id);
    await openEditor(page, api, KINESIN_PROJECT);
    await settle(page);

    await openSectionEditor(page, 'SIM');
    await settle(page);
    beat.mark('editor-open');

    // Advanced open → the Last generation card (if a previous run recorded one) is on screen
    // before the refresh, so the refresh is visible as a refresh.
    const adv = page.locator('[data-tour="sec-sim-advanced"]');
    if ((await adv.getAttribute('aria-expanded')) !== 'true') await adv.click();
    await settle(page, 1200);
    beat.mark('advanced-open');

    // The follow-up replaces the box's text — the conversation itself lives server-side
    // (the AI reloads the saved conversation; SCRIPT-3-HEAVY-SIM.md scene 4).
    const ta = page.locator('textarea[id^="sim-prompt-"]');
    await ta.waitFor({ timeout: 10000 });
    await ta.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await api.typeSlow(page, FOLLOWUP);
    await settle(page, 900);
    beat.mark('followup-typed');

    beat.mark('generate-click');
    await generateAndWait(page, { timeoutMs: 150000 });
    beat.mark('generated');

    // The refreshed Last generation card on camera.
    await page.getByText('Last generation', { exact: true }).waitFor({ timeout: 10000 });
    await settle(page, 3000);
    beat.mark('last-generation');
    beat.flush();
  },
};
