/**
 * llm-pipeline-003 — the writers'-room INTERMEDIATE schemas must not accept an
 * empty pass output.
 *
 * Every field of StoryPlanSchema/MaterialsSchema carries a `.catch()`, so `{}`
 * parsed successfully into a fully-defaulted object. ScriptRoom then persisted
 * that empty plan as `story_json` and fed it — as `STORY_JSON` — to Materials,
 * Playwright, three reviewers, the rewrite, the compiler and the delivery
 * director: eight further creative-tier (Opus/Fable) passes driven by a beat
 * sheet with no beats.
 *
 * The intended failure mode is the one PlaywrightDraftSchema already has: reject,
 * so LLMService.sendStructured raises PARSING_ERROR and retries the pass with the
 * JSON-only reinforcement instead of spending the rest of the run on nothing.
 */
import { describe, it, expect } from 'vitest';
import { StoryPlanSchema, MaterialsSchema } from '../schemas.js';

const FULL_PLAN = {
  episode_title: 'How a matrix is a movie theatre',
  xy: 'This is about matrices; the interesting thing is seating',
  focus_sentence: 'A cinema usher seats a crowd because the rows already encode the map.',
  core_concept: 'A matrix is an indexed grid, not a wall of numbers',
  story_world: 'a movie theatre at opening night',
  uses_user_analogy: false,
  cold_open: 'The usher has ninety seats and one flashlight.',
  beats: [
    { id: 'b1', name: 'The doors open', content: 'The crowd arrives and nobody knows where to sit.' },
    { id: 'b2', name: 'Rows and columns', content: 'The usher reads a seat number aloud.' },
  ],
  callbacks: [],
  curiosity_ledger: [],
  cut_list: [],
};

const FULL_MATERIALS = {
  spine: { world: 'a movie theatre at opening night', mapping: [{ element: 'seat', concept: 'entry' }], extensions: [] },
  loaner_analogies: [],
  worked_examples: [],
  grounding: [],
  misconceptions: [],
};

describe('StoryPlanSchema — an empty beat sheet must be rejected, not defaulted', () => {
  it('rejects {} instead of manufacturing an "Untitled Episode" plan with no beats', () => {
    const r = StoryPlanSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('rejects a plan with zero beats (the beat sheet IS the pass output)', () => {
    const r = StoryPlanSchema.safeParse({ ...FULL_PLAN, beats: [] });
    expect(r.success).toBe(false);
  });

  it('rejects beats whose id/name/content the next pass would read as empty strings', () => {
    const r = StoryPlanSchema.safeParse({
      ...FULL_PLAN,
      beats: [{ id: '', name: '', content: '' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a plan whose story_world is blank (the validator + every prompt ride the spine)', () => {
    const r = StoryPlanSchema.safeParse({ ...FULL_PLAN, story_world: '   ' });
    expect(r.success).toBe(false);
  });

  it('rejects a plan with a blank core_concept', () => {
    const r = StoryPlanSchema.safeParse({ ...FULL_PLAN, core_concept: '' });
    expect(r.success).toBe(false);
  });

  it('still ACCEPTS a real plan, and still degrades garbage in DECORATIVE fields', () => {
    const r = StoryPlanSchema.safeParse({
      ...FULL_PLAN,
      uses_user_analogy: 'yes',          // wrong type → .catch(false)
      callbacks: 'nope',                 // wrong type → .catch([])
      cut_list: 42,                      // wrong type → .catch([])
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.uses_user_analogy).toBe(false);
      expect(r.data.callbacks).toEqual([]);
      expect(r.data.cut_list).toEqual([]);
      expect(r.data.beats).toHaveLength(2);
    }
  });
});

describe('MaterialsSchema — an empty materials pass must be rejected', () => {
  it('rejects {} instead of manufacturing an empty spine', () => {
    expect(MaterialsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a materials object whose spine.world is blank', () => {
    const r = MaterialsSchema.safeParse({ ...FULL_MATERIALS, spine: { world: '', mapping: [], extensions: [] } });
    expect(r.success).toBe(false);
  });

  it('still ACCEPTS materials with empty grounding (the prompt allows it when there are no sources)', () => {
    expect(MaterialsSchema.safeParse(FULL_MATERIALS).success).toBe(true);
  });
});
