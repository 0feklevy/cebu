/**
 * ListMultipartUploads through both S3 adapters: paginated by the two markers, mapped to the
 * adapter-neutral shape, and the local adapter honestly answers "none".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import { R2StorageAdapter } from '../R2StorageAdapter.js';
import { SupabaseStorageAdapter } from '../SupabaseStorageAdapter.js';
import { LocalStorageAdapter } from '../LocalStorageAdapter.js';
import { listOpenMultipartUploads } from '../listMultipartUploads.js';
import { s3ClientsOf } from './fakeS3.js';

beforeAll(() => {
  process.env.R2_ACCOUNT_ID = 'acct';
  process.env.R2_ACCESS_KEY_ID = 'key-12345678901';
  process.env.R2_SECRET_ACCESS_KEY = 'secret-12345678901';
  process.env.R2_BUCKET = 'bucket';
  process.env.SUPABASE_URL = 'https://ref.supabase.co';
  process.env.SUPABASE_S3_ACCESS_KEY_ID = 'key-12345678901';
  process.env.SUPABASE_S3_SECRET_ACCESS_KEY = 'secret-12345678901';
  process.env.SUPABASE_S3_BUCKET = 'bucket';
});

/** Two pages, joined by the key + upload-id markers. */
function pagedSend(seen: unknown[]) {
  return async (cmd: ListMultipartUploadsCommand) => {
    seen.push(cmd.input);
    if (!cmd.input.KeyMarker) {
      return {
        Uploads: [{ Key: 'videos/p1/a.mp4', UploadId: 'u1', Initiated: new Date('2026-08-01T00:00:00Z') }],
        IsTruncated: true, NextKeyMarker: 'videos/p1/a.mp4', NextUploadIdMarker: 'u1',
      };
    }
    return { Uploads: [{ Key: 'videos/p1/b.mp4', UploadId: 'u2' }, { Key: undefined, UploadId: 'ghost' }], IsTruncated: false };
  };
}

describe('listOpenMultipartUploads', () => {
  it('walks every page with both markers and maps the shape; an entry without a key is skipped', async () => {
    const seen: Array<{ KeyMarker?: string; UploadIdMarker?: string; Prefix?: string }> = [];
    const out = await listOpenMultipartUploads(pagedSend(seen) as never, 'bucket', 'videos/');
    expect(out).toEqual([
      { key: 'videos/p1/a.mp4', uploadId: 'u1', initiated: '2026-08-01T00:00:00.000Z' },
      { key: 'videos/p1/b.mp4', uploadId: 'u2', initiated: null },
    ]);
    expect(seen.map((i) => [i.Prefix, i.KeyMarker, i.UploadIdMarker])).toEqual([['videos/', undefined, undefined], ['videos/', 'videos/p1/a.mp4', 'u1']]);
  });
});

describe('the adapters', () => {
  for (const [name, make] of [['R2', () => new R2StorageAdapter()], ['Supabase', () => new SupabaseStorageAdapter()]] as const) {
    it(`${name}: sends ListMultipartUploads on its client and returns the mapped list`, async () => {
      const adapter = make();
      const seen: unknown[] = [];
      for (const [, client] of s3ClientsOf(adapter)) {
        (client as { send: unknown }).send = pagedSend(seen);
      }
      const out = await adapter.listMultipartUploads('videos/');
      expect(out.map((u) => u.key)).toEqual(['videos/p1/a.mp4', 'videos/p1/b.mp4']);
      expect(seen).toHaveLength(2);
    });
  }

  it('local disk has no open multipart uploads', async () => {
    expect(await new LocalStorageAdapter().listMultipartUploads()).toEqual([]);
  });
});
