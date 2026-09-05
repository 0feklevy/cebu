// Film 3 · Scene 3 — the kinesin package in the "Generate mini model" card (the capture profile's
// staged kinesin project, its SIM section): card opens, HOLD, the script's verbatim prompt, Minimal
// UI, Auto script, ✦ Generate — editor's pacing (CARD_PACING). Normalised off camera first
// (switches OFF, prompt empty, saved) so every flip is on camera.
import { settle, openEditor, openBlock, revealCard, setSwitch, clearPrompt, saveSection, easeMove, cardBeat, V3_VIEWPORT, KINESIN_PROJECT } from '../shot-utils.mjs';

const PROMPT = 'Let viewers scrub the walking cycle and switch motors — keep only those two controls';

export default {
  id: 'f3-s3-simple-ui',
  film: 3,
  scene: '3',
  kind: 'editor-flow',
  duration: 22,
  viewport: V3_VIEWPORT,
  cursor: true,
  async run(page, api) {
    await openEditor(page, api, KINESIN_PROJECT);
    await settle(page);

    // Off camera: normalise + save.
    await openBlock(page, 'SIM', { glide: false });
    await revealCard(page);
    await setSwitch(page, 'simple', false);
    await setSwitch(page, 'auto', false);
    await clearPrompt(page);
    await saveSection(page);
    await settle(page, 800);

    // On camera.
    await easeMove(page, 700, 420, { ms: 300 });
    api.mark('start');
    await openBlock(page, 'SIM');
    await revealCard(page);
    const gen = await cardBeat(page, api, PROMPT);
    return {
      trim: { from: 'start', to: 'held', padBefore: 0.3 },
      note: gen.ok ? 'generation completed after the cut' : `GENERATION FAILED after the cut: ${gen.error}`,
    };
  },
};
