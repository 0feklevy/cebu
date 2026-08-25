/**
 * Store the bytes once. Hand every project that wants them the same row.
 *
 * This is the I/O half of the dedup feature; `contentIdentity.ts` holds the decision logic and is
 * where the reasoning about the four verification mechanisms lives. The split is deliberate: every
 * branch of "may these be treated as the same file" is provable without a database or a bucket,
 * and this file is left with the ordering.
 *
 * ── THE ORDERING IS THE WHOLE CORRECTNESS ARGUMENT ────────────────────────────────────────────
 * Bytes are written BEFORE the row that claims them, always. The other order — insert the row,
 * then upload — creates a window in which a second uploader finds a matching row, skips its own
 * upload, and points at an object that does not exist yet and may never exist if the first
 * uploader crashes. That project then serves nothing, permanently, with no error anywhere.
 *
 * Writing bytes first can only ever leak an object nobody references, which the sweeper collects.
 * One direction fails to a bill; the other fails to a broken video. They are not symmetric.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { media_blobs, video_files, image_files, audio_files } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import {
  judgeReuse,
  blobStorageKey,
  isWellFormedSha256,
  type ContentIdentity,
  type BlobRecord,
  type ReuseVerdict,
} from './contentIdentity.js';
import type { StorageService } from './StorageService.js';

export interface BlobClaim {
  blob: BlobRecord;
  /** True when the bytes were already present and this upload was skipped entirely. */
  deduped: boolean;
  /** Why a dedup did NOT happen, when it did not. Null on a hit. */
  declinedBecause: Exclude<ReuseVerdict, { reuse: true }>['why'] | null;
}

/**
 * Find the blob for this content, or create it — uploading the bytes only if nobody has them.
 *
 * `upload` is a thunk rather than a buffer so the caller can stream, and so that a dedup HIT never
 * touches the bytes at all: on the common path the file is never read a second time and never
 * leaves the machine that already has it. That is where the bandwidth saving comes from — the disk
 * saving is only half the point.
 */
export async function claimBlob(input: {
  identity: ContentIdentity;
  adapter: StorageService;
  contentType?: string | null;
  /** Filename extension, used only to keep keys readable. Never part of identity. */
  ext?: string;
  upload: (key: string) => Promise<void>;
}): Promise<BlobClaim> {
  const { identity, adapter } = input;

  // A malformed digest must never reach the table: the DB's CHECK would reject it anyway, but a
  // constraint violation at insert time is a worse error message than a refusal here.
  if (!isWellFormedSha256(identity.sha256)) {
    throw new Error('claimBlob: sha256 is not a 64-character lowercase hex digest');
  }

  // ── 1. Is it already here? ──────────────────────────────────────────────────────────────────
  // Keyed on the PAIR, matching the unique index. Querying by digest alone and checking the size
  // afterwards would work, and would also be the version somebody later "simplifies" into a
  // digest-only lookup.
  const [candidate] = await db
    .select({
      id: media_blobs.id, sha256: media_blobs.sha256,
      byte_size: media_blobs.byte_size, storage_key: media_blobs.storage_key,
    })
    .from(media_blobs)
    .where(and(eq(media_blobs.sha256, identity.sha256), eq(media_blobs.byte_size, identity.byteSize)))
    .limit(1);

  if (candidate) {
    // Mechanism 4: the row is not evidence that the object is there. A probe failure is treated as
    // "not there" rather than propagated — the fallback (upload again) is always safe, and letting
    // a transient HEAD error fail the whole upload would make dedup a reliability regression.
    const head = await adapter.headObject(candidate.storage_key).catch((e: unknown) => {
      logger.warn({ evt: 'blob_probe_failed', blobId: candidate.id, err: (e as Error)?.name }, '[Blob] probe failed; treating as absent');
      return null;
    });
    const verdict = judgeReuse({
      incoming: identity,
      candidate: candidate as BlobRecord,
      probe: head ? { exists: true, byteSize: head.size } : { exists: false, byteSize: null },
    });

    if (verdict.reuse) {
      // Cheap and worth it: it is the only record that this blob was confirmed present, and the
      // sweeper uses it to tell "never checked" from "checked and fine".
      await db.update(media_blobs).set({ last_verified_at: new Date(), orphaned_at: null })
        .where(eq(media_blobs.id, candidate.id)).catch(() => { /* bookkeeping, never fatal */ });
      logger.info({ evt: 'blob_reused', blobId: candidate.id, bytes: identity.byteSize }, '[Blob] upload skipped — bytes already stored');
      return { blob: verdict.blob, deduped: true, declinedBecause: null };
    }

    logger.warn({ evt: 'blob_reuse_declined', why: verdict.why, blobId: candidate.id }, '[Blob] candidate rejected — storing again');
    // Falls through and uploads. A declined candidate is not an error: it is the system refusing
    // to guess, and the correct outcome is a second copy rather than a wrong reference.
    const fresh = await uploadAndInsert({ ...input, forceNewKey: true });
    return { ...fresh, declinedBecause: verdict.why };
  }

  const fresh = await uploadAndInsert(input);
  return { ...fresh, declinedBecause: null };
}

/**
 * Bytes first, row second — see the file header.
 *
 * The insert is `ON CONFLICT DO NOTHING` on the identity index followed by a re-read, because two
 * uploads of the same new file can race here. Both will have written the SAME key (it is derived
 * from the content), so the second write is idempotent by construction and the loser of the insert
 * race simply adopts the winner's row.
 */
async function uploadAndInsert(input: {
  identity: ContentIdentity;
  contentType?: string | null;
  ext?: string;
  upload: (key: string) => Promise<void>;
  forceNewKey?: boolean;
}): Promise<{ blob: BlobRecord; deduped: boolean }> {
  const { identity } = input;
  // A declined candidate means something already occupies the content-addressed key and is NOT
  // this content. Disambiguating by size keeps the key derived rather than random, so a repeat of
  // the same situation lands on the same key instead of leaking a new object every attempt.
  const key = input.forceNewKey
    ? `${blobStorageKey(identity, input.ext)}.${identity.byteSize}`
    : blobStorageKey(identity, input.ext);

  await input.upload(key);

  await db.insert(media_blobs).values({
    sha256: identity.sha256,
    byte_size: identity.byteSize,
    storage_key: key,
    content_type: input.contentType ?? null,
    last_verified_at: new Date(),
  }).onConflictDoNothing();

  const [row] = await db
    .select({
      id: media_blobs.id, sha256: media_blobs.sha256,
      byte_size: media_blobs.byte_size, storage_key: media_blobs.storage_key,
    })
    .from(media_blobs)
    .where(and(eq(media_blobs.sha256, identity.sha256), eq(media_blobs.byte_size, identity.byteSize)))
    .limit(1);

  if (!row) throw new Error('claimBlob: blob row vanished immediately after insert');
  return { blob: row as BlobRecord, deduped: false };
}

/**
 * How many rows, anywhere, still point at this blob.
 *
 * Derived on demand rather than stored. Migration 078 explains the reasoning at length; the short
 * version is that `ON DELETE CASCADE` on project deletion removes media rows without running a
 * line of our code, so any maintained counter drifts every time an owner deletes a project — and a
 * drifted counter deletes bytes that are still in use.
 *
 * Adding a new table that references blobs means adding it HERE. That is the one maintenance
 * burden this design carries, and it is why the query is written as an explicit union rather than
 * something clever: a missing table is visible in a diff.
 */
export async function referenceCount(blobId: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    SELECT (
      (SELECT count(*) FROM ${video_files} WHERE ${video_files.blob_id} = ${blobId}) +
      (SELECT count(*) FROM ${image_files} WHERE ${image_files.blob_id} = ${blobId}) +
      (SELECT count(*) FROM ${audio_files} WHERE ${audio_files.blob_id} = ${blobId})
    )::int AS n
  `) as unknown as Array<{ n: number }>;
  return row?.n ?? 0;
}
