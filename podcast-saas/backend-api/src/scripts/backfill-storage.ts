/**
 * One-time migration: copy all local-disk media (the R2-read-only fallback store)
 * into the configured cloud bucket, so media uploaded/transcoded before the storage
 * switch keeps playing once URLs point at the cloud.
 *
 *   pnpm --filter backend-api backfill:storage
 *
 * Idempotent enough to re-run (objects are overwritten). Safe: only reads local files
 * and writes to the cloud adapter; never deletes anything.
 */
import { readdir, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { join, relative, sep } from 'path';
import { LOCAL_STORAGE_BASE_DIR } from '../services/storage/localStoragePaths.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';

function contentTypeFor(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
    vtt: 'text/vtt', mp3: 'audio/mpeg', wav: 'audio/wav', json: 'application/json',
    html: 'text/html', css: 'text/css', js: 'application/javascript', wasm: 'application/wasm', pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function main(): Promise<void> {
  const storage = getStorageAdapter();
  const adapterName = storage.constructor.name;
  if (adapterName === 'LocalStorageAdapter') {
    console.error('[backfill] target adapter is LocalStorageAdapter — set cloud creds first.');
    process.exit(1);
  }
  console.log(`[backfill] copying ${LOCAL_STORAGE_BASE_DIR} → ${adapterName}`);

  let count = 0, bytes = 0, failed = 0;
  for await (const file of walk(LOCAL_STORAGE_BASE_DIR)) {
    const key = relative(LOCAL_STORAGE_BASE_DIR, file).split(sep).join('/');
    try {
      const { size } = await stat(file);
      await storage.uploadStream(key, createReadStream(file), contentTypeFor(key), size);
      count++; bytes += size;
      if (count % 25 === 0) console.log(`[backfill]   ${count} files, ${(bytes / 1e6).toFixed(1)} MB …`);
    } catch (err) {
      failed++;
      console.warn(`[backfill]   FAILED ${key}: ${(err as Error).message?.slice(0, 140)}`);
    }
  }
  console.log(`\n[backfill] ${failed === 0 ? '✓' : '⚠'} done — ${count} files (${(bytes / 1e6).toFixed(1)} MB) uploaded, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
