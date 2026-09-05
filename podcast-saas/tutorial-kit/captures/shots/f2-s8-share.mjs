// Film 2 · Scene 8 — Create link → "Share this video" sheet → Public page → permalink typed →
// Publish at this address → the address rows (Video / Podcast / Library) → Create podcast.
// The library share is pre-created first so its row exists in the sheet
// (ProjectShareLinks.tsx:201 renders it only when a live share exists).
import { settle, readStage2, beatClock, openEditor } from '../shot-utils.mjs';

const PERMALINK = 'welcome-flow-video-demo';

export default {
  id: 'f2-s8-share',
  film: 2,
  scene: '8',
  kind: 'editor-flow',
  duration: 45,
  async run(page, api) {
    const beat = beatClock(this.id);
    const { tourProjectId } = readStage2();
    if (!tourProjectId) throw new Error('run f2-s2a first: no tourProjectId in STAGE2.json');
    await openEditor(page, api, tourProjectId);
    await settle(page);
    beat.mark('editor');

    // ── Pre-create the library share (its row in the sheet needs one) ──
    await page.locator('[aria-label="Share this library"]').click();
    await page.getByText('Share this library', { exact: true }).first().waitFor({ timeout: 10000 });
    const mint = page.getByRole('button', { name: 'Create the link', exact: true });
    try {
      await mint.waitFor({ state: 'visible', timeout: 2500 });
      await mint.click();
      await page.locator('[aria-label="Library link"]').waitFor({ timeout: 15000 });
    } catch { /* already shared — the link input is showing */ }
    await settle(page, 1000);
    await page.locator('[aria-label="Close share dialog"]').click();
    await settle(page, 800);
    beat.mark('library-share');

    // ── Create link → the share sheet ──
    await page.getByRole('button', { name: /^(Create link|Share)$/ }).click();
    await page.getByText('Share this video', { exact: true }).waitFor({ timeout: 15000 });
    await settle(page, 1000);
    beat.mark('sheet-open');

    // Public page tab (default, but the click is the scripted beat).
    await page.getByRole('tab', { name: 'Public page' }).click();
    await settle(page, 800);
    beat.mark('public-tab');

    // Permalink: clear the suggestion, type ours slowly.
    const slug = page.getByLabel('Permalink URL slug');
    await slug.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await api.typeSlow(page, PERMALINK);
    await settle(page, 1500); // debounce → "Available"
    beat.mark('permalink-typed');

    await page.getByRole('button', { name: 'Publish at this address', exact: true }).click();
    await page.getByText('Share this project', { exact: false }).waitFor({ timeout: 15000 });
    await settle(page, 1000);
    beat.mark('published');

    // Hover the address rows.
    for (const label of ['Video', 'Podcast', 'Library']) {
      const row = page.getByText(label, { exact: true }).first();
      try {
        await row.waitFor({ state: 'visible', timeout: 1500 });
        await row.hover();
        await settle(page, 900);
      } catch { /* Library row absent if the share was not minted */ }
    }
    beat.mark('rows-hovered');

    // Create podcast (film 5 needs the Podcast row to exist later).
    const pod = page.getByRole('button', { name: 'Create podcast', exact: true });
    try {
      await pod.waitFor({ state: 'visible', timeout: 2000 });
      await pod.click();
      await settle(page, 2500); // "Building…" state on camera
      beat.mark('podcast-building');
    } catch { /* row absent or already built */ }

    await settle(page, 3000); // hold on the published URL
    beat.mark('hold-url');
    beat.flush();
  },
};
