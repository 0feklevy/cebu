// Film 3 · Scene 2 — a NEW empty project ("Molecular Motors"); the 30MB kinesin zip dropped on
// the Library; upload progress; the package card appears. Writes { heavyProjectId } to STAGE2.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { settle, writeStage2, beatClock, createProject } from '../shot-utils.mjs';

const SCRATCH = '/private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad';

export default {
  id: 'f3-s2-heavy-drop',
  film: 3,
  scene: '2',
  kind: 'editor-flow',
  duration: 60,
  async run(page, api) {
    const beat = beatClock(this.id);
    const zip = ['kinesin-upload.zip', 'kinesin-dynein-sim.zip']
      .map((n) => join(SCRATCH, n))
      .find((p) => existsSync(p));
    if (!zip) throw new Error(`no kinesin zip found in ${SCRATCH}`);

    const heavyProjectId = await createProject(page, api, 'Molecular Motors');
    writeStage2({ heavyProjectId });
    await settle(page);
    beat.mark('editor');

    // REAL network shaping (film 3's own honesty rule): localhost swallows 30MB sub-second, so
    // the upload-progress beat only exists under a throttled uplink. ~2.5MB/s ≈ 12s on camera.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 20,
      downloadThroughput: 50 * 1024 * 1024,
      uploadThroughput: 2.5 * 1024 * 1024,
    });

    await api.dropFiles(page, '[data-tour="library"]', [
      { name: 'kinesin-upload.zip', type: 'application/zip', path: zip },
    ]);
    beat.mark('dropped');

    // Upload progress renders in the sim uploader (percent + speed bar) while the throttled
    // POST runs; hold a beat mid-upload.
    await settle(page, 5000);
    beat.mark('progress');

    // Then the package card appears (exact match: the card shows the extension-less name,
    // while any in-flight progress text would say "kinesin-upload.zip").
    await page.getByText('kinesin-upload', { exact: true }).first().waitFor({ timeout: 240000 });
    beat.mark('card');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }).catch(() => {});
    await settle(page, 4000);
    beat.flush();
  },
};
