import { writeFile, mkdir, readFile, rm, readdir, stat } from 'fs/promises';
import { createWriteStream } from 'fs';
import { join } from 'path';
import type { CompletedPart, StorageService } from './StorageService.js';
import { LOCAL_STORAGE_BASE_DIR } from './localStoragePaths.js';
import { logger } from '../../lib/logger.js';

// Local disk storage — used when R2 is not configured AND as the durable
// fallback when R2 object writes are denied. Files are written to a PERSISTENT
// directory (see localStoragePaths.ts — NOT os.tmpdir, which is wiped on
// restart) and served via the backend's /local-storage/:path* route.

const BASE_DIR = LOCAL_STORAGE_BASE_DIR;
const SERVE_BASE = process.env.BACKEND_API_URL ?? 'http://localhost:8080';

export class LocalStorageAdapter implements StorageService {
  constructor() {
    logger.warn('R2 not configured — using local disk storage (dev only). Files stored in ' + BASE_DIR);
  }

  async uploadFile(path: string, data: Buffer, _contentType: string, _cacheControl?: string): Promise<string> {
    const dest = join(BASE_DIR, path);
    await mkdir(dest.substring(0, dest.lastIndexOf('/')), { recursive: true });
    await writeFile(dest, data);
    return `${SERVE_BASE}/local-storage/${path}`;
  }

  async uploadStream(path: string, stream: NodeJS.ReadableStream, _contentType: string, _contentLength?: number): Promise<string> {
    const dest = join(BASE_DIR, path);
    await mkdir(dest.substring(0, dest.lastIndexOf('/')), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(dest);
      stream.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      stream.on('error', reject);
    });
    return `${SERVE_BASE}/local-storage/${path}`;
  }

  async getPresignedDownloadUrl(path: string, _ttlSeconds: number): Promise<string> {
    // /video-raw/* serves with range-request support and no auth requirement,
    // so the browser's <video> element can stream it directly.
    return `${SERVE_BASE}/video-raw/${path}`;
  }

  async getPresignedUploadUrl(path: string, _contentType: string, _ttlSeconds: number): Promise<string> {
    // In local dev the "presigned" URL is just a backend PUT endpoint
    return `${SERVE_BASE}/local-storage/upload/${path}`;
  }

  // S3 multipart is a cloud-storage concept; local disk has no equivalent. Throwing a
  // clear error lets the controller report "multipart unsupported" so the browser uses
  // the single-PUT path in local dev. Production never resolves this adapter (fail-closed).
  private static multipartUnsupported(): never {
    throw new Error('Multipart upload is not supported by the local-disk adapter; use the single-PUT path');
  }
  async createMultipartUpload(_path: string, _contentType: string): Promise<string> {
    return LocalStorageAdapter.multipartUnsupported();
  }
  async getPresignedUploadPartUrl(_path: string, _uploadId: string, _partNumber: number, _ttlSeconds: number): Promise<string> {
    return LocalStorageAdapter.multipartUnsupported();
  }
  async completeMultipartUpload(_path: string, _uploadId: string, _parts: CompletedPart[]): Promise<string> {
    return LocalStorageAdapter.multipartUnsupported();
  }
  async abortMultipartUpload(_path: string, _uploadId: string): Promise<void> {
    return LocalStorageAdapter.multipartUnsupported();
  }

  async deleteFile(path: string): Promise<void> {
    const { unlink } = await import('fs/promises');
    await unlink(join(BASE_DIR, path)).catch(() => null);
  }

  async deleteWithPrefix(prefix: string): Promise<void> {
    await rm(join(BASE_DIR, prefix), { recursive: true, force: true });
  }

  getPublicUrl(path: string): string {
    // HLS segments are served via the unauthenticated /hls-public/* route
    return `${SERVE_BASE}/hls-public/${path}`;
  }

  getSimPublicUrl(path: string): string {
    // Simulation files served via the unauthenticated /sim-public/* route
    return `${SERVE_BASE}/sim-public/${path}`;
  }

  async readObject(key: string): Promise<Buffer> {
    return readFile(join(BASE_DIR, key));
  }

  async listObjects(prefix: string): Promise<string[]> {
    const dir = join(BASE_DIR, prefix);
    const keys: string[] = [];
    async function walk(current: string) {
      let entries: string[];
      try {
        entries = await readdir(current);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(current, entry);
        const s = await stat(full).catch(() => null);
        if (!s) continue;
        if (s.isDirectory()) {
          await walk(full);
        } else {
          // Return key relative to BASE_DIR
          keys.push(full.slice(BASE_DIR.length + 1));
        }
      }
    }
    await walk(dir);
    return keys;
  }
}
