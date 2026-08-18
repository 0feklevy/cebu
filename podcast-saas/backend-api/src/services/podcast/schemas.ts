/**
 * Zod schemas for the writers'-room pass outputs.
 *
 * Intermediate passes (story / materials / reviews) stay permissive about the
 * SHAPE of a field — a wrong-typed decorative field `.catch()`es to a safe
 * default rather than costing a re-generation. They are NOT permissive about
 * whether the pass produced anything: a pass output is only accepted when it
 * carries the load-bearing content the next pass reads (llm-pipeline-003).
 *
 * Why the distinction matters: `story_json` is forwarded verbatim as STORY_JSON
 * into Materials, Playwright, three reviewers, the rewrite, the compiler and the
 * delivery director. When every field was `.catch()`ed, `{}` parsed into a
 * fully-defaulted "Untitled Episode" with zero beats, was persisted, and then
 * drove eight further creative-tier (Opus/Fable) passes off a beat sheet with no
 * beats. Rejecting instead routes through the path PlaywrightDraftSchema already
 * uses: LLMService raises PARSING_ERROR and retries that ONE pass with the
 * JSON-only reinforcement, which is both cheaper and recoverable.
 *
 * The review schemas (Fact / Ear / Judge) are deliberately left permissive — see
 * the note above them.
 *
 * The FINAL body reuses the shared strict-ish PodcastScriptBody so the editor and
 * the audio stitcher receive clean, well-typed turns.
 */

import { z } from 'zod';
import { PodcastTurnSchema } from 'shared';

/** A field is "present" only when it is a non-blank string. */
const filled = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

function requireFilled(
  ctx: z.RefinementCtx,
  value: unknown,
  path: (string | number)[],
  what: string,
): void {
  if (!filled(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `${what} is required and must not be blank` });
  }
}

// ── Pass A — Story Architect ──────────────────────────────────────────────────

export const BeatSchema = z.object({
  id: z.string().catch(''),
  name: z.string().catch(''),
  role: z.string().catch('').optional(),
  kind: z.string().catch('').optional(),           // "action" | "reflection" (Glass alternation)
  pillar: z.string().catch('').optional(),
  content: z.string().catch('').optional(),
  minutes: z.number().catch(1).optional(),
  words: z.number().catch(0).optional(),            // per-beat word budget (sums to the episode budget)
  bridge_to_next: z.string().catch('').optional(),
  transition_type: z.string().catch('').optional(),
});

const StoryPlanShape = z.object({
  episode_title: z.string().catch('Untitled Episode'),
  xy: z.string().catch(''),
  focus_sentence: z.string().catch(''),
  core_concept: z.string().catch(''),
  story_world: z.string().catch(''),
  uses_user_analogy: z.boolean().catch(false),
  cold_open: z.string().catch(''),
  value_promise: z.string().catch('').optional(),
  beats: z.array(BeatSchema).catch([]),
  breaking_moment: z.string().catch('').optional(),
  teach_back_beat_id: z.string().catch('').optional(),
  closing_return: z.string().catch('').optional(),
  open_loop: z.string().catch('').optional(),
  callbacks: z.array(z.string()).catch([]),
  curiosity_ledger: z.array(z.object({
    loop: z.string().catch(''),
    opened_beat: z.string().catch('').optional(),
    closed_beat: z.string().catch('').optional(),
  })).catch([]),
  cut_list: z.array(z.string()).catch([]),
});

/**
 * Pass A output. The beat sheet IS the deliverable: an "accepted" plan with no
 * beats, no story world or no core concept is not a cheaper plan, it is a plan
 * that makes every later pass improvise from nothing.
 */
export const StoryPlanSchema = StoryPlanShape.superRefine((plan, ctx) => {
  requireFilled(ctx, plan.episode_title, ['episode_title'], 'episode_title');
  requireFilled(ctx, plan.core_concept, ['core_concept'], 'core_concept');
  requireFilled(ctx, plan.story_world, ['story_world'], 'story_world');
  requireFilled(ctx, plan.cold_open, ['cold_open'], 'cold_open');

  // `episode_title` .catch()es to the literal 'Untitled Episode'; accepting that
  // would let the exact empty-plan case back in through the default.
  if (plan.episode_title.trim() === 'Untitled Episode') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['episode_title'],
      message: 'episode_title is the placeholder default — the architect pass produced no title',
    });
  }

  if (plan.beats.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['beats'], message: 'the beat sheet must contain at least one beat' });
    return;
  }
  plan.beats.forEach((beat, i) => {
    requireFilled(ctx, beat.id, ['beats', i, 'id'], 'beat id');
    requireFilled(ctx, beat.name, ['beats', i, 'name'], 'beat name');
    requireFilled(ctx, beat.content, ['beats', i, 'content'], 'beat content');
  });
});
export type StoryPlan = z.infer<typeof StoryPlanSchema>;

// ── Pass B — Materials Hunter ─────────────────────────────────────────────────

const MaterialsShape = z.object({
  spine: z.object({
    world: z.string().catch(''),
    mapping: z.array(z.object({
      element: z.string().catch(''),
      concept: z.string().catch(''),
      relation: z.string().catch('').optional(),
    })).catch([]),
    extensions: z.array(z.string()).catch([]),
    breaks_at: z.string().catch('').optional(),
  }).catch({ world: '', mapping: [], extensions: [], breaks_at: '' }),
  loaner_analogies: z.array(z.object({
    for_concept: z.string().catch(''),
    analogy: z.string().catch(''),
    return_within: z.string().catch('').optional(),
  })).catch([]),
  worked_examples: z.array(z.object({
    beat_id: z.string().catch('').optional(),
    setup: z.string().catch(''),
    spoken_steps: z.array(z.string()).catch([]),
    result: z.string().catch('').optional(),
    proves: z.string().catch('').optional(),
  })).catch([]),
  grounding: z.array(z.object({
    beat_id: z.string().catch('').optional(),
    fact_or_quote: z.string().catch(''),
    source: z.string().catch('').optional(),
  })).catch([]),
  misconceptions: z.array(z.object({
    mistake: z.string().catch(''),
    why_tempting: z.string().catch('').optional(),
    correction: z.string().catch('').optional(),
  })).catch([]),
});

/**
 * Pass B output. `grounding` may legitimately be empty (the prompt says so when
 * there are no sources), but the analogy spine is the thing the playwright
 * dramatises — an empty spine is an empty pass.
 */
export const MaterialsSchema = MaterialsShape.superRefine((materials, ctx) => {
  requireFilled(ctx, materials.spine.world, ['spine', 'world'], 'spine.world');
});
export type Materials = z.infer<typeof MaterialsSchema>;

// ── Pass C/E — Playwright draft (turns have no id yet) ────────────────────────

export const DraftTurnSchema = z.object({
  speaker: z.enum(['teacher', 'learner']).catch('learner'),
  text: z.string().min(1),
  overlap: z.boolean().catch(false).default(false),
  is_hook: z.boolean().catch(false).default(false),
  beat: z.string().catch('').default(''),
});

export const PlaywrightDraftSchema = z.object({
  title: z.string().catch('Untitled Episode'),
  scratchpad: z.string().catch('').optional(),
  turns: z.array(DraftTurnSchema).min(1),
});
export type PlaywrightDraft = z.infer<typeof PlaywrightDraftSchema>;

// ── Pass D — reviews ──────────────────────────────────────────────────────────
// Deliberately still permissive, unlike Story/Materials above. For a REVIEWER an
// empty output degrading to verdict='needs_fixes' is fail-SAFE: it costs one
// rewrite pass. Rejecting would instead 422 a run that has already paid for
// seven passes. The asymmetry is the point — an empty PLAN corrupts everything
// downstream, an empty REVIEW only over-corrects.

export const FactAuditSchema = z.object({
  findings: z.array(z.object({
    severity: z.enum(['red', 'orange', 'yellow']).catch('yellow'),
    turn_index: z.number().catch(-1),
    quote: z.string().catch('').optional(),
    problem: z.string().catch(''),
    fix: z.string().catch('').optional(),
  })).catch([]),
  verdict: z.enum(['pass', 'needs_fixes']).catch('needs_fixes'),
});

export const EarEditSchema = z.object({
  findings: z.array(z.object({
    meter: z.string().catch('').optional(),
    turn_index: z.number().catch(-1),
    quote: z.string().catch('').optional(),
    problem: z.string().catch(''),
    suggestion: z.string().catch('').optional(),
  })).catch([]),
  estimated_minutes: z.number().catch(0).optional(),
  verdict: z.enum(['pass', 'needs_fixes']).catch('needs_fixes'),
});

export const NarrativeJudgeSchema = z.object({
  scores: z.object({
    opening_hook: z.number().catch(0),
    structure_flow: z.number().catch(0),
    rhythm: z.number().catch(0),
    ending: z.number().catch(0),
    naturalness: z.number().catch(0),
    persona_consistency: z.number().catch(0),
  }).catch({ opening_hook: 0, structure_flow: 0, rhythm: 0, ending: 0, naturalness: 0, persona_consistency: 0 }),
  total: z.number().catch(0),
  weakest_transition: z.object({
    turn_index: z.number().catch(-1),
    quote: z.string().catch('').optional(),
    why: z.string().catch('').optional(),
    rewrite: z.string().catch('').optional(),
  }).catch({ turn_index: -1, quote: '', why: '', rewrite: '' }),
  top_fixes: z.array(z.string()).catch([]),
  verdict: z.enum(['approve', 'needs_fixes']).catch('needs_fixes'),
});

export type ReviewReports = {
  fact: z.infer<typeof FactAuditSchema>;
  ear: z.infer<typeof EarEditSchema>;
  judge: z.infer<typeof NarrativeJudgeSchema>;
};

// ── Pass F — final compiled body (ids optional; validator assigns them) ───────

export const CompilerTurnSchema = z.object({
  id: z.string().catch('').optional(),
  speaker: z.enum(['teacher', 'learner']).catch('learner'),
  text: z.string().min(1),
  overlap: z.boolean().catch(false).default(false),
  is_hook: z.boolean().catch(false).default(false),
  beat: z.string().catch('').default(''),
});

export const CompiledBodySchema = z.object({
  title: z.string().catch('Untitled Episode'),
  turns: z.array(CompilerTurnSchema).min(1),
  open_loop: z.string().catch('').optional(),
});
export type CompiledBody = z.infer<typeof CompiledBodySchema>;

// ── Single-turn regenerate ────────────────────────────────────────────────────
// Permissive (unlike the strict editor-facing PodcastTurnSchema): the controller
// overrides id/beat from the existing turn afterward, so only `text` is load-bearing.
// This keeps a mangled single-turn LLM response degrading gracefully like every
// other writers'-room pass instead of hard-502ing.

export const RegenTurnSchema = z.object({
  id: z.string().catch('').optional(),
  speaker: z.enum(['teacher', 'learner']).catch('learner'),
  text: z.string().min(1),
  overlap: z.boolean().catch(false).default(false),
  is_hook: z.boolean().catch(false).default(false),
  beat: z.string().catch('').default(''),
});

// ── Memory scribe ─────────────────────────────────────────────────────────────

export const MemorySummarySchema = z.object({
  episode_title: z.string().catch('').optional(),
  concepts_taught: z.array(z.string()).catch([]),
  story_world: z.string().catch('').optional(),
  callbacks_planted: z.array(z.string()).catch([]),
  open_loops: z.array(z.string()).catch([]),
  running_jokes: z.array(z.string()).catch([]),
  listener_promises: z.array(z.string()).catch([]),
  one_line: z.string().catch('').optional(),
});
export type MemorySummary = z.infer<typeof MemorySummarySchema>;
