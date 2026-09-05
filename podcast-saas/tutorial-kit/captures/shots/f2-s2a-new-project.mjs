// Film 2 · Scene 2a — Home → New project → "Tour the Solar System" → Create → land in editor.
// Writes { tourProjectId } into captures/STAGE2.json (parsed from the editor URL).
import { settle, writeStage2, beatClock, dismissTour } from '../shot-utils.mjs';

export default {
  id: 'f2-s2a-new-project',
  film: 2,
  scene: '2a',
  kind: 'editor-flow',
  duration: 20,
  async run(page, api) {
    const beat = beatClock(this.id);
    await page.goto(api.APP, { waitUntil: 'domcontentloaded' });
    const newBtn = page.getByRole('button', { name: 'New project', exact: true }).first();
    await newBtn.waitFor({ timeout: 30000 });
    await dismissTour(page);
    await settle(page);
    beat.mark('home');

    await newBtn.click();
    const input = page.getByPlaceholder(/Product demo, lecture/);
    await input.waitFor({ timeout: 10000 });
    await settle(page, 600);
    beat.mark('dialog');
    await input.click();
    await api.typeSlow(page, 'Tour the Solar System');
    await settle(page, 800);
    beat.mark('titled');

    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]+\/editor/, { timeout: 30000 });
    const tourProjectId = page.url().match(/\/projects\/([0-9a-f-]+)\/editor/)[1];
    writeStage2({ tourProjectId });

    await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
    await dismissTour(page);
    await settle(page);
    beat.mark('editor');
    await settle(page, 1500);
    beat.flush();
  },
};
