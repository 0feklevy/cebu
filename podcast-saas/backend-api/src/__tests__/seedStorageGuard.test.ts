/**
 * The synthetic seeder's storage refusal.
 *
 * seed-sim-pool-synthetic.ts writes fixture bytes through whatever adapter STORAGE_BACKEND
 * resolves to; `assertLocalStorageOnly` is the only thing standing between "loopback fixture" and
 * "synthetic rows written into a shared cloud bucket". The seeder runs main() at import time, so
 * this is tested through the shared seedGuards module the seeder actually calls.
 *
 * `Object.create(LocalStorageAdapter.prototype)` satisfies `instanceof` without running the
 * constructor, which logs and probes the environment — the test pins the CLASS check, not the
 * constructor's side effects.
 */
import { describe, it, expect } from 'vitest';
import { assertLocalStorageOnly } from '../scripts/seedGuards.js';
import { LocalStorageAdapter } from '../services/storage/LocalStorageAdapter.js';

describe('assertLocalStorageOnly', () => {
  it('accepts the local-disk adapter', () => {
    const local = Object.create(LocalStorageAdapter.prototype) as unknown;
    expect(() => assertLocalStorageOnly(local)).not.toThrow();
  });

  it('REFUSES any non-local adapter rather than writing fixtures into a shared bucket', () => {
    const s3ish = {
      uploadFile: async () => undefined,
      getSimPublicUrl: (k: string) => `https://bucket.example.com/${k}`,
    };
    expect(() => assertLocalStorageOnly(s3ish)).toThrow(/LOCAL disk adapter/);
    expect(() => assertLocalStorageOnly(undefined)).toThrow(/LOCAL disk adapter/);
    expect(() => assertLocalStorageOnly(null)).toThrow(/LOCAL disk adapter/);
  });
});
