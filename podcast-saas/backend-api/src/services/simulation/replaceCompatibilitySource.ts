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

/** The active revision's package could not be read, so no compatibility verdict is possible. */
export class ActiveRevisionUnreadable extends Error {
  readonly code = 'SIM_ACTIVE_REVISION_UNREADABLE';
  constructor(readonly revisionId: string, readonly detail: string) {
    super(
      `The active package revision (${revisionId}) could not be read, so this upload cannot be ` +
      `checked against the bridge that is actually being served: ${detail}`,
    );
    this.name = 'ActiveRevisionUnreadable';
  }
}

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
}

/**
 * A manifest path → the path the CUSTOMER's own bundle uses for the same file.
 *
 * Customer bytes are nested under `package/` inside a revision (see `revisionPathForLegacy`) so a
 * customer file named `manifest.json` cannot shadow ours. The uploaded bundle has no such nesting,
 * so the two have to be translated rather than compared directly — otherwise every entry-name check
 * against a revisioned package fails on a prefix the user never typed.
 */
export function bundleRelPathForManifestPath(manifestPath: string): string | null {
  const path = manifestPath.replace(/^\/+/, '').trim();
  if (!path) return null;
  const marker = `${PACKAGE_SUBDIR}/`;
  if (path.startsWith(marker)) return path.slice(marker.length) || null;
  // A revision published before the `package/` nesting: the manifest path IS the bundle path.
  return path;
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
    return { origin: 'revision', bridgeJs: '', bridgeKey: null, entryRelPath, revisionId };
  }

  const bridgeKey = revisionFileKey(sim.storage_prefix, revisionId, bridgePath);
  let bridgeJs: string;
  try {
    bridgeJs = await readText(storage, bridgeKey);
  } catch (err) {
    throw new ActiveRevisionUnreadable(revisionId, `bridge ${bridgeKey}: ${(err as Error).message}`);
  }

  return { origin: 'revision', bridgeJs, bridgeKey, entryRelPath, revisionId };
}
