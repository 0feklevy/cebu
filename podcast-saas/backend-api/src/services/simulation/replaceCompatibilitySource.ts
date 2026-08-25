/**
 * WHICH BYTES THE REPLACE-COMPATIBILITY GATE IS ALLOWED TO READ (audit simulation-003).
 *
 * THE DEFECT
 * The gate asks one question: "if this upload replaced the package, would the bridge that is being
 * SERVED still work?" It answered it by reading `<prefix>/bridge.js` and deriving the entry path
 * from `simulations.entry_file` — both of which describe the LEGACY mutable prefix. For a
 * revisioned simulation the served bridge is `<prefix>/revisions/<active>/package/bridge.js`, and
 * those two copies drift apart the moment anything republishes: the legacy one is whatever was last
 * written before the package moved to revisions, the active one is what the player loads. So the
 * check read a stale artifact and confidently answered a question about a different package.
 *
 * This is a DIFFERENT bug from the dead-guidance finding (simulation-002), which the original audit
 * merged into it. Refusing new replaces stops the divergence growing; it does not repair a package
 * whose two copies have ALREADY diverged, and it does not make a stale read correct — a preflight
 * that reports on bytes nobody serves is wrong whether or not a write follows it.
 *
 * FAILING TO READ IS NOT AN ANSWER
 * The legacy path treats "no bridge.js" as "nothing to preserve ⇒ compatible", which is right: a
 * package with no generated bridge really has no contract to break. That reasoning does NOT
 * transfer to a revisioned package, where a missing manifest or an unreadable bridge means the
 * check could not see the contract it was asked about. Returning the permissive verdict there
 * would make an I/O failure look like a clean bill of health, so this module refuses instead.
 */

import type { StorageService } from '../storage/StorageService.js';
import { PACKAGE_SUBDIR, revisionFileKey, revisionManifestKey } from 'shared/sim/simRevision';
import type { SimManifest as SimPackageManifest } from 'shared/sim/simManifest';
import { deriveEntryRelPath } from './SimulationService.js';

// The gate READS what a derivation WRITES, so both speak one vocabulary for where a customer file
// lives inside a revision, and one error type for "the package being served cannot be read".
export { bundleRelPathForManifestPath } from './revisionPackagePaths.js';
export { ActiveRevisionUnreadable } from './RevisionDerivation.js';
import { bundleRelPathForManifestPath } from './revisionPackagePaths.js';
import { ActiveRevisionUnreadable } from './RevisionDerivation.js';

export interface ReplaceCompatibilitySource {
  /** Where the bytes came from — `revision` whenever the simulation has an active revision. */
  origin: 'legacy' | 'revision';
  /** The bridge that is ACTUALLY SERVED. `''` only for a legacy package that has none. */
  bridgeJs: string;
  /** The key `bridgeJs` was read from; null when a legacy package has no bridge at all. */
  bridgeKey: string | null;
  /** Bundle-relative path of the entry document — what the replacement upload must contain. */
  entryRelPath: string | null;
  /** The revision the bytes describe, when `origin === 'revision'`. */
  revisionId: string | null;
  /**
   * The revision's files — bundle-relative path plus the FULL storage key, straight from the
   * manifest — so a consumer that needs the package's sources (the saved-bridge fit check) reads
   * the same tree this module vouches for, without rebuilding key grammar. Null for a legacy
   * package: it has no manifest, and a consumer that needs the tree treats "cannot enumerate" as
   * "cannot verify", which every judge downstream already resolves conservatively.
   */
  files: { rel: string; key: string; role: string }[] | null;
}

/**
 * Where the generated bridge lives inside a revision.
 *
 * `package/bridge.js` first, because that is where publication puts it and where the entry
 * document's relative `<script src="bridge.js">` resolves. The manifest is consulted after, so a
 * package that nests its entry deeper is still found rather than reported as bridge-less.
 */
export function bridgeManifestPath(manifest: SimPackageManifest): string | null {
  const canonical = `${PACKAGE_SUBDIR}/bridge.js`;
  const runtime = manifest.runtime ?? [];
  if (runtime.includes(canonical)) return canonical;
  const declared = runtime.find((p) => /(?:^|\/)bridge\.js$/.test(p));
  if (declared) return declared;
  const fromFiles = (manifest.files ?? [])
    .find((f) => f.role === 'runtime' && /(?:^|\/)bridge\.js$/.test(f.path));
  return fromFiles?.path ?? null;
}

async function readText(storage: Pick<StorageService, 'readObject'>, key: string): Promise<string> {
  return (await storage.readObject(key)).toString('utf-8');
}

/**
 * Read the bridge and entry path the compatibility gate must judge an upload against.
 *
 * Reads only. Throws `ActiveRevisionUnreadable` when a revisioned package cannot be resolved —
 * never a default verdict.
 */
export async function readReplaceCompatibilitySource(
  storage: Pick<StorageService, 'readObject'>,
  sim: {
    storage_prefix: string;
    entry_file: string | null;
    active_revision_id?: string | null;
  },
): Promise<ReplaceCompatibilitySource> {
  const revisionId = sim.active_revision_id ?? null;

  if (!revisionId) {
    const bridgeKey = `${sim.storage_prefix}/bridge.js`;
    // No bridge generated yet ⇒ nothing to preserve ⇒ always compatible. True of a legacy package
    // and ONLY of a legacy package — see the module header.
    const bridgeJs = await readText(storage, bridgeKey).catch(() => '');
    return {
      origin: 'legacy',
      bridgeJs,
      bridgeKey: bridgeJs ? bridgeKey : null,
      entryRelPath: deriveEntryRelPath(sim.entry_file, sim.storage_prefix),
      revisionId: null,
      files: null,
    };
  }

  const manifestKey = revisionManifestKey(sim.storage_prefix, revisionId);
  let manifest: SimPackageManifest;
  try {
    manifest = JSON.parse(await readText(storage, manifestKey)) as SimPackageManifest;
  } catch (err) {
    throw new ActiveRevisionUnreadable(revisionId, `manifest ${manifestKey}: ${(err as Error).message}`);
  }

  const entryRelPath = manifest.entry ? bundleRelPathForManifestPath(manifest.entry) : null;
  if (!entryRelPath) {
    throw new ActiveRevisionUnreadable(revisionId, 'the manifest names no entry document');
  }

  const bridgePath = bridgeManifestPath(manifest);
  // A revision genuinely CAN have no bridge — a package whose sections were never generated. That
  // is a real "nothing to preserve", read from the manifest rather than inferred from a failed GET.
  if (!bridgePath) {
    return { origin: 'revision', bridgeJs: '', bridgeKey: null, entryRelPath, revisionId, files: manifestBundleFiles(sim.storage_prefix, revisionId, manifest) };
  }

  const bridgeKey = revisionFileKey(sim.storage_prefix, revisionId, bridgePath);
  let bridgeJs: string;
  try {
    bridgeJs = await readText(storage, bridgeKey);
  } catch (err) {
    throw new ActiveRevisionUnreadable(revisionId, `bridge ${bridgeKey}: ${(err as Error).message}`);
  }

  return { origin: 'revision', bridgeJs, bridgeKey, entryRelPath, revisionId, files: manifestBundleFiles(sim.storage_prefix, revisionId, manifest) };
}

/** The manifest's package files as (bundle-relative, full-key) pairs. Posters and canary reports
 * are not sources and are skipped; the fit check must never scan a poster for a selector. */
function manifestBundleFiles(
  storagePrefix: string,
  revisionId: string,
  manifest: SimPackageManifest,
): { rel: string; key: string; role: string }[] {
  const out: { rel: string; key: string; role: string }[] = [];
  for (const f of manifest.files ?? []) {
    if (f.role === 'poster' || f.role === 'canary') continue;
    const rel = bundleRelPathForManifestPath(f.path);
    if (!rel) continue;
    out.push({ rel, key: revisionFileKey(storagePrefix, revisionId, f.path), role: f.role });
  }
  return out;
}
