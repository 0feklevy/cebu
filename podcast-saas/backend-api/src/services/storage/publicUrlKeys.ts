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
 * Query parameters this product APPENDS to a URL an adapter has already built.
 *
 * There is exactly one such shape, and it is worth naming rather than pattern-matching: the
 * SIMULATION ENTRY URL. `SimulationService` publishes `getSimPublicUrl(entryKey)` and then extends
 * it with `?section=<timeline section id>` — the variant key the bridge dispatches on and
 * `variantKeyFor` reads — and `?v=<bridge hash>`, the cache buster. Nothing else in the product
 * appends anything, and NO forward builder emits a query of its own: `getPublicUrl` /
 * `getSimPublicUrl` interpolate the key and stop.
 */
const APPENDED_QUERY_PARAMS: ReadonlySet<string> = new Set(['section', 'v']);

/**
 * Drop a query the PRODUCT appended, and nothing else.
 *
 * A `?` after the base is ambiguous by construction, because the forward builders interpolate the
 * key verbatim: it is either URL grammar (the sim entry URL above) or a character IN THE KEY (a
 * corpus object named after a file the user chose). Guessing "it is always grammar" is what broke
 * ingestion for `report?draft.pdf`; guessing "it is always key" would hand a sim entry URL back as a
 * key with `?section=…` glued on. So the rule is neither guess: the query is grammar only when
 * every parameter in it is one this product is known to append. `b.pdf` parses as a parameter named
 * `b.pdf`, which is not, so that key survives whole.
 *
 * A fragment is only ever dropped as part of such a query. Nothing here appends one, and `#` is a
 * perfectly ordinary character in a filename.
 *
 * The residual ambiguity — a corpus file literally named `notes?v=2.pdf` — is closed at the MINT
 * SITE instead (`corpus.controller`'s `corpusObjectName`), because that is the only place with
 * enough information to close it.
 */
function withoutAppendedQuery(rest: string): string {
  const q = rest.indexOf('?');
  if (q < 0) return rest;
  const names = [...new URLSearchParams(rest.slice(q + 1)).keys()];
  if (names.length === 0 || !names.every((n) => APPENDED_QUERY_PARAMS.has(n))) return rest;
  return rest.slice(0, q);
}

/**
 * The key `url` names, given the bases this adapter publishes under — or null.
 *
 * MATCH THE BASE FIRST, THEN TAKE THE REMAINDER VERBATIM. The remainder IS the key, character for
 * character, because that is exactly what the forward builder interpolated. Splitting the URL on
 * `?`/`#` BEFORE matching — which is what this did — truncates every key that contains one of
 * those characters, and corpus keys are interpolated straight from the upload filename: a file
 * named `q&a#2.pdf` produced a key the presign could not find, so `CorpusBuilder.ingest` failed on
 * a file that had uploaded perfectly and a duplication of the same project died on `NoSuchKey`.
 * The one query this product does append is handled by `withoutAppendedQuery`, which knows its name.
 *
 * NO PERCENT-DECODING, for the same reason: the key goes into the URL verbatim on every adapter, so
 * decoding here would invent a key that was never published. Same reasoning as `rebaseUrl`, which
 * substitutes on the stored text rather than re-deriving through the adapter.
 *
 * The scoped media token (`/hls-public/t/{token}/{key}`, `/hls-proxy/t/{token}/{key}`) sits in the
 * PATH so relative segment URLs inherit it, so it is stripped where it appears: between the route
 * base and the key. `t` is not a legal first key segment on any path this product mints.
 */
export function keyFromPublicUrlAgainst(url: string | null | undefined, bases: readonly string[]): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  // LONGEST BASE FIRST. Several bases share an origin (`{o}/local-storage` and `{o}/sim-public`,
  // or a bare R2 public origin alongside a route under it); the shortest would otherwise swallow
  // the others and hand back a key that still carries a route prefix.
  const ordered = [...bases].map((b) => b.replace(/\/+$/, '')).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const base of ordered) {
    if (!url.startsWith(`${base}/`)) continue;
    const rest = withoutAppendedQuery(url.slice(base.length + 1).replace(/^t\/[^/]+\//, ''));
    return rest.length > 0 ? rest : null;
  }
  return null;
}
