/**
 * The delete chokepoint refuses shared-blob keys.
 *
 * Every deleter in the codebase — images, audio, video, avatars, playlists, ones not written yet —
 * goes through deleteWithFallback. Once keys can be SHARED (migration 078), any one of those call
 * sites passing a blob key would destroy bytes other projects are serving. The guard lives at the
 * chokepoint precisely so that no caller has to remember, because "every caller remembers" is the
 * pattern that produced this repo's writer/deleter asymmetry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const adapter = { deleteFile: vi.fn(async () => {}), deleteWithPrefix: vi.fn(async () => {}) };
vi.mock('../getStorageAdapter.js', () => ({ getStorageAdapter: () => adapter }));
vi.mock('../R2StorageAdapter.js', () => ({ R2StorageAdapter: class {} }));
vi.mock('../LocalStorageAdapter.js', () => ({ LocalStorageAdapter: class { async deleteFile() {} async deleteWithPrefix() {} } }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { deleteWithFallback, deleteWithPrefixFallback } from '../deleteWithFallback.js';

beforeEach(() => {
  adapter.deleteFile.mockClear();
  adapter.deleteWithPrefix.mockClear();
});

describe('single-key deletes', () => {
  it('REFUSES a blobs/ key — shared bytes are the sweeper\'s, not any caller\'s', async () => {
    await deleteWithFallback('blobs/ab/cd/abcdef.mp4');
    expect(adapter.deleteFile).not.toHaveBeenCalled();
  });

  it('still deletes ordinary per-project keys exactly as before', async () => {
    // The guard must not turn into a general delete outage: everything outside blobs/ behaves
    // identically to the pre-078 world.
    await deleteWithFallback('images/p1/pic.png');
    expect(adapter.deleteFile).toHaveBeenCalledWith('images/p1/pic.png');
  });

  it('is not fooled by a key that merely CONTAINS the word', async () => {
    await deleteWithFallback('images/p1/blobs/x.png');
    expect(adapter.deleteFile).toHaveBeenCalledTimes(1);
  });
});

describe('prefix deletes', () => {
  it('refuses a prefix inside the blob namespace — that is a mass delete of shared bytes', async () => {
    await deleteWithPrefixFallback('blobs/ab');
    expect(adapter.deleteWithPrefix).not.toHaveBeenCalled();
  });

  it('lets a per-project prefix through untouched', async () => {
    await deleteWithPrefixFallback('simulations/p1/s1');
    expect(adapter.deleteWithPrefix).toHaveBeenCalledWith('simulations/p1/s1');
  });
});
