import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'path';
import { safeLocalPath, keyHasTraversal } from '../pathSafety.js';

const BASE = '/var/app/.local-storage';

describe('safeLocalPath', () => {
  it('allows legitimate keys under the base dir', () => {
    expect(safeLocalPath(BASE, 'hls/abc/index.m3u8')).toBe(resolve(BASE, 'hls/abc/index.m3u8'));
    expect(safeLocalPath(BASE, 'videos/v1.mp4')).toBe(resolve(BASE, 'videos/v1.mp4'));
    expect(safeLocalPath(BASE, 'images/a.png')).toBe(resolve(BASE, 'images/a.png'));
  });

  it('rejects `..` traversal that escapes the base dir', () => {
    expect(safeLocalPath(BASE, '../../../etc/passwd')).toBeNull();
    expect(safeLocalPath(BASE, 'hls/../../../../etc/passwd')).toBeNull();
    expect(safeLocalPath(BASE, 'videos/../../secret')).toBeNull();
  });

  it('rejects absolute paths', () => {
    expect(safeLocalPath(BASE, '/etc/passwd')).toBeNull();
  });

  it('allows internal `..` that stays within the base dir', () => {
    // hls/x/../y resolves to hls/y — still under base, so permitted.
    expect(safeLocalPath(BASE, 'hls/x/../y/seg.ts')).toBe(resolve(BASE, 'hls/y/seg.ts'));
  });

  it('does not treat a sibling dir with the same prefix as inside the base', () => {
    // resolve(BASE, '../.local-storage-evil/x') must not pass the base+sep guard.
    expect(safeLocalPath(BASE, '../.local-storage-evil/x')).toBeNull();
  });

  it('returns the base itself for an empty key', () => {
    expect(safeLocalPath(BASE, '')).toBe(resolve(BASE));
  });

  it('uses the platform separator boundary', () => {
    const p = safeLocalPath(BASE, 'a/b');
    expect(p).toBe(`${resolve(BASE)}${sep}a${sep}b`);
  });
});

describe('keyHasTraversal', () => {
  it('flags keys with a `..` segment', () => {
    expect(keyHasTraversal('hls/../../etc')).toBe(true);
    expect(keyHasTraversal('..')).toBe(true);
    expect(keyHasTraversal('videos/../x')).toBe(true);
  });

  it('passes clean keys', () => {
    expect(keyHasTraversal('hls/abc/index.m3u8')).toBe(false);
    expect(keyHasTraversal('videos/v1.mp4')).toBe(false);
    // a filename merely containing dots (not a `..` path segment) is fine
    expect(keyHasTraversal('hls/a..b/seg.ts')).toBe(false);
  });
});
