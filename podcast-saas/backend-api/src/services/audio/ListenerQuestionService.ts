/**
 * Raise Your Hand — asking, saving and answering. P3-B / A2.4.
 *
 * The rules live in `listenerQuestion.ts` and are tested there. This file is the part that touches
 * the database and the model, and its one job is to make sure the order of operations cannot be
 * used to spend the owner's money: count first, record first, call the model last.
 */
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { listener_questions, project_audio_editions, projects } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { LLMService } from '../llm/LLMService.js';
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { UsageTrackingService } from '../usage/UsageTrackingService.js';
import {
  contextAround,
  decideSpend,
  fallbackIntent,
  parseVtt,
  type QuestionIntent,
} from './listenerQuestion.js';

/**
 * How many questions one project will answer per rolling day, by default.
 *
 * A number, stated once, that someone can argue with. Twenty is enough for a lesson with real
 * listeners and small enough that a stranger holding down a button costs the owner cents rather
 * than a bill. It is a DEFAULT because the eventual per-creator setting belongs to whoever is
 * paying; until that exists, the safe value is the one that cannot surprise anybody.
 */
export const DEFAULT_DAILY_ANSWER_CAP = 20;

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AskInput {
  projectId: string;
  language?: string | null;
  positionMs: number;
  question: string;
  intent: QuestionIntent;
  /** Null for an anonymous listener — the common case on a public page. */
  userId?: string | null;
  /** The interactive voice path: every token as the model writes it, so speech can start on the first sentence. */
  onTokenChunk?: (chunk: string) => void;
  abortSignal?: AbortSignal;
}

export interface AskResult {
  status: 'answered' | 'saved' | 'refused';
  /** The answer, when there is one. */
  answer?: string;
  /** Why it was not answered, in words the listener can act on. */
  reason?: string;
  questionId?: string;
}

/** Answers billed to this project inside the rolling window. */
async function answeredToday(projectId: string): Promise<number> {
  const since = new Date(Date.now() - WINDOW_MS);
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(listener_questions)
    .where(and(
      eq(listener_questions.project_id, projectId),
      // `answered_at`, not `created_at`. Saved questions are the majority and none of them cost
      // anything, so counting rows by creation would let the driving path exhaust the answer
      // budget it was designed never to touch.
      isNotNull(listener_questions.answered_at),
      gte(listener_questions.answered_at, since),
    ));
  return rows[0]?.n ?? 0;
}

export async function askListenerQuestion(input: AskInput, llm = new LLMService(new ApiKeyService(), new UsageTrackingService())): Promise<AskResult> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, input.projectId) });
  if (!project) return { status: 'refused', reason: 'That lesson no longer exists.' };

  const decision = decideSpend({
    intent: input.intent,
    question: input.question,
    answeredToday: await answeredToday(input.projectId),
    dailyCap: DEFAULT_DAILY_ANSWER_CAP,
    // Until a per-project setting exists, questions are on wherever the lesson is public. Stated
    // here rather than hidden in a default so the eventual column has one obvious home.
    enabled: project.visibility === 'public',
  });

  // RECORD BEFORE ANSWERING, always. A question the model then fails on is still a question the
  // creator wants to see, and it is the demand signal A2.5 waits on. Writing the row only on
  // success would lose exactly the questions that reveal where the lesson is confusing.
  const [row] = await db.insert(listener_questions).values({
    project_id: input.projectId,
    language: input.language ?? null,
    position_ms: Math.max(0, Math.round(input.positionMs)),
    question: input.question.trim().slice(0, 500),
    asked_by: input.userId ?? null,
    status: 'saved',
  }).returning({ id: listener_questions.id });

  if (!decision.allowed) {
    const fallback = fallbackIntent(decision);
    // A capped or disabled question is already saved by the insert above; a MALFORMED one should
    // never have been stored, so it is removed rather than left as noise in the creator's list.
    if (!fallback) {
      await db.delete(listener_questions).where(eq(listener_questions.id, row.id));
      return { status: 'refused', reason: decision.reason ?? 'That question could not be accepted.' };
    }
    return { status: 'saved', reason: decision.reason ?? undefined, questionId: row.id };
  }
  if (input.intent === 'save') return { status: 'saved', questionId: row.id };

  // ── Grounding ─────────────────────────────────────────────────────────────────────────────
  const edition = await db.query.project_audio_editions.findFirst({
    where: and(
      eq(project_audio_editions.project_id, input.projectId),
      input.language
        ? eq(project_audio_editions.language, input.language)
        : sql`${project_audio_editions.language} IS NULL`,
    ),
  });
  const context = contextAround(parseVtt(edition?.captions_vtt ?? ''), input.positionMs);
  if (!context) {
    // NO TRANSCRIPT, NO ANSWER. Asking a model to answer a lesson question with nothing from the
    // lesson produces a confident, plausible, ungrounded answer — which is worse than no answer,
    // because the listener has no way to tell and the creator's name is on it.
    return {
      status: 'saved',
      reason: 'This lesson has no transcript yet, so your question was saved for the creator.',
      questionId: row.id,
    };
  }

  try {
    // Plain text, streamed: the voice path speaks the first sentence while the model writes the
    // next (owner ruling 2026-09-03 — Tap to ask like NotebookLM's interrupt). The register is
    // the prompt's job; there is no JSON to unwrap, so nothing waits for a closing brace.
    const res = await llm.sendText({
      task: 'listener_question',
      systemPrompt:
        'You answer a listener\'s question about the passage of a lesson they are currently hearing. ' +
        'Answer ONLY from the passage. If the passage does not contain the answer, say so plainly in ' +
        'one sentence rather than guessing — the listener is driving and cannot check. Two or three ' +
        'sentences, spoken register, no preamble, no lists, no markdown — it will be read aloud.\n\nPASSAGE:\n' + context,
      userPrompt: input.question.trim(),
      userId: input.userId ?? null,
      projectId: input.projectId,
      onTokenChunk: input.onTokenChunk,
      abortSignal: input.abortSignal ?? new AbortController().signal,
    });

    const answer = String(res.text ?? '').trim();
    if (!answer) throw new Error('the model returned no answer text');

    await db.update(listener_questions)
      .set({
        answer,
        status: 'answered',
        // Set TOGETHER with the answer, in one write. The cap counts this column, so a row that
        // has an answer without a timestamp is one the cap cannot see — free answers forever.
        answered_at: new Date(),
        cost_cents: Math.round(res.usage?.cost_cents ?? 0),
      })
      .where(eq(listener_questions.id, row.id));

    return { status: 'answered', answer, questionId: row.id };
  } catch (err) {
    logger.warn({ err, projectId: input.projectId }, 'listener question could not be answered');
    await db.update(listener_questions)
      .set({ status: 'failed' })
      .where(eq(listener_questions.id, row.id));
    // NOT `answered_at`. A failed call may still have cost something upstream, but charging the
    // cap for an answer the listener never received would let one broken provider exhaust a
    // creator's whole day.
    return {
      status: 'saved',
      reason: 'That could not be answered right now — your question was saved.',
      questionId: row.id,
    };
  }
}
