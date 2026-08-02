/**
 * Re-export shim. The implementation moved to `shared/src/sim/simUrl` so admin-web — which
 * renders stored sim URLs in the avatar gallery and cannot import from client-web — resolves them
 * through the SAME origin rebase. A client-local copy could never fix admin's blank frames.
 *
 * Kept as a shim rather than rewriting ~10 call sites: the import path is not the interesting part
 * of this change, and every existing test keeps pointing at a real module.
 */
export {
  resolveSimUrl,
  __resetDprSnapshotForTests,
  type SimBootParams,
} from 'shared/src/sim/simUrl';
