/**
 * Collecting blobs nobody references any more — the other half of migrations 078 and 080.
 *
 * ── WHY THIS HAD TO EXIST BEFORE THE FEATURE COULD BE CALLED FINISHED ────────────────────────
 * Sharing bytes means a blob outlives any single holder. `sim_files` rows cascade away with a
 * deleted simulation and media rows cascade away with a deleted project, so a blob's last
 * reference can vanish without a line of application code running — which is exactly the property
 * that made a maintained counter the wrong design. It also means that WITHOUT a collector,
 * shipping dedup replaces one storage problem with another: no duplicates, and no way to ever
 * reclaim anything. That is a leak introduced by the feature, not one it inherited.
 *
 * ── THE TWO-PASS DESIGN, AND WHY ONE PASS WOULD BE WRONG ──────────────────────────────────────
 * A blob is not deleted the moment it looks unreferenced. It is MARKED (`orphaned_at`), and only a
 * LATER pass, after a grace period, removes it. The window between "the last row was deleted" and
 * "a new import references the same content" is real: an import claims a blob before it writes its
 * mapping rows, so for a moment a freshly-claimed blob has no references at all. A single-pass
 * sweeper racing that window would delete bytes an import is in the middle of adopting.
 *
 * The grace period is therefore not caution, it is correctness. And a blob that gains a reference
 * while marked is UN-marked on the next pass rather than deleted, so the mark is a suspicion, not
 * a sentence.
 *
 * ── THE ORDER OF THE DELETE, WHICH IS THE OPPOSITE OF THE WRITE ──────────────────────────────
 * Writing goes bytes-then-row: the failure leaks an object this sweeper collects. Deleting goes
 * ROW-then-bytes for the same reason read backwards — if the row goes first and the object delete
 * fails, what remains is an unreferenced object with no row, which this sweeper can no longer see.
 * So the object is deleted FIRST, and only a confirmed removal takes the row. A crash between them
 * leaves a row pointing at nothing, which `judgeReuse`'s existence probe already refuses to reuse
 * and the next pass cleans up.
 */

import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { media_blobs, video_files, image_files, audio_files, sim_files } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { getStorageAdapter } from './getStorageAdapter.js';

/**
 * How long a blob must look unreferenced before its bytes go.
 *
 * Generous on purpose: the cost of waiting is storage nobody is paying attention to, and the cost
 * of being early is a file that vanishes from under an import. Twenty-four hours also means a
 * mistake is noticed by a human before it is irreversible.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Never remove more than this in one pass — a runaway delete should be slow enough to notice. */
export const SWEEP_BATCH = 200;

export interface SweepResult {
  marked: number;
  unmarked: number;
  deleted: number;
  failed: number;
}

/**
 * Is this blob referenced by anything, anywhere?
 *
 * DERIVED, not counted (see 078). Every table carrying a `blob_id` must appear here — that is the
 * one maintenance burden this design has, and it is why the query is an explicit union rather than
 * something clever: a table missing from this list is visible in a diff, whereas a table missing
 * from a generic scan is invisible until it deletes somebody's file.
 */
async function referenceCounts(): Promise<Map<string, number>> {
  const rows = await db.execute<{ blob_id: string; n: number }>(sql`
    SELECT blob_id, count(*)::int AS n FROM (
      SELECT ${video_files.blob_id} AS blob_id FROM ${video_files} WHERE ${video_files.blob_id} IS NOT NULL
      UNION ALL
      SELECT ${image_files.blob_id} FROM ${image_files} WHERE ${image_files.blob_id} IS NOT NULL
      UNION ALL
      SELECT ${audio_files.blob_id} FROM ${audio_files} WHERE ${audio_files.blob_id} IS NOT NULL
      UNION ALL
      SELECT ${sim_files.blob_id} FROM ${sim_files}
    ) refs GROUP BY blob_id
  `);
  // `db.execute` returns an ARRAY on postgres-js and a `{ rows }` object on the pglite driver the
  // real-database tests use. Normalising here rather than picking one keeps the production path
  // and the test path running the identical query — which is the whole point of testing it.
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Array<{ blob_id: string; n: number }>;
  return new Map(list.map((r) => [r.blob_id, Number(r.n)]));
}

/**
 * One pass: mark what looks unreferenced, un-mark what came back, delete what has been unreferenced
 * long enough.
 *
 * Safe to run concurrently with anything. The deletion itself is guarded twice over — by the grace
 * period, and by the foreign keys, which refuse the row delete outright if a reference appeared
 * between the check and the attempt.
 */
export async function sweepOrphanBlobs(now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { marked: 0, unmarked: 0, deleted: 0, failed: 0 };
  const refs = await referenceCounts();
  const storage = getStorageAdapter();

  // ── Pass 1: mark and un-mark ───────────────────────────────────────────────────────────────
  const all = await db
    .select({ id: media_blobs.id, storage_key: media_blobs.storage_key, orphaned_at: media_blobs.orphaned_at })
    .from(media_blobs);

  for (const blob of all) {
    const referenced = (refs.get(blob.id) ?? 0) > 0;
    if (referenced && blob.orphaned_at) {
      // It came back. A mark is a suspicion, not a sentence.
      await db.update(media_blobs).set({ orphaned_at: null }).where(eq(media_blobs.id, blob.id));
      result.unmarked += 1;
    } else if (!referenced && !blob.orphaned_at) {
      await db.update(media_blobs).set({ orphaned_at: new Date(now) }).where(eq(media_blobs.id, blob.id));
      result.marked += 1;
    }
  }

  // ── Pass 2: delete what has been unreferenced for the whole grace period ───────────────────
  const due = await db
    .select({ id: media_blobs.id, storage_key: media_blobs.storage_key })
    .from(media_blobs)
    .where(and(
      sql`${media_blobs.orphaned_at} IS NOT NULL`,
      lt(media_blobs.orphaned_at, new Date(now - ORPHAN_GRACE_MS)),
    ))
    .limit(SWEEP_BATCH);

  for (const blob of due) {
    // NO re-check of `refs` here, deliberately. A draft had one and a mutation proved it could be
    // deleted with every test still green — because it cannot fire: pass 1 clears `orphaned_at` on
    // every referenced blob, and this query only selects marked ones. Against the race it appeared
    // to guard (another process adding a reference mid-sweep) it would consult the map read BEFORE
    // pass 1 and miss it anyway.
    //
    // The real guard for that race is the foreign key: the row delete below throws if a reference
    // appeared, whatever this process last observed. Defensiveness nothing can falsify is just
    // code, and it makes the thing that DOES protect you harder to see.
    try {
      // BYTES FIRST — the reverse of the write order, for the same reason. A row deleted before
      // its object leaves an unreferenced object this sweeper can never see again.
      await storage.deleteFile(blob.storage_key);
      // The foreign keys are the final word: if a reference appeared in the last few milliseconds,
      // this throws and the object is gone but the row stays — which `judgeReuse` already refuses
      // to reuse (its existence probe fails) and the next pass tidies.
      await db.delete(media_blobs).where(eq(media_blobs.id, blob.id));
      result.deleted += 1;
    } catch (e) {
      result.failed += 1;
      logger.warn({ evt: 'blob_sweep_failed', blobId: blob.id, err: (e as Error)?.name },
        '[BlobSweep] could not remove an orphaned blob');
    }
  }

  if (result.marked || result.unmarked || result.deleted || result.failed) {
    logger.info({ evt: 'blob_sweep', ...result }, '[BlobSweep] pass complete');
  }
  return result;
}

/**
 * The startup hook. Deliberately does NOT delete on the first pass of a fresh deployment: every
 * blob is unmarked at that moment, so the earliest anything can be removed is a full grace period
 * after this process first saw it.
 */
export async function sweepOrphanBlobsOnStartup(): Promise<void> {
  try {
    await sweepOrphanBlobs();
  } catch (e) {
    // Maintenance must never prevent a boot.
    logger.warn({ err: (e as Error)?.message?.slice(0, 200) }, '[BlobSweep] startup pass skipped');
  }
}
