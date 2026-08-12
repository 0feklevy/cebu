/** One uploaded part of an S3 multipart upload, as reported back by the browser. */
export interface CompletedPart {
  /** 1-based part index. */
  partNumber: number;
  /** The ETag the storage returned for that part's PUT (quoted string). */
  etag: string;
}

export interface StorageService {
  /**
   * Upload a buffer. `cacheControl`, when given, is stored as the object's Cache-Control
   * metadata — Supabase's public endpoint serves it verbatim (objects uploaded without it
   * serve `no-cache`). Pass `public, max-age=31536000, immutable` ONLY for write-once keys;
   * never for objects that are overwritten in place (sim entry HTML / bridge.js).
   */
  uploadFile(path: string, data: Buffer, contentType: string, cacheControl?: string): Promise<string>;
  uploadStream(path: string, stream: NodeJS.ReadableStream, contentType: string, contentLength?: number): Promise<string>;
  getPresignedDownloadUrl(path: string, ttlSeconds: number): Promise<string>;
  getPresignedUploadUrl(path: string, contentType: string, ttlSeconds: number): Promise<string>;

  // ── S3 multipart upload (for files larger than a single PUT / the bucket size cap) ──
  // The browser uploads the file in parts straight to object storage, mirroring fiji's
  // large-file path. Adapters that can't do S3 multipart (local disk) throw a clear error;
  // callers fall back to the single-PUT presigned path for those.
  /** Begin a multipart upload; returns the uploadId the subsequent calls need. */
  createMultipartUpload(path: string, contentType: string): Promise<string>;
  /** Presigned PUT URL for one part (partNumber is 1-based). The browser PUTs the chunk to it. */
  getPresignedUploadPartUrl(
    path: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<string>;
  /** Finalize the upload by stitching the parts (ordered by partNumber). Returns the public URL. */
  completeMultipartUpload(path: string, uploadId: string, parts: CompletedPart[]): Promise<string>;
  /** Abort an in-progress multipart upload so the storage drops the orphaned parts. */
  abortMultipartUpload(path: string, uploadId: string): Promise<void>;

  deleteFile(path: string): Promise<void>;
  /** Delete all objects whose key starts with prefix (used to purge HLS segments). */
  deleteWithPrefix(prefix: string): Promise<void>;

  /**
   * Copy one object to a new key, preserving its content type and Cache-Control.
   *
   * Server-side where the store can do it (S3 `CopyObject`), so a 400 MB HLS ladder never
   * travels through the Node heap. Adapters that cannot copy server-side fall back to
   * read-then-write, which is correct but slow — the fallback is an implementation detail,
   * never a difference in observable behaviour.
   *
   * IDEMPOTENT BY CONSTRUCTION: the destination is overwritten, so an interrupted copy is
   * resumable by simply running it again. `RevisionMigration` already depends on that property
   * for its own byte-shuttling loop, and project duplication relies on it too — bytes are
   * written before any row is committed, so a retry must be able to land on top of whatever
   * the previous attempt already wrote.
   */
  copyObject(srcKey: string, destKey: string): Promise<void>;
  /**
   * Copy every object under `srcPrefix` to the same relative path under `destPrefix`.
   *
   * "Under" means the key IS `srcPrefix` or begins with `srcPrefix + '/'` — a deliberate
   * narrowing of the raw string-prefix semantics `deleteWithPrefix` has on the cloud adapters,
   * so that `copyPrefix('hls/abc', …)` cannot sweep up `hls/abcdef/…`. Every adapter honours
   * that same rule, which is what lets the local-disk adapter (whose natural unit is a
   * directory) and the S3 adapters (whose natural unit is a key prefix) agree.
   *
   * Returns the number of objects copied.
   */
  copyPrefix(srcPrefix: string, destPrefix: string): Promise<number>;
  /** Returns the public (no-auth) URL for a storage key. Used for HLS segments. */
  getPublicUrl(path: string): string;
  /** Returns the public (no-auth) URL for a simulation file. Served via /sim-public/* in local dev, R2 public URL in prod. */
  getSimPublicUrl(path: string): string;
  /**
   * The storage key a URL this adapter published names — the INVERSE of `getPublicUrl` /
   * `getSimPublicUrl` — or null when the URL is not one of ours.
   *
   * Several columns store a full public URL and no key (`corpora.storage_url`,
   * `avatar_config…faces[].imageUrl`, `guidance_meta.mdUrl`, `guidance[].audioUrl`). Recovering the
   * key by pattern-matching hosts in a SERVICE is wrong for any adapter whose URL shape is not on
   * the list — see `publicUrlKeys.ts` for the Supabase failure that motivated moving it here. Each
   * adapter answers for its OWN shapes, beside the forward direction, so the pair cannot drift.
   */
  keyFromPublicUrl(url: string | null | undefined): string | null;
  /** Read a stored object as a Buffer. */
  readObject(key: string): Promise<Buffer>;
  /** List all object keys under the given prefix (non-recursive prefix, returns full keys). */
  listObjects(prefix: string): Promise<string[]>;
  /** True if an object exists at this key (cheap HEAD; used by the URL backfill migration). */
  objectExists(key: string): Promise<boolean>;
  /**
   * The stored object's metadata, or null when it does not exist.
   *
   * Exists so a publication can VERIFY what the store accepted rather than record what it asked
   * for. `objectExists` already sends the same HEAD on both cloud adapters and throws the response
   * away — so without this, a package manifest's `contentType` and `cacheControl` are claims about
   * an upload call, not observations of the object, while looking exactly like observations.
   *
   * A store that does not report a field returns null for it rather than a guess; a caller must be
   * able to tell "served as text/plain" from "cannot tell".
   */
  headObject(key: string): Promise<StoredObjectHead | null>;
}

/** What a HEAD can tell us about a stored object. Nulls mean "the store did not report it". */
export interface StoredObjectHead {
  contentType: string | null;
  cacheControl: string | null;
  size: number | null;
  etag: string | null;
}
