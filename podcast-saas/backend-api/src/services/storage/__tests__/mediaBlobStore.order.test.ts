/**
 * The two things only the ORCHESTRATION can get wrong.
 *
 * Every "are these the same file" branch is proved in contentIdentity.test.ts against pure
 * functions. What is left here is sequencing, and sequencing has exactly two failure modes:
 *
 *   1. A dedup hit that uploads anyway — the feature silently does nothing, and the only symptom
 *      is a bill that does not fall. No test of the decision logic can see this.
 *   2. A row inserted before its bytes exist — a second uploader then matches that row, skips its
 *      own upload, and points at an object that may never arrive. That project serves nothing,
 *      permanently, with no error raised anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const events: string[] = [];
const state = {
  candidate: null as Record<string, unknown> | null,
  head: null as { size: number | null } | null,
  /** The row the mocked insert will make visible — set per-test. */
  pending: null as Record<string, unknown> | null,
};

/** Minimal drizzle shape: enough for the two queries and the one insert this module makes. */
vi.mock('../../../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (state.candidate ? [state.candidate] : []) }) }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoNothing: async () => { events.push('insert-row'); state.candidate = state.pending; } }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    execute: async () => [{ n: 0 }],
  },
}));
vi.mock('../../../db/schema.js', () => ({
  media_blobs: { id: 'id', sha256: 'sha256', byte_size: 'byte_size', storage_key: 'storage_key' },
  video_files: { blob_id: 'blob_id' }, image_files: { blob_id: 'blob_id' }, audio_files: { blob_id: 'blob_id' },
}));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), sql: Object.assign(() => ({}), { raw: () => ({}) }) }));

import { claimBlob } from '../MediaBlobStore.js';

const SHA = createHash('sha256').update('hello').digest('hex');
const identity = { sha256: SHA, byteSize: 5 };
const adapter = { headObject: async () => state.head } as never;

beforeEach(() => {
  events.length = 0;
  state.candidate = null;
  state.head = null;
  state.pending = { id: 'b1', sha256: SHA, byte_size: 5, storage_key: 'k' };
});

describe('a dedup hit', () => {
  it('does NOT upload the bytes again', async () => {
    // The entire point of the feature. If this regresses, everything still WORKS and nothing is
    // saved — the failure is invisible except in the storage bill.
    state.candidate = { id: 'b1', sha256: SHA, byte_size: 5, storage_key: 'blobs/aa/bb/x' };
    state.head = { size: 5 };

    const upload = vi.fn(async () => { events.push('upload'); });
    const res = await claimBlob({ identity, adapter, upload });

    expect(upload).not.toHaveBeenCalled();
    expect(res.deduped).toBe(true);
    expect(res.blob.id).toBe('b1');
  });

  it('does not happen when the stored object is GONE, and re-uploads instead', async () => {
    state.candidate = { id: 'b1', sha256: SHA, byte_size: 5, storage_key: 'blobs/aa/bb/x' };
    state.head = null; // HEAD says it is not there

    const upload = vi.fn(async () => { events.push('upload'); });
    const res = await claimBlob({ identity, adapter, upload });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(res.deduped).toBe(false);
    expect(res.declinedBecause).toBe('bytes-missing');
  });

  it('does not happen when storage holds a different LENGTH than the row claims', async () => {
    state.candidate = { id: 'b1', sha256: SHA, byte_size: 5, storage_key: 'blobs/aa/bb/x' };
    state.head = { size: 4096 };

    const res = await claimBlob({ identity, adapter, upload: async () => {} });
    expect(res.declinedBecause).toBe('size-drift');
  });
});

describe('a fresh blob', () => {
  it('writes the BYTES BEFORE the row that claims them', async () => {
    // The asymmetry that decides the order: bytes-then-row can only ever leak an object nobody
    // references, which the sweeper collects. Row-then-bytes creates a window where another
    // uploader matches the row, skips its upload, and references an object that never arrives.
    await claimBlob({ identity, adapter, upload: async () => { events.push('upload'); } });
    expect(events).toEqual(['upload', 'insert-row']);
  });

  it('keys the object by its CONTENT, not by anything the caller chose', async () => {
    // A content-derived key is what makes the concurrent case safe: two uploaders racing the same
    // new file write the same key, so the second write is idempotent rather than a conflict.
    let seen = '';
    await claimBlob({ identity, adapter, ext: 'mp4', upload: async (k) => { seen = k; } });
    expect(seen).toBe(`blobs/${SHA.slice(0, 2)}/${SHA.slice(2, 4)}/${SHA}.mp4`);
  });

  it('refuses a malformed digest before touching storage at all', async () => {
    const upload = vi.fn();
    await expect(claimBlob({ identity: { sha256: 'nope', byteSize: 5 }, adapter, upload }))
      .rejects.toThrow(/64-character lowercase hex/);
    expect(upload).not.toHaveBeenCalled();
  });
});
