/**
 * Tests for ScriptSchema resilience — ensures .catch() defaults protect against
 * unexpected LLM output (unknown emotions, invalid b_roll, bad audio tags, etc.)
 */
import { describe, it, expect } from 'vitest';
import { ScriptSchema, DialogueTurnSchema } from 'shared';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE_TURN = {
  speaker: 'host_a' as const,
  text: 'Hello world',
  audio_tags: [],
  emotion: 'neutral',
  is_hook: false,
  b_roll: null,
};

const VALID_SCRIPT = {
  title: 'Test',
  intro_runtime_sec: 5,
  outro_runtime_sec: 5,
  total_estimated_seconds: 60,
  turns: [
    { ...BASE_TURN, is_hook: true },
    { ...BASE_TURN, speaker: 'host_b' as const },
    { ...BASE_TURN },
    { ...BASE_TURN, speaker: 'host_b' as const },
  ],
};

// ── DialogueTurnSchema resilience ─────────────────────────────────────────────

describe('DialogueTurnSchema resilience', () => {
  it('accepts a fully valid turn', () => {
    const result = DialogueTurnSchema.safeParse(BASE_TURN);
    expect(result.success).toBe(true);
  });

  it('degrades unknown emotion to neutral via .catch()', () => {
    const result = DialogueTurnSchema.safeParse({ ...BASE_TURN, emotion: 'pondering' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.emotion).toBe('neutral');
  });

  it('degrades invalid audio_tags array to [] via .catch()', () => {
    const result = DialogueTurnSchema.safeParse({ ...BASE_TURN, audio_tags: ['robot_noise', 'custom_tag'] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.audio_tags).toEqual([]);
  });

  it('degrades invalid b_roll object to null via .catch()', () => {
    const result = DialogueTurnSchema.safeParse({ ...BASE_TURN, b_roll: {} });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.b_roll).toBeNull();
  });

  it('degrades b_roll with unknown type to null via .catch()', () => {
    const result = DialogueTurnSchema.safeParse({ ...BASE_TURN, b_roll: { type: 'unknown_visual', prompt: 'hi' } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.b_roll).toBeNull();
  });

  it('accepts valid b_roll', () => {
    const result = DialogueTurnSchema.safeParse({ ...BASE_TURN, b_roll: { type: 'stat', prompt: 'Show a chart' } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.b_roll?.type).toBe('stat');
  });

  it('degrades bad is_hook to false via .catch()', () => {
    const result = DialogueTurnSchema.safeParse({ ...BASE_TURN, is_hook: 'yes' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.is_hook).toBe(false);
  });

  it('degrades bad duration_hint_sec to fallback via .catch()', () => {
    const result = DialogueTurnSchema.safeParse({ ...BASE_TURN, duration_hint_sec: 'fast' });
    expect(result.success).toBe(true);
  });

  it('defaults missing emotion to neutral', () => {
    const { emotion: _, ...noEmotion } = BASE_TURN as typeof BASE_TURN & { emotion: string };
    const result = DialogueTurnSchema.safeParse(noEmotion);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.emotion).toBe('neutral');
  });
});

// ── ScriptSchema resilience ───────────────────────────────────────────────────

describe('ScriptSchema resilience', () => {
  it('accepts a fully valid script', () => {
    const result = ScriptSchema.safeParse(VALID_SCRIPT);
    expect(result.success).toBe(true);
  });

  it('degrades missing title to "Untitled" via .catch()', () => {
    const result = ScriptSchema.safeParse({ ...VALID_SCRIPT, title: 123 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('Untitled');
  });

  it('degrades bad intro_runtime_sec to 5 via .catch()', () => {
    const result = ScriptSchema.safeParse({ ...VALID_SCRIPT, intro_runtime_sec: -1 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.intro_runtime_sec).toBe(5);
  });

  it('survives a mix of valid and invalid turns — invalid turns degrade gracefully', () => {
    const script = {
      ...VALID_SCRIPT,
      turns: [
        { ...BASE_TURN, is_hook: true, emotion: 'pondering' },  // bad emotion → neutral
        { ...BASE_TURN, speaker: 'host_b', b_roll: {} },         // bad b_roll → null
        { ...BASE_TURN, audio_tags: ['bad_tag'] },               // bad tags → []
        { ...BASE_TURN, speaker: 'host_b' },
      ],
    };
    const result = ScriptSchema.safeParse(script);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.turns[0].emotion).toBe('neutral');
      expect(result.data.turns[1].b_roll).toBeNull();
      expect(result.data.turns[2].audio_tags).toEqual([]);
    }
  });

  it('rejects if turns array is empty (min(1) enforced)', () => {
    const result = ScriptSchema.safeParse({ ...VALID_SCRIPT, turns: [] });
    expect(result.success).toBe(false);
  });
});
