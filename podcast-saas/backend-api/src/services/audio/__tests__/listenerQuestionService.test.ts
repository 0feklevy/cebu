/**
 * P3-B / A2.4 — the ORDER of operations, which is what stops a stranger spending the owner's money.
 *
 * The rules are tested next door. What this file pins is that they are consulted before anything
 * is spent, and that a question is recorded before a model is called — because the two mistakes
 * available here are opposite and both are silent. Answer first and the cap is decorative; record
 * only on success and the creator loses exactly the questions that reveal where their lesson is
 * confusing, which is also the demand signal A2.5 is waiting on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  project: { id: 'p1', visibility: 'public' } as Record<string, unknown> | undefined,
  edition: { captions_vtt: 'WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nA ledger records what happened.\n' } as Record<string, unknown> | undefined,
  answeredCount: 0,
  inserted: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  deletes: 0,
  llmCalls: [] as Array<Record<string, unknown>>,
  llmThrows: null as string | null,
  llmAnswer: 'Because the entry outranks the crate.' as string,
};

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: async () => state.project },
      project_audio_editions: { findFirst: async () => state.edition },
    },
    select: () => ({ from: () => ({ where: async () => [{ n: state.answeredCount }] }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserted.push(v);
        return { returning: async () => [{ id: 'q1' }] };
      },
    }),
    update: () => ({ set: (p: Record<string, unknown>) => ({ where: async () => { state.updates.push(p); return []; } }) }),
    delete: () => ({ where: async () => { state.deletes += 1; return []; } }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  listener_questions: { id: 'id', project_id: 'project_id', answered_at: 'answered_at' },
  project_audio_editions: { project_id: 'project_id', language: 'language' },
  projects: { id: 'id' },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})), eq: vi.fn(() => ({})), gte: vi.fn(() => ({})), isNotNull: vi.fn(() => ({})),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));

const { askListenerQuestion, DEFAULT_DAILY_ANSWER_CAP } = await import('../ListenerQuestionService.js');

/** A stand-in LLM that records what it was asked and can be made to fail. */
const fakeLlm = {
  sendText: async (opts: Record<string, unknown> & { onTokenChunk?: (c: string) => void }) => {
    state.llmCalls.push(opts);
    if (state.llmThrows) throw new Error(state.llmThrows);
    // Streams the answer in two pieces, the way a real provider hands tokens over.
    const half = Math.ceil(state.llmAnswer.length / 2);
    opts.onTokenChunk?.(state.llmAnswer.slice(0, half));
    opts.onTokenChunk?.(state.llmAnswer.slice(half));
    return { text: state.llmAnswer, usage: { cost_cents: 3 }, provider: 'fake', model: 'fake' };
  },
};

const ask = (over: Record<string, unknown> = {}) =>
  askListenerQuestion(
    { projectId: 'p1', positionMs: 30_000, question: 'Why does the ledger win?', intent: 'answer', ...over } as never,
    fakeLlm as never,
  );

beforeEach(() => {
  state.project = { id: 'p1', visibility: 'public' };
  state.edition = { captions_vtt: 'WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nA ledger records what happened.\n' };
  state.answeredCount = 0;
  state.inserted = [];
  state.updates = [];
  state.deletes = 0;
  state.llmCalls = [];
  state.llmThrows = null;
  state.llmAnswer = 'Because the entry outranks the crate.';
});

describe('the cap is consulted before anything is spent', () => {
  it('answers a question under the cap', async () => {
    const r = await ask();
    expect(r.status).toBe('answered');
    expect(r.answer).toBe('Because the entry outranks the crate.');
    expect(state.llmCalls).toHaveLength(1);
  });

  it('calls NO model once the cap is reached', async () => {
    // The expensive-side assertion. A cap that refuses AFTER the call has already happened is a
    // cap that costs exactly as much as no cap at all.
    state.answeredCount = DEFAULT_DAILY_ANSWER_CAP;
    const r = await ask();
    expect(r.status).toBe('saved');
    expect(state.llmCalls, 'a model was called for a question over the cap').toEqual([]);
  });

  it('calls no model for an over-long question', async () => {
    // The question is attacker-controlled text that goes into a prompt the owner pays for.
    const r = await ask({ question: 'a'.repeat(2000) });
    expect(r.status).toBe('refused');
    expect(state.llmCalls).toEqual([]);
  });

  it('calls no model when the lesson is not public', async () => {
    state.project = { id: 'p1', visibility: 'private' };
    const r = await ask();
    expect(r.status).toBe('saved');
    expect(state.llmCalls).toEqual([]);
  });

  it('counts by answered_at, so saved questions never consume the budget', async () => {
    // Verified through the WHERE clause the count is built from: the column being filtered on is
    // the billable timestamp, not the row's creation. A count by `created_at` would let the
    // free driving path exhaust the budget it was designed never to touch.
    const { isNotNull } = await import('drizzle-orm');
    await ask();
    expect(vi.mocked(isNotNull)).toHaveBeenCalledWith('answered_at');
  });
});

describe('the question is recorded before the model is called', () => {
  it('inserts the row first, then answers', async () => {
    await ask();
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ project_id: 'p1', position_ms: 30_000, status: 'saved' });
  });

  it('keeps a question the model FAILED on', async () => {
    // A failed answer is still a question the creator wants to see. Writing the row only on
    // success would lose precisely the questions that reveal where the lesson is confusing.
    state.llmThrows = 'provider exploded';
    const r = await ask();
    expect(r.status).toBe('saved');
    expect(state.inserted).toHaveLength(1);
    expect(state.updates.find((u) => u.status === 'failed')).toBeDefined();
  });

  it('does NOT stamp answered_at on a failure', async () => {
    // Charging the cap for an answer the listener never received would let one broken provider
    // exhaust a creator's entire day.
    state.llmThrows = 'provider exploded';
    await ask();
    const failed = state.updates.find((u) => u.status === 'failed');
    expect(failed).not.toHaveProperty('answered_at');
  });

  it('keeps a capped question rather than discarding it', async () => {
    state.answeredCount = DEFAULT_DAILY_ANSWER_CAP;
    await ask();
    expect(state.inserted, 'a capped question was not recorded').toHaveLength(1);
    expect(state.deletes, 'a capped question was deleted').toBe(0);
  });

  it('removes a MALFORMED question — there is nothing worth keeping', async () => {
    await ask({ question: '   ' });
    expect(state.deletes, 'an empty question was left as noise in the creator’s list').toBe(1);
  });

  it('stamps answered_at together with the answer, in one write', async () => {
    // A row holding an answer with no timestamp is one the cap cannot see: free answers, forever.
    await ask();
    const done = state.updates.find((u) => u.status === 'answered');
    expect(done?.answer).toBeTruthy();
    expect(done?.answered_at, 'an answer was stored without its billable timestamp').toBeInstanceOf(Date);
    expect(done?.cost_cents).toBe(3);
  });
});

describe('an answer is grounded, or there is no answer', () => {
  it('sends the transcript around the question’s moment', async () => {
    await ask();
    expect(String(state.llmCalls[0].systemPrompt)).toContain('A ledger records what happened.');
  });

  it('refuses to answer at all when the lesson has no transcript', async () => {
    // Asking a model a lesson question with nothing from the lesson produces a confident,
    // plausible, ungrounded answer — worse than none, because the listener cannot tell and the
    // creator's name is on it.
    state.edition = { captions_vtt: null };
    const r = await ask();
    expect(r.status).toBe('saved');
    expect(r.reason).toMatch(/no transcript/i);
    expect(state.llmCalls, 'a model was asked to answer from nothing').toEqual([]);
  });

  it('a position past the end of the transcript still answers — from the WHOLE transcript', async () => {
    // Changed with the 2026-09-04 grounding rework (owner: "the CC text is the base knowledge").
    // The whole transcript is the model's knowledge now, so an out-of-window position — asked
    // after the lesson ended, or a skewed clock — answers like NotebookLM would, instead of
    // being treated as "no transcript at all". Refusal remains ONLY for a lesson with no
    // transcript (the test above).
    const r = await ask({ positionMs: 9_000_000 });
    expect(r.status).toBe('answered');
    expect(state.llmCalls).toHaveLength(1);
    // Grounded: the full transcript rides in the system prompt even with no playhead passage.
    expect(String(state.llmCalls[0].systemPrompt)).toContain('LESSON TRANSCRIPT');
  });

  it('treats an empty model answer as a failure, not an answer', async () => {
    state.llmAnswer = '   ';
    const r = await ask();
    expect(r.status).toBe('saved');
    expect(state.updates.find((u) => u.status === 'answered')).toBeUndefined();
  });
});

describe('saving is free and stays available', () => {
  it('saves without calling a model, even with the cap exhausted', async () => {
    state.answeredCount = 9999;
    const r = await ask({ intent: 'save' });
    expect(r.status).toBe('saved');
    expect(state.llmCalls).toEqual([]);
    expect(state.inserted).toHaveLength(1);
  });

  it('records an anonymous listener as anonymous rather than refusing them', async () => {
    // The audio page is public; asking must not require an account, and the row is still useful
    // to the creator without one.
    await ask({ intent: 'save', userId: undefined });
    expect(state.inserted[0].asked_by).toBeNull();
  });

  it('clamps a negative position rather than storing it', async () => {
    await ask({ intent: 'save', positionMs: -5000 });
    expect(state.inserted[0].position_ms).toBe(0);
  });
});
