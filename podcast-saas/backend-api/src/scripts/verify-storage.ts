/**
 * Phase 1 storage verification.
 *
 *   pnpm --filter backend-api verify:storage
 *
 * Resolves the configured storage adapter and performs a real round-trip:
 *   PUT (uploadFile) → object exists (readObject + presigned GET) → bytes match → delete.
 * Fails loudly if the resolved adapter is the LocalStorageAdapter (i.e. NOT cloud).
 */
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';

async function main(): Promise<void> {
  const storage = getStorageAdapter();
  const adapterName = storage.constructor.name;
  console.log(`[verify-storage] resolved adapter: ${adapterName}`);

  if (adapterName === 'LocalStorageAdapter') {
    console.error(
      '[verify-storage] ✗ Using LOCAL disk, not cloud storage.\n' +
        '  Set STORAGE_BACKEND=supabase and the SUPABASE_S3_* env vars (see .env.example),\n' +
        '  then create the bucket + S3 access keys in the Supabase dashboard.',
    );
    process.exit(1);
  }

  const key = `_selfcheck/probe-${Date.now()}.txt`;
  const payload = Buffer.from(`podcast-saas storage selfcheck ${new Date().toISOString()}`);

  try {
    console.log(`[verify-storage] PUT  ${key} (${payload.length} bytes) …`);
    const publicUrl = await storage.uploadFile(key, payload, 'text/plain');

    console.log('[verify-storage] readObject (object exists?) …');
    const readBack = await storage.readObject(key);
    const readMatches = readBack.equals(payload);

    console.log('[verify-storage] presigned GET round-trip …');
    const signed = await storage.getPresignedDownloadUrl(key, 120);
    const res = await fetch(signed);
    const fetched = Buffer.from(await res.arrayBuffer());
    const getMatches = res.ok && fetched.equals(payload);

    // Public-URL read (the HLS/thumbnail playback path). A private bucket is valid for
    // signed-only media, but Phase 2/3 HLS + OG thumbnails need public read.
    console.log('[verify-storage] public URL fetch (HLS/thumbnail playback path) …');
    const pubRes = await fetch(publicUrl).catch(() => null);
    const pubReadable = !!pubRes?.ok && Buffer.from(await pubRes.arrayBuffer()).equals(payload);
    if (!pubReadable) {
      console.warn(
        `[verify-storage] ⚠ public URL NOT readable (status ${pubRes?.status ?? 'n/a'}). ` +
          'HLS playback + OG thumbnails need the bucket (or the hls/ and thumbnails/ objects) ' +
          'to be PUBLIC-read. Presigned GET works regardless (used for private media).',
      );
    }

    console.log('[verify-storage] presigned PUT round-trip (the browser upload path) …');
    const putKey = `_selfcheck/presigned-${Date.now()}.txt`;
    const putUrl = await storage.getPresignedUploadUrl(putKey, 'text/plain', 120);
    const putRes = await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: payload });
    const putReadBack = putRes.ok ? await storage.readObject(putKey).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    const putMatches = putRes.ok && putReadBack.equals(payload);

    console.log('[verify-storage] DELETE (cleanup) …');
    await storage.deleteFile(key);
    await storage.deleteFile(putKey).catch(() => {});

    if (readMatches && getMatches && putMatches) {
      console.log('\n[verify-storage] ✓ PASS — server PUT, presigned PUT, and presigned GET all round-trip.');
      console.log(`  adapter:        ${adapterName}`);
      console.log(`  public read:    ${pubReadable ? 'yes (HLS/thumbnails OK)' : 'NO — make bucket public for HLS/OG'}`);
      console.log(`  publicUrl:      ${publicUrl}`);
      process.exit(0);
    }
    console.error('\n[verify-storage] ✗ FAIL — bytes did not match.', {
      readMatches, getMatches, putMatches, getStatus: res.status, putStatus: putRes.status,
    });
    process.exit(1);
  } catch (err) {
    console.error('\n[verify-storage] ✗ FAIL — round-trip threw:', err);
    process.exit(1);
  }
}

void main();
