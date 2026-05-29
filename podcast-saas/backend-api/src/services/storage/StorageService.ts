export interface StorageService {
  uploadFile(path: string, data: Buffer, contentType: string): Promise<string>;
  uploadStream(path: string, stream: NodeJS.ReadableStream, contentType: string, contentLength?: number): Promise<string>;
  getPresignedDownloadUrl(path: string, ttlSeconds: number): Promise<string>;
  getPresignedUploadUrl(path: string, contentType: string, ttlSeconds: number): Promise<string>;
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
