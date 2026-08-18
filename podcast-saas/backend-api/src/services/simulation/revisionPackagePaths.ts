/**
 * WHERE A CUSTOMER FILE LIVES INSIDE A REVISION, AND WHAT IT IS CALLED OUTSIDE ONE.
 *
 * A revision nests the customer's own bundle under `package/` so a customer file named
 * `manifest.json`, or a customer directory named `runtime`, cannot shadow ours. An uploaded bundle
 * has no such nesting, and neither does the Files tab, the download ZIP or the entry-name rule —
 * all four speak the path the customer typed. Every place that crosses between the two
 * vocabularies has to translate, and translating in more than one place is how they drift.
 *
 * NESTING IS READ OFF THE BASE ENTRY, NEVER ASSUMED — WHERE IT MATTERS.
 * Revisions published before the `package/` nesting store the bundle path AS the manifest path, so
 * `isPackageNested` exists for the derivations that CARRY base paths forward untouched (publishing
 * guidance copies every file at the path it already has, and must place its `guidance.js` beside
 * them or the entry's relative tag resolves to nothing).
 *
 * A derivation that REBUILDS the package from an uploaded bundle — replace — does not preserve the
 * base layout, and deliberately: it re-derives every path, its own and the runtime it carries, from
 * bundle-relative names, so the result is always nested. That is uniform, so nothing moves relative
 * to anything else, and it is what keeps a customer file named `manifest.json` from composing the
 * same storage key as the revision's own manifest. See `SimulationService.replaceIntoRevision`.
 */

import { PACKAGE_SUBDIR } from 'shared/sim/simRevision';

const MARKER = `${PACKAGE_SUBDIR}/`;

/**
 * A manifest path → the path the CUSTOMER's own bundle uses for the same file.
 *
 * Returns null for a path that names nothing (empty, or `package/` with no file after it), so a
 * caller comparing against an uploaded bundle never matches on the empty string.
 */
export function bundleRelPathForManifestPath(manifestPath: string): string | null {
  const path = manifestPath.replace(/^\/+/, '').trim();
  if (!path) return null;
  if (path.startsWith(MARKER)) return path.slice(MARKER.length) || null;
  // A revision published before the `package/` nesting: the manifest path IS the bundle path.
  return path;
}

/**
 * Does this revision nest its customer bundle under `package/`?
 *
 * Decided from the ENTRY path because that is the one manifest path every revision has, and the
 * one whose location the whole layout is relative to.
 */
export function isPackageNested(entryManifestPath: string): boolean {
  return entryManifestPath.replace(/^\/+/, '').startsWith(MARKER);
}

/** A customer bundle path → the manifest path it takes inside a revision with this layout. */
export function manifestPathForBundleRel(rel: string, nested: boolean): string {
  const clean = rel.replace(/^\/+/, '');
  return nested ? `${MARKER}${clean}` : clean;
}

/**
 * The path a sibling of the entry document is reached by FROM the entry document.
 *
 * `bridge.js` and `guidance.js` sit at the package root; the entry may be nested inside the
 * package (`app/main.html`), so the tag it carries has to climb back out. Computed from the
 * entry's depth WITHIN the package, which is why it takes the bundle-relative entry path and not
 * the manifest one.
 */
export function packageRootRelPath(entryBundleRelPath: string, filename: string): string {
  const depth = entryBundleRelPath.split('/').length - 1;
  return (depth > 0 ? '../'.repeat(depth) : './') + filename;
}
