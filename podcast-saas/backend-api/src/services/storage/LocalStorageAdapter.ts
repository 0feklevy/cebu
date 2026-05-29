import { writeFile, mkdir, readFile, rm, readdir, stat } from 'fs/promises';
import { createWriteStream } from 'fs';
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
