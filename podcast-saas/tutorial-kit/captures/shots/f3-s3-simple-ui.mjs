// Film 3 · Scene 3 — the staged kinesin project: open its existing simulation section, show the
// This-moment card with the stored prompt, flip Simple UI (stored ON — shown flipping OFF→ON so
// the state lands ON with the motion on camera), then Preview → Run with collapsed controls.
import { settle, beatClock, openEditor, openSectionEditor } from '../shot-utils.mjs';

const KINESIN_PROJECT = '02d892ff-dea3-4a88-a8a7-2498dbafda1f';

export default {
  id: 'f3-s3-simple-ui',
  film: 3,
  scene: '3',
  kind: 'editor-flow',
  duration: 30,
  async run(page, api) {
    const beat = beatClock(this.id);
    await openEditor(page, api, KINESIN_PROJECT);
    await settle(page);
    beat.mark('editor');

    // The staged section (10s→40s, type simulation — verified via probe-state.mjs).
    await openSectionEditor(page, 'SIM');
    await settle(page, 2000); // the This-moment card with the existing prompt
    beat.mark('this-moment');

    // Simple UI: stored ON. Flip OFF → ON so the camera sees the switch move and end ON.
    const sw = page.locator('button[role="switch"]').filter({ hasText: 'Simple UI' }).first();
    await sw.waitFor({ timeout: 10000 });
    if ((await sw.getAttribute('aria-checked')) === 'true') {
      await sw.click();
      await settle(page, 700);
    }
    await sw.click();
    if ((await sw.getAttribute('aria-checked')) !== 'true') throw new Error('Simple UI did not end ON');
    await settle(page, 1000);
    beat.mark('simple-ui-on');

    // Preview → Run: the collapsed control set.
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await settle(page, 800);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    beat.mark('run');
    await settle(page, 6000);
    beat.mark('collapsed-controls');
    await settle(page, 1500);
    beat.flush();
  },
};
