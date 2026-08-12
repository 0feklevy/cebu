/**
 * What "under a prefix" means — ONE definition, shared by every adapter's `copyPrefix`.
 *
 * The three adapters have genuinely different native units. The cloud adapters list by raw string
 * prefix, so `Prefix: 'hls/abc'` also returns `hls/abcdef/seg.ts`. The local adapter walks a
 * DIRECTORY, so the same call returns nothing from `hls/abcdef/`. Left alone, a duplication would
 * copy a different set of bytes depending on which storage backend it ran against — and the
 * difference would only show up as a project that plays in dev and 404s in production.
 *
 * So both are narrowed to the directory-ish reading: a key is under `p` when it IS `p` or begins
 * with `p + '/'`. That is what every caller already means (`hls/{videoFileId}`,
 * `simulations/{projectId}/{simulationId}`), and it is the only reading that is safe when the ids
 * involved are not fixed-length.
 */

/** Trailing slashes are not part of a prefix's identity. */
export function normalizePrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '');
}

/** Is `key` the prefix itself, or inside it? */
export function isUnderPrefix(key: string, prefix: string): boolean {
  const base = normalizePrefix(prefix);
  if (base === '') return true;
  return key === base || key.startsWith(`${base}/`);
}

/**
 * The destination key for `key` when `srcPrefix` is re-rooted at `destPrefix`, or null when the
 * key is not under `srcPrefix` at all.
 *
 * Returning null rather than throwing lets a lister over-return (which the cloud adapters do) and
 * the copier simply skip what it should not have been handed.
 */
export function reroot(key: string, srcPrefix: string, destPrefix: string): string | null {
  const from = normalizePrefix(srcPrefix);
  const to = normalizePrefix(destPrefix);
  if (!isUnderPrefix(key, from)) return null;
  if (from === '') return to === '' ? key : `${to}/${key}`;
  const rest = key.slice(from.length); // '' for the prefix itself, '/…' otherwise
  return `${to}${rest}`;
}
