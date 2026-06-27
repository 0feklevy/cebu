/** One uploaded part of an S3 multipart upload, as reported back by the browser. */
export interface CompletedPart {
  /** 1-based part index. */
  partNumber: number;
  /** The ETag the storage returned for that part's PUT (quoted string). */
  etag: string;
}

export interface StorageService {
  uploadFile(path: string, data: Buffer, contentType: string): Promise<string>;
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
  /** Returns the public (no-auth) URL for a storage key. Used for HLS segments. */
  getPublicUrl(path: string): string;
  /** Returns the public (no-auth) URL for a simulation file. Served via /sim-public/* in local dev, R2 public URL in prod. */
  getSimPublicUrl(path: string): string;
  /** Read a stored object as a Buffer. */
  readObject(key: string): Promise<Buffer>;
  /** List all object keys under the given prefix (non-recursive prefix, returns full keys). */
  listObjects(prefix: string): Promise<string[]>;
}
