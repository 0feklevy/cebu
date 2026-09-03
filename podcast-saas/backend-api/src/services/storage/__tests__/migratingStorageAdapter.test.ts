/**
 * The cutover adapter: writes to the primary, reads through to the secondary, deletes both,
 * copies pull the source through first, URLs are the primary's and the inverse understands both.
 */
import { describe, it, expect, vi } from 'vitest';
import { MigratingStorageAdapter } from '../MigratingStorageAdapter.js';
import type { StorageService } from '../StorageService.js';

vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

/** An in-memory provider with a public base, enough of StorageService for the adapter's logic. */
function fake(name: string, base: string, initial: Record<string, string> = {}): StorageService & { objects: Map<string, Buffer>; log: string[] } {
  const objects = new Map<string, Buffer>(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v) as Buffer]));
  const log: string[] = [];
  const svc = {
    objects, log,
    uploadFile: async (key: string, data: Buffer) => { log.push(`put ${key}`); objects.set(key, data); return `${base}/${key}`; },
    uploadStream: async (key: string) => { log.push(`stream ${key}`); return `${base}/${key}`; },
    getPresignedDownloadUrl: async (key: string) => `${base}/signed/${key}`,
    getPresignedUploadUrl: async (key: string) => `${base}/upload/${key}`,
    createMultipartUpload: async (key: string) => { log.push(`mp ${key}`); return 'u1'; },
    getPresignedUploadPartUrl: async () => 'part',
    completeMultipartUpload: async (key: string) => `${base}/${key}`,
    abortMultipartUpload: async () => {},
    listMultipartUploads: async () => [],
    deleteFile: async (key: string) => { log.push(`del ${key}`); objects.delete(key); },
    deleteWithPrefix: async (prefix: string) => { log.push(`delprefix ${prefix}`); for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k); },
    copyObject: async (src: string, dest: string) => { log.push(`copy ${src}→${dest}`); const b = objects.get(src); if (!b) throw new Error(`${name}: no ${src}`); objects.set(dest, b); },
    copyPrefix: async (src: string, dest: string) => { let n = 0; for (const [k, v] of [...objects]) if (k.startsWith(src)) { objects.set(dest + k.slice(src.length), v); n++; } return n; },
    getPublicUrl: (key: string) => `${base}/${key}`,
    getSimPublicUrl: (key: string) => `${base}/${key}`,
    keyFromPublicUrl: (url: string | null | undefined) => (url && url.startsWith(`${base}/`) ? url.slice(base.length + 1) : null),
    readObject: async (key: string) => { const b = objects.get(key); if (!b) throw new Error(`${name}: no ${key}`); return b; },
    listObjects: async (prefix: string) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
    objectExists: async (key: string) => objects.has(key),
    headObject: async (key: string) => (objects.has(key) ? { contentType: 'text/plain', cacheControl: null, size: objects.get(key)!.length, etag: '"x"', lastModified: null } : null),
  };
  return svc as unknown as StorageService & { objects: Map<string, Buffer>; log: string[] };
}

function pair() {
  const r2 = fake('r2', 'https://media.example.com', { 'hls/v1/new.m3u8': 'new' });
  const supabase = fake('supabase', 'https://ref.supabase.co/storage/v1/object/public/media', { 'videos/p1/old.mp4': 'old', 'sims/s1/index.html': 'sim' });
  return { r2, supabase, m: new MigratingStorageAdapter(r2, supabase, { primary: 'r2', secondary: 'supabase' }) };
}

describe('MigratingStorageAdapter', () => {
  it('writes only to the primary', async () => {
    const { r2, supabase, m } = pair();
    expect(await m.uploadFile('images/x.png', Buffer.from('x'), 'image/png')).toBe('https://media.example.com/images/x.png');
    expect(r2.objects.has('images/x.png')).toBe(true);
    expect(supabase.objects.has('images/x.png')).toBe(false);
  });

  it('reads from the primary, and from the secondary when the primary has not got it yet', async () => {
    const { m } = pair();
    expect((await m.readObject('hls/v1/new.m3u8')).toString()).toBe('new');
    expect((await m.readObject('videos/p1/old.mp4')).toString()).toBe('old');
    await expect(m.readObject('nowhere')).rejects.toThrow(/r2: no nowhere/);
    expect(await m.objectExists('videos/p1/old.mp4')).toBe(true);
    expect((await m.headObject('videos/p1/old.mp4'))?.size).toBe(3);
    expect((await m.listObjects('')).sort()).toEqual(['hls/v1/new.m3u8', 'sims/s1/index.html', 'videos/p1/old.mp4']);
  });

  it('a presigned GET points where the bytes are', async () => {
    const { m } = pair();
    expect(await m.getPresignedDownloadUrl('videos/p1/old.mp4', 60)).toContain('supabase.co');
    expect(await m.getPresignedDownloadUrl('hls/v1/new.m3u8', 60)).toContain('media.example.com');
  });

  it('deletes on both, and a failing secondary delete does not fail the delete', async () => {
    const { r2, supabase, m } = pair();
    await m.uploadFile('videos/p1/old.mp4', Buffer.from('new copy'), 'video/mp4');
    await m.deleteFile('videos/p1/old.mp4');
    expect(r2.objects.has('videos/p1/old.mp4')).toBe(false);
    expect(supabase.objects.has('videos/p1/old.mp4')).toBe(false);
    supabase.deleteWithPrefix = async () => { throw new Error('secondary down'); };
    await expect(m.deleteWithPrefix('sims/')).resolves.toBeUndefined();
    expect(r2.log).toContain('delprefix sims/');
  });

  it('a copy whose source lives only on the secondary is pulled through to the primary first', async () => {
    const { r2, supabase, m } = pair();
    await m.copyObject('sims/s1/index.html', 'sims/s2/index.html');
    expect(r2.objects.get('sims/s1/index.html')?.toString()).toBe('sim');
    expect(r2.objects.get('sims/s2/index.html')?.toString()).toBe('sim');
    expect(r2.log).toEqual(['put sims/s1/index.html', 'copy sims/s1/index.html→sims/s2/index.html']);
    expect(supabase.log).toEqual([]);
  });

  it('URLs are the primary’s; the inverse understands both vendors’ shapes', () => {
    const { m } = pair();
    expect(m.getPublicUrl('hls/v1/a.m3u8')).toBe('https://media.example.com/hls/v1/a.m3u8');
    expect(m.keyFromPublicUrl('https://media.example.com/images/a.png')).toBe('images/a.png');
    expect(m.keyFromPublicUrl('https://ref.supabase.co/storage/v1/object/public/media/images/a.png')).toBe('images/a.png');
    expect(m.keyFromPublicUrl('https://elsewhere.example/x')).toBeNull();
    expect(m.describe()).toBe('migrating: writes → r2, reads r2 then supabase, deletes → both');
  });
});
