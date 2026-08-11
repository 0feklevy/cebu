/**
 * Shared bits of the S3 `CopyObject` path, used by both S3-protocol adapters (R2 and Supabase).
 *
 * Only the parts that are easy to get subtly wrong live here; the command dispatch itself stays in
 * each adapter so R2 keeps its bare `send` and Supabase keeps its `withRetry` wrapper.
 */

import type { CompletedPart, StoredObjectHead } from './StorageService.js';
import { logger } from '../../lib/logger.js';

/**
 * The `CopySource` value for a bucket/key pair.
 *
 * S3 requires this to be URL-encoded, but the `/` separators must survive — so each PATH SEGMENT
 * is encoded individually. Most keys here are uuids and hex, which encode to themselves; the ones
 * that do not are the user-named ones (`projects/{id}/corpus/{ts}_{filename}`), where a space or a
 * `+` in the original filename would otherwise be silently copied from the WRONG key, or from no
 * key at all.
 */
export function copySourceFor(bucket: string, key: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${bucket}/${encoded}`;
}

/**
 * Does this error mean "this store does not implement server-side copy" rather than "the copy
 * failed"?
 *
 * Supabase's S3-compatible gateway does not implement the whole protocol, and `CopyObject` is a
 * classic gap. Answering yes here downgrades to read-then-write, which is slow but correct;
 * answering yes to a REAL failure (a missing source, a permission error) would silently substitute
 * a second, equally doomed attempt for a clear error, so the test is deliberately narrow: only the
 * status codes and error names that mean "unimplemented", never a 403 or a 404.
 */
export function isCopyUnsupported(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string } | null;
  if (!e) return false;
  const status = e.$metadata?.httpStatusCode;
  if (status === 501 || status === 405) return true;
  const name = e.name ?? e.Code;
  return name === 'NotImplemented' || name === 'MethodNotAllowed';
}

/**
 * The largest object a single S3/R2 `CopyObject` may move: 5 GiB, fixed by the protocol.
 *
 * The same 5 GiB bounds ONE `UploadPartCopy` source range, which is why it also caps the part size
 * below. The product's own video upload path allows 10 GB (`MAX_UPLOAD_BYTES`), so the wall is
 * reachable with a perfectly ordinary master — `copyObject` therefore does not report it as a
 * failure, it re-issues the copy as a ranged multipart copy (`multipartCopyObject`).
 */
export const S3_COPY_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Does this error mean "the source object is too big for a single-part copy"?
 *
 * Distinct from `isCopyUnsupported` in both cause and remedy: this is a 400 `InvalidRequest`, no
 * retry can get past it, and the read-then-write fallback would be strictly worse (it pulls the
 * whole object through the Node heap). It is classified separately so the failure surfaces as the
 * fact it is instead of as a generic copy error with "you can try again" advice that never can.
 *
 * The message is part of the test on purpose: `InvalidRequest` is a broad S3 code, and only the one
 * that names the copy-source size limit means this.
 */
export function isCopyTooLarge(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; message?: string } | null;
  if (!e) return false;
  const name = e.name ?? e.Code;
  if (name === 'EntityTooLarge') return true;
  if (name !== 'InvalidRequest') return false;
  return /larger than the maximum allowable size/i.test(String(e.message ?? ''));
}

// ── Ranged multipart copy: `CopyObject` for objects past the 5 GiB wall ───────────────────────

/**
 * The size of every part of a ranged multipart copy — the last one excepted.
 *
 * IT HAS TO BE A CONSTANT. Cloudflare R2's `CompleteMultipartUpload` rejects an upload whose parts
 * are not all the same size except the last, so a size derived per object (`size / N`) would work
 * on S3 and fail on R2, which is the store this product actually runs on.
 *
 * 256 MiB, because:
 *   • A 10 GB master — the largest `MAX_UPLOAD_BYTES` admits — is 40 parts, three orders of
 *     magnitude under S3's 10,000-part limit, so part COUNT is never the thing that fails.
 *   • It is far above the 5 MiB per-part minimum, so even an object barely over the wall (5 GiB +
 *     1 byte, 21 parts) has no runt part to make legal.
 *   • It is far below `S3_COPY_MAX_BYTES`, which bounds one `UploadPartCopy` source range exactly
 *     as it bounds one `CopyObject` — a part size above that would reproduce the very bug this
 *     path exists to fix.
 *   • A part that has to be retried costs 256 MiB of redone server-side work, not a gigabyte.
 * 512 MiB would be equally defensible; the cost of the smaller pick is request count, not
 * correctness.
 */
export const MULTIPART_COPY_PART_BYTES = 256 * 1024 * 1024;

/** Parts allowed in one multipart upload, fixed by the protocol. */
export const MULTIPART_COPY_MAX_PARTS = 10_000;

/**
 * The largest object a ranged multipart copy can address: 10,000 uniform 256 MiB parts = 2.5 TiB.
 *
 * A real ceiling rather than a theoretical one — uniform parts are an R2 requirement, so "use
 * bigger parts for a bigger object" is not available mid-copy — but one that no shipped
 * configuration reaches: uploads cap at 10 GB and a whole duplication caps at 50 GB.
 */
export const MULTIPART_COPY_MAX_BYTES = MULTIPART_COPY_PART_BYTES * MULTIPART_COPY_MAX_PARTS;

/** One `UploadPartCopy`: which part, and which bytes of the source it takes. */
export interface PartCopyRange {
  /** 1-based, as S3 numbers parts. */
  partNumber: number;
  /** First byte, inclusive. */
  start: number;
  /** Last byte, INCLUSIVE — `CopySourceRange` is closed at both ends, unlike a JS slice. */
  end: number;
  /** The literal `CopySourceRange` value: `bytes=start-end`. */
  range: string;
}

/**
 * Cut `size` bytes into the parts a multipart copy will issue.
 *
 * The parts are contiguous, non-overlapping, cover exactly `[0, size-1]`, and are all `partSize`
 * long except the last — the four properties `CompleteMultipartUpload` silently depends on and
 * whose violations produce a destination object that is subtly the wrong length.
 */
export function partCopyRanges(size: number, partSize: number = MULTIPART_COPY_PART_BYTES): PartCopyRange[] {
  if (!Number.isFinite(size) || size <= 0 || !Number.isInteger(size)) {
    throw new Error(`multipart copy: cannot range over a source of ${size} bytes`);
  }
  if (!Number.isInteger(partSize) || partSize <= 0 || partSize > S3_COPY_MAX_BYTES) {
    // A part range is bounded by the same 5 GiB that bounds a whole `CopyObject`.
    throw new Error(`multipart copy: part size ${partSize} is not in 1..${S3_COPY_MAX_BYTES}`);
  }
  const count = Math.ceil(size / partSize);
  if (count > MULTIPART_COPY_MAX_PARTS) {
    throw new Error(
      `multipart copy: ${size} bytes needs ${count} parts of ${partSize}, over the ${MULTIPART_COPY_MAX_PARTS}-part limit`,
    );
  }
  const parts: PartCopyRange[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * partSize;
    // `size - 1` on the last part: inclusive end, so an exact multiple must not mint an empty part.
    const end = Math.min(start + partSize, size) - 1;
    parts.push({ partNumber: i + 1, start, end, range: `bytes=${start}-${end}` });
  }
  return parts;
}

/**
 * The five calls a ranged multipart copy makes, dispatched by whichever adapter owns the client.
 *
 * Split this way so the ORDER, the ranges and the abort discipline are written once, while R2 keeps
 * its bare `send` and Supabase keeps its `withRetry` wrapper — the same division of labour the rest
 * of this module already follows.
 */
export interface MultipartCopyOps {
  /** HEAD the SOURCE. Called only from here, i.e. only on the fallback path. */
  head(): Promise<StoredObjectHead | null>;
  /** `CreateMultipartUpload` at the destination, carrying the source's metadata. → uploadId. */
  create(meta: { contentType: string | null; cacheControl: string | null }): Promise<string>;
  /** `UploadPartCopy` for one range. → that part's ETag. */
  copyPart(uploadId: string, part: PartCopyRange): Promise<string>;
  complete(uploadId: string, parts: CompletedPart[]): Promise<void>;
  abort(uploadId: string): Promise<void>;
}

/**
 * Copy an object that is too big for a single `CopyObject`, as N ranged part copies.
 *
 * BYTES NEVER ENTER THIS PROCESS. Each part names a byte RANGE OF THE SOURCE KEY and the store
 * moves it internally, which is what makes this a legitimate implementation of
 * `StorageService.copyObject`'s promise. The read-then-write fallback next to it is for a store
 * that cannot copy at all; using it here would pull 10 GB through the Node heap and kill the
 * process, so the two paths must stay disjoint.
 *
 * THE HEAD IS HERE, NOT AT THE CALL SITE. `copyPrefix` copies hundreds of HLS segments in a loop,
 * every one of them far below the wall; a proactive HEAD would double the request count of every
 * duplication to learn something only this path needs.
 *
 * SEQUENTIAL. Parallel parts would finish sooner, but they turn one failure into a race between an
 * abort and the parts still in flight — and the caller is a background job with a heartbeat, not a
 * request. Predictable beats fast here.
 *
 * @param cause the `CopyObject` failure that sent us here, preserved on anything thrown before the
 *              upload starts so a diagnosis does not lose the original 400.
 */
export async function multipartCopyObject(
  srcKey: string,
  destKey: string,
  ops: MultipartCopyOps,
  cause?: unknown,
): Promise<void> {
  const head = await ops.head();
  if (!head) {
    throw new Error(`storage: cannot copy ${srcKey} — it is over the single-copy ceiling and does not exist`, { cause });
  }
  if (head.size === null) {
    throw new Error(`storage: cannot copy ${srcKey} — the store did not report its size`, { cause });
  }
  const parts = partCopyRanges(head.size);
  logger.info(
    { srcKey, destKey, bytes: head.size, parts: parts.length, partBytes: MULTIPART_COPY_PART_BYTES },
    'storage: object is over the single-copy ceiling — copying it as a ranged multipart copy',
  );

  const uploadId = await ops.create({ contentType: head.contentType, cacheControl: head.cacheControl });
  const done: CompletedPart[] = [];
  try {
    for (const part of parts) {
      done.push({ partNumber: part.partNumber, etag: await ops.copyPart(uploadId, part) });
    }
    await ops.complete(uploadId, done);
  } catch (err) {
    // ALWAYS abort. An abandoned multipart upload keeps its already-copied parts alive and BILLED
    // on both R2 and S3, invisibly, until a lifecycle rule reaps it — so a duplication that fails
    // half way through a 10 GB master must not leave 5 GB behind it.
    await ops.abort(uploadId).catch((abortErr: unknown) => {
      // Logged, never thrown: the abort is cleanup, and masking the real failure with the
      // cleanup's failure would hide why the copy stopped.
      logger.warn(
        { err: abortErr, srcKey, destKey, uploadId },
        'storage: could not abort the failed multipart copy — parts may remain until the bucket lifecycle reaps them',
      );
    });
    throw err;
  }
}
