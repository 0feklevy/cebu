/**
 * The abandoned-multipart sweep: lists through the adapter, aborts only past the grace, only with
 * apply, and a failed abort is counted rather than fatal.
 */
import { describe, it, expect, vi } from 'vitest';
import { abandonedUploads, sweepAbandonedMultipartUploads, MULTIPART_ABORT_GRACE_MS } from '../multipartSweeper.js';
import type { MultipartUploadInfo } from '../StorageService.js';

vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../getStorageAdapter.js', () => ({ getStorageAdapter: () => { throw new Error('the test passes its own storage'); } }));

const NOW = Date.parse('2026-09-03T12:00:00Z');
const up = (key: string, initiated: string | null): MultipartUploadInfo => ({ key, uploadId: `id-${key}`, initiated });

const UPLOADS = [
  up('videos/p1/old.mp4', '2026-08-01T00:00:00.000Z'),     // 33 days
  up('videos/p1/fresh.mp4', '2026-09-03T11:00:00.000Z'),   // an hour
  up('videos/p1/unknown.mp4', null),                        // no date: never touched
];

describe('abandonedUploads', () => {
  it('keeps only uploads with a known start past the grace', () => {
    expect(abandonedUploads(UPLOADS, MULTIPART_ABORT_GRACE_MS, NOW).map((u) => u.key)).toEqual(['videos/p1/old.mp4']);
  });
});

describe('sweepAbandonedMultipartUploads', () => {
  const storage = () => ({
    listMultipartUploads: vi.fn(async () => UPLOADS),
    abortMultipartUpload: vi.fn(async (key: string) => { if (key.includes('old')) return; throw new Error('boom'); }),
  });

  it('a dry run lists and aborts nothing', async () => {
    const s = storage();
    const r = await sweepAbandonedMultipartUploads({ apply: false, now: NOW, storage: s });
    expect(r).toMatchObject({ listed: 3, aborted: 0, failed: 0, apply: false });
    expect(r.abandoned.map((u) => u.key)).toEqual(['videos/p1/old.mp4']);
    expect(s.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('apply aborts exactly the abandoned ones, with their upload ids', async () => {
    const s = storage();
    const r = await sweepAbandonedMultipartUploads({ apply: true, now: NOW, storage: s });
    expect(s.abortMultipartUpload).toHaveBeenCalledTimes(1);
    expect(s.abortMultipartUpload).toHaveBeenCalledWith('videos/p1/old.mp4', 'id-videos/p1/old.mp4');
    expect(r).toMatchObject({ aborted: 1, failed: 0 });
  });

  it('a failed abort is counted, and the pass finishes', async () => {
    const s = storage();
    s.listMultipartUploads.mockResolvedValue([up('videos/p1/a.mp4', '2026-01-01T00:00:00.000Z'), up('videos/p1/old.mp4', '2026-01-01T00:00:00.000Z')]);
    const r = await sweepAbandonedMultipartUploads({ apply: true, now: NOW, storage: s });
    expect(r).toMatchObject({ aborted: 1, failed: 1 });
  });

  it('a shorter grace is honoured', async () => {
    const s = storage();
    const r = await sweepAbandonedMultipartUploads({ apply: false, now: NOW, graceMs: 30 * 60 * 1000, storage: s });
    expect(r.abandoned.map((u) => u.key)).toEqual(['videos/p1/old.mp4', 'videos/p1/fresh.mp4']);
  });
});
