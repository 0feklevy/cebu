/**
 * Inverting a public URL back into the storage key it was minted from.
 *
 * WHY THE ADAPTER HAS TO ANSWER THIS, AND NOT A SERVICE
 * Several columns store a full public URL with no shadow key column — `corpora.storage_url`,
 * `avatar_config.avatarCircles.faces[].imageUrl`, `simulations.guidance_meta.mdUrl`,
 * `simulations.guidance[].audioUrl`. Recovering the key from one of those was done by pattern
 * matching in the caller: strip `https://host/`, then strip one of a hard-coded list of dev route
 * prefixes. That answer is only correct for the adapters whose URL shape happens to be on the list.
 *
 * On Supabase it is WRONG in the most damaging possible way. Its public URLs are
 * `{origin}/storage/v1/object/public/{bucket}/{key}`, so the "recovered key" is
 * `storage/v1/object/public/{bucket}/{key}` — a string that still contains the project id, so a
 * duplication happily plans a copy of it, and then `CopyObject` fails with `NoSuchKey`, which is
 * neither "unsupported" nor "too large" and therefore fails the whole run with advice ("try again")
 * that can never work. Every project with a corpus file became permanently un-duplicatable.
 *
 * The only component that knows how a URL was built is the adapter that built it, so that is where
 * the inverse lives — one implementation per adapter, next to the forward direction, where the two
 * cannot drift apart.
 */

/**
 * The key `url` names, given the bases this adapter publishes under — or null.
 *
 * NO PERCENT-DECODING. The forward direction (`getPublicUrl` / `getSimPublicUrl`) interpolates the
 * key into the URL verbatim on every adapter, so decoding here would invent a key that was never
 * published. Same reasoning as `rebaseUrl`, which substitutes on the stored text rather than
 * re-deriving through the adapter.
 *
 * The scoped media token (`/hls-public/t/{token}/{key}`, `/hls-proxy/t/{token}/{key}`) sits in the
 * PATH so relative segment URLs inherit it, so it is stripped where it appears: between the route
 * base and the key. `t` is not a legal first key segment on any path this product mints.
 */
export function keyFromPublicUrlAgainst(url: string | null | undefined, bases: readonly string[]): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const clean = url.split('#')[0].split('?')[0];
  // LONGEST BASE FIRST. Several bases share an origin (`{o}/local-storage` and `{o}/sim-public`,
  // or a bare R2 public origin alongside a route under it); the shortest would otherwise swallow
  // the others and hand back a key that still carries a route prefix.
  const ordered = [...bases].map((b) => b.replace(/\/+$/, '')).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const base of ordered) {
    if (!clean.startsWith(`${base}/`)) continue;
    const rest = clean.slice(base.length + 1).replace(/^t\/[^/]+\//, '');
    return rest.length > 0 ? rest : null;
  }
  return null;
}
