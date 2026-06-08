import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the primary adapter selector and the local adapter so we can assert the
// fallback path without touching real storage.
const primaryUpload = vi.fn();
const localUpload = vi.fn();

vi.mock('../getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ uploadFile: primaryUpload }),
}));
vi.mock('../LocalStorageAdapter.js', () => ({
  LocalStorageAdapter: class { uploadFile = localUpload; },
}));

import { uploadWithFallback } from '../uploadWithFallback.js';

beforeEach(() => { primaryUpload.mockReset(); localUpload.mockReset(); });

describe('uploadWithFallback', () => {
  it('uses the primary adapter when it succeeds (no fallback)', async () => {
    primaryUpload.mockResolvedValue('https://r2/public/key.mp3');
    const url = await uploadWithFallback('key.mp3', Buffer.from('x'), 'audio/mpeg');
    expect(url).toBe('https://r2/public/key.mp3');
    expect(localUpload).not.toHaveBeenCalled();
  });

  it('falls back to local storage when the primary write is denied', async () => {
    primaryUpload.mockRejectedValue(new Error('Access Denied'));
    localUpload.mockResolvedValue('http://localhost:8080/local-storage/key.mp3');
    const url = await uploadWithFallback('key.mp3', Buffer.from('x'), 'audio/mpeg');
    expect(url).toBe('http://localhost:8080/local-storage/key.mp3');
    expect(primaryUpload).toHaveBeenCalledOnce();
    expect(localUpload).toHaveBeenCalledWith('key.mp3', expect.any(Buffer), 'audio/mpeg');
  });

  it('propagates the error if even local storage fails', async () => {
    primaryUpload.mockRejectedValue(new Error('Access Denied'));
    localUpload.mockRejectedValue(new Error('disk full'));
    await expect(uploadWithFallback('k', Buffer.from('x'), 'image/png')).rejects.toThrow('disk full');
  });
});
