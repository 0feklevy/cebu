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
  /**
   * Rows the voice path fetched CONCURRENTLY WITH the speech-to-text call (latency work,
   * 2026-09-04): the project row, the rolling answer count and the audio edition are all
   * independent of the transcript, so waiting for Whisper before fetching them was pure serial
   * waste. Absent (the typed-question path), they are fetched here as before.
   */
  prefetched?: Awaited<ReturnType<typeof prefetchAskContext>>;
}

/**
 * Everything `askListenerQuestion` needs from the database that does NOT depend on the question
 * text — safe to start before the listener's audio is even transcribed.
 */
export async function prefetchAskContext(projectId: string, language: string | null | undefined) {
  const [project, answered, edition] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
    answeredToday(projectId),
    db.query.project_audio_editions.findFirst({
      where: and(
        eq(project_audio_editions.project_id, projectId),
        language
          ? eq(project_audio_editions.language, language)
          : sql`${project_audio_editions.language} IS NULL`,
      ),
    }),
  ]);
  return { project, answeredToday: answered, edition };
}

/**
 * The whole lesson, as plain speech text, capped — the model's base knowledge (owner direction
 * 2026-09-04: "the CC text is the base knowledge", NotebookLM-style). The cap keeps a pathological
 * transcript from flooding the context; typical lessons fit whole. Trimmed from the FRONT so the
 * most recent material — likeliest to be what the question is about — survives.
 */
export const MAX_TRANSCRIPT_CHARS = 24_000;
function fullTranscriptText(vtt: string): string {
  const text = parseVtt(vtt).map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(text.length - MAX_TRANSCRIPT_CHARS) : text;
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
  const pre = input.prefetched ?? await prefetchAskContext(input.projectId, input.language);
  const project = pre.project;
  if (!project) return { status: 'refused', reason: 'That lesson no longer exists.' };

  const decision = decideSpend({
    intent: input.intent,
    question: input.question,
    answeredToday: pre.answeredToday,
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
  const edition = pre.edition;
  const vtt = edition?.captions_vtt ?? '';
  const transcript = fullTranscriptText(vtt);
  const passage = contextAround(parseVtt(vtt), input.positionMs);
  if (!transcript) {
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
    //
    // GROUNDING (owner direction 2026-09-04): the WHOLE lesson transcript is the base knowledge,
    // not just a ±window — a question about minute 3 asked at minute 40 deserves an answer. The
    // transcript is byte-stable for the whole lesson, so it rides in the CACHED PREFIX: the first
    // question of a session writes the cache, every later one reads it (the old prompt embedded a
    // per-call window in the system prompt and cache-wrote 1.25× on every single call, never
    // reading anything back). Only the playhead passage + the question vary per call.
    const stablePrefix =
      'You are the lesson\'s instant voice assistant. A listener tapped to ask a question while ' +
      'listening; they are often driving and cannot check anything. Answer ONLY from the lesson ' +
      'transcript below. Be fast and conversational: lead with the answer itself in ONE or TWO ' +
      'short spoken sentences — no preamble, no "great question", no lists, no markdown; it is ' +
      'read aloud. If the transcript does not contain the answer, say that plainly in one ' +
      'sentence rather than guessing.\n\nLESSON TRANSCRIPT:\n' + transcript;
    const res = await llm.sendText({
      task: 'listener_question',
      systemPrompt:
        stablePrefix +
        (passage ? '\n\nPASSAGE PLAYING RIGHT NOW (their position):\n' + passage : ''),
      systemPromptCachePrefix: stablePrefix,
      userPrompt: input.question.trim(),
      // A spoken two-sentence answer needs nothing like the tier's 8k headroom; the cap also
      // bounds worst-case TTS spend per answer.
      maxTokensOverride: 500,
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
