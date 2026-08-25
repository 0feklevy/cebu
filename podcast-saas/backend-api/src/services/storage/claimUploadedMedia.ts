/**
 * The one place an uploaded media file becomes bytes-plus-a-reference.
 *
 * ── WHY A SHARED HELPER RATHER THAN THREE COPIES ──────────────────────────────────────────────
 * Images, audio and video each have their own controller, their own table and their own key
 * shape, but the storage question is identical: hash what arrived, upload only if nobody already
 * holds those bytes, and hand the caller both a URL to serve and a blob to reference. Three
 * copies of that would drift — and the interesting failure is not that they diverge, it is that
 * ONE of them quietly stops deduplicating and nothing looks wrong anywhere.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CHANGE ────────────────────────────────────────────────────
 * The caller still gets a `storage_key` and a public URL, and still writes them to its own row
 * exactly as before. `blob_id` is ADDITIONAL. That keeps every reader — the player config, the
 * export pipeline, the duplication service, the crop and caption jobs — working against the same
 * columns they always have, while the bytes underneath become shared.
 *
 * A dedup hit therefore returns the EXISTING blob's key rather than the caller's proposed one.
 * That is the entire saving, and it is also the one thing a caller must not second-guess: writing
 * the proposed key to the row while the bytes live at the blob's key produces a row pointing at
 * nothing.
 *
 * ── FAILING OPEN, ON PURPOSE ──────────────────────────────────────────────────────────────────
 * If anything in the dedup path throws, this falls back to a plain upload at the caller's key and
 * returns `blobId: null`. An upload that fails because the DEDUP failed would be a feature making
 * the product less reliable in exchange for a storage saving — the wrong trade in every direction.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { logger } from '../../lib/logger.js';
import { uploadWithFallback } from './uploadWithFallback.js';
import { uploadFileFromDisk } from './uploadFromDisk.js';
import { identifyStream } from './contentIdentity.js';
import { getStorageAdapter } from './getStorageAdapter.js';
import { claimBlob } from './MediaBlobStore.js';
import { identifyBuffer } from './contentIdentity.js';

export interface ClaimedUpload {
  /** The key the bytes are ACTUALLY at — the blob's on a hit, the proposed one otherwise. */
  storageKey: string;
  /** Public URL for that key. */
  publicUrl: string;
  /** The blob to reference, or null when dedup was unavailable and this is a plain upload. */
  blobId: string | null;
  /** True when nothing was uploaded because the bytes were already stored. */
  deduped: boolean;
}

/**
 * Store an uploaded file once.
 *
 * `proposedKey` is what the caller would have used before dedup existed; it is still used when
 * these bytes are new to the system, so nothing about a first upload changes.
 */
export async function claimUploadedMedia(input: {
  proposedKey: string;
  bytes: Buffer;
  contentType: string;
  /** Extension for the blob key, purely so stored objects stay readable. Never part of identity. */
  ext?: string;
}): Promise<ClaimedUpload> {
  const storage = getStorageAdapter();

  try {
    const identity = identifyBuffer(input.bytes);
    const claim = await claimBlob({
      identity,
      adapter: storage,
      contentType: input.contentType,
      ext: input.ext ?? input.proposedKey.slice(input.proposedKey.lastIndexOf('.') + 1),
      // Only called when the bytes are new. On a hit this never runs, which is where the
      // bandwidth saving comes from — the file is not re-sent to the bucket at all.
      upload: async (key) => { await uploadWithFallback(key, input.bytes, input.contentType); },
    });

    return {
      storageKey: claim.blob.storage_key,
      publicUrl: storage.getPublicUrl(claim.blob.storage_key),
      blobId: claim.blob.id,
      deduped: claim.deduped,
    };
  } catch (e) {
    // See the header: a dedup failure must never become an upload failure.
    logger.warn({ evt: 'media_claim_fell_back', err: (e as Error)?.name },
      '[Media] dedup unavailable — storing at the caller\'s key');
    const publicUrl = await uploadWithFallback(input.proposedKey, input.bytes, input.contentType);
    return { storageKey: input.proposedKey, publicUrl, blobId: null, deduped: false };
  }
}

/**
 * The same thing for a file already on disk — the path large uploads take.
 *
 * Audio and video arrive through `withBoundedTempFile`, which streams to disk precisely so a big
 * file never sits in memory. Reading it back into a Buffer to hash would undo that, so the digest
 * is computed by STREAMING the file, and the upload still streams too. Nothing is ever fully
 * resident.
 *
 * The declared size is checked against what was actually read (`identifyStream`'s second
 * mechanism): a truncated temp file would otherwise mint an identity for content nobody has, and
 * a later equally-truncated upload would dedup onto it.
 */
export async function claimUploadedMediaFromDisk(input: {
  proposedKey: string;
  filePath: string;
  contentType: string;
  ext?: string;
}): Promise<ClaimedUpload> {
  const storage = getStorageAdapter();

  try {
    const { size } = await stat(input.filePath);
    const identity = await identifyStream(createReadStream(input.filePath), { declaredSize: size });
    const claim = await claimBlob({
      identity,
      adapter: storage,
      contentType: input.contentType,
      ext: input.ext ?? input.proposedKey.slice(input.proposedKey.lastIndexOf('.') + 1),
      upload: async (key) => { await uploadFileFromDisk(key, input.filePath, input.contentType); },
    });

    return {
      storageKey: claim.blob.storage_key,
      publicUrl: storage.getPublicUrl(claim.blob.storage_key),
      blobId: claim.blob.id,
      deduped: claim.deduped,
    };
  } catch (e) {
    logger.warn({ evt: 'media_claim_fell_back', err: (e as Error)?.name },
      '[Media] dedup unavailable — storing at the caller\'s key');
    const publicUrl = await uploadFileFromDisk(input.proposedKey, input.filePath, input.contentType);
    return { storageKey: input.proposedKey, publicUrl, blobId: null, deduped: false };
  }
}
