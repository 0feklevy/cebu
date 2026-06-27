import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// uploadWithFallback is now CLOUD-ONLY: the bytes must land in the shared object store
// (this is a multi-user, horizontally-scalable app — nothing may be written to
// per-instance local disk). The "fallback" is retry-then-throw, NOT local disk.
//
// We mock the storage-adapter selector so we can drive the cloud uploadFile, and we mock
// the local adapter purely to ASSERT it is never constructed/called.
const cloudUpload = vi.fn();
const localUpload = vi.fn();
const localCtor = vi.fn();

vi.mock('../getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ uploadFile: cloudUpload }),
}));
vi.mock('../LocalStorageAdapter.js', () => ({
  LocalStorageAdapter: class {
    constructor() { localCtor(); }
    uploadFile = localUpload;
  },
}));

import { uploadWithFallback } from '../uploadWithFallback.js';

beforeEach(() => {
  cloudUpload.mockReset();
  localUpload.mockReset();
  localCtor.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('uploadWithFallback (cloud-only)', () => {
  it('returns the cloud URL on success — never touches local disk', async () => {
    cloudUpload.mockResolvedValue('https://cdn.example/media/key.mp3');
    const url = await uploadWithFallback('key.mp3', Buffer.from('x'), 'audio/mpeg');
    expect(url).toBe('https://cdn.example/media/key.mp3');
    expect(cloudUpload).toHaveBeenCalledTimes(1);
    expect(cloudUpload).toHaveBeenCalledWith('key.mp3', expect.any(Buffer), 'audio/mpeg');
    expect(localCtor).not.toHaveBeenCalled();
    expect(localUpload).not.toHaveBeenCalled();
  });

  it('retries a transient failure and then succeeds (still cloud, no local fallback)', async () => {
    vi.useFakeTimers();
    cloudUpload
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce('https://cdn.example/media/key.mp3');

    const promise = uploadWithFallback('key.mp3', Buffer.from('x'), 'audio/mpeg');
    // Advance past the backoff delay between attempt 1 and attempt 2.
    await vi.runAllTimersAsync();
    const url = await promise;

    expect(url).toBe('https://cdn.example/media/key.mp3');
    expect(cloudUpload).toHaveBeenCalledTimes(2);
    expect(localCtor).not.toHaveBeenCalled();
    expect(localUpload).not.toHaveBeenCalled();
  });

  it('throws after exhausting retries — does NOT fall back to local disk', async () => {
    vi.useFakeTimers();
    cloudUpload.mockRejectedValue(new Error('Access Denied'));

    const promise = uploadWithFallback('key.mp3', Buffer.from('x'), 'audio/mpeg');
    // Attach the rejection assertion BEFORE draining timers so the promise isn't unhandled.
    const expectation = expect(promise).rejects.toThrow('Access Denied');
    await vi.runAllTimersAsync();
    await expectation;

    // 3 attempts total (initial + 2 retries), then it throws — never local.
    expect(cloudUpload).toHaveBeenCalledTimes(3);
    expect(localCtor).not.toHaveBeenCalled();
    expect(localUpload).not.toHaveBeenCalled();
  });
});
