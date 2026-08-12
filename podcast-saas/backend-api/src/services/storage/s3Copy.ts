/**
 * Shared bits of the S3 `CopyObject` path, used by both S3-protocol adapters (R2 and Supabase).
 *
 * Only the parts that are easy to get subtly wrong live here; the command dispatch itself stays in
 * each adapter so R2 keeps its bare `send` and Supabase keeps its `withRetry` wrapper.
 */

import type { CompletedPart, StoredObjectHead } from './StorageService.js';
import { logger } from '../../lib/logger.js';

/**
 * The codes `PermanentStorageError` is thrown with. Stable strings, because a caller CLASSIFIES on
 * them — matching on the message text would break the moment the wording is improved.
 */
export type PermanentStorageErrorCode =
  /** The source object is not there. A copy of a thing that does not exist cannot start. */
  | 'COPY_SOURCE_MISSING'
  /** The store answered the HEAD but would not say how big the object is. */
  | 'COPY_SIZE_UNKNOWN'
  /** Server-side copy is unavailable and the object is too big to pass through the API's heap. */
  | 'COPY_TOO_LARGE_FOR_FALLBACK'
  /** The object needs more parts than one multipart upload may have. */
  | 'COPY_TOO_MANY_PARTS';

/**
 * A storage failure that RETRYING CANNOT FIX.
 *
 * The refusals in this module were written to be actionable — they name the object, the size and the
 * configuration change that would let the copy succeed. Thrown as a plain `Error` they are
 * indistinguishable from a transient one, so `ProjectDuplicationService`'s catch flattens every one
 * of them into "Duplication failed. Nothing was created; you can try again." — advice that is not
 * merely unhelpful here but WRONG: the same run will fail the same way forever, and the user has no
 * way to learn that the fix is a bucket setting.
 *
 * `message` is user-safe by construction: every site below states a fact about the caller's own
 * object and the store's own limits, and none interpolates a credential, a signed URL or an internal
 * path. `code` is what a classifier should switch on.
 */
export class PermanentStorageError extends Error {
  readonly code: PermanentStorageErrorCode;

  constructor(code: PermanentStorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentStorageError';
    this.code = code;
  }
}

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
 * The ways a store says "that copy source is over the single-copy ceiling".
 *
 * A FIXED VOCABULARY, NOT A GENERIC "too large". AWS's and R2's exact clause is the first
 * alternative; the rest are the phrasings an S3-COMPATIBLE GATEWAY uses for the same refusal.
 * Anything vaguer would start classifying ordinary 400s as oversize and re-issuing them as
 * multipart copies that answer a different failure.
 */
const COPY_OVERSIZE_MESSAGE =
  /(larger than the maximum allowable size|copy source is too large|exceeds the maximum (allowed |allowable )?(copy |object |source )?size|maximum allowed size|payload too large|entity too large)/i;

/**
 * Does this error mean "the source object is too big for a single-part copy"?
 *
 * Distinct from `isCopyUnsupported` in both cause and remedy: no retry can get past it, and the
 * read-then-write fallback would be strictly worse (it pulls the whole object through the Node
 * heap). It is classified separately so the failure surfaces as the fact it is instead of as a
 * generic copy error with "you can try again" advice that never can.
 *
 * NOT ONLY AWS'S WORDING. `InvalidRequest` + one English clause is how AWS S3 and R2 phrase it, and
 * for a long time it was the whole test — but the writable adapter in production is Supabase, an
 * S3-COMPATIBLE GATEWAY that phrases its own errors. Two shapes it can answer with were missed
 * entirely: a `413`, the canonical status for "too large" and the one a fronting proxy returns with
 * an HTML body the SDK cannot parse into a `Code` at all; and a 400 that names the size in words
 * other than AWS's. Both fell through to "neither unsupported nor too large" and failed the whole
 * duplication with advice that can never work.
 *
 * Still deliberately narrow in the other direction: absence and permission errors are never size
 * errors, and `isCopyUnsupported` wins outright, so the two stay disjoint by construction rather
 * than by the caller happening to test them in the right order.
 */
export function isCopyTooLarge(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number } } | null;
  if (!e) return false;
  if (isCopyUnsupported(e)) return false;
  const name = e.name ?? e.Code;
  if (name === 'EntityTooLarge') return true;
  const status = e.$metadata?.httpStatusCode;
  if (status === 413) return true;
  // A miss or a refusal says nothing about size, and routing either one to the multipart copy would
  // replace a clear error with a slower repeat of it.
  if (status === 403 || status === 404 || name === 'AccessDenied' || name === 'NoSuchKey') return false;
  return COPY_OVERSIZE_MESSAGE.test(String(e.message ?? ''));
}

// ── Read-then-write: the fallback for a store that cannot copy server-side at all ─────────────

/**
 * The largest object the read-then-write fallback will pull through the Node heap.
 *
 * THE TWO FALLBACKS ARE DISJOINT BY ERROR CLASS, NOT BY SIZE — and that is not enough.
 * `isCopyTooLarge` routes big objects to the ranged multipart copy, which keeps every byte inside
 * the store. But a gateway that rejects `CopyObject` OUTRIGHT (501/405) answers `isCopyUnsupported`
 * for an object of ANY size, and the Supabase adapter's own documentation calls that "an EXPECTED
 * path, not a curiosity". Uploads are admitted to 10 GB (`MAX_UPLOAD_BYTES`) and duplication runs
 * INLINE IN THE API PROCESS, so without a bound one duplication of one ordinary video project can
 * exhaust the heap and take the API down for every user of the deployment.
 *
 * 256 MiB, matching `MULTIPART_COPY_PART_BYTES` — the same figure this module already accepts as a
 * reasonable transient allocation, arrived at for the same reason. Everything a package, a poster,
 * an HLS segment or a caption track contains is orders of magnitude below it; a raw video master is
 * the only thing that is not, and a store that cannot copy one server-side cannot serve this
 * product's video pipeline at all.
 */
export const HEAP_COPY_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Copy by downloading and re-uploading, refusing anything the heap should not hold.
 *
 * Written once and shared, so the bound cannot be present on one adapter and absent on the other —
 * which is exactly how it came to be absent on both.
 *
 * The refusal is ACTIONABLE and permanent-sounding on purpose: no retry gets past it, and the real
 * remedy is a storage configuration whose `CopyObject` works. Buffering anyway and hoping would
 * trade a clear error for an OOM in a process that is also serving requests.
 */
export async function readThenWriteCopy(
  srcKey: string,
  destKey: string,
  provider: string,
  ops: {
    head(): Promise<StoredObjectHead | null>;
    read(): Promise<Buffer>;
    write(bytes: Buffer, contentType: string, cacheControl: string | undefined): Promise<unknown>;
  },
): Promise<void> {
  const head = await ops.head();
  if (!head) {
    throw new PermanentStorageError(
      'COPY_SOURCE_MISSING',
      `${provider}: cannot copy ${srcKey} — server-side copy is unavailable and the object does not exist`,
    );
  }
  // A store that will not say how big an object is cannot be trusted to hand back something the
  // heap can hold. Refusing is the safe direction; the alternative is finding out by dying.
  if (head.size === null) {
    throw new PermanentStorageError(
      'COPY_SIZE_UNKNOWN',
      `${provider}: cannot copy ${srcKey} — server-side copy is unavailable and the store did not report the object's size, ` +
      'so the download-and-re-upload fallback cannot bound how much memory it would need.',
    );
  }
  if (head.size > HEAP_COPY_MAX_BYTES) {
    throw new PermanentStorageError(
      'COPY_TOO_LARGE_FOR_FALLBACK',
      `${provider}: cannot copy ${srcKey} (${Math.round(head.size / 1e6)} MB) — this storage does not support server-side ` +
      `copy, and the download-and-re-upload fallback refuses anything over ${Math.round(HEAP_COPY_MAX_BYTES / 1e6)} MB ` +
      'because the whole object would be held in the API process\'s memory. Enable server-side copy (CopyObject) on the ' +
      'storage bucket, or move this project\'s large media to a store that supports it.',
    );
  }
  const bytes = await ops.read();
  await ops.write(bytes, head.contentType ?? 'application/octet-stream', head.cacheControl ?? undefined);
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
    // Permanent, unlike the two argument checks above: those are invariant violations by this
    // module's own callers, while this one is a fact about the caller's OBJECT that no re-run
    // changes — the parts are uniform by R2's requirement, so a bigger part size is not available.
    throw new PermanentStorageError(
      'COPY_TOO_MANY_PARTS',
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
    throw new PermanentStorageError(
      'COPY_SOURCE_MISSING',
      `storage: cannot copy ${srcKey} — it is over the single-copy ceiling and does not exist`,
      { cause },
    );
  }
  if (head.size === null) {
    throw new PermanentStorageError(
      'COPY_SIZE_UNKNOWN',
      `storage: cannot copy ${srcKey} — the store did not report its size`,
      { cause },
    );
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
