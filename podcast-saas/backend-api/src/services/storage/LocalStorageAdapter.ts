import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { StorageService } from './StorageService.js';
import { logger } from '../../lib/logger.js';

// Dev-only local disk storage — activated when R2_ACCOUNT_ID is not set.
// Files are written to <tmpdir>/podcast-saas-local-storage/ and served via
// the backend's /local-storage/:path* route.

const BASE_DIR = join(tmpdir(), 'podcast-saas-local-storage');
const SERVE_BASE = process.env.BACKEND_API_URL ?? 'http://localhost:8080';

export class LocalStorageAdapter implements StorageService {
  constructor() {
    logger.warn('R2 not configured — using local disk storage (dev only). Files stored in ' + BASE_DIR);
  }

  async uploadFile(path: string, data: Buffer, _contentType: string): Promise<string> {
    const dest = join(BASE_DIR, path);
    await mkdir(dest.substring(0, dest.lastIndexOf('/')), { recursive: true });
    await writeFile(dest, data);
    return `${SERVE_BASE}/local-storage/${path}`;
  }

  async uploadStream(path: string, stream: NodeJS.ReadableStream, contentType: string): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return this.uploadFile(path, Buffer.concat(chunks), contentType);
  }

  async getPresignedDownloadUrl(path: string, _ttlSeconds: number): Promise<string> {
    return `${SERVE_BASE}/local-storage/${path}`;
  }

  async deleteFile(path: string): Promise<void> {
    const { unlink } = await import('fs/promises');
    await unlink(join(BASE_DIR, path)).catch(() => null);
  }
}
