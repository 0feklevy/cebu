/**
 * Safety predicates for fixture seeders, in their own module so they are importable by unit tests.
 *
 * The synthetic sim-pool seeder writes package bytes, HLS media and posters through the configured
 * storage adapter. Its whole authorization rests on that adapter being LOCAL DISK: pointed at a
 * cloud bucket it would write synthetic fixtures into shared storage. The seeder script itself
 * runs `main()` at import time, so a test cannot import IT to prove the refusal exists — the
 * refusal lives here instead, where deleting or weakening it is caught by a unit test rather than
 * by someone noticing objects in a bucket.
 */
import { LocalStorageAdapter } from '../services/storage/LocalStorageAdapter.js';

export function assertLocalStorageOnly(storage: unknown): asserts storage is LocalStorageAdapter {
  if (!(storage instanceof LocalStorageAdapter)) {
    throw new Error('refusing to run: STORAGE_BACKEND must resolve to the LOCAL disk adapter — '
      + 'this fixture must never write into a cloud bucket');
  }
}
