/**
 * The language a project's video is ALREADY in — resolved, not assumed.
 *
 * ── The defect ────────────────────────────────────────────────────────────────────────────────
 * Migration 068 added `projects.source_language`, and the dubbing routes refuse to dub a video into
 * it. Both correct, both inert: NOTHING EVER WROTE THE COLUMN. It is null for every project that
 * exists, so an English lesson is offered "English" as a paid target — a full billable vendor run
 * that returns a worse copy of the original. Shipping the refusal without shipping the detection
 * left the defect exactly where it started, which is why it was reported twice.
 *
 * ── Three sources, in a fixed order of authority ──────────────────────────────────────────────
 *   declared — a person said so. Nothing here ever overwrites it.
 *   vendor   — the dubbing vendor auto-detected it while doing a real run. It listened to the
 *              audio, which beats anything inferred from text, so it replaces a `detected` value.
 *   detected — identified offline from the transcript this product already stores. Free, instant,
 *              and no tokens: the captions are sitting in the database.
 *
 * ── The rule that governs all of it ───────────────────────────────────────────────────────────
 * A LOW-CONFIDENCE GUESS IS NOT AN ANSWER. It is returned as a SUGGESTION, which prefills the
 * creator's picker and changes nothing on its own. Only a guess at or above `CONFIDENT` is written
 * down, and even then it is written as `detected` so the UI can say where it came from and offer
 * to change it. A language silently removed from someone's list with no explanation is a worse
 * failure than the one this module fixes.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { projects, video_files } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { captionsToPlainText, detectLanguage, CONFIDENT } from './detectLanguage.js';
import { normalizeDubbingLanguage, sourceLanguageTag } from './languages.js';

export type SourceLanguageOrigin = 'declared' | 'detected' | 'vendor';

export interface ResolvedSourceLanguage {
  /** The language to treat as the source, or null when nothing is known well enough to act on. */
  code: string | null;
  origin: SourceLanguageOrigin | null;
  /**
   * A best guess that did NOT clear the bar — offered to prefill the creator's picker and never
   * acted on. Null when the transcript gave no usable signal at all.
   */
  suggestion: { code: string; confidence: number } | null;
  /** Why `code` is null, for a UI that has to say something more useful than nothing. */
  reason: 'no_transcript' | 'undecided' | null;
}

/**
 * How much transcript to read.
 *
 * Language identification saturates long before this: a couple of thousand words settles it and
 * everything after is repetition. The cap exists so a three-hour course does not pull megabytes of
 * text into memory to answer a question the first two minutes already answered.
 */
const MAX_SAMPLE_CHARS = 40_000;

/** The project's source language, detecting and caching it the first time anyone asks. */
export async function resolveProjectSourceLanguage(projectId: string): Promise<ResolvedSourceLanguage> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { id: true, source_language: true, source_language_origin: true },
  });
  if (!project) return { code: null, origin: null, suggestion: null, reason: null };

  const stored = normalizeDubbingLanguage(project.source_language ?? '')
    ?? sourceLanguageTag(project.source_language);
  if (stored) {
    // A value with no origin predates migration 070. Reading it as `declared` is the conservative
    // choice: it means nothing here will overwrite it, and a human can still change it.
    const origin = (project.source_language_origin as SourceLanguageOrigin | null) ?? 'declared';
    return { code: stored, origin, suggestion: null, reason: null };
  }

  const sample = await transcriptSample(projectId);
  if (!sample) return { code: null, origin: null, suggestion: null, reason: 'no_transcript' };

  const guess = detectLanguage(sample);
  if (!guess) return { code: null, origin: null, suggestion: null, reason: 'undecided' };

  // The detector answers in base codes; this product's target list is the gate on what those codes
  // are allowed to mean. A language it can identify but cannot dub into is not a source we act on.
  const code = normalizeDubbingLanguage(guess.code);
  if (!code) return { code: null, origin: null, suggestion: null, reason: 'undecided' };

  if (guess.confidence < CONFIDENT) {
    return {
      code: null,
      origin: null,
      suggestion: { code, confidence: Number(guess.confidence.toFixed(2)) },
      reason: 'undecided',
    };
  }

  // Cache it. Guarded on the column still being null so a creator who declared a language in the
  // meantime is not overwritten by a read that started before they did.
  try {
    await db.update(projects)
      .set({ source_language: code, source_language_origin: 'detected' })
      .where(and(eq(projects.id, projectId), isNull(projects.source_language)));
  } catch (err) {
    // Detection is still correct even if caching it failed; the next read simply repeats the work.
    logger.warn(
      { projectId, err: (err as Error).message?.slice(0, 160) },
      '[dubbing] could not cache the detected source language',
    );
  }

  logger.info(
    { projectId, code, confidence: guess.confidence, basis: guess.basis },
    '[dubbing] detected the project source language from its transcript',
  );
  return { code, origin: 'detected', suggestion: null, reason: null };
}

/**
 * Record what the vendor heard.
 *
 * Called after a real dub, where the vendor auto-detected the source from the audio itself. It
 * outranks our text inference and replaces it — but never a human's declaration, which is what the
 * `origin` test in the WHERE clause enforces at the database rather than in a branch above it.
 */
export async function recordVendorSourceLanguage(projectId: string, tag: string | null | undefined): Promise<void> {
  const code = normalizeDubbingLanguage(tag ?? '') ?? sourceLanguageTag(tag);
  if (!code) return;
  try {
    await db.update(projects)
      .set({ source_language: code, source_language_origin: 'vendor' })
      .where(and(
        eq(projects.id, projectId),
        or(isNull(projects.source_language), eq(projects.source_language_origin, 'detected')),
      ));
  } catch (err) {
    logger.warn(
      { projectId, err: (err as Error).message?.slice(0, 160) },
      '[dubbing] could not record the vendor-detected source language',
    );
  }
}

/** A person's declaration. Outranks everything, including a later vendor detection. */
export async function declareProjectSourceLanguage(projectId: string, tag: string | null): Promise<string | null> {
  if (tag === null) {
    await db.update(projects)
      .set({ source_language: null, source_language_origin: null })
      .where(eq(projects.id, projectId));
    return null;
  }
  const code = normalizeDubbingLanguage(tag);
  if (!code) return null;
  await db.update(projects)
    .set({ source_language: code, source_language_origin: 'declared' })
    .where(eq(projects.id, projectId));
  return code;
}

/** Concatenated speech from the project's main videos, capped, or null when there is none. */
async function transcriptSample(projectId: string): Promise<string | null> {
  const videos = await db.query.video_files.findMany({
    where: eq(video_files.project_id, projectId),
    columns: { id: true, is_broll: true, captions_vtt: true },
  });
  const parts: string[] = [];
  let length = 0;
  for (const v of videos) {
    // B-roll is stock footage with someone else's narration or none at all — it is not evidence
    // about the language of THIS lesson.
    if (v.is_broll || !v.captions_vtt) continue;
    const text = captionsToPlainText(v.captions_vtt);
    if (!text) continue;
    parts.push(text);
    length += text.length;
    if (length >= MAX_SAMPLE_CHARS) break;
  }
  if (parts.length === 0) return null;
  return parts.join(' ').slice(0, MAX_SAMPLE_CHARS);
}
