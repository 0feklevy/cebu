/**
 * llm-pipeline-017 — the writers' room had no end-to-end test, and its output is the product.
 *
 * ScriptRoom is a nine-call chain that produces the episode a customer pays for. Every existing
 * test around it covers one pass in isolation; nothing drove the whole room and looked at what
 * came out. A silent quality regression in the core deliverable therefore shipped unnoticed, and
 * that is not hypothetical: `llm-pipeline-016` — a compiler returning THREE turns from a
 * sixty-turn draft, hashed, written `status: 'ready'`, episode marked `script_ready` — was live
 * until 2026-08-22. A gutted paid deliverable, marked complete, with nothing to indicate it.
 *
 * ── WHAT A GOLDEN SUITE CAN AND CANNOT PROVE HERE ─────────────────────────────────────────────
 * It cannot prove the writing is good. No test can; that is the model's judgement and it changes
 * every call. What it CAN hold still is everything the room does after the model has spoken — the
 * proportional floor, the long-turn splitter, the overlap demotion, the hook guarantee, the title
 * and open-loop fallbacks, the order the passes run in, and the content hash that identifies the
 * result. Those are deterministic given fixed answers, and they are precisely where 016 lived.
 *
 * So the LLM is replaced by a fixed corpus and the REAL room runs over it. The fake still parses
 * every fixture through the pass's own Zod schema — exactly as `LLMService.sendStructured` does —
 * so a fixture that could never have come back from a real call fails here rather than quietly
 * testing a shape the pipeline would have rejected.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';

vi.mock('../../../db/index.js', () => ({
  db: {
    query: new Proxy(
      {},
      { get: () => ({ findFirst: async () => ({ id: 'x', show_id: 'sh1', title: 't' }), findMany: async () => [] }) },
    ),
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async () => { writes.push(patch); return []; } }) }),
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
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: Object.assign(
    vi.fn(() => ({})),
    { raw: vi.fn() },
  ),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../podcastPrompts.js', () => ({
  // Every placeholder the room interpolates, so `fillPrompt` has something to fill and a missing
  // one would show up as a literal `{{TOKEN}}` rather than as nothing at all.
  loadPodcastPrompt: async () => 'SYS {{STORY_JSON}} {{MATERIALS_JSON}} {{DRAFT_TURNS}} {{REVIEW_JSON}}',
}));

/** Every patch the room wrote to `podcast_scripts`/`podcast_episodes`, in order. */
const writes: Record<string, unknown>[] = [];

const { ScriptRoom } = await import('../ScriptRoom.js');
const { COMPILED, DIRECTED, DRAFT, MATERIALS, REVIEW_CLEAN, STORY } = await import('./scriptRoomGolden.fixtures.js');

/** What the room asks for, keyed the way the room names its passes. */
type Corpus = Partial<Record<string, unknown>>;

const DEFAULT_CORPUS: Corpus = {
  architect: STORY,
  materials: MATERIALS,
  playwright: DRAFT,
  fact_auditor: REVIEW_CLEAN.fact,
  ear_editor: REVIEW_CLEAN.ear,
  narrative_judge: REVIEW_CLEAN.judge,
  playwright_rewrite: DRAFT,
  fact_auditor_verify: REVIEW_CLEAN.fact,
  playwright_repair: DRAFT,
  compiler: COMPILED,
  delivery_director: DIRECTED,
};

interface TelemetryEntry {
  pass: string;
  provider: string;
  model: string;
  cost_cents: number;
}

interface RunResult {
  body: { title: string; turns: Array<Record<string, unknown>>; open_loop?: string };
  contentHash: string;
  telemetry: TelemetryEntry[];
  passes: string[];
  stages: string[];
  episodeStatus: string | undefined;
  scriptStatus: string | undefined;
}

/**
 * Every pass, identified by the user prompt the room sends with it.
 *
 * NOT by call order, which was the first version of this harness and was wrong in a way that
 * cost an hour: three of the eleven passes are conditional, so when the room skips them every
 * later call shifts position, and the fake labels `compiler` as `playwright_repair` and hands it
 * a draft fixture. `PlaywrightDraft` happens to satisfy `CompiledBodySchema` — title plus turns —
 * so nothing throws. The `passes` array simply reports a chain that did not run, and every
 * assertion about pass order is then checking the harness against itself.
 *
 * The user prompts are distinct per pass and are part of what the room sends, so matching on them
 * identifies a pass by something the room actually did.
 */
const PASS_BY_PROMPT: ReadonlyArray<readonly [RegExp, string]> = [
  [/beat sheet/i, 'architect'],
  [/raw materials/i, 'materials'],
  [/^Write the full episode/i, 'playwright'],
  [/^Audit the draft/i, 'fact_auditor'],
  [/^Listen and report/i, 'ear_editor'],
  [/^Judge and report/i, 'narrative_judge'],
  [/^Write the full revised episode/i, 'playwright_rewrite'],
  [/^Audit the revised draft/i, 'fact_auditor_verify'],
  [/^Repair only the listed errors/i, 'playwright_repair'],
  [/^Compile the final script body/i, 'compiler'],
  [/^Direct the delivery/i, 'delivery_director'],
];

function passNameFor(userPrompt: string): string {
  const hit = PASS_BY_PROMPT.find(([re]) => re.test(userPrompt));
  if (!hit) throw new Error(`unrecognised pass — no rule matches its user prompt: ${JSON.stringify(userPrompt)}`);
  return hit[1];
}

/** Drive the real room over a corpus and report what came out. */
async function runRoom(overrides: Corpus = {}): Promise<RunResult> {
  writes.length = 0;
  const corpus = { ...DEFAULT_CORPUS, ...overrides };
  const passes: string[] = [];
  const stages: string[] = [];

  const sendStructured = vi.fn(async (opts: { schema: ZodTypeAny; userPrompt: string }) => {
    const name = passNameFor(opts.userPrompt);
    passes.push(name);
    const fixture = corpus[name];
    if (fixture === undefined) throw new Error(`the room asked for pass "${name}", which the corpus does not answer`);
    // Parsed through the pass's OWN schema, exactly as LLMService.sendStructured does. A fixture
    // that could not have come back from a real call must fail here, not quietly stand in for one.
    const data = opts.schema.parse(fixture) as unknown;
    return { data, provider: 'fake', model: 'fake-1', usage: { input: 1, output: 1, cost_cents: 0 } };
  });

  const room = new ScriptRoom({ sendStructured } as never);
  await room.run({
    scriptId: 's1',
    episode: { id: 'e1', title: 'ep', brief: 'b', target_minutes: null },
    show: { id: 'sh1', title: 'show', memory_json: null },
    sources: [],
    userId: 'u1',
    directorNotes: null,
    onStage: (s: string) => stages.push(s),
  } as never);

  const bodyWrite = [...writes].reverse().find((w) => w.body_json);
  if (!bodyWrite) throw new Error('the room never wrote a body — the run did not complete');
  return {
    body: bodyWrite.body_json as RunResult['body'],
    contentHash: bodyWrite.content_hash as string,
    telemetry: (bodyWrite.telemetry ?? []) as TelemetryEntry[],
    passes,
    stages,
    episodeStatus: [...writes].reverse().find((w) => w.status === 'script_ready')?.status as string | undefined,
    scriptStatus: bodyWrite.status as string | undefined,
  };
}

describe('the golden episode — the whole room, one fixed corpus', () => {
  it('produces exactly this body, and nothing about it drifts silently', async () => {
    const { body } = await runRoom();

    // Pinned INLINE rather than in a snapshot file. A `.snap` is updated with a flag and reviewed
    // by nobody; a diff in this array is a diff a reader has to look at and agree with. That is
    // the whole difference between a golden test and a record of whatever happened last.
    expect(body.title).toBe('The Ledger Episode');
    expect(body.open_loop).toBe('What happens when two ledgers disagree?');
    expect(body.turns.map((t) => `${t.id} ${t.speaker}${t.overlap ? ' (overlap)' : ''}: ${t.text}`)).toEqual([
      't1 teacher: The crate was already open when the harbour warehouse clerk arrived.',
      't2 learner: Open how? Prised, or just unlatched?',
      't3 teacher: Unlatched. Which is the part that mattered to the ledger.',
      't4 learner: Because an unlatched crate still counts as sealed?',
      't5 teacher: It counts as whatever the last entry says it is.',
      't6 learner: So the paper outranks the crate.',
      // The director's backchannel survives AND keeps its overlap, because "Mm." is non-lexical.
      't7 learner (overlap): Mm.',
    ]);
    // Exactly one hook, and it is the first turn.
    expect(body.turns.filter((t) => t.is_hook).map((t) => t.id)).toEqual(['t1']);
  });

  it('the same corpus yields the same content hash, run after run', async () => {
    // The hash is what tells a later stage "this is the same script". If it moved between
    // identical runs, every cache and every resume built on it would be wrong — and the drift
    // would show up as a mysterious re-render rather than as a bug in here.
    const a = await runRoom();
    const b = await runRoom();
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.body).toEqual(b.body);
  });

  it('the hash distinguishes bodies that differ only in delivery', async () => {
    // Stability alone is not enough, and asserting it alone was the gap: a hash that ignored
    // `overlap` stayed perfectly stable, matched the hex pattern, and was identical for two
    // scripts that sound different. Dropping overlap from the canonical form was a surviving
    // mutation until this test existed.
    //
    // Two bodies, same words, one overlapping turn demoted. A downstream stage that caches or
    // resumes on this hash would serve the wrong audio.
    const withOverlap = await runRoom();
    const withoutOverlap = await runRoom({
      delivery_director: {
        ...DIRECTED,
        turns: DIRECTED.turns.map((t) => ({ ...t, overlap: false })),
      },
    });
    expect(withoutOverlap.body.turns.map((t) => t.text)).toEqual(withOverlap.body.turns.map((t) => t.text));
    expect(withoutOverlap.contentHash, 'the hash cannot tell an overlapping turn from a sequential one').not.toBe(
      withOverlap.contentHash,
    );
  });

  it('the hash distinguishes bodies that differ only in speaker', async () => {
    // The other half of the canonical form. Same words, other voice — a different episode.
    const swapped = await runRoom({
      delivery_director: {
        ...DIRECTED,
        turns: DIRECTED.turns.map((t) => ({ ...t, speaker: t.speaker === 'teacher' ? 'learner' : 'teacher' })),
      },
    });
    const base = await runRoom();
    expect(swapped.contentHash, 'the hash cannot tell the two hosts apart').not.toBe(base.contentHash);
  });

  it('runs the passes in the order the room documents, and stops when the work is done', async () => {
    const { passes, stages } = await runRoom();
    // The clean corpus needs no rewrite, so the three conditional passes must not fire. A room
    // that rewrites a passing draft is burning the most expensive tier in the product for nothing.
    expect(passes).toEqual([
      'architect', 'materials', 'playwright',
      'fact_auditor', 'ear_editor', 'narrative_judge',
      'compiler', 'delivery_director',
    ]);
    expect(stages).toEqual(['architect', 'materials', 'playwright', 'review', 'compile', 'delivery', 'done']);
  });

  it('records what every pass cost, by name', async () => {
    // Telemetry is the only record of what an episode cost to produce, and it is written once, at
    // the end, alongside the body. Losing it breaks nothing a user sees — which is exactly why it
    // needs a test: deleting the push was a surviving mutation until this existed.
    const { telemetry, passes } = await runRoom();
    expect(telemetry.map((t) => t.pass), 'telemetry does not match the passes that ran').toEqual(passes);
    for (const entry of telemetry) {
      expect(entry.provider, `${entry.pass} recorded no provider`).toBeTruthy();
      expect(entry.model, `${entry.pass} recorded no model`).toBeTruthy();
      expect(typeof entry.cost_cents, `${entry.pass} recorded no cost`).toBe('number');
    }
  });

  it('marks the script ready and the episode script_ready, together', async () => {
    const { scriptStatus, episodeStatus } = await runRoom();
    expect(scriptStatus).toBe('ready');
    expect(episodeStatus).toBe('script_ready');
  });
});

describe('llm-pipeline-016 — a compiler that loses the script must not be published', () => {
  it('falls back to the DRAFT when the compiled body is a fragment', async () => {
    // The exact shape that shipped: a compiler returning a handful of turns from a full draft.
    // Both original guards passed it — `directed.turns.length >= compiled.turns.length` was true,
    // and the all-or-nothing fallback only fired at exactly zero.
    const fragment = { title: 'The Ledger Episode', turns: [COMPILED.turns[0]], open_loop: '' };
    const { body } = await runRoom({ compiler: fragment, delivery_director: fragment });

    // Unpolished but COMPLETE beats polished but gutted: the customer gets the whole episode.
    expect(body.turns).toHaveLength(DRAFT.turns.length);
    expect(body.turns.map((t) => t.text)).toEqual(DRAFT.turns.map((t) => t.text));
  });

  it('rebuilds from the draft rather than topping the fragment up', async () => {
    // A partial compile and the draft are two different scripts. Interleaving them produces one
    // that reads as neither, and the seam is invisible in a turn count.
    const fragment = { title: 'x', turns: [{ ...COMPILED.turns[0], text: 'A COMPILED FRAGMENT.' }], open_loop: '' };
    const { body } = await runRoom({ compiler: fragment, delivery_director: fragment });
    expect(body.turns.some((t) => t.text === 'A COMPILED FRAGMENT.'), 'the fragment leaked into the rebuilt body').toBe(false);
  });

  it('a compile that merely COMPRESSES is kept', async () => {
    // The floor must not punish the compiler for doing its job. Losing one turn of six is
    // polishing; the fallback is for losing most of them.
    const trimmed = { ...COMPILED, turns: COMPILED.turns.slice(0, 5) };
    const { body } = await runRoom({ compiler: trimmed, delivery_director: trimmed });
    expect(body.turns).toHaveLength(5);
  });
});

describe('the deterministic rules that run after the model', () => {
  it('splits an over-long turn at a sentence boundary and renumbers', async () => {
    const long = `${'This sentence is exactly the sort of thing a model writes when it forgets it is speech. '.repeat(4)}And then a short one.`;
    const one = { title: 'The Ledger Episode', turns: [{ ...COMPILED.turns[0], text: long }], open_loop: '' };
    const { body } = await runRoom({
      // A single-turn draft, so the proportional floor is satisfied by a single compiled turn and
      // this test is about the splitter rather than about the fallback.
      playwright: { ...DRAFT, turns: [DRAFT.turns[0]] },
      compiler: one,
      delivery_director: one,
    });
    expect(body.turns.length, 'a 340-character turn was not split').toBeGreaterThan(1);
    for (const t of body.turns) expect(String(t.text).length).toBeLessThanOrEqual(300);
    // Ids stay sequential across the split — a downstream stitcher addresses turns by id.
    expect(body.turns.map((t) => t.id)).toEqual(body.turns.map((_, i) => `t${i + 1}`));
    // Split at a sentence end, not mid-word.
    expect(String(body.turns[0].text)).toMatch(/[.!?]$/);
  });

  it('demotes a WORDED overlap — two voices never speak words in parallel', async () => {
    const worded = {
      title: 'The Ledger Episode',
      turns: [...COMPILED.turns, { speaker: 'learner' as const, text: 'Wait, that is the whole point though.', overlap: true, is_hook: false, beat: 'b2' }],
      open_loop: '',
    };
    const { body } = await runRoom({ compiler: worded, delivery_director: worded });
    const last = body.turns[body.turns.length - 1];
    expect(last.text).toBe('Wait, that is the whole point though.');
    expect(last.overlap, 'a worded reaction was left overlapping — it would be spoken over').toBe(false);
  });

  it('drops a blank turn rather than numbering it', async () => {
    // A whitespace-only turn is a silent gap in the finished audio and an id that addresses
    // nothing. `CompilerTurnSchema` requires a non-empty string, so the blank has to be
    // whitespace to get this far — which is precisely the shape that slips past a `min(1)`.
    const withBlank = {
      ...COMPILED,
      turns: [
        COMPILED.turns[0],
        { ...COMPILED.turns[1], text: '   ' },
        ...COMPILED.turns.slice(2),
      ],
    };
    const { body } = await runRoom({ compiler: withBlank, delivery_director: withBlank });
    expect(body.turns.map((t) => String(t.text).trim()).filter((t) => !t), 'a blank turn reached the body').toEqual([]);
    // One fewer turn than the compiler sent, and the ids close over the gap rather than skipping.
    expect(body.turns).toHaveLength(COMPILED.turns.length - 1);
    expect(body.turns.map((t) => t.id)).toEqual(body.turns.map((_, i) => `t${i + 1}`));
  });

  it('trims surrounding whitespace from a turn', async () => {
    const padded = {
      ...COMPILED,
      turns: COMPILED.turns.map((t, i) => (i === 0 ? { ...t, text: `\n  ${t.text}  \n` } : t)),
    };
    const { body } = await runRoom({ compiler: padded, delivery_director: padded });
    expect(body.turns[0].text).toBe(COMPILED.turns[0].text);
  });

  it('guarantees a hook even when every pass forgot one', async () => {
    const noHook = { ...COMPILED, turns: COMPILED.turns.map((t) => ({ ...t, is_hook: false })) };
    const { body } = await runRoom({ compiler: noHook, delivery_director: noHook });
    expect(body.turns.filter((t) => t.is_hook).map((t) => t.id)).toEqual(['t1']);
  });

  it('falls back to the story plan for a missing title and open loop', async () => {
    const bare = { title: '', turns: COMPILED.turns.map((t) => ({ ...t })), open_loop: '' };
    const { body } = await runRoom({ compiler: bare, delivery_director: bare });
    expect(body.title).toBe(STORY.episode_title);
    expect(body.open_loop).toBe(STORY.open_loop);
  });

  it('keeps the compiled body when the director LOSES turns', async () => {
    // The director is meant to add short backchannels. One that returns fewer turns than it was
    // given has cut teaching content, so its output is discarded rather than trusted.
    //
    // FOUR turns from six, deliberately — not two. The first version of this test used two, which
    // is below the proportional floor, so the floor rebuilt from the draft and the assertion
    // passed whether or not the director guard existed at all. Deleting the guard was a surviving
    // mutation. Four sits above the floor, so the ONLY thing that can produce a six-turn body here
    // is the director guard doing its job.
    const thin = { ...COMPILED, turns: COMPILED.turns.slice(0, 4) };
    const { body } = await runRoom({ delivery_director: thin });
    expect(body.turns).toHaveLength(COMPILED.turns.length);
    // ...and it is the COMPILED text that survived, not a draft rebuild that happens to be the
    // same length. Those are different bodies and the count alone cannot tell them apart.
    expect(body.turns.map((t) => t.text)).toEqual(COMPILED.turns.map((t) => t.text));
  });

  it('the floor and the director guard are separate protections', async () => {
    // A director that loses turns AND lands under the floor must still yield a complete episode —
    // via the draft rebuild. Stated separately so that neither test can silently start covering
    // for the other, which is exactly how the guard above went unprotected.
    const gutted = { ...COMPILED, turns: COMPILED.turns.slice(0, 1) };
    const { body } = await runRoom({ delivery_director: gutted });
    expect(body.turns).toHaveLength(COMPILED.turns.length);
  });
});

describe('the rewrite path fires only when a reviewer asks for it', () => {
  it('a needs_fixes verdict adds the rewrite, verify and repair passes', async () => {
    const { passes } = await runRoom({
      fact_auditor: { findings: [{ severity: 'red', quote: 'q', problem: 'p', fix: 'f' }], verdict: 'needs_fixes' },
      // The re-audit still reports a red, so the capped repair pass runs too.
      fact_auditor_verify: { findings: [{ severity: 'red', quote: 'q', problem: 'p', fix: 'f' }], verdict: 'needs_fixes' },
    });
    expect(passes).toEqual([
      'architect', 'materials', 'playwright',
      'fact_auditor', 'ear_editor', 'narrative_judge',
      'playwright_rewrite', 'fact_auditor_verify', 'playwright_repair',
      'compiler', 'delivery_director',
    ]);
  });

  it('a clean re-audit stops before the repair pass — the cap is real', async () => {
    // The repair iteration is hard-capped at one to bound cost and latency. A room that repairs a
    // clean re-audit is paying for the most expensive tier twice with nothing to fix.
    const { passes } = await runRoom({
      ear_editor: { findings: [], estimated_minutes: 1, verdict: 'needs_fixes' },
    });
    expect(passes).toContain('playwright_rewrite');
    expect(passes).toContain('fact_auditor_verify');
    expect(passes, 'a repair pass ran with no reds to repair').not.toContain('playwright_repair');
  });
});
