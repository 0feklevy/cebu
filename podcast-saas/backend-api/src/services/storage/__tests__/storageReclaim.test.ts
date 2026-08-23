/**
 * The reclaimers that run OUTSIDE a delete route: the superseded-thumbnail GC that four writers
 * now call, and the sweep that finally gives RevisionService.gc() a production caller.
 *
 * The mutation each test must kill is named inline — every one of these is a place where a
 * guard could go decorative without behavioural coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteWithFallback: vi.fn(async () => {}),
  simsSelect: vi.fn(async () => [] as Array<{ id: string; storage_prefix: string | null }>),
  gc: vi.fn(async () => ({ deleted: [] as string[] })),
}));

vi.mock('../deleteWithFallback.js', () => ({
  deleteWithFallback: mocks.deleteWithFallback,
  deleteWithPrefixFallback: vi.fn(async () => {}),
}));

import { deleteSupersededThumbnail } from '../deleteSupersededThumbnail.js';
import { callArgs } from '../../../__tests__/helpers/mockCalls.js';

beforeEach(() => {
  mocks.deleteWithFallback.mockClear();
  mocks.simsSelect.mockClear();
  mocks.gc.mockClear();
});

describe('deleteSupersededThumbnail', () => {
  it('deletes a genuinely superseded thumbnail key', async () => {
    await deleteSupersededThumbnail('thumbnails/p1/old.jpg', 'thumbnails/p1/new.jpg');
    expect(mocks.deleteWithFallback).toHaveBeenCalledWith('thumbnails/p1/old.jpg');
  });

  it('is a no-op for null, unchanged, and — load-bearing — NON-thumbnail keys', async () => {
    // The prefix guard is what makes a mis-wired caller a no-op instead of a data loss:
    // handing this a raw-video key must delete nothing. Killing `startsWith('thumbnails/')`
    // makes exactly this case fail.
    await deleteSupersededThumbnail(null, 'thumbnails/p1/new.jpg');
    await deleteSupersededThumbnail('thumbnails/p1/same.jpg', 'thumbnails/p1/same.jpg');
    await deleteSupersededThumbnail('videos/p1/source.mp4', 'thumbnails/p1/new.jpg');
    expect(mocks.deleteWithFallback).not.toHaveBeenCalled();
  });
});

describe('sweepRevisionGc', () => {
  async function load() {
    vi.doMock('../../../db/index.js', () => ({
      db: { select: () => ({ from: () => ({ where: mocks.simsSelect }) }) },
    }));
    vi.doMock('../../simulation/RevisionService.js', async (orig) => {
      const real = await orig<Record<string, unknown>>();
      return { ...real, RevisionService: class { gc = mocks.gc; } };
    });
    return import('../../simulation/revisionGcSweep.js');
  }

  it('calls gc once per simulation with the keep-floor, and sums the deletions', async () => {
    mocks.simsSelect.mockResolvedValueOnce([
      { id: 'sim-1', storage_prefix: 'simulations/p1/sim-1' },
      { id: 'sim-2', storage_prefix: 'simulations/p1/sim-2' },
    ]);
    mocks.gc
      .mockResolvedValueOnce({ deleted: ['r1', 'r2'] })
      .mockResolvedValueOnce({ deleted: ['r3'] });

    const { sweepRevisionGc } = await load();
    const res = await sweepRevisionGc();

    expect(mocks.gc).toHaveBeenCalledTimes(2);
    // keepLastN must be the exported floor, not a literal someone can quietly lower to 1 —
    // keep-1 collects every retired revision and makes rollback permanently impossible.
    const { GC_MIN_KEEP } = await import('../../simulation/RevisionService.js');
    for (const arg of callArgs<{ keepLastN: number }>(mocks.gc)) {
      expect(arg.keepLastN).toBe(GC_MIN_KEEP);
    }
    expect(res).toEqual({ simulations: 2, deleted: 3 });
  });

  it("one simulation's failure does not starve the rest", async () => {
    mocks.simsSelect.mockResolvedValueOnce([
      { id: 'sim-bad', storage_prefix: 'simulations/p1/bad' },
      { id: 'sim-good', storage_prefix: 'simulations/p1/good' },
    ]);
    mocks.gc
      .mockRejectedValueOnce(new Error('storage listing failed'))
      .mockResolvedValueOnce({ deleted: ['r9'] });

    const { sweepRevisionGc } = await load();
    const res = await sweepRevisionGc();
    expect(mocks.gc).toHaveBeenCalledTimes(2);   // the second sim still ran
    expect(res.deleted).toBe(1);
  });
});
