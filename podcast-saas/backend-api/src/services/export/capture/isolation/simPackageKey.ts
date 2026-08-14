/**
 * THE PACKAGE ROOT — the grammar that says where a simulation package begins.
 *
 * THE INCIDENT (v0.1.23, 11/11 sim windows). The capture provider anchored the "package" at the
 * ENTRY DOCUMENT'S DIRECTORY (`dirname(entryKey)`) and staged only that subtree. But a package's
 * generated runtime lives at the PACKAGE ROOT, and a nested entry references it upward:
 * `SimulationService` writes the tag as `'../'.repeat(depth) + 'bridge.js'` — so for the real
 * production package
 *
 *   simulations/<projectId>/<simulationId>/boids-3d/index.html   ← entry
 *   simulations/<projectId>/<simulationId>/bridge.js             ← the SIM_READY emitter
 *
 * staging captured `boids-3d/**` and dropped `bridge.js`. Inside `--network none` the loopback
 * served the entry at `/index.html`, `../bridge.js` resolved to `/bridge.js`, 404 — the bridge
 * never installed, SIM_READY never fired, and every section timed out at `bridge_ready`.
 *
 * The fix is not "also fetch bridge.js" — that would encode one more incomplete assumption and
 * still lose `guidance.js`, `guidance/*`, and any author asset referenced with `../`. The fix is
 * to name the package boundary correctly and stage the package WHOLE, layout preserved. Then every
 * relative reference resolves inside the container exactly as it does in the viewer, whatever the
 * package happens to contain.
 *
 * DERIVED FROM THE KEY, NOT FROM THE DATABASE. The parser is pure: it reads the storage key that
 * the export plan already froze into the window's `servedUrl`. That is deliberate — the plan is the
 * capture's identity, and consulting `simulations.active_revision_id` at capture time would make a
 * live pointer flip (a republish mid-export) able to move the bytes out from under a job that had
 * already resolved them. One authority, decided once, at plan time.
 *
 * The grammar is narrow and FAILS CLOSED. Anything it does not recognise is refused rather than
 * guessed at, because guessing the package boundary is what produced the incident above.
 */

/** The canonical simulation prefix depth: `simulations/<projectId>/<simulationId>`. */
const SIM_PREFIX_SEGMENTS = 3;
const REVISIONS_SEGMENT = 'revisions';
const PACKAGE_SUBDIR = 'package';

/**
 * Subtrees under a LEGACY prefix that belong to the system, not to the customer's live package:
 * immutable revisions and captured posters. Staging them would ship the package's entire
 * publication history (and every poster rendition) into the capture container. Mirrors
 * `shared/sim/simRevision.ts`'s `SYSTEM_OWNED_SEGMENTS` — kept as a local constant so this parser
 * stays dependency-free and usable from the container half.
 */
export const SYSTEM_OWNED_SEGMENTS: readonly string[] = [REVISIONS_SEGMENT, 'posters'];

export type SimPackageLayout = 'legacy' | 'revision';

export interface SimPackageKey {
  /** `legacy` = mutable prefix; `revision` = immutable `revisions/<id>/package`. */
  layout: SimPackageLayout;
  /** Storage key prefix the package root sits at — NO trailing slash. */
  packageRoot: string;
  /** Entry document path RELATIVE to `packageRoot`, nesting preserved (`boids-3d/index.html`). */
  entryPath: string;
  /** The full entry key, echoed back for logging/diagnostics. */
  entryKey: string;
}

/** A path segment that would escape or confuse the package root. */
function segmentIsUnsafe(segment: string): boolean {
  return segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0');
}

/**
 * Parse a simulation ENTRY storage key into its package root + package-relative entry path.
 *
 * Recognised grammar (everything else returns null — fail closed):
 *
 *   LEGACY    simulations/<projectId>/<simulationId>/<entry…>
 *             → root `simulations/<projectId>/<simulationId>`, entry `<entry…>`
 *
 *   REVISION  simulations/<projectId>/<simulationId>/revisions/<revisionId>/package/<entry…>
 *             → root `…/revisions/<revisionId>/package`,       entry `<entry…>`
 *
 * Both keep `<entry…>` intact, so a nested entry stays nested and `../bridge.js` resolves to the
 * package root — the property the whole fix exists to restore.
 */
export function parseSimPackageKey(entryKey: string): SimPackageKey | null {
  if (!entryKey || entryKey.startsWith('/') || entryKey.includes('\0') || entryKey.includes('\\')) return null;
  const segments = entryKey.split('/');
  if (segments.some(segmentIsUnsafe)) return null; // empty, '.', '..' — traversal refused
  if (segments[0] !== 'simulations') return null;
  if (segments.length <= SIM_PREFIX_SEGMENTS) return null; // no entry below the prefix

  const simPrefix = segments.slice(0, SIM_PREFIX_SEGMENTS).join('/');
  const rest = segments.slice(SIM_PREFIX_SEGMENTS);

  // REVISION: `revisions/<id>/package/<entry…>` — the id and `package/` must both be present, and
  // there must be at least one segment of entry below `package/`.
  if (rest[0] === REVISIONS_SEGMENT) {
    if (rest.length < 4) return null;            // revisions + id + package + ≥1 entry segment
    if (rest[2] !== PACKAGE_SUBDIR) return null; // anything else under a revision is not a package
    // The id must LOOK like a revision id (the same `[A-Za-z0-9_-]{8,64}` shape `isValidRevisionId`
    // enforces). Accepting any string would let a customer directory literally named `revisions/`
    // be read as an immutable revision and silently move the package boundary.
    const revisionId = rest[1];
    if (!revisionId || !/^[A-Za-z0-9_-]{8,64}$/.test(revisionId)) return null;
    const entryPath = rest.slice(3).join('/');
    if (!entryPath) return null;
    return {
      layout: 'revision',
      packageRoot: `${simPrefix}/${REVISIONS_SEGMENT}/${revisionId}/${PACKAGE_SUBDIR}`,
      entryPath,
      entryKey,
    };
  }

  // LEGACY: everything under the simulation prefix IS the package. An entry inside a system-owned
  // subtree is not a legacy entry (a `posters/…` key is not an entry document).
  if (SYSTEM_OWNED_SEGMENTS.includes(rest[0] as string)) return null;
  return {
    layout: 'legacy',
    packageRoot: simPrefix,
    entryPath: rest.join('/'),
    entryKey,
  };
}

/**
 * Is this package-relative path one the capture should stage?
 *
 * Only LEGACY roots need filtering: a legacy prefix is shared by the customer's live bytes AND the
 * system's `revisions/` + `posters/` subtrees, so staging the root verbatim would ship the entire
 * publication history into the container. A revision's `package/` root contains customer bytes
 * only, by construction (`manifest.json`, `posters/`, `canary/` are siblings ABOVE it).
 */
export function isStageablePackagePath(layout: SimPackageLayout, relPath: string): boolean {
  if (!relPath) return false;
  if (layout === 'revision') return true;
  const first = relPath.split('/')[0];
  return first !== undefined && !SYSTEM_OWNED_SEGMENTS.includes(first);
}
