/**
 * llm-pipeline-007 — the writers' room must not pay to cache prompts that can never be read back.
 *
 * Every ScriptRoom pass builds its system prompt with `fillPrompt`, interpolating per-call JSON
 * INTO it — STORY_JSON, MATERIALS_JSON, DRAFT_TURNS. The prompt is therefore unique by
 * construction, so a cache entry written from it has a structural hit rate of zero, and caching it
 * bought a 1.25x cache-WRITE premium on every call of the most expensive tier in the product.
 *
 * This drives the REAL ScriptRoom over a fake LLM and asserts on the payload of the first pass.
 * The run cannot complete against a fake — and does not need to: the flag is observable on the
 * first call, which is the thing that was missing.
 */
import { describe, it, expect, vi } from 'vitest';
import { callArg } from '../../../__tests__/helpers/mockCalls.js';

vi.mock('../../../db/index.js', () => ({
  db: {
    // Any table, any query — this test is about the LLM payload, not the data layer.
    query: new Proxy({}, { get: () => ({ findFirst: async () => ({ id: 'x', show_id: 'sh1', title: "t" }), findMany: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));
// Vitest validates named exports against the factory's own keys, so a Proxy is not enough.
vi.mock('../../../db/schema.js', () => ({
  podcast_scripts: { id: 'id', status: 'status', claimed_at: 'claimed_at' },
  podcast_episodes: { id: 'id', status: 'status' },
  podcast_shows: { id: 'id' },
  system_prompts: { key: 'key' },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})), and: vi.fn(() => ({})), sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../podcastPrompts.js', () => ({
  loadPodcastPrompt: async () => 'SYSTEM {{STORY_JSON}} {{DRAFT_TURNS}}',
}));

const { ScriptRoom } = await import('../ScriptRoom.js');

describe('the writers room opts out of system-prompt caching', () => {
  it('passes systemPromptCacheable:false on its very first pass', async () => {
    const sendStructured = vi.fn(async () => { throw new Error('stop after the first pass'); });
    const room = new ScriptRoom({ sendStructured } as never);

    await room.run({
      scriptId: 's1',
      episode: { id: 'e1', title: 't', brief: 'b' },
      show: { id: 'sh1', title: 'show' },
      sources: [],
      userId: 'u1',
      directorNotes: null,
    } as never).catch(() => { /* the fake throws after the first pass — by design */ });

    expect(sendStructured, 'the room never reached the LLM').toHaveBeenCalled();
    const payload = callArg<Record<string, unknown>>(sendStructured);
    expect(payload.systemPromptCacheable, 'a prompt unique per call must not be cache-written').toBe(false);
  });
});
