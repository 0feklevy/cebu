/**
 * THE PACKAGE A REVISIONED SIMULATION IS ACTUALLY SERVING, for the read paths (audit D-04).
 *
 * The Files tab, the download ZIP and the Minimal-UI control scan all answer "what is in this
 * simulation?" — and all three answered it from the mutable prefix. For a revisioned package that
 * is wrong in two directions at once:
 *
 *   - it SHOWS what nobody serves. `listObjects(storage_prefix)` returns every revision's every
 *     file plus captured posters, so the Files tab of a package with four revisions listed four
 *     copies of index.html under machine-generated directory names, and the ZIP shipped all of
 *     them; and
 *   - it HIDES what is served. The control scan read `<prefix>/<entry_file>`, the pre-revision
 *     copy, so the Minimal-UI picker offered controls from a document the player stopped loading
 *     however many publications ago — the same stale read that made the replace-compatibility
 *     gate answer a question about the wrong bytes (simulation-003).
 *
 * Both follow from asking storage instead of asking the manifest. The active revision's manifest
 * is the authoritative file list of the package that is live, so that is what this reads.
 *
 * ROLES ARE A FILTER, NOT DECORATION. `poster` and `canary` files live inside the revision and are
 * system-owned evidence, not package content: they were never in the customer's bundle and putting
 * them in the download ZIP would make a round-trip (download → edit → replace) grow the package
 * every time.
 *
 * LEGACY SIMULATIONS GET NULL and every caller keeps its existing storage-listing path. A
 * simulation with no `active_revision_id` really is served from its mutable prefix.
 */

import type { StorageService } from '../storage/StorageService.js';
import type { SimFileRole, SimManifest } from 'shared/sim/simManifest';
import { revisionFileKey } from 'shared/sim/simRevision';
import { readBasePackage } from './RevisionDerivation.js';
import { bundleRelPathForManifestPath } from './revisionPackagePaths.js';

/** One file of the live package, named both ways. */
export interface ActivePackageFile {
  /** Full storage key — what `file-content` proxies and what the public URL is built from. */
  key: string;
  /** The path the CUSTOMER knows: bundle-relative, without the `package/` nesting. */
  relPath: string;
  role: SimFileRole;
  contentType: string;
  bytes: number;
}

export interface ActivePackageView {
  revisionId: string;
  /** Full storage key of the live entry document. */
  entryKey: string;
  /** Bundle-relative path of the live entry document. */
  entryRelPath: string;
  manifest: SimManifest;
  /** Entry, runtime and asset files — never posters or canary evidence. */
  files: ActivePackageFile[];
}

/** Roles that are part of the package a customer uploaded, downloads, and replaces. */
const PACKAGE_ROLES: ReadonlySet<SimFileRole> = new Set<SimFileRole>(['entry', 'runtime', 'asset']);

/**
 * The live package of a revisioned simulation, or null when it has no revisions.
 *
 * Throws `ActiveRevisionUnreadable` (from `readBasePackage`) when the pointer names a revision
 * whose manifest cannot be read — never a partial or empty view. A read path that answered
 * "this simulation has no files" because a GET failed would be the same permissive-on-failure
 * mistake the compatibility gate was corrected for.
 */
export async function readActiveRevisionPackage(
  storage: Pick<StorageService, 'readObject'>,
  sim: { id: string; storage_prefix: string; active_revision_id?: string | null },
): Promise<ActivePackageView | null> {
  const revisionId = sim.active_revision_id ?? null;
  if (!revisionId) return null;

  const storagePrefix = sim.storage_prefix.replace(/\/+$/, '');
  const base = await readBasePackage(storage, {
    simulationId: sim.id, storagePrefix, revisionId,
  });

  const files: ActivePackageFile[] = [];
  for (const f of base.manifest.files ?? []) {
    if (!PACKAGE_ROLES.has(f.role)) continue;
    const relPath = bundleRelPathForManifestPath(f.path);
    if (!relPath) continue;
    files.push({
      key: revisionFileKey(storagePrefix, revisionId, f.path),
      relPath,
      role: f.role,
      contentType: f.contentType,
      bytes: f.bytes,
    });
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  return {
    revisionId,
    entryKey: revisionFileKey(storagePrefix, revisionId, base.entryManifestPath),
    entryRelPath: bundleRelPathForManifestPath(base.entryManifestPath) ?? base.entryManifestPath,
    manifest: base.manifest,
    files,
  };
}
