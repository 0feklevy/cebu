// Film 2 · Scene 5 — Preview tab → Run → the sim plays with minimal UI for ~8s.
import { settle, readStage2, beatClock, openEditor, openSectionEditor } from '../shot-utils.mjs';

export default {
  id: 'f2-s5-preview-run',
  film: 2,
  scene: '5',
  kind: 'editor-flow',
  duration: 20,
  async run(page, api) {
    const beat = beatClock(this.id);
    const { tourProjectId } = readStage2();
    if (!tourProjectId) throw new Error('run f2-s2a first: no tourProjectId in STAGE2.json');
    await openEditor(page, api, tourProjectId);
    await settle(page);

    await openSectionEditor(page, 'SIM'); // configured as a simulation in f2-s4
    await settle(page);
    beat.mark('editor-open');

    // Preview is the default right tab; clicking it is the scripted beat regardless.
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await settle(page, 800);
    beat.mark('preview-tab');

    await page.getByRole('button', { name: 'Run', exact: true }).click();
    beat.mark('run');
    await settle(page, 8000); // the sim plays under minimal UI
    beat.mark('played');
    await settle(page, 1500);
    beat.flush();
  },
};
