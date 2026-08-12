/**
 * The copy primitive: the shared "under a prefix" rule, the S3 CopySource encoding, the ranged
 * multipart copy that carries objects past the 5 GiB single-copy wall, and the local-disk adapter's
 * implementation against a real temp directory.
 *
 * WHY THE RULE IS TESTED SEPARATELY FROM THE ADAPTERS
 * The three adapters have different native units — S3 lists by raw string prefix, local disk walks
 * a directory — and left alone they would copy DIFFERENT sets of bytes for the same call. The
 * difference is invisible until a project duplicated in dev is opened in production. `reroot` is
 * the single definition both are held to, so it is pinned here on its own.
 *
 * WHY THE MULTIPART COPY IS TESTED THROUGH BOTH S3 ADAPTERS
 * The arithmetic (`partCopyRanges`) is pure and pinned on its own below, but the things that
 * actually break a 10 GB duplication are in the dispatch: an exclusive range end truncates the copy
 * by one byte per part, a non-uniform part size is accepted by S3 and REJECTED by R2, and a missing
 * abort leaves billed parts behind. Those live in each adapter, so each adapter is driven through
 * them against a fake `send` that records the real command objects.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { isUnderPrefix, normalizePrefix, reroot } from '../prefixScope.js';
import {
  copySourceFor, isCopyTooLarge, isCopyUnsupported, partCopyRanges, PermanentStorageError,
  HEAP_COPY_MAX_BYTES, MULTIPART_COPY_MAX_BYTES, MULTIPART_COPY_MAX_PARTS, MULTIPART_COPY_PART_BYTES,
  S3_COPY_MAX_BYTES,
} from '../s3Copy.js';
import { R2StorageAdapter } from '../R2StorageAdapter.js';
import { SupabaseStorageAdapter } from '../SupabaseStorageAdapter.js';
import { fakeS3 } from './fakeS3.js';

describe('the "under a prefix" rule', () => {
  it('matches the prefix itself and its children, and nothing that merely starts with it', () => {
    expect(isUnderPrefix('hls/abc', 'hls/abc')).toBe(true);
    expect(isUnderPrefix('hls/abc/run/master.m3u8', 'hls/abc')).toBe(true);
    // The one the raw S3 semantics get wrong: a sibling whose id shares a leading substring.
    expect(isUnderPrefix('hls/abcdef/run/master.m3u8', 'hls/abc')).toBe(false);
    expect(isUnderPrefix('hls/abc-2/x', 'hls/abc')).toBe(false);
  });

  it('ignores trailing slashes on the prefix', () => {
    expect(normalizePrefix('a/b///')).toBe('a/b');
    expect(isUnderPrefix('a/b/c', 'a/b/')).toBe(true);
    expect(reroot('a/b/c', 'a/b/', 'x/y/')).toBe('x/y/c');
  });

  it('re-roots by replacing the prefix, and refuses keys outside it', () => {
    expect(reroot('sim/p/s/pkg/index.html', 'sim/p/s', 'sim/q/t')).toBe('sim/q/t/pkg/index.html');
    expect(reroot('sim/p/s', 'sim/p/s', 'sim/q/t')).toBe('sim/q/t');
    expect(reroot('sim/pOTHER/s/x', 'sim/p/s', 'sim/q/t')).toBeNull();
  });
});

describe('S3 CopySource', () => {
  it('encodes each path segment but keeps the separators', () => {
    expect(copySourceFor('media', 'videos/p/main.mp4')).toBe('media/videos/p/main.mp4');
  });

  it('encodes characters a user-supplied filename can contain', () => {
    // `projects/{id}/corpus/{ts}_{filename}` is the one key shape built from a name the user chose.
    expect(copySourceFor('media', 'projects/p/corpus/1_my paper+v2.pdf'))
      .toBe('media/projects/p/corpus/1_my%20paper%2Bv2.pdf');
  });

  it('treats only "unimplemented" as a reason to fall back', () => {
    expect(isCopyUnsupported({ $metadata: { httpStatusCode: 501 } })).toBe(true);
    expect(isCopyUnsupported({ name: 'NotImplemented' })).toBe(true);
    expect(isCopyUnsupported({ name: 'MethodNotAllowed' })).toBe(true);
    // A real failure must surface as itself, not be retried as a download.
    expect(isCopyUnsupported({ $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isCopyUnsupported({ $metadata: { httpStatusCode: 404 }, name: 'NoSuchKey' })).toBe(false);
    expect(isCopyUnsupported(null)).toBe(false);
  });

  /**
   * The 5 GiB wall, which is reachable: video upload allows 10 GB and the duplication byte cap is
   * 50 GB. The two classifications drive DIFFERENT remedies — this one a ranged multipart copy that
   * keeps the bytes inside the store, the other a read-then-write through the Node heap — so a
   * misclassification either way is a 10 GB Buffer or a copy that cannot succeed.
   */
  it('recognises the single-part copy ceiling as its own, permanent, kind of failure', () => {
    const real = {
      name: 'InvalidRequest',
      $metadata: { httpStatusCode: 400 },
      message: 'The specified copy source is larger than the maximum allowable size for a copy source: 5368709120',
    };
    expect(isCopyTooLarge(real)).toBe(true);
    expect(isCopyTooLarge({ name: 'EntityTooLarge' })).toBe(true);
    // …and is not so eager that any 400 becomes "too big". `InvalidRequest` is a broad S3 code.
    expect(isCopyTooLarge({ name: 'InvalidRequest', message: 'Invalid Argument' })).toBe(false);
    expect(isCopyTooLarge({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })).toBe(false);
    expect(isCopyTooLarge(null)).toBe(false);
    // The two classifications are disjoint: an oversize copy must never be retried as a download.
    expect(isCopyUnsupported(real)).toBe(false);
  });

  /**
   * THE STORE IN PRODUCTION IS NOT AWS. `InvalidRequest` plus one English clause is how AWS S3 and
   * R2 phrase this refusal, and for a long time it was the entire test — but the writable adapter
   * on the deployment is Supabase, an S3-COMPATIBLE GATEWAY that phrases its own errors and sits
   * behind a proxy that phrases some of them for it. An oversize rejection it did not recognise
   * fell through as "neither unsupported nor too large" and failed the whole duplication with
   * "you can try again", instead of being re-issued as the ranged multipart copy that gets past it.
   */
  it('recognises an S3-compatible gateway saying it, not only AWS\'s exact clause', () => {
    // 413 is the canonical status for "too large", and the one a fronting proxy returns with an
    // HTML body the SDK cannot parse into a `Code` at all — so status is the only thing left.
    expect(isCopyTooLarge({ $metadata: { httpStatusCode: 413 } })).toBe(true);
    expect(isCopyTooLarge({ name: 'EntityTooLarge', $metadata: { httpStatusCode: 413 } })).toBe(true);
    // A 400 that names the size in words other than AWS's.
    expect(isCopyTooLarge({
      name: 'InvalidArgument', $metadata: { httpStatusCode: 400 }, message: 'copy source is too large',
    })).toBe(true);
    expect(isCopyTooLarge({
      name: 'InvalidRequest', $metadata: { httpStatusCode: 400 }, message: 'Object exceeded the maximum allowed size',
    })).toBe(true);

    // …without becoming a catch-all for 4xx. These mean other things and have other remedies.
    expect(isCopyTooLarge({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isCopyTooLarge({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })).toBe(false);
    expect(isCopyTooLarge({ name: 'InvalidArgument', $metadata: { httpStatusCode: 400 }, message: 'Invalid Argument' })).toBe(false);
    // Disjoint from "unsupported" BY CONSTRUCTION now, not by the caller testing in the right
    // order — even when the gateway's "not implemented" text also mentions the size. Answering
    // "too large" here would start a multipart copy on a store that cannot copy at all.
    expect(isCopyTooLarge({
      name: 'NotImplemented', $metadata: { httpStatusCode: 501 },
      message: 'copy source is too large: server-side copy is not implemented',
    })).toBe(false);
    // A dead socket is transient. Reading it as a permanent ceiling would swap a retry for a
    // failure — and start a multipart copy against a gateway that never answered.
    expect(isCopyTooLarge(Object.assign(
      new Error('@smithy/node-http-handler - the request socket timed out after 15000 ms of inactivity (configured by client requestHandler).'),
      { name: 'TimeoutError' },
    ))).toBe(false);
  });

  it('states the ceiling as the protocol does', () => {
    expect(S3_COPY_MAX_BYTES).toBe(5 * 1024 * 1024 * 1024);
  });
});

/**
 * The type a caller CLASSIFIES on.
 *
 * These refusals were written to be actionable and permanent — they name the object, its size and
 * the bucket setting that would let the copy succeed — and then were thrown as plain `Error`s, so
 * `ProjectDuplicationService`'s catch flattened every one into "Duplication failed. Nothing was
 * created; you can try again." for conditions where trying again is guaranteed to fail identically.
 */
describe('PermanentStorageError', () => {
  it('is an Error with a stable code, a user-safe message, and the original cause kept', () => {
    const cause = new Error('the 400 that sent us here');
    const err = new PermanentStorageError('COPY_SOURCE_MISSING', 'storage: cannot copy x', { cause });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PermanentStorageError);
    expect(err.name).toBe('PermanentStorageError');
    expect(err.code).toBe('COPY_SOURCE_MISSING');
    expect(err.message).toBe('storage: cannot copy x');
    expect(err.cause).toBe(cause);
  });

  it('is not what a transient failure produces', () => {
    // The whole value of the type is the discrimination; a classifier that answered "permanent" to
    // an ordinary 5xx would turn a retryable duplication into a dead end.
    expect(new Error('boom')).not.toBeInstanceOf(PermanentStorageError);
  });

  it('refuses an object no multipart copy can address, permanently', () => {
    // Uniform parts are an R2 requirement, so "use bigger parts" is not available mid-copy: this
    // one is a fact about the object, not about the moment.
    const err = (() => {
      try { partCopyRanges(MULTIPART_COPY_MAX_BYTES + 1); return null; } catch (e) { return e as PermanentStorageError; }
    })();
    expect(err).toBeInstanceOf(PermanentStorageError);
    expect(err?.code).toBe('COPY_TOO_MANY_PARTS');
  });
});

// ── The ranges a multipart copy issues ────────────────────────────────────────────────────────

describe('partCopyRanges', () => {
  const TEN_GIB = 10 * 1024 * 1024 * 1024; // MAX_UPLOAD_BYTES: the largest object that can exist

  const sizes = (parts: ReturnType<typeof partCopyRanges>): number[] =>
    parts.map((p) => p.end - p.start + 1);

  it('covers exactly [0, size-1] with contiguous, non-overlapping parts', () => {
    const size = 6 * 1024 * 1024 * 1024 + 12_345;
    const parts = partCopyRanges(size);

    expect(parts[0].start).toBe(0);
    expect(parts[parts.length - 1].end).toBe(size - 1); // INCLUSIVE end: not `size`
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i].start).toBe(parts[i - 1].end + 1); // no gap, no overlap
    }
    expect(sizes(parts).reduce((a, b) => a + b, 0)).toBe(size);
    expect(parts.map((p) => p.partNumber)).toEqual(parts.map((_, i) => i + 1)); // 1-based, in order
    expect(parts[0].range).toBe(`bytes=0-${MULTIPART_COPY_PART_BYTES - 1}`);
  });

  /** R2's `CompleteMultipartUpload` rejects an upload whose parts are not uniform but for the last. */
  it('gives every part the same size except the last', () => {
    const parts = partCopyRanges(6 * 1024 * 1024 * 1024 + 12_345);
    const all = sizes(parts);
    expect(new Set(all.slice(0, -1))).toEqual(new Set([MULTIPART_COPY_PART_BYTES]));
    expect(all[all.length - 1]).toBe(12_345);
  });

  it('mints no empty trailing part when the size is an exact multiple', () => {
    const parts = partCopyRanges(24 * MULTIPART_COPY_PART_BYTES);
    expect(parts).toHaveLength(24);
    expect(new Set(sizes(parts))).toEqual(new Set([MULTIPART_COPY_PART_BYTES]));
    expect(parts[23].end).toBe(24 * MULTIPART_COPY_PART_BYTES - 1);
  });

  it('keeps the largest uploadable object far under the part limit', () => {
    // 40 parts for a 10 GiB master. The claim the part size was chosen on.
    expect(partCopyRanges(TEN_GIB)).toHaveLength(40);
    expect(MULTIPART_COPY_PART_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024); // S3's per-part floor
    expect(MULTIPART_COPY_PART_BYTES).toBeLessThanOrEqual(S3_COPY_MAX_BYTES); // one range is a copy
    expect(MULTIPART_COPY_MAX_BYTES).toBe(MULTIPART_COPY_PART_BYTES * MULTIPART_COPY_MAX_PARTS);
  });

  it('refuses what it cannot address rather than silently truncating it', () => {
    expect(partCopyRanges(MULTIPART_COPY_MAX_BYTES)).toHaveLength(MULTIPART_COPY_MAX_PARTS);
    expect(() => partCopyRanges(MULTIPART_COPY_MAX_BYTES + 1)).toThrow(/10000|10,000/);
    expect(() => partCopyRanges(0)).toThrow(/0 bytes/);
    expect(() => partCopyRanges(-1)).toThrow();
    // A part range is bounded by the same 5 GiB that bounds a whole CopyObject.
    expect(() => partCopyRanges(10, S3_COPY_MAX_BYTES + 1)).toThrow(/part size/);
  });
});

// ── The multipart copy, driven through both S3-protocol adapters ──────────────────────────────

/** The real 400 R2 and S3 answer a `CopyObject` of an object over 5 GiB with. */
function tooLargeError(): Error {
  return Object.assign(
    new Error('The specified copy source is larger than the maximum allowable size for a copy source: 5368709120'),
    { name: 'InvalidRequest', $metadata: { httpStatusCode: 400 } },
  );
}

/**
 * Simulated failures carry a 4xx on purpose: Supabase's `withRetry` re-sends anything with a 5xx or
 * NO status, so a bare `new Error()` would make these cases sleep through four attempts.
 */
function failure(message: string): Error {
  return Object.assign(new Error(message), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
}

/** The store answering "there is no such object" — a 404 both adapters read as absence. */
function missingError(): Error {
  return Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
}

/**
 * The error a call rejected with, so a test can assert its TYPE and CODE rather than only its text.
 * `rejects.toThrow(/…/)` cannot tell a permanent refusal from a transient failure with similar
 * wording, and that distinction is the entire point of `PermanentStorageError`.
 */
async function refusalFrom(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the call to be refused, but it succeeded');
}

const parseRange = (r: unknown): { start: number; end: number } => {
  const m = /^bytes=(\d+)-(\d+)$/.exec(String(r));
  if (!m) throw new Error(`not an S3 copy-source range: ${String(r)}`);
  return { start: Number(m[1]), end: Number(m[2]) };
};

const S3_ADAPTERS = [
  {
    label: 'R2',
    env: {
      R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET_NAME: 'media', R2_PUBLIC_URL: 'https://cdn.test',
    } as Record<string, string>,
    make: (): import('../StorageService.js').StorageService => new R2StorageAdapter(),
  },
  {
    label: 'Supabase',
    env: {
      SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_S3_ACCESS_KEY_ID: 'key',
      SUPABASE_S3_SECRET_ACCESS_KEY: 'secret', SUPABASE_S3_REGION: 'us-east-1',
      SUPABASE_STORAGE_BUCKET: 'media',
    } as Record<string, string>,
    make: (): import('../StorageService.js').StorageService => new SupabaseStorageAdapter(),
  },
];

describe.each(S3_ADAPTERS)('$label copyObject past the single-copy ceiling', ({ env, make }) => {
  const SRC = 'videos/p/main.mp4';
  const DEST = 'videos/q/main.mp4';
  const COPY_SOURCE = 'media/videos/p/main.mp4';
  const SIZE = 6 * 1024 * 1024 * 1024 + 12_345; // over the wall, and not a whole number of parts
  const PARTS = Math.ceil(SIZE / MULTIPART_COPY_PART_BYTES);

  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
  });

  function adapterUnder(react: (name: string, input: any) => unknown) {
    for (const [k, v] of Object.entries(env)) { saved.set(k, process.env[k]); process.env[k] = v; }
    const adapter = make();
    return { adapter, s3: fakeS3(adapter, react) };
  }

  /** The happy oversize path: HEAD once, then create → N part copies → complete. */
  const oversizeStore = (overrides: Partial<Record<string, (input: any) => unknown>> = {}) =>
    (name: string, input: any): unknown => {
      const override = overrides[name];
      if (override) return override(input);
      switch (name) {
        case 'CopyObject': throw tooLargeError();
        case 'HeadObject':
          return { ContentType: 'video/mp4', CacheControl: 'public, max-age=31536000, immutable', ContentLength: SIZE, ETag: '"src"' };
        case 'CreateMultipartUpload': return { UploadId: 'upload-1' };
        case 'UploadPartCopy': return { CopyPartResult: { ETag: `"p${input.PartNumber}"` } };
        case 'CompleteMultipartUpload': return {};
        case 'AbortMultipartUpload': return {};
        default: throw new Error(`unexpected command: ${name}`);
      }
    };

  it('falls back to a ranged multipart copy that covers the source exactly once', async () => {
    const { adapter, s3 } = adapterUnder(oversizeStore());

    await adapter.copyObject(SRC, DEST);

    // One attempt at the cheap path, then one HEAD — of the SOURCE — to learn the size.
    expect(s3.of('CopyObject')).toHaveLength(1);
    expect(s3.of('CopyObject')[0]).toMatchObject({ Key: DEST, CopySource: COPY_SOURCE });
    expect(s3.of('HeadObject')).toEqual([expect.objectContaining({ Key: SRC })]);

    // The destination upload carries the source's metadata, or a copied HLS/sim object would
    // silently lose `immutable` and revalidate for the life of the copy.
    expect(s3.of('CreateMultipartUpload')).toEqual([expect.objectContaining({
      Key: DEST, ContentType: 'video/mp4', CacheControl: 'public, max-age=31536000, immutable',
    })]);

    const parts = s3.of('UploadPartCopy');
    expect(parts).toHaveLength(PARTS);
    expect(parts).toHaveLength(25);
    expect(parts.map((p) => p.PartNumber)).toEqual(parts.map((_, i) => i + 1));
    for (const p of parts) {
      expect(p).toMatchObject({ Key: DEST, CopySource: COPY_SOURCE, UploadId: 'upload-1' });
    }

    const ranges = parts.map((p) => parseRange(p.CopySourceRange));
    expect(ranges[0].start).toBe(0);
    expect(ranges[ranges.length - 1].end).toBe(SIZE - 1); // inclusive: an exclusive end loses a byte
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end + 1);
    expect(ranges.reduce((n, r) => n + (r.end - r.start + 1), 0)).toBe(SIZE);

    // Completed with every part's returned ETag, in order.
    expect(s3.of('CompleteMultipartUpload')[0].MultipartUpload.Parts).toEqual(
      Array.from({ length: PARTS }, (_, i) => ({ PartNumber: i + 1, ETag: `"p${i + 1}"` })),
    );
    expect(s3.of('AbortMultipartUpload')).toHaveLength(0);
    // The bytes never entered this process: no GET, no PUT.
    expect(s3.names()).not.toContain('GetObject');
    expect(s3.names()).not.toContain('PutObject');
  });

  it('sends uniformly sized parts, only the last one short (R2 rejects anything else)', async () => {
    const { adapter, s3 } = adapterUnder(oversizeStore());

    await adapter.copyObject(SRC, DEST);

    const lengths = s3.of('UploadPartCopy')
      .map((p) => parseRange(p.CopySourceRange))
      .map((r) => r.end - r.start + 1);
    expect(new Set(lengths.slice(0, -1))).toEqual(new Set([MULTIPART_COPY_PART_BYTES]));
    expect(lengths[lengths.length - 1]).toBe(12_345);
    expect(lengths[lengths.length - 1]).toBeLessThanOrEqual(MULTIPART_COPY_PART_BYTES);
  });

  it('aborts the upload when a part fails, and rethrows the failure itself', async () => {
    const boom = failure('part 3 exploded');
    const { adapter, s3 } = adapterUnder(oversizeStore({
      UploadPartCopy: (input) => {
        if (input.PartNumber === 3) throw boom;
        return { CopyPartResult: { ETag: `"p${input.PartNumber}"` } };
      },
    }));

    // The ORIGINAL error, not a wrapper: the reason the copy stopped is the only actionable fact.
    await expect(adapter.copyObject(SRC, DEST)).rejects.toBe(boom);

    expect(s3.of('UploadPartCopy')).toHaveLength(3); // stopped there, did not grind on
    expect(s3.of('CompleteMultipartUpload')).toHaveLength(0);
    // Without this the already-copied parts stay alive and BILLED until a lifecycle rule reaps them.
    expect(s3.of('AbortMultipartUpload')).toEqual([expect.objectContaining({ Key: DEST, UploadId: 'upload-1' })]);
  });

  it('does not let a failed abort mask why the copy failed', async () => {
    const boom = failure('part 1 exploded');
    const { adapter, s3 } = adapterUnder(oversizeStore({
      UploadPartCopy: () => { throw boom; },
      AbortMultipartUpload: () => { throw failure('abort refused too'); },
    }));

    await expect(adapter.copyObject(SRC, DEST)).rejects.toBe(boom);
    expect(s3.of('AbortMultipartUpload').length).toBeGreaterThanOrEqual(1);
  });

  it('refuses before creating an upload when the store will not say how big the source is', async () => {
    const { adapter, s3 } = adapterUnder(oversizeStore({ HeadObject: () => ({ ContentType: 'video/mp4' }) }));

    const err = await refusalFrom(adapter.copyObject(SRC, DEST));
    expect(err).toBeInstanceOf(PermanentStorageError);
    // Permanent, and SAYS so: the duplication service's catch turns anything else into
    // "you can try again", which for this condition is advice that can never work.
    expect((err as PermanentStorageError).code).toBe('COPY_SIZE_UNKNOWN');
    expect(err.message).toMatch(/did not report its size/);
    expect(s3.of('CreateMultipartUpload')).toHaveLength(0);
    expect(s3.of('UploadPartCopy')).toHaveLength(0);
  });

  /**
   * The failure this whole investigation started from: a key that names nothing.
   *
   * A duplication that plans a copy of a key recovered from a public URL can be planning a copy of
   * an object that does not exist (see `publicUrlKeys.ts` for how that happened on Supabase). Every
   * re-run plans the same copy of the same absent object, so "you can try again" is the one thing
   * the user must not be told.
   */
  it('reports an absent source as permanent, not as something to try again', async () => {
    const { adapter, s3 } = adapterUnder(oversizeStore({ HeadObject: () => { throw missingError(); } }));

    const err = await refusalFrom(adapter.copyObject(SRC, DEST));
    expect(err).toBeInstanceOf(PermanentStorageError);
    expect((err as PermanentStorageError).code).toBe('COPY_SOURCE_MISSING');
    expect(err.message).toMatch(/does not exist/);
    // The 400 that sent us down this path is kept, so a diagnosis does not lose it.
    expect((err.cause as Error)?.message).toMatch(/larger than the maximum allowable size/);
    expect(s3.of('CreateMultipartUpload')).toHaveLength(0);
  });

  it('reports an absent source as permanent on the read-then-write path too', async () => {
    const { adapter, s3 } = adapterUnder((name) => {
      switch (name) {
        case 'CopyObject':
          throw Object.assign(new Error('nope'), { name: 'NotImplemented', $metadata: { httpStatusCode: 501 } });
        case 'HeadObject': throw missingError();
        default: throw new Error(`unexpected command: ${name}`);
      }
    });

    const err = await refusalFrom(adapter.copyObject(SRC, DEST));
    expect(err).toBeInstanceOf(PermanentStorageError);
    expect((err as PermanentStorageError).code).toBe('COPY_SOURCE_MISSING');
    expect(err.message).toMatch(/the object does not exist/);
    expect(s3.names()).not.toContain('GetObject');
  });

  it('takes none of it for an ordinary object — no HEAD, no multipart, one round trip', async () => {
    // `copyPrefix` runs this in a loop over hundreds of HLS segments; a proactive HEAD would double
    // every duplication's request count to learn something only the oversize branch needs.
    const { adapter, s3 } = adapterUnder((name) => {
      if (name === 'CopyObject') return {};
      throw new Error(`unexpected command: ${name}`);
    });

    await adapter.copyObject('hls/v/run/seg_000.ts', 'hls/w/run/seg_000.ts');

    expect(s3.names()).toEqual(['CopyObject']);
  });

  it('keeps "too large" and "not implemented" disjoint: unsupported still downloads and re-uploads', async () => {
    const { adapter, s3 } = adapterUnder((name) => {
      switch (name) {
        case 'CopyObject': throw Object.assign(new Error('nope'), { name: 'NotImplemented', $metadata: { httpStatusCode: 501 } });
        case 'HeadObject': return { ContentType: 'video/mp4', ContentLength: 4, CacheControl: 'no-cache' };
        case 'GetObject': return { Body: Readable.from([Buffer.from('abcd')]) };
        case 'PutObject': return {};
        default: throw new Error(`unexpected command: ${name}`);
      }
    });

    await adapter.copyObject(SRC, DEST);

    expect(s3.names()).toContain('GetObject');
    expect(s3.of('PutObject')[0]).toMatchObject({ Key: DEST, ContentType: 'video/mp4', CacheControl: 'no-cache' });
    // The one thing that must never happen: 10 GB through the Node heap, or a multipart copy of an
    // object the gateway cannot copy at all.
    expect(s3.names()).not.toContain('CreateMultipartUpload');
    expect(s3.names()).not.toContain('UploadPartCopy');
  });

  /**
   * The gateway rejects `CopyObject` outright — the branch whose own documentation calls it "an
   * EXPECTED path, not a curiosity" on Supabase — for an object far too big to hold in memory.
   */
  const unsupportedStore = (contentLength: number | undefined) => (name: string): unknown => {
    switch (name) {
      case 'CopyObject':
        throw Object.assign(new Error('nope'), { name: 'NotImplemented', $metadata: { httpStatusCode: 501 } });
      case 'HeadObject': return { ContentType: 'video/mp4', ContentLength: contentLength };
      case 'GetObject': return { Body: Readable.from([Buffer.alloc(8)]) };
      case 'PutObject': return {};
      default: throw new Error(`unexpected command: ${name}`);
    }
  };

  it('refuses the read-then-write fallback for an object too big to hold in memory', async () => {
    // THE TWO FALLBACKS ARE DISJOINT BY ERROR CLASS, NOT BY SIZE, and that was never enough. A 501
    // says nothing about how big the object is, so a 6 GB master took the read-then-write path and
    // `Buffer.concat`-ed the whole thing inside the API process — which is where duplication runs,
    // inline, for every user of the deployment.
    const { adapter, s3 } = adapterUnder(unsupportedStore(SIZE));

    const err = await refusalFrom(adapter.copyObject(SRC, DEST));
    expect(err).toBeInstanceOf(PermanentStorageError);
    expect((err as PermanentStorageError).code).toBe('COPY_TOO_LARGE_FOR_FALLBACK');
    // The wording is the actionable part and must survive the trip to the user intact.
    expect(err.message).toMatch(/does not support server-side copy/);
    expect(err.message).toMatch(/Enable server-side copy \(CopyObject\) on the storage bucket/);
    // Not a byte was moved, and it did not silently reroute to the multipart path either — that one
    // answers a different failure and would fail again, slower.
    expect(s3.names()).not.toContain('GetObject');
    expect(s3.names()).not.toContain('PutObject');
    expect(s3.names()).not.toContain('CreateMultipartUpload');
  });

  it('refuses when the store will not say how big the object is', async () => {
    // A bound that cannot be evaluated is not a bound. Refusing costs a clear error; guessing costs
    // the process.
    const { adapter, s3 } = adapterUnder(unsupportedStore(undefined));

    const err = await refusalFrom(adapter.copyObject(SRC, DEST));
    expect(err).toBeInstanceOf(PermanentStorageError);
    expect((err as PermanentStorageError).code).toBe('COPY_SIZE_UNKNOWN');
    expect(err.message).toMatch(/did not report the object's size/);
    expect(s3.names()).not.toContain('GetObject');
  });

  it('still takes the fallback for an object the heap can hold', async () => {
    // The guard must not turn an expected path into a broken one: Supabase's whole simulation
    // package, every poster and every HLS segment goes through here.
    const { adapter, s3 } = adapterUnder(unsupportedStore(HEAP_COPY_MAX_BYTES));

    await adapter.copyObject(SRC, DEST);
    expect(s3.names()).toContain('GetObject');
    expect(s3.of('PutObject')[0]).toMatchObject({ Key: DEST, ContentType: 'video/mp4' });
  });

  it('lets a real failure surface as itself', async () => {
    const denied = failure('access denied');
    const { adapter, s3 } = adapterUnder((name) => {
      if (name === 'CopyObject') throw denied;
      throw new Error(`unexpected command: ${name}`);
    });

    await expect(adapter.copyObject(SRC, DEST)).rejects.toBe(denied);
    expect(s3.names()).toEqual(['CopyObject']); // not retried as a multipart copy, nor as a download
  });
});

describe('LocalStorageAdapter copy', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.LOCAL_STORAGE_DIR;
  });

  /**
   * `LOCAL_STORAGE_BASE_DIR` is resolved at module-eval time, so the env var has to be set BEFORE
   * the import and the registry reset between cases — otherwise every case would share the first
   * one's temp directory.
   */
  async function withAdapter(): Promise<{ base: string; adapter: import('../StorageService.js').StorageService }> {
    const base = mkdtempSync(join(tmpdir(), 'copyprefix-'));
    dirs.push(base);
    process.env.LOCAL_STORAGE_DIR = base;
    vi.resetModules();
    const mod = await import('../LocalStorageAdapter.js');
    return { base, adapter: new mod.LocalStorageAdapter() };
  }

  const put = (base: string, key: string, body: string): void => {
    const full = join(base, key);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, body);
  };

  it('copies a whole tree and leaves the source in place', async () => {
    const { base, adapter } = await withAdapter();
    put(base, 'hls/v1/run/master.m3u8', 'MASTER');
    put(base, 'hls/v1/run/360p/seg_000.ts', 'SEG');
    put(base, 'hls/v1other/run/master.m3u8', 'SIBLING');

    const n = await adapter.copyPrefix('hls/v1', 'hls/v2');

    expect(n).toBe(2);
    expect(readFileSync(join(base, 'hls/v2/run/master.m3u8'), 'utf8')).toBe('MASTER');
    expect(readFileSync(join(base, 'hls/v2/run/360p/seg_000.ts'), 'utf8')).toBe('SEG');
    // The sibling prefix is untouched — the directory walk and the S3 rule agree here.
    expect(existsSync(join(base, 'hls/v2other'))).toBe(false);
    expect(readFileSync(join(base, 'hls/v1/run/master.m3u8'), 'utf8')).toBe('MASTER');
  });

  it('is idempotent, so an interrupted copy can just be re-run', async () => {
    const { base, adapter } = await withAdapter();
    put(base, 'sim/a/index.html', 'ONE');
    await adapter.copyPrefix('sim/a', 'sim/b');
    put(base, 'sim/a/index.html', 'TWO');
    await adapter.copyPrefix('sim/a', 'sim/b');
    expect(readFileSync(join(base, 'sim/b/index.html'), 'utf8')).toBe('TWO');
  });

  it('copying an absent prefix is a no-op, not a throw', async () => {
    const { adapter } = await withAdapter();
    expect(await adapter.copyPrefix('nothing/here', 'somewhere/else')).toBe(0);
  });

  it('refuses a key that escapes the storage root', async () => {
    const { base, adapter } = await withAdapter();
    put(base, 'videos/p/a.mp4', 'X');
    await expect(adapter.copyObject('videos/p/a.mp4', '../escaped.mp4')).rejects.toThrow(/escapes/);
    await expect(adapter.copyObject('../../etc/passwd', 'videos/p/b.mp4')).rejects.toThrow(/escapes/);
  });

  /**
   * CONFIRMING THE ASSUMPTION, rather than making it: the local adapter needs no oversize fallback.
   *
   * `copyObject` here is `fs.copyFile`, a single syscall whose only ceilings are the filesystem's
   * own maximum file size and its free space — there is no protocol limit to classify, and it
   * issues no S3 request, so `isCopyTooLarge` can never see anything from this adapter. The pin
   * below is the corroborating half: multipart is not implemented here AT ALL, so if this adapter
   * did need the fallback it could not have one. A 6 GiB fixture is deliberately not written — that
   * would assert the same thing at the cost of six gigabytes of temp disk on every run.
   */
  it('needs no oversize path: it has no copy ceiling, and no multipart to fall back to', async () => {
    const { base, adapter } = await withAdapter();
    put(base, 'videos/p/a.mp4', 'X'.repeat(4096));

    await adapter.copyObject('videos/p/a.mp4', 'videos/q/a.mp4');

    expect(readFileSync(join(base, 'videos/q/a.mp4'), 'utf8')).toHaveLength(4096);
    await expect(adapter.createMultipartUpload('videos/q/a.mp4', 'video/mp4'))
      .rejects.toThrow(/[Mm]ultipart upload is not supported/);
  });
});
