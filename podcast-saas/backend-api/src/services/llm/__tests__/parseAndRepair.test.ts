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
// The failure log is what the last describe block is about, so it has to be observable.
vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { LLMService } from '../LLMService.js';
import { logger } from '../../../lib/logger.js';

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

/**
 * THE FAILURE LOG ITSELF (observability-009).
 *
 * `unparseableOutput.test.ts` proves the describer is safe. This proves the SERVICE USES IT —
 * a different claim, and the one that decides what actually reaches the log. Restoring
 * `raw.slice(0, 800)` on that line leaves every describer test green while customer content goes
 * back into an error-level record, so the assertion belongs where the leak would happen.
 */
describe('what the parse-failure log carries', () => {
  // Assembled rather than written out: a literal of this shape in the repository is itself the
  // thing secret scanners exist to find, and a test fixture is not a good enough reason to add one.
  const CREDENTIAL = ['sk', 'livekey0123456789abcdefghij'].join('-');
  const PRIVATE_SENTENCE = 'The acquisition price agreed with Northwind was fourteen million.';

  const failParse = (): string => {
    const errorSpy = logger.error as unknown as ReturnType<typeof vi.fn>;
    errorSpy.mockClear();
    // Unparseable however hard the repair loop tries: prose first, then a credential, then an
    // object that stops mid-value.
    const raw = `Sure! Here you go. token=${CREDENTIAL}. ${PRIVATE_SENTENCE} {"name":"x","value":`;
    expect(() => parseAndRepair(raw, SimpleSchema)).toThrow(AppError);
    const calls = errorSpy.mock.calls;
    expect(calls.length, 'the failure was never logged at all').toBeGreaterThan(0);
    return JSON.stringify(calls[calls.length - 1]);
  };

  it('does not carry the customer sentence the model was working on', () => {
    expect(failParse()).not.toContain('fourteen million');
  });

  it('does not carry a credential that appeared in the output', () => {
    expect(failParse()).not.toContain(CREDENTIAL);
  });

  it('carries no word of it either — this is what killed the redaction design', () => {
    // Not credential-shaped: just a sentence. A redactor cannot see it, so the module stopped
    // keeping excerpts at all.
    expect(failParse()).not.toContain('Northwind');
  });

  it('still says enough to diagnose the failure', () => {
    // The reason the raw dump existed in the first place. If THIS is the assertion that breaks,
    // the description went too far and the log has stopped earning its place.
    const line = failParse();
    expect(line).toContain('braceBalance');
    expect(line).toContain('"len"');
    expect(line).toContain('"kind":"prose"');
  });
});

/**
 * THE WARN-LEVEL SIBLING (found by the end-of-day verification pass, not by a report).
 *
 * The suite above only drives the never-valid-JSON path, so it exercises `logger.error` and is
 * structurally blind to the other failure: JSON that PARSES and fails the schema. That path had
 * its own `raw.slice(0, 300)`, and a second leak nobody was looking for — Zod puts the offending
 * VALUE into both `received` and `message`, and the issue array was interpolated into the thrown
 * AppError's message as well, which travels further than a log line.
 *
 * The fixture is therefore valid JSON with a wrong enum value, which is exactly the shape that
 * makes Zod echo the value back.
 */
describe('what the SCHEMA-failure log carries', () => {
  const PRIVATE_ENUM_VALUE = 'Northwind-acquisition-fourteen-million';
  const EnumSchema = z.object({ mode: z.enum(['fast', 'slow']), name: z.string() });

  const failSchema = (): string => {
    const warnSpy = logger.warn as unknown as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();
    const raw = JSON.stringify({ mode: PRIVATE_ENUM_VALUE, name: 'The acquisition brief' });
    expect(() => parseAndRepair(raw, EnumSchema)).toThrow(AppError);
    const calls = warnSpy.mock.calls;
    expect(calls.length, 'the schema failure was never logged').toBeGreaterThan(0);
    return JSON.stringify(calls[calls.length - 1]);
  };

  it('does not carry the raw output', () => {
    expect(failSchema()).not.toContain('The acquisition brief');
  });

  it('does not carry the value Zod echoed back in `received`', () => {
    // The half that looks structural and is not.
    expect(failSchema()).not.toContain(PRIVATE_ENUM_VALUE);
  });

  it('still names WHICH field failed, which is the whole diagnostic value', () => {
    const line = failSchema();
    expect(line).toContain('"path":"mode"');
    expect(line).toContain('invalid_enum_value');
    expect(line).toContain('"options":2');
  });

  it('keeps the value out of the THROWN error too, not only the log', () => {
    // The AppError message is interpolated from the same array and reaches further than a log
    // line does — it is the 422 the caller sees and whatever records that.
    const raw = JSON.stringify({ mode: PRIVATE_ENUM_VALUE, name: 'x' });
    try {
      parseAndRepair(raw, EnumSchema);
      expect.unreachable('the schema should have rejected this');
    } catch (e) {
      expect((e as AppError).message).not.toContain(PRIVATE_ENUM_VALUE);
      expect((e as AppError).message).toContain('mode');
    }
  });
});
