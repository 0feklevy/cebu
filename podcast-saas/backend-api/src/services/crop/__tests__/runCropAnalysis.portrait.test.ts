/**
 * A PORTRAIT source is never cropped (night run 2026-09-03 §3).
 *
 * The crop track is a landscape→9:16 reframing; on a portrait source every keyframe degenerates to
 * x = 0.5 and the viewer's `object-fit: cover` would then cut the top and bottom off. Two guards,
 * each tested here: the project-wide enqueue skips portrait rows, and the runner itself refuses
 * before claiming, downloading or spawning anything — and clears a stale 'ready' so the player
 * config stops emitting a crop_url for it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
  enqueueJob: vi.fn(),
  processVideoCrop: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: { video_files: { findFirst: h.findFirst, findMany: h.findMany } },
    update: () => ({ set: (v: unknown) => { h.set(v); return { where: (w: unknown) => { h.where(w); return { returning: h.returning }; } }; } }),
  },
  video_files: { id: 'id', project_id: 'project_id', crop_status: 'crop_status', crop_updated_at: 'crop_updated_at' },
}));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: h.enqueueJob }));
vi.mock('../cropProcessor.js', () => ({ processVideoCrop: h.processVideoCrop }));
vi.mock('../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ getPresignedDownloadUrl: h.getPresignedDownloadUrl, uploadFile: vi.fn() }),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ t: 'eq' })), and: vi.fn(() => ({ t: 'and' })), or: vi.fn(() => ({ t: 'or' })),
  isNull: vi.fn(() => ({ t: 'isNull' })), ne: vi.fn(() => ({ t: 'ne' })), lt: vi.fn(() => ({ t: 'lt' })),
}));

import { enqueueCropForProject, runCropAnalysis } from '../runCropAnalysis.js';

const base = {
  id: 'vid-1', project_id: 'proj-1', storage_key: 'videos/proj-1/a.mp4', is_broll: false,
  file_size: 1000, duration_sec: 60, crop_status: 'none', crop_source_hash: null, crop_updated_at: null,
};

beforeEach(() => {
  h.findFirst.mockReset(); h.findMany.mockReset(); h.set.mockReset(); h.where.mockReset();
  h.returning.mockReset(); h.enqueueJob.mockReset(); h.processVideoCrop.mockReset(); h.getPresignedDownloadUrl.mockReset();
  h.returning.mockResolvedValue([{ id: 'vid-1' }]);
});

describe('enqueueCropForProject', () => {
  it('enqueues landscape and unknown-geometry videos, never a portrait one', async () => {
    h.findMany.mockResolvedValue([
      { ...base, id: 'land', width: 1920, height: 1080 },
      { ...base, id: 'unknown', width: null, height: null },
      { ...base, id: 'port', width: 1080, height: 1920 },
      { ...base, id: 'broll', is_broll: true, width: 1920, height: 1080 },
    ]);
    await enqueueCropForProject('proj-1');
    expect(h.enqueueJob.mock.calls.map((c) => (c[1] as { videoFileId: string }).videoFileId)).toEqual(['land', 'unknown']);
  });
});

describe('runCropAnalysis on a portrait source', () => {
  it('refuses before claiming, downloading or analysing — and leaves a clean row alone', async () => {
    h.findFirst.mockResolvedValue({ ...base, width: 1080, height: 1920 });
    await runCropAnalysis('vid-1');
    expect(h.getPresignedDownloadUrl).not.toHaveBeenCalled();
    expect(h.processVideoCrop).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();      // status was already 'none': nothing to write
  });

  it('clears a stale ready crop on a source later learned to be portrait, so no crop_url is ever emitted', async () => {
    h.findFirst.mockResolvedValue({ ...base, width: 1080, height: 1920, crop_status: 'ready', crop_key: 'crop/vid-1.json', crop_source_hash: 'abc' });
    await runCropAnalysis('vid-1');
    expect(h.processVideoCrop).not.toHaveBeenCalled();
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.set.mock.calls[0]![0]).toMatchObject({ crop_status: 'none', crop_key: null, crop_source_hash: null });
  });

  it('a LANDSCAPE source still goes through the claim (the guard is not a blanket refusal)', async () => {
    h.findFirst.mockResolvedValue({ ...base, width: 1920, height: 1080 });
    h.getPresignedDownloadUrl.mockRejectedValue(new Error('stop here — the claim happened'));
    await runCropAnalysis('vid-1').catch(() => {});
    // The first write is the 'processing' claim.
    expect(h.set.mock.calls[0]![0]).toMatchObject({ crop_status: 'processing' });
  });
});
