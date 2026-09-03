/**
 * The storage adapter for the cutover window (owner ruling 2026-09-03: R2 is the direction,
 * production is not flipped by a flag — a staged migration with rollback and read compatibility
 * while objects move).
 *
 * Writes go to the PRIMARY. Reads try the primary and fall back to the SECONDARY; a bodyless read
 * (head, exists) answers from whichever has it. Deletes go to both, so a delete during the window
 * cannot resurrect from the copy. URLs are the primary's — the URL-bearing columns are rewritten
 * separately (scripts/storage-rewrite-urls.ts), and `keyFromPublicUrl` reverses BOTH vendors'
 * shapes so a row not yet rewritten still resolves to a key. Multipart, presigned uploads, copies
 * and listings are the primary's: every new byte lands there.
 *
 * Selected by STORAGE_BACKEND=migrating with STORAGE_PRIMARY / STORAGE_SECONDARY (r2 | supabase).
 * Rolling back is STORAGE_BACKEND=<secondary> — nothing written during the window is lost, it
 * simply stops being read until the copy runs the other way.
 */
import type { CompletedPart, MultipartUploadInfo, StorageService, StoredObjectHead } from './StorageService.js';
import { logger } from '../../lib/logger.js';

export class MigratingStorageAdapter implements StorageService {
  constructor(
    readonly primary: StorageService,
    readonly secondary: StorageService,
    private readonly names: { primary: string; secondary: string } = { primary: 'primary', secondary: 'secondary' },
  ) {}

  /** What the log says once, so an operator reading it knows which way the bytes flow. */
  describe(): string {
    return `migrating: writes → ${this.names.primary}, reads ${this.names.primary} then ${this.names.secondary}, deletes → both`;
  }

  // ── writes: primary only ──
  uploadFile(path: string, data: Buffer, contentType: string, cacheControl?: string): Promise<string> {
    return this.primary.uploadFile(path, data, contentType, cacheControl);
  }
  uploadStream(path: string, stream: NodeJS.ReadableStream, contentType: string, contentLength?: number): Promise<string> {
    return this.primary.uploadStream(path, stream, contentType, contentLength);
  }
  getPresignedUploadUrl(path: string, contentType: string, ttlSeconds: number): Promise<string> {
    return this.primary.getPresignedUploadUrl(path, contentType, ttlSeconds);
  }
  createMultipartUpload(path: string, contentType: string): Promise<string> {
    return this.primary.createMultipartUpload(path, contentType);
  }
  getPresignedUploadPartUrl(path: string, uploadId: string, partNumber: number, ttlSeconds: number): Promise<string> {
    return this.primary.getPresignedUploadPartUrl(path, uploadId, partNumber, ttlSeconds);
  }
  completeMultipartUpload(path: string, uploadId: string, parts: CompletedPart[]): Promise<string> {
    return this.primary.completeMultipartUpload(path, uploadId, parts);
  }
  abortMultipartUpload(path: string, uploadId: string): Promise<void> {
    return this.primary.abortMultipartUpload(path, uploadId);
  }
  listMultipartUploads(prefix?: string): Promise<MultipartUploadInfo[]> {
    return this.primary.listMultipartUploads(prefix);
  }

  /**
   * A copy whose source is not on the primary yet is copied THROUGH: read from the secondary, put
   * on the primary, then the primary copies. Duplications and republishes keep working mid-window.
   */
  async copyObject(srcKey: string, destKey: string): Promise<void> {
    if (!(await this.primary.objectExists(srcKey)) && (await this.secondary.objectExists(srcKey))) {
      await this.pullThrough(srcKey);
    }
    return this.primary.copyObject(srcKey, destKey);
  }
  async copyPrefix(srcPrefix: string, destPrefix: string): Promise<number> {
    const onPrimary = new Set(await this.primary.listObjects(srcPrefix));
    for (const key of await this.secondary.listObjects(srcPrefix)) {
      if (!onPrimary.has(key)) await this.pullThrough(key);
    }
    return this.primary.copyPrefix(srcPrefix, destPrefix);
  }

  // ── deletes: both ──
  async deleteFile(path: string): Promise<void> {
    await this.primary.deleteFile(path);
    await this.secondary.deleteFile(path).catch((err) => {
      logger.warn({ err: (err as Error)?.message?.slice(0, 200), path }, '[storage:migrating] secondary delete failed');
    });
  }
  async deleteWithPrefix(prefix: string): Promise<void> {
    await this.primary.deleteWithPrefix(prefix);
    await this.secondary.deleteWithPrefix(prefix).catch((err) => {
      logger.warn({ err: (err as Error)?.message?.slice(0, 200), prefix }, '[storage:migrating] secondary prefix delete failed');
    });
  }

  // ── reads: primary, then secondary ──
  async readObject(key: string): Promise<Buffer> {
    try {
      return await this.primary.readObject(key);
    } catch (primaryErr) {
      if (await this.secondary.objectExists(key)) return this.secondary.readObject(key);
      throw primaryErr;
    }
  }
  async headObject(key: string): Promise<StoredObjectHead | null> {
    return (await this.primary.headObject(key)) ?? this.secondary.headObject(key);
  }
  async objectExists(key: string): Promise<boolean> {
    return (await this.primary.objectExists(key)) || this.secondary.objectExists(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    const [a, b] = await Promise.all([this.primary.listObjects(prefix), this.secondary.listObjects(prefix)]);
    return [...new Set([...a, ...b])];
  }
  /** A presigned GET must point where the bytes ARE. */
  async getPresignedDownloadUrl(path: string, ttlSeconds: number): Promise<string> {
    if (await this.primary.objectExists(path)) return this.primary.getPresignedDownloadUrl(path, ttlSeconds);
    if (await this.secondary.objectExists(path)) return this.secondary.getPresignedDownloadUrl(path, ttlSeconds);
    return this.primary.getPresignedDownloadUrl(path, ttlSeconds);
  }

  // ── URLs: the primary's; the inverse understands both ──
  getPublicUrl(path: string): string { return this.primary.getPublicUrl(path); }
  getSimPublicUrl(path: string): string { return this.primary.getSimPublicUrl(path); }
  keyFromPublicUrl(url: string | null | undefined): string | null {
    return this.primary.keyFromPublicUrl(url) ?? this.secondary.keyFromPublicUrl(url);
  }
  effectiveSimulationContentType(key: string, storedContentType: string): string {
    return this.primary.effectiveSimulationContentType?.(key, storedContentType) ?? storedContentType;
  }

  /** Secondary → primary, preserving the content type the secondary reports. */
  private async pullThrough(key: string): Promise<void> {
    const [bytes, head] = await Promise.all([this.secondary.readObject(key), this.secondary.headObject(key)]);
    await this.primary.uploadFile(key, bytes, head?.contentType ?? 'application/octet-stream', head?.cacheControl ?? undefined);
    logger.info({ key, bytes: bytes.length }, '[storage:migrating] pulled through to the primary');
  }
}
