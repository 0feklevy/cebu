/**
 * A FIXED CORPUS FOR THE WRITERS' ROOM — the same nine answers, every run.
 *
 * These are not recordings of a real LLM and are not trying to be. They are the smallest inputs
 * that exercise each deterministic decision the room makes AFTER the model has spoken: the
 * proportional floor, the long-turn splitter, the overlap demotion, the hook guarantee, the title
 * and open-loop fallbacks. Everything a model actually decides — whether the writing is any good —
 * is out of reach of any test, and pretending otherwise is how a suite becomes decoration.
 *
 * What a golden suite CAN hold still is the machinery around the model, and that machinery has
 * already shipped a defect worth this file: `llm-pipeline-016`, a compiler returning three turns
 * from a sixty-turn draft, hashed, written `status: 'ready'`, episode marked `script_ready`. A
 * gutted paid deliverable, marked complete, with nothing anywhere to indicate it.
 *
 * Keep every string here BORING. A fixture that reads like a real episode invites edits that make
 * it read better, and each of those quietly changes what the golden body is.
 */
import type {
  CompiledBody,
  MaterialsSchema,
  PlaywrightDraft,
  StoryPlan,
} from '../schemas.js';
import type { z } from 'zod';

type Materials = z.infer<typeof MaterialsSchema>;

/** Pass A. `story_world` is load-bearing: the validator looks for its first long word in the body. */
export const STORY: StoryPlan = {
  episode_title: 'The Ledger Episode',
  xy: 'ledger x accounting',
  focus_sentence: 'A ledger records what happened.',
  core_concept: 'ledgers',
  story_world: 'harbour warehouse',
  uses_user_analogy: false,
  cold_open: 'The crate was already open.',
  value_promise: 'You will know what a ledger is for.',
  beats: [
    { id: 'b1', name: 'Opening', role: 'hook', kind: 'action', pillar: '', content: 'The crate.', minutes: 1, words: 120, bridge_to_next: '', transition_type: '' },
    { id: 'b2', name: 'Middle', role: 'teach', kind: 'reflection', pillar: '', content: 'The count.', minutes: 1, words: 120, bridge_to_next: '', transition_type: '' },
  ],
  breaking_moment: '',
  teach_back_beat_id: 'b2',
  closing_return: '',
  open_loop: 'What happens when two ledgers disagree?',
  callbacks: [],
  curiosity_ledger: [],
  cut_list: [],
} as StoryPlan;

/**
 * Pass B. Nothing downstream reads these fields — but they are written to the exact shape
 * `MaterialsSchema` demands, because the harness parses every fixture through the pass's own
 * schema. The first version of this object was invented from memory and the schema rejected it,
 * which is the point: a corpus that could not have come back from a real call is not a corpus.
 */
export const MATERIALS: Materials = {
  spine: {
    world: 'harbour warehouse',
    mapping: [{ element: 'crate', concept: 'entry', relation: 'one crate is one entry' }],
    extensions: ['the clerk is the auditor'],
    breaks_at: 'goods that leave unrecorded',
  },
  loaner_analogies: [{ for_concept: 'ledgers', analogy: 'a harbour warehouse manifest', return_within: 'one beat' }],
  worked_examples: [{ beat_id: 'b2', setup: 'Two crates arrive.', spoken_steps: ['Both are entered.'], result: 'The count matches.', proves: 'entries reconcile' }],
  grounding: [{ beat_id: 'b1', fact_or_quote: 'Ledgers predate double-entry.', source: 'the sources' }],
  misconceptions: [{ mistake: 'A ledger is a receipt.', why_tempting: 'Both are paper.', correction: 'A receipt is one entry.' }],
} as Materials;

/** A draft turn, spelled once so the corpus below stays readable. */
const turn = (speaker: 'teacher' | 'learner', text: string, extra: Partial<PlaywrightDraft['turns'][number]> = {}) =>
  ({ speaker, text, overlap: false, is_hook: false, beat: 'b1', ...extra }) as PlaywrightDraft['turns'][number];

/**
 * Pass C — a draft with no lint findings and no length problem, so the default corpus takes the
 * SHORT path (no rewrite). The rewrite path is exercised by overriding a review verdict instead,
 * which keeps the two paths independent: a lint-rule change cannot silently move the default.
 *
 * Speakers alternate deliberately — four consecutive turns by one speaker is a `monologue_run`.
 */
export const DRAFT: PlaywrightDraft = {
  title: 'The Ledger Episode',
  scratchpad: '',
  turns: [
    turn('teacher', 'The crate was already open when the harbour warehouse clerk arrived.', { is_hook: true }),
    turn('learner', 'Open how? Prised, or just unlatched?'),
    turn('teacher', 'Unlatched. Which is the part that mattered to the ledger.'),
    turn('learner', 'Because an unlatched crate still counts as sealed?'),
    turn('teacher', 'It counts as whatever the last entry says it is.'),
    turn('learner', 'So the paper outranks the crate.'),
  ],
} as PlaywrightDraft;

/**
 * Pass D — the clean review, in the exact shapes the three schemas define.
 *
 * The judge's verdict enum is `approve | needs_fixes`, NOT `pass | needs_fixes` like the other
 * two. The first version of this fixture said `pass`, which `.catch()` silently coerced to
 * `needs_fixes` — so the "clean" corpus quietly took the rewrite path, and three conditional
 * passes ran in a test whose whole point was that they do not. Nothing failed loudly; the golden
 * body was simply built by different passes than the ones named in the assertion.
 *
 * That is the argument for parsing fixtures through the real schemas: a `.catch()` default is
 * indistinguishable from a correct value at the call site, and a corpus is only fixed if it is
 * fixed at the values the pipeline actually uses.
 */
export const REVIEW_CLEAN = {
  fact: { findings: [], verdict: 'pass' as const },
  ear: { findings: [], estimated_minutes: 1, verdict: 'pass' as const },
  judge: {
    scores: { opening_hook: 8, structure_flow: 8, rhythm: 8, ending: 8, naturalness: 8, persona_consistency: 8 },
    total: 48,
    weakest_transition: { turn_index: 3, quote: 'So the paper outranks the crate.', why: 'fine', rewrite: '' },
    top_fixes: [],
    verdict: 'approve' as const,
  },
};

/** Pass F — a compiler that behaves: it keeps every turn and polishes the title. */
export const COMPILED: CompiledBody = {
  title: 'The Ledger Episode',
  turns: DRAFT.turns.map((t) => ({ ...t })),
  open_loop: 'What happens when two ledgers disagree?',
} as CompiledBody;

/** Pass G — a director that behaves: it keeps every turn and adds one short backchannel. */
export const DIRECTED: CompiledBody = {
  title: 'The Ledger Episode',
  turns: [
    ...COMPILED.turns.map((t) => ({ ...t })),
    { speaker: 'learner', text: 'Mm.', overlap: true, is_hook: false, beat: 'b2' },
  ],
  open_loop: 'What happens when two ledgers disagree?',
} as CompiledBody;
