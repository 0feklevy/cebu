// Film 3 · Scene 4 — iteration in English on the kinesin card: after f3-s3's generation, the
// previous prompt is selected and replaced by the script's verbatim follow-up, ✦ Generate again.
// Run AFTER f3-s3-simple-ui.
import { settle, openEditor, openBlock, revealCard, easeMove, cardBeat, V3_VIEWPORT, KINESIN_PROJECT } from '../shot-utils.mjs';

const FOLLOWUP = 'Hide the Teaching playback slider too';

export default {
  id: 'f3-s4-iteration',
  film: 3,
  scene: '4',
  kind: 'editor-flow',
  duration: 14,
  viewport: V3_VIEWPORT,
  cursor: true,
  async run(page, api) {
    await openEditor(page, api, KINESIN_PROJECT);
    await settle(page);
    await easeMove(page, 700, 420, { ms: 300 });
    api.mark('start');
    await openBlock(page, 'SIM');
    await revealCard(page);
    const gen = await cardBeat(page, api, FOLLOWUP, { followUp: true, hold: 2500 });
    return {
      trim: { from: 'start', to: 'held', padBefore: 0.3 },
      note: gen.ok ? 'generation completed after the cut' : `GENERATION FAILED after the cut: ${gen.error}`,
    };
  },
};
