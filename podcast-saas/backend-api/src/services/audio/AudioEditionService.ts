/**
 * Building, and not rebuilding, a project's audio edition — P3-B / A2.1.
 *
 * Three pieces meet here and nothing else does: the rules (`audioEdition.ts`), the ffmpeg pass
 * (`audioEditionBuilder.ts`), and the row. The interesting behaviour in this file is all about
 * NOT doing work — deciding an edition is already current, refusing a project that cannot produce
 * one, and making sure a crashed job leaves something a later run can pick up rather than a row
 * stuck in `processing` forever.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../../db/index.js';
import { project_audio_editions, projects, timeline_sections, video_files } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import {
  concatCaptions,
  deriveChapters,
  editionRefusalReason,
  editionSourceHash,
  totalDurationMs,
  type EditionSection,
  type EditionSegment,
} from './audioEdition.js';
import { editionStorageKey, joinToM4a, probeDurationMs } from './audioEditionBuilder.js';

/**
 * How long a claim may be held before another run may take it.
 *
 * A worker that dies mid-render leaves `status: 'processing'` and a `claimed_at` that never
 * advances. Without a horizon that row is permanently unbuildable — the creator presses
 * regenerate and nothing happens, forever, with no error to see. Twenty minutes is far longer
 * than any real edition takes and far shorter than a person's patience.
 */
export const STALE_CLAIM_MS = 20 * 60 * 1000;

export interface BuildOptions {
  /** Rebuild even when the source hash matches — the creator's explicit "regenerate". */
  force?: boolean;
}

export interface BuildResult {
  status: 'ready' | 'skipped' | 'refused' | 'failed';
  reason?: string;
  editionId?: string;
}

/** The project's segments and sections, in the shape the rules take. */
async function loadInputs(projectId: string): Promise<{ segments: EditionSegment[]; sections: EditionSection[] }> {
  const [videos, sections] = await Promise.all([
    db.query.video_files.findMany({
      where: and(eq(video_files.project_id, projectId), eq(video_files.is_broll, false)),
      orderBy: (v, { asc }) => [asc(v.sequence_order), asc(v.created_at)],
    }),
    db.query.timeline_sections.findMany({
      where: eq(timeline_sections.project_id, projectId),
    }),
  ]);

  return {
    segments: videos.map((v) => ({
      audioKey: v.storage_key ?? '',
      durationMs: Math.round((v.duration_sec ?? 0) * 1000),
      captionsVtt: v.captions_vtt,
    })),
    sections: sections.map((s) => ({
      startSec: s.start_sec,
      endSec: s.end_sec,
      label: s.label,
      type: s.type,
      sortOrder: s.sort_order,
    })),
  };
}

/**
 * Build the edition for a project, or explain why not.
 *
 * `language` is NULL for the source track. A dubbed edition is a separate row and a separate
 * artifact — see migration 071 for why that is identity rather than a column.
 */
export async function buildAudioEdition(
  projectId: string,
  language: string | null = null,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) return { status: 'refused', reason: 'That project no longer exists.' };

  const { segments, sections } = await loadInputs(projectId);

  const refusal = editionRefusalReason(segments);
  if (refusal) {
    // REFUSED, not FAILED. The distinction reaches the creator: a refusal names something they can
    // act on ("no playable audio yet"), while a failure asks them to report a bug. Marking a
    // not-yet-ready project as failed would also stop the retry that will succeed once transcoding
    // finishes.
    return { status: 'refused', reason: refusal };
  }

  const usable = segments.filter((s) => s.audioKey && s.durationMs > 0);
  const hash = editionSourceHash({ language, segments: usable, sections });

  const existing = await db.query.project_audio_editions.findFirst({
    where: language === null
      ? and(eq(project_audio_editions.project_id, projectId), isNull(project_audio_editions.language))
      : and(eq(project_audio_editions.project_id, projectId), eq(project_audio_editions.language, language)),
  });

  if (!opts.force && existing?.status === 'ready' && existing.source_hash === hash) {
    // The whole point of the hash. Without this branch "regenerate" is either always-work or
    // never-work, and both are wrong: the first burns compute on every page load that touches it,
    // the second leaves a stale artifact that no longer matches the lesson.
    return { status: 'skipped', reason: 'This edition already matches the project.', editionId: existing.id };
  }

  // CLAIM BEFORE WORKING, and only if nobody else holds a live claim. Two workers building the
  // same edition would both upload, both write the row, and the loser's object would be orphaned
  // in the bucket with nothing pointing at it.
  const claimed = await claimEdition(projectId, language, existing?.id);
  if (!claimed) {
    return { status: 'skipped', reason: 'Another run is already building this edition.' };
  }

  const dir = await mkdtemp(join(tmpdir(), 'flowvid-edition-src-'));
  try {
    const storage = getStorageAdapter();
    const inputs = [];
    for (const [i, seg] of usable.entries()) {
      const localPath = join(dir, `seg-${String(i).padStart(4, '0')}`);
      await writeFile(localPath, await storage.readObject(seg.audioKey));
      inputs.push({ localPath, label: seg.audioKey });
    }

    const outPath = join(dir, 'edition.m4a');
    await joinToM4a(inputs, outPath);

    // MEASURED, not summed. The sum is what we expected; this is what the file contains, and the
    // two disagreeing is how a dropped segment announces itself instead of shipping quietly.
    const measuredMs = await probeDurationMs(outPath);
    const expectedMs = totalDurationMs(usable);
    if (expectedMs > 0 && Math.abs(measuredMs - expectedMs) > Math.max(2000, expectedMs * 0.02)) {
      logger.warn(
        { projectId, language, measuredMs, expectedMs },
        'audio edition: measured duration differs from the sum of its segments',
      );
    }

    const key = editionStorageKey(projectId, language, hash);
    const { readFile } = await import('node:fs/promises');
    await storage.uploadFile(key, await readFile(outPath), 'audio/mp4');

    // Chapters are derived against the MEASURED duration, so the last chapter ends where the audio
    // actually ends rather than where the sections claimed it would.
    const chapters = deriveChapters(sections, measuredMs || expectedMs);
    const captions = concatCaptions(usable);

    const [row] = await db.update(project_audio_editions)
      .set({
        status: 'ready',
        source_hash: hash,
        m4a_key: key,
        duration_ms: measuredMs || expectedMs,
        chapters_json: chapters,
        captions_vtt: captions || null,
        error: null,
        claimed_at: null,
        updated_at: new Date(),
      })
      .where(eq(project_audio_editions.id, claimed))
      .returning({ id: project_audio_editions.id });

    return { status: 'ready', editionId: row?.id ?? claimed };
  } catch (err) {
    // The claim is RELEASED on failure, not held. A row left claimed after a crash is one the
    // stale horizon eventually frees, but a row left claimed after a clean failure would wait out
    // that full horizon for no reason at all.
    await db.update(project_audio_editions)
      .set({ status: 'failed', error: (err as Error).message.slice(0, 500), claimed_at: null, updated_at: new Date() })
      .where(eq(project_audio_editions.id, claimed));
    logger.error({ err, projectId, language }, 'audio edition build failed');
    return { status: 'failed', reason: (err as Error).message, editionId: claimed };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* disk space, not correctness */ });
  }
}

/**
 * Take the claim, creating the row if this is the first time.
 *
 * Returns the edition id when the claim is ours, null when someone else holds a live one. The
 * `claimed_at IS NULL OR claimed_at < horizon` test is what makes a crashed worker recoverable —
 * without it the row sits in `processing` forever and the creator's regenerate button does
 * nothing, silently, with no error anywhere to explain it.
 */
async function claimEdition(projectId: string, language: string | null, existingId?: string): Promise<string | null> {
  const horizon = new Date(Date.now() - STALE_CLAIM_MS);

  if (existingId) {
    const [row] = await db.update(project_audio_editions)
      .set({ status: 'processing', claimed_at: new Date(), error: null, updated_at: new Date() })
      .where(and(
        eq(project_audio_editions.id, existingId),
        sql`(${project_audio_editions.claimed_at} IS NULL OR ${project_audio_editions.claimed_at} < ${horizon.toISOString()}::timestamptz)`,
      ))
      .returning({ id: project_audio_editions.id });
    return row?.id ?? null;
  }

  // A UNIQUE index on (project_id, language) makes this the race arbiter: two workers reaching
  // here at once, one insert wins and the other's ON CONFLICT DO NOTHING returns nothing, which
  // reads correctly as "someone else is building it".
  const [row] = await db.insert(project_audio_editions)
    .values({ project_id: projectId, language, status: 'processing', claimed_at: new Date() })
    .onConflictDoNothing()
    .returning({ id: project_audio_editions.id });
  return row?.id ?? null;
}

/** Queue entrypoint. Thin, like every other handler in the registry. */
export async function runAudioEditionJob(payload: {
  projectId: string;
  language?: string | null;
  force?: boolean;
}): Promise<BuildResult> {
  return buildAudioEdition(payload.projectId, payload.language ?? null, { force: payload.force });
}
