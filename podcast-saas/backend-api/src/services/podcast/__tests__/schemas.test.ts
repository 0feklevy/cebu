import { describe, it, expect } from 'vitest';
import { PodcastTurnSchema } from 'shared';
import { StoryPlanSchema, CompiledBodySchema, PlaywrightDraftSchema } from '../schemas.js';

describe('PodcastTurnSchema — id safety + resilience', () => {
  it('rejects an id containing path-traversal characters (the render-path fix)', () => {
    const bad = PodcastTurnSchema.safeParse({ id: '../../../../tmp/pwn', speaker: 'teacher', text: 'hi' });
    expect(bad.success).toBe(false);
    const slash = PodcastTurnSchema.safeParse({ id: 'a/b', speaker: 'teacher', text: 'hi' });
    expect(slash.success).toBe(false);
  });

  it('accepts safe token ids (t1, uuids)', () => {
    expect(PodcastTurnSchema.safeParse({ id: 't1', speaker: 'teacher', text: 'hi' }).success).toBe(true);
    expect(PodcastTurnSchema.safeParse({ id: '3f2a1b0c-1111-2222-3333-444455556666', speaker: 'learner', text: 'hi' }).success).toBe(true);
  });

  it('allows pause_after_ms to be null (clearable) and coerces a bad speaker', () => {
    const r = PodcastTurnSchema.safeParse({ id: 't1', speaker: 'narrator', text: 'hi', pause_after_ms: null });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.pause_after_ms).toBeNull();
      expect(r.data.speaker).toBe('learner'); // .catch() default
    }
  });
});

describe('pass-output schema resilience', () => {
  it('StoryPlanSchema degrades garbage to safe defaults instead of throwing', () => {
    const r = StoryPlanSchema.safeParse({ episode_title: 123, beats: 'nope', uses_user_analogy: 'yes' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.beats).toEqual([]);
      expect(typeof r.data.episode_title).toBe('string');
      expect(r.data.uses_user_analogy).toBe(false);
    }
  });

  it('CompiledBodySchema tolerates turns with missing ids (validator assigns them later)', () => {
    const r = CompiledBodySchema.safeParse({ title: 'X', turns: [{ speaker: 'teacher', text: 'hi' }] });
    expect(r.success).toBe(true);
  });

  it('PlaywrightDraftSchema/CompiledBodySchema STILL fail on empty/missing turns (so the LLM retry fires)', () => {
    // turns has no .catch() and requires .min(1); a regression adding .catch([]) here
    // would silently produce empty episodes instead of retrying.
    expect(PlaywrightDraftSchema.safeParse({ title: 'X', turns: [] }).success).toBe(false);
    expect(PlaywrightDraftSchema.safeParse({ title: 'X' }).success).toBe(false);
    expect(CompiledBodySchema.safeParse({ title: 'X', turns: [] }).success).toBe(false);
  });
});
