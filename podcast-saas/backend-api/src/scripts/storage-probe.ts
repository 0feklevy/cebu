/**
 * storage-probe — the capability matrix of ONE NAMED storage backend, not the resolved one.
 *
 *   pnpm --filter backend-api storage:probe -- --backend=r2
 *   pnpm --filter backend-api storage:probe -- --backend=supabase
 *
 * Owner ruling 2026-09-03 (R2, staged): before anything is migrated, verify what the R2 token can
 * actually do — the code has said for weeks that it is read-only. Under a `_probe/<ts>/` prefix
 * it deletes afterwards, this tries every capability the app relies on and prints PASS / FAIL per
 * line; the exit code is non-zero on any FAIL. Nothing outside the probe prefix is touched.
 *
 * Capabilities: put · head (with last-modified) · get · list · copy · presigned GET · public URL
 * fetch (+ CORS preflight from the app origin, + the cache header observed) · multipart create →
 * presigned part PUT → complete · multipart abort · list-multipart · delete · delete-prefix.
 */
import { R2StorageAdapter } from '../services/storage/R2StorageAdapter.js';
import { SupabaseStorageAdapter } from '../services/storage/SupabaseStorageAdapter.js';
import type { StorageService } from '../services/storage/StorageService.js';

const ARGS = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k!, v ?? 'true']; }));
const BACKEND = ARGS.get('backend');
const ORIGIN = ARGS.get('origin') ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://flowvidco.com';

function named(name: string | undefined): StorageService {
  if (name === 'r2') return new R2StorageAdapter();
  if (name === 'supabase') return new SupabaseStorageAdapter();
  throw new Error('--backend=r2|supabase is required (the RESOLVED adapter is deliberately not used)');
}

type Row = { capability: string; ok: boolean; note: string };
const rows: Row[] = [];
async function step(capability: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const note = (await fn()) ?? '';
    rows.push({ capability, ok: true, note });
    return true;
  } catch (err) {
    rows.push({ capability, ok: false, note: String((err as Error)?.message ?? err).slice(0, 160) });
    return false;
  }
}

async function main(): Promise<void> {
  const storage = named(BACKEND);
  const prefix = `_probe/${Date.now()}`;
  const key = `${prefix}/object.txt`;
  const copyKey = `${prefix}/copy.txt`;
  const mpKey = `${prefix}/multipart.bin`;
  const abortKey = `${prefix}/aborted.bin`;
  const payload = Buffer.from(`storage probe ${new Date().toISOString()} backend=${BACKEND}`);
  console.log(`[storage-probe] backend=${BACKEND} prefix=${prefix} origin=${ORIGIN}`);

  let publicUrl = '';
  await step('put', async () => { publicUrl = await storage.uploadFile(key, payload, 'text/plain', 'public, max-age=60'); return publicUrl; });
  await step('head', async () => {
    const h = await storage.headObject(key);
    if (!h) throw new Error('head answered null for an object just written');
    return `size=${h.size} type=${h.contentType} cache=${h.cacheControl} lastModified=${h.lastModified}`;
  });
  await step('get', async () => { const b = await storage.readObject(key); if (!b.equals(payload)) throw new Error('bytes differ'); });
  await step('list', async () => { const keys = await storage.listObjects(prefix); if (!keys.includes(key)) throw new Error(`list did not contain ${key}: ${keys.join(',')}`); return `${keys.length} key(s)`; });
  await step('copy', async () => { await storage.copyObject(key, copyKey); if (!(await storage.readObject(copyKey)).equals(payload)) throw new Error('copy differs'); });
  await step('presigned GET', async () => {
    const url = await storage.getPresignedDownloadUrl(key, 120);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    if (!Buffer.from(await res.arrayBuffer()).equals(payload)) throw new Error('bytes differ');
  });
  await step('public URL fetch', async () => {
    const res = await fetch(publicUrl, { headers: { Origin: ORIGIN } });
    if (!res.ok) throw new Error(`status ${res.status} at ${publicUrl}`);
    if (!Buffer.from(await res.arrayBuffer()).equals(payload)) throw new Error('bytes differ');
    return `cache-control=${res.headers.get('cache-control')} acao=${res.headers.get('access-control-allow-origin') ?? '(none)'}`;
  });
  await step('CORS preflight (GET from the app origin)', async () => {
    const res = await fetch(publicUrl, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } });
    const acao = res.headers.get('access-control-allow-origin');
    if (!acao) throw new Error(`no Access-Control-Allow-Origin (status ${res.status})`);
    return `acao=${acao}`;
  });
  await step('multipart create → part PUT → complete', async () => {
    const uploadId = await storage.createMultipartUpload(mpKey, 'application/octet-stream');
    const part = Buffer.alloc(5 * 1024 * 1024, 7);          // the S3 minimum part size
    const url = await storage.getPresignedUploadPartUrl(mpKey, uploadId, 1, 120);
    const put = await fetch(url, { method: 'PUT', body: part });
    if (!put.ok) throw new Error(`part PUT status ${put.status}`);
    const etag = put.headers.get('etag');
    if (!etag) throw new Error('part PUT returned no ETag');
    await storage.completeMultipartUpload(mpKey, uploadId, [{ etag, partNumber: 1 }]);
    const h = await storage.headObject(mpKey);
    if (h?.size !== part.length) throw new Error(`completed object size ${h?.size} ≠ ${part.length}`);
    return `uploadId=${uploadId.slice(0, 12)}…`;
  });
  await step('multipart abort + list-multipart', async () => {
    const uploadId = await storage.createMultipartUpload(abortKey, 'application/octet-stream');
    const open = await storage.listMultipartUploads(prefix);
    if (!open.some((u) => u.uploadId === uploadId)) throw new Error('the open upload was not listed');
    await storage.abortMultipartUpload(abortKey, uploadId);
    const after = await storage.listMultipartUploads(prefix);
    if (after.some((u) => u.uploadId === uploadId)) throw new Error('the upload is still listed after abort');
    return `listed ${open.length}, after abort ${after.length}`;
  });
  await step('delete', async () => { await storage.deleteFile(copyKey); if (await storage.objectExists(copyKey)) throw new Error('still exists'); });
  await step('delete-prefix', async () => { await storage.deleteWithPrefix(prefix); const left = await storage.listObjects(prefix); if (left.length) throw new Error(`${left.length} object(s) left`); });

  const width = Math.max(...rows.map((r) => r.capability.length));
  console.log('');
  for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.capability.padEnd(width)}  ${r.note}`);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n[storage-probe] ${rows.length - failed}/${rows.length} capabilities pass on ${BACKEND}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
