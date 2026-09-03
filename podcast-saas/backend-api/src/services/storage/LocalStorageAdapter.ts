import { writeFile, mkdir, readFile, rm, readdir, stat, copyFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { join, dirname, sep } from 'path';
import type { CompletedPart, MultipartUploadInfo, StorageService, StoredObjectHead } from './StorageService.js';
import { LOCAL_STORAGE_BASE_DIR } from './localStoragePaths.js';
import { safeLocalPath } from './pathSafety.js';
import { reroot } from './prefixScope.js';
import { mediaKeyScope, mintMediaToken } from './mediaToken.js';
import { logger } from '../../lib/logger.js';
import { publicApiOrigin, isProd } from '../../config/publicOrigins.js';
import { keyFromPublicUrlAgainst } from './publicUrlKeys.js';

// Local disk storage — DEV ONLY. Files are written to a PERSISTENT directory
// (see localStoragePaths.ts — NOT os.tmpdir, which is wiped on restart) and served
// via the backend's /local-storage/:path* route. This adapter must NEVER be used in
// production: it serves per-instance disk over a localhost-based URL that no other
// container/CDN/browser can reach (getStorageAdapter fails closed in prod).

const BASE_DIR = LOCAL_STORAGE_BASE_DIR;
// Resolved per-call (not at import) so it always reflects current env and so importing
// this module in prod for type reasons never throws. In prod publicApiOrigin() is a real
// https origin; getStorageAdapter guarantees this adapter isn't constructed in prod anyway.
const serveBase = (): string => publicApiOrigin();

export class LocalStorageAdapter implements StorageService {
  constructor() {
    if (isProd()) {
      throw new Error(
        'LocalStorageAdapter must not be used in production — configure Supabase (SUPABASE_S3_*) storage.',
      );
    }
    logger.warn('R2 not configured — using local disk storage (dev only). Files stored in ' + BASE_DIR);
  }

  async uploadFile(path: string, data: Buffer, _contentType: string, _cacheControl?: string): Promise<string> {
    const dest = join(BASE_DIR, path);
    await mkdir(dest.substring(0, dest.lastIndexOf('/')), { recursive: true });
    await writeFile(dest, data);
    return `${serveBase()}/local-storage/${path}`;
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
    return `${serveBase()}/local-storage/${path}`;
  }

  async getPresignedDownloadUrl(path: string, ttlSeconds: number): Promise<string> {
    // /video-raw/* serves with range-request support so the browser's <video>
    // element can stream it directly — but it only accepts videos/ keys. The
    // scoped media token in the path authorizes private projects' media without
    // the player needing auth headers (security-002). Everything else
    // (podcasts/ masters + clips) goes via /local-storage/* which has Range +
    // CORS and public podcast prefixes.
    if (path.startsWith('videos/')) {
      const scope = mediaKeyScope(path);
      if (scope) return `${serveBase()}/video-raw/t/${mintMediaToken(scope)}/${path}`;
      return `${serveBase()}/video-raw/${path}`;
    }
    // Export masters download via a plain <a> navigation — no Authorization header possible —
    // so the "presigned" local URL carries the same scoped token the video routes use. The TTL
    // honours the caller's request the way a real presign would.
    if (path.startsWith('exports/')) {
      const scope = mediaKeyScope(path);
      if (scope) return `${serveBase()}/local-storage/t/${mintMediaToken(scope, ttlSeconds)}/${path}`;
    }
    return `${serveBase()}/local-storage/${path}`;
  }

  async getPresignedUploadUrl(path: string, _contentType: string, _ttlSeconds: number): Promise<string> {
    // In local dev the "presigned" URL is just a backend PUT endpoint
    return `${serveBase()}/local-storage/upload/${path}`;
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
  /** Local disk never has an open multipart upload: the parts path does not exist here. */
  async listMultipartUploads(_prefix?: string): Promise<MultipartUploadInfo[]> {
    return [];
  }

  async deleteFile(path: string): Promise<void> {
    const { unlink } = await import('fs/promises');
    await unlink(join(BASE_DIR, path)).catch(() => null);
  }

  async deleteWithPrefix(prefix: string): Promise<void> {
    await rm(join(BASE_DIR, prefix), { recursive: true, force: true });
  }

  /**
   * Copy one file, creating the destination directory.
   *
   * Unlike every other method here, copy takes TWO caller-supplied keys and WRITES to the second,
   * so it is the one place where an escaping key would let a caller author a file anywhere on
   * disk. `safeLocalPath` is therefore applied to both — the rest of this adapter predates it and
   * relies on its callers, but a brand-new write primitive should not inherit that.
   */
  async copyObject(srcKey: string, destKey: string): Promise<void> {
    const src = safeLocalPath(BASE_DIR, srcKey);
    const dest = safeLocalPath(BASE_DIR, destKey);
    if (!src || !dest) {
      throw new Error('copyObject: key escapes the local storage root');
    }
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }

  async copyPrefix(srcPrefix: string, destPrefix: string): Promise<number> {
    // listObjects already walks recursively and returns BASE_DIR-relative keys; reroot() then
    // applies the shared "under the prefix" rule so this agrees with the cloud adapters even
    // though the walk itself is directory-shaped.
    const keys = await this.listObjects(srcPrefix);
    let copied = 0;
    for (const key of keys) {
      // listObjects builds keys with the platform separator; storage keys are always '/'.
      const posixKey = key.split(sep).join('/');
      const dest = reroot(posixKey, srcPrefix, destPrefix);
      if (dest === null) continue;
      await this.copyObject(posixKey, dest);
      copied += 1;
    }
    return copied;
  }

  getPublicUrl(path: string): string {
    // HLS is served via /hls-public/* with a scoped media token in the PATH so
    // relative child-playlist/segment URLs inherit it (security-002); other
    // public assets (podcasts/ clips etc.) go via /local-storage/* whose
    // PUBLIC_LOCAL_PREFIXES gate them.
    if (path.startsWith('hls/')) {
      const scope = mediaKeyScope(path);
      if (scope) return `${serveBase()}/hls-public/t/${mintMediaToken(scope)}/${path}`;
      return `${serveBase()}/hls-public/${path}`;
    }
    return `${serveBase()}/local-storage/${path}`;
  }

  getSimPublicUrl(path: string): string {
    // Simulation files served via the unauthenticated /sim-public/* route
    return `${serveBase()}/sim-public/${path}`;
  }

  /** The inverse of the three routes above. See `publicUrlKeys.ts`. */
  keyFromPublicUrl(url: string | null | undefined): string | null {
    const base = serveBase().replace(/\/+$/, '');
    return keyFromPublicUrlAgainst(url, [
      `${base}/local-storage`,
      `${base}/hls-public`,
      `${base}/sim-public`,
    ]);
  }

  async objectExists(key: string): Promise<boolean> {
    return stat(join(BASE_DIR, key)).then(() => true).catch(() => false);
  }

  async headObject(key: string): Promise<StoredObjectHead | null> {
    // Local disk stores no per-object metadata, so contentType/cacheControl are honestly null: this
    // adapter CANNOT verify them, and saying so is what lets a caller report "unverified" instead
    // of inventing a pass. Size and mtime-derived etag are real observations and are returned.
    try {
      const st = await stat(join(BASE_DIR, key));
      return {
        contentType: null,
        cacheControl: null,
        size: st.size,
        etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
        lastModified: st.mtime.toISOString(),
      };
    } catch {
      return null;
    }
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
