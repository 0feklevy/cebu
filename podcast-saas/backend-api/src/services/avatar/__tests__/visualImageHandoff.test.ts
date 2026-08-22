/**
 * ONE B-ROLL, ONE CLASSIFY.
 *
 * A conversational turn that ends in a picture runs two endpoints in sequence, and until this
 * change it ran a gpt-4.1-mini completion in EACH of them on the same message:
 *
 *   /avatar/visual/analyze → analyzeVisual → MODELS.visualClassify → {type:'image', dallePrompt…}
 *   /avatar/image/analyze  → analyzeAndGenerateImage → MODELS.imageClassify → the same conclusion
 *
 * and only then did gpt-image-1 start. The viewer waited out both. visualService's own
 * CLASSIFY_PROMPT lists "image" as priority 1, "USE BY DEFAULT", so this was the ordinary path,
 * not an edge case.
 *
 * The bar these tests are written against: what would a BROKEN implementation also satisfy?
 * "the image comes back" passes with the duplicate completion still in place, so every assertion
 * about the fix counts CALLS TO THE MODEL, not the returned value. And the two that matter most
 * are the ones proving the shortcut cannot be reached from outside: a caller who never went
 * through the visual classify must still be classified, and the parked prompt must be spendable
 * exactly once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const lib = vi.hoisted(() => ({
  findVisual: vi.fn(async () => null),
  findRelevantLibraryVisual: vi.fn(async () => null),
  isDuplicateVisual: vi.fn(async () => false),
  incrementUseCount: vi.fn(async () => {}),
  insertVisual: vi.fn(async () => ({ id: 'row-1' })),
  getVisual: vi.fn(async () => null),
  storeSimulationHtml: vi.fn(async () => ({ prefix: 'p', url: 'u' })),
  storeImageB64: vi.fn(async () => ({ url: 'https://cdn.test/img.png', key: 'k' })),
}));

const ai = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  imagesGenerate: vi.fn(async () => ({ data: [{ b64_json: 'AAAA' }] })),
  recordChatUsage: vi.fn(async () => {}),
  recordImageUsage: vi.fn(async () => {}),
}));

vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../libraryService.js', () => lib);
vi.mock('../../storage/getStorageAdapter.js', () => ({ getStorageAdapter: vi.fn(() => ({})) }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), or: vi.fn(), sql: vi.fn(), desc: vi.fn(), asc: vi.fn(), isNull: vi.fn() }));
vi.mock('../../../db/schema.js', () => ({ avatar_visuals: Symbol('avatar_visuals') }));
vi.mock('../../../db/index.js', () => ({
  db: { update: () => ({ set: () => ({ where: async () => undefined }) }) },
}));
vi.mock('../../llm/systemAi.js', () => ({
  isGenerationPaused: vi.fn(async () => false),
  getOpenAIClient: vi.fn(async () => ({
    chat: { completions: { create: ai.chatCreate } },
    images: { generate: ai.imagesGenerate },
  })),
  recordChatUsage: ai.recordChatUsage,
  recordImageUsage: ai.recordImageUsage,
}));

import { analyzeVisual } from '../visualService.js';
import { analyzeAndGenerateImage } from '../imageService.js';
import { resetImageClassificationMemo, takeImageClassification } from '../visualClassifyMemo.js';
import { callArg } from '../../../__tests__/helpers/mockCalls.js';

const MESSAGE = 'why do the finch beaks differ between the islands?';
const CHARACTER = 'darwin';
const PROJECT = 'proj-1';
const DALLE = 'Galápagos finches on a branch, photorealistic, cinematic lighting, highly detailed';

/** The visual classifier's answer on its own default branch: "image — USE BY DEFAULT". */
const visualSaysImage = () => ({
  usage: { prompt_tokens: 1, completion_tokens: 1 },
  choices: [{ message: { content: JSON.stringify({ type: 'image', dallePrompt: DALLE, imageType: 'realistic', caption: 'Beak shape tracks the food on each island.' }) } }],
});

/** The image endpoint's own classifier — the completion this change is about removing. */
const imageClassifies = () => ({
  usage: { prompt_tokens: 1, completion_tokens: 1 },
  choices: [{ message: { content: JSON.stringify({ should_generate: true, image_type: 'realistic', caption: 'Rediscovered from scratch.', dalle_prompt: 'a second, redundant prompt' }) } }],
});

/** Every chat completion the run made, by model. */
const modelsCalled = (): string[] => ai.chatCreate.mock.calls.map((c) => (c[0] as { model: string }).model);

beforeEach(() => {
  vi.clearAllMocks();
  resetImageClassificationMemo();
  lib.findVisual.mockResolvedValue(null);
  lib.findRelevantLibraryVisual.mockResolvedValue(null);
  lib.isDuplicateVisual.mockResolvedValue(false);
  lib.insertVisual.mockResolvedValue({ id: 'row-1' });
  lib.storeImageB64.mockResolvedValue({ url: 'https://cdn.test/img.png', key: 'k' });
  ai.imagesGenerate.mockResolvedValue({ data: [{ b64_json: 'AAAA' }] });
});

describe('the turn that ends in a picture', () => {
  it('runs ONE classify across both halves, not two', async () => {
    ai.chatCreate.mockResolvedValueOnce(visualSaysImage());
    // A SUCCEEDING second classify is left armed on purpose. Without it, an implementation that
    // still runs the duplicate fails this test by returning no image at all — which would let the
    // red be read as "the image broke" rather than "the completion came back". With it armed, the
    // duplicate path produces a perfectly good image and the ONLY assertion that fails is the
    // count, which is the actual defect.
    ai.chatCreate.mockResolvedValue(imageClassifies());

    const visual = await analyzeVisual(MESSAGE, CHARACTER, MESSAGE, { projectId: PROJECT });
    expect(visual.type).toBe('image');
    expect(modelsCalled()).toEqual(['gpt-4.1-mini']); // the visual classify, once

    // The second half of the SAME turn. AvatarConversation sends no context here (it passes
    // `undefined` on the user-message path) — which is exactly why the memo is keyed on the
    // message rather than on the context.
    const image = await analyzeAndGenerateImage(MESSAGE, CHARACTER, undefined, PROJECT);

    // The whole assertion: a chat completion count of ONE across a turn that produced a rendered
    // image. Asserted before the happy-path checks so a regression names itself.
    expect(modelsCalled()).toEqual(['gpt-4.1-mini']);
    expect(image.shouldGenerate).toBe(true);
    expect(image.imageUrl).toBe('https://cdn.test/img.png');

    // The prompt actually sent to gpt-image-1 is the one the visual classify wrote — proving the
    // shortcut carried the real work forward rather than skipping the work altogether.
    expect(ai.imagesGenerate).toHaveBeenCalledTimes(1);
    expect(callArg<{ prompt: string }>(ai.imagesGenerate, 0, 0).prompt).toBe(DALLE);
    expect(image.caption).toBe('Beak shape tracks the food on each island.');
  });

  it('still classifies when the image endpoint is reached on its own', async () => {
    // The shortcut must not become the only path. Nothing parked anything here, so the endpoint
    // owes the caller a real classification — and a mutation that always trusts a (missing) memo
    // fails on `shouldGenerate`.
    ai.chatCreate.mockResolvedValueOnce(imageClassifies());

    const image = await analyzeAndGenerateImage('a message nobody classified', CHARACTER, undefined, PROJECT);

    expect(modelsCalled()).toEqual(['gpt-4.1-mini']);
    expect(image.shouldGenerate).toBe(true);
    expect(callArg<{ prompt: string }>(ai.imagesGenerate, 0, 0).prompt).toBe('a second, redundant prompt');
  });

  it('does not let one classification cover a later, different question', async () => {
    ai.chatCreate.mockResolvedValueOnce(visualSaysImage());
    await analyzeVisual(MESSAGE, CHARACTER, MESSAGE, { projectId: PROJECT });

    // A different message in the same session must be classified on its own merits.
    ai.chatCreate.mockResolvedValueOnce(imageClassifies());
    await analyzeAndGenerateImage('what did the tortoises eat?', CHARACTER, undefined, PROJECT);
    expect(modelsCalled()).toEqual(['gpt-4.1-mini', 'gpt-4.1-mini']);
  });

  it('does not let one project’s classification be spent on another', async () => {
    // The parked prompt was produced under one project's library and budget; a call naming a
    // different project is a different caller and gets its own classify.
    ai.chatCreate.mockResolvedValueOnce(visualSaysImage());
    await analyzeVisual(MESSAGE, CHARACTER, MESSAGE, { projectId: PROJECT });

    ai.chatCreate.mockResolvedValueOnce(imageClassifies());
    await analyzeAndGenerateImage(MESSAGE, CHARACTER, undefined, 'some-other-project');
    expect(modelsCalled()).toEqual(['gpt-4.1-mini', 'gpt-4.1-mini']);
  });

  it('spends a parked classification exactly once', async () => {
    ai.chatCreate.mockResolvedValueOnce(visualSaysImage());
    await analyzeVisual(MESSAGE, CHARACTER, MESSAGE, { projectId: PROJECT });

    expect(takeImageClassification(MESSAGE, CHARACTER, PROJECT)).not.toBeNull();
    // Redeemed. A second reader must get nothing, or the memo would start standing in for the
    // avatar_visuals library — a durable cache with none of its scoping rules.
    expect(takeImageClassification(MESSAGE, CHARACTER, PROJECT)).toBeNull();
  });

  it('parks nothing when the classify chose something other than an image', async () => {
    ai.chatCreate.mockResolvedValueOnce({
      usage: {},
      choices: [{ message: { content: JSON.stringify({ type: 'equation', latex: 'E = mc^2', caption: 'Mass-energy equivalence.' }) } }],
    });
    const visual = await analyzeVisual('show me the formula', CHARACTER, undefined, { projectId: PROJECT });
    expect(visual.type).toBe('equation');
    expect(takeImageClassification('show me the formula', CHARACTER, PROJECT)).toBeNull();
  });
});
