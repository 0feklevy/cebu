/**
 * Tests for the JSON parse-and-repair logic inside LLMService.
 *
 * These previously hand-copied the private helpers into the test file. That copy
 * went stale: `normalizePythonLiterals` in LLMService became string-context aware
 * (backend-003) while the test kept a blanket global replace, so the test proved
 * nothing about the real code (first-pass finding test-001). We now exercise the
 * REAL private method via `(new LLMService(...) as any).parseAndRepair(...)`, the
 * same construction the retry test uses.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AppError, LLMErrorType } from 'shared';

// ── Mocks so importing LLMService is cheap (no real DB / providers / SDKs) ───────

vi.mock('../../../db/index.js', () => ({
  db: { query: { admin_settings: { findFirst: vi.fn() } } },
}));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: vi.fn() }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: vi.fn() }));
vi.mock('../ClaudeProvider.js', () => ({ ClaudeProvider: vi.fn() }));
vi.mock('../OpenAIProvider.js', () => ({ OpenAIProvider: vi.fn() }));
vi.mock('../GeminiProvider.js', () => ({ GeminiProvider: vi.fn() }));

import { LLMService } from '../LLMService.js';

// Call the REAL private parseAndRepair through the constructed service.
function parseAndRepair<T>(raw: string, schema: z.ZodSchema<T>): T {
  const svc = new LLMService({} as never, {} as never) as unknown as {
    parseAndRepair<U>(raw: string, schema: z.ZodSchema<U>): U;
  };
  return svc.parseAndRepair(raw, schema);
}

// ── Schema fixtures ─────────────────────────────────────────────────────────────

const SimpleSchema = z.object({ name: z.string(), value: z.number() });
const NestedSchema = z.object({
  title: z.string(),
  items: z.array(z.object({ id: z.number(), label: z.string() })),
});

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('parseAndRepair', () => {
  describe('clean JSON', () => {
    it('parses plain valid JSON', () => {
      const result = parseAndRepair('{"name":"Alice","value":42}', SimpleSchema);
      expect(result).toEqual({ name: 'Alice', value: 42 });
    });

    it('parses JSON with whitespace', () => {
      const result = parseAndRepair(
        JSON.stringify({ name: 'Bob', value: 7 }, null, 2),
        SimpleSchema,
      );
      expect(result).toEqual({ name: 'Bob', value: 7 });
    });

    it('parses nested JSON', () => {
      const payload = { title: 'Episode', items: [{ id: 1, label: 'Intro' }] };
      const result = parseAndRepair(JSON.stringify(payload), NestedSchema);
      expect(result).toEqual(payload);
    });
  });

  describe('code fence stripping', () => {
    it('strips ```json ... ``` fences', () => {
      const raw = '```json\n{"name":"Alice","value":1}\n```';
      expect(parseAndRepair(raw, SimpleSchema)).toEqual({ name: 'Alice', value: 1 });
    });

    it('strips plain ``` fences', () => {
      const raw = '```\n{"name":"Alice","value":2}\n```';
      expect(parseAndRepair(raw, SimpleSchema)).toEqual({ name: 'Alice', value: 2 });
    });
  });

  describe('preamble text extraction', () => {
    it('extracts JSON from response that starts with explanation text', () => {
      const raw = 'Here is the JSON output:\n\n{"name":"Claude","value":99}';
      expect(parseAndRepair(raw, SimpleSchema)).toEqual({ name: 'Claude', value: 99 });
    });

    it('extracts JSON when model adds a closing remark', () => {
      const raw = '{"name":"X","value":5}\n\nLet me know if you need adjustments.';
      expect(parseAndRepair(raw, SimpleSchema)).toEqual({ name: 'X', value: 5 });
    });

    it('extracts JSON wrapped in explanation and code fences', () => {
      const raw = 'Based on the material, here is my analysis:\n```json\n{"name":"Y","value":3}\n```\nHope this helps!';
      expect(parseAndRepair(raw, SimpleSchema)).toEqual({ name: 'Y', value: 3 });
    });
  });

  describe('Python literal normalisation', () => {
    it('converts True / False / None to JSON booleans / null', () => {
      const PythonSchema = z.object({ flag: z.boolean(), other: z.boolean(), empty: z.null() });
      const raw = '{"flag": True, "other": False, "empty": None}';
      expect(parseAndRepair(raw, PythonSchema)).toEqual({ flag: true, other: false, empty: null });
    });

    it('does NOT rewrite a Python literal that appears inside a JSON string value (backend-003)', () => {
      // The real normalizePythonLiterals is string-context aware: a bare `True`
      // written inside a string value (e.g. generated JS/source text) must be
      // preserved verbatim, not turned into `true`. The old hand-copied test
      // helper used a blanket global replace and would have corrupted this.
      const StrSchema = z.object({ name: z.string(), code: z.string(), value: z.number() });
      const raw = '{"name":"Alice","code":"if x is True: return None","value":1}';
      expect(parseAndRepair(raw, StrSchema)).toEqual({
        name: 'Alice',
        code: 'if x is True: return None',
        value: 1,
      });
    });
  });

  describe('trailing comma repair', () => {
    it('strips trailing commas in objects', () => {
      const raw = '{"name":"X","value":1,}';
      expect(parseAndRepair(raw, SimpleSchema)).toEqual({ name: 'X', value: 1 });
    });

    it('strips trailing commas in arrays', () => {
      const ArrSchema = z.object({ items: z.array(z.string()) });
      const raw = '{"items":["a","b","c",]}';
      expect(parseAndRepair(raw, ArrSchema)).toEqual({ items: ['a', 'b', 'c'] });
    });
  });

  describe('schema validation failures', () => {
    it('throws PARSING_ERROR with "Schema validation failed" when JSON is valid but schema does not match', () => {
      const raw = '{"name":42,"value":"wrong"}'; // types are swapped
      expect(() => parseAndRepair(raw, SimpleSchema)).toThrowError(/Schema validation failed/);
    });

    it('thrown error has error_type PARSING_ERROR', () => {
      try {
        parseAndRepair('{"name":42,"value":"wrong"}', SimpleSchema);
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).error_type).toBe(LLMErrorType.PARSING_ERROR);
      }
    });
  });

  describe('unrecoverable responses', () => {
    it('throws PARSING_ERROR for completely non-JSON content', () => {
      expect(() => parseAndRepair('I cannot help with that request.', SimpleSchema))
        .toThrowError(/Schema validation failed|Failed to parse/);
    });

    it('throws PARSING_ERROR for empty string', () => {
      expect(() => parseAndRepair('', SimpleSchema))
        .toThrowError(/Failed to parse|Schema validation/);
    });
  });

  describe('complex real-world schemas', () => {
    it('parses a structural analysis JSON', () => {
      const StructuralSchema = z.object({
        title: z.string(),
        thesis: z.string(),
        audience_persona: z.string(),
        topic_map: z.array(z.object({
          topic: z.string(),
          key_facts: z.array(z.string()),
          tensions: z.array(z.string()),
          analogies: z.array(z.string()),
        })),
        narrative_arc: z.array(z.string()),
        pacing_seconds: z.array(z.number().positive()),
      });

      const payload = {
        title: 'The Hidden Cost of Free AI',
        thesis: 'Free AI tools extract hidden value through data and attention.',
        audience_persona: 'Tech-savvy professional',
        topic_map: [{
          topic: 'Data harvesting',
          key_facts: ['GPT processes 1T tokens/day'],
          tensions: ['Privacy vs convenience'],
          analogies: ['Like a free newspaper funded by ads'],
        }],
        narrative_arc: ['Hook', 'Problem', 'Solution', 'CTA'],
        pacing_seconds: [60, 120, 180, 60],
      };

      expect(parseAndRepair(JSON.stringify(payload), StructuralSchema)).toEqual(payload);
    });

    it('parses a minimal ScriptSchema JSON', () => {
      const DialogueTurnSchema = z.object({
        speaker: z.enum(['host_a', 'host_b']),
        text: z.string().min(1),
        audio_tags: z.array(z.enum(['laughs', 'sighs', 'interrupting', 'hesitates', 'whispers', 'excited', 'pauses'])).default([]),
        emotion: z.enum(['neutral', 'enthusiastic', 'thoughtful', 'agreeing', 'analytical', 'amused', 'surprised']).default('neutral'),
        duration_hint_sec: z.number().positive().optional(),
        is_hook: z.boolean().default(false),
        b_roll: z.object({ type: z.string(), prompt: z.string().optional() }).nullable().default(null),
      });
      const ScriptSchema = z.object({
        title: z.string(),
        intro_runtime_sec: z.number().positive(),
        turns: z.array(DialogueTurnSchema).min(1),
        outro_runtime_sec: z.number().positive(),
        total_estimated_seconds: z.number().positive(),
      });

      const script = {
        title: 'AI Risks Explained',
        intro_runtime_sec: 5,
        turns: [
          { speaker: 'host_a', text: 'Welcome!', audio_tags: [], emotion: 'enthusiastic', is_hook: true, b_roll: null },
          { speaker: 'host_b', text: 'Thanks for having me.', audio_tags: [], emotion: 'neutral', is_hook: false, b_roll: null },
        ],
        outro_runtime_sec: 5,
        total_estimated_seconds: 60,
      };

      const result = parseAndRepair(JSON.stringify(script), ScriptSchema);
      expect(result.turns).toHaveLength(2);
      expect(result.turns[0].is_hook).toBe(true);
    });
  });
});
