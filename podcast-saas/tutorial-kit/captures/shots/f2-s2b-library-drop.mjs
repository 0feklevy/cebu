// Film 2 · Scene 2b — multi-drop onto the Library: overlay → toast → cards sorted into
// Videos / Simulations / Images / Sound.
//
// PRODUCT LIMIT (real, not worked around): every .zip in one drop is routed to a single
// SimulationUploader call (VideoEditor.tsx:991), and uploadItems refuses more than one zip
// ("Upload one ZIP, or upload the unzipped folder/files", SimulationUploader.tsx:199). So the
// second package lands in a second on-camera drop, with its display name typed first so the
// dropdown in scene 4 reads "Orbit Lab". Recorded in out/DISCREPANCIES.md.
import { join } from 'node:path';
import { settle, readStage2, beatClock, openEditor } from '../shot-utils.mjs';

export default {
  id: 'f2-s2b-library-drop',
  film: 2,
  scene: '2b',
  kind: 'editor-flow',
  duration: 40,
  async run(page, api) {
    const beat = beatClock(this.id);
    const { tourProjectId } = readStage2();
    if (!tourProjectId) throw new Error('run f2-s2a first: no tourProjectId in STAGE2.json');
    await openEditor(page, api, tourProjectId);
    await settle(page);
    beat.mark('editor');

    // ── Drop 1: video + one sim zip + image + audio, all at once ──
    await api.dropFiles(page, '[data-tour="library"]', [
      { name: 'lesson-waves.mp4', type: 'video/mp4', path: join(api.propsDir, 'lesson-waves.mp4') },
      { name: 'murmuration.zip', type: 'application/zip', path: join(api.propsDir, 'murmuration.zip') },
      { name: 'waves-diagram.png', type: 'image/png', path: join(api.propsDir, 'waves-diagram.png') },
      { name: 'ambient-tone.wav', type: 'audio/wav', path: join(api.propsDir, 'ambient-tone.wav') },
    ]);
    beat.mark('drop1');

    // Sorted cards appear: sim, image, audio (video keeps uploading in its panel with progress).
    await page.getByText('murmuration', { exact: false }).first().waitFor({ timeout: 90000 });
    await page.getByText('ambient-tone', { exact: false }).first().waitFor({ timeout: 30000 });
    await settle(page, 1200);
    beat.mark('cards1');

    // ── Drop 2: the Orbit Lab package, named on camera ──
    await page.locator('button[title="Upload simulation"]').click();
    const nameInput = page.getByPlaceholder('Simulation name (optional)');
    await nameInput.waitFor({ timeout: 10000 });
    await nameInput.click();
    await api.typeSlow(page, 'Orbit Lab');
    await settle(page, 500);
    await api.dropFiles(page, '[data-tour="library"]', [
      { name: 'orbit-lab.zip', type: 'application/zip', path: join(api.propsDir, 'orbit-lab.zip') },
    ]);
    beat.mark('drop2');
    await page.getByText('Orbit Lab', { exact: true }).first().waitFor({ timeout: 90000 });
    await settle(page, 1000);
    beat.mark('cards2');

    await settle(page, 4000); // linger on the sorted library
    beat.flush();
  },
};
