/**
 * Which simulation bytes the EDITOR should mount (audit §9.6).
 *
 * A section row carries two different URLs and confusing them is the whole defect:
 *
 *   - `simulation_url` is what this section last PUBLISHED. It is written only by the generation
 *     that published it, and it is the only value the editor ever writes BACK (sectionPatchBody on
 *     undo/redo restore, sectionCreateBody on duplicate). After any other section of the same
 *     package republishes — or after a rollback — it names a RETIRED revision.
 *   - `simulation_served_url` is what the simulation's active-revision pointer resolves to right
 *     now. The server computes it on the way out and it is never persisted anywhere.
 *
 * It rides only on the two editor bootstrap reads (GET /sections, GET /editor-state); create and
 * update responses return the stored row, because those endpoints must keep storing exactly what
 * the client sent. So the editor remembers what the pointer resolved to at load, and that memory
 * is keyed on the value it was resolved FROM — a regeneration rewrites `simulation_url` to the
 * revision it just published, and that must invalidate the memory rather than pin the preview to
 * the revision that happened to be live when the editor opened.
 */

/** What the pointer resolved to at load, and the stored value it was resolved from. */
export interface RememberedServedUrl {
  stored: string;
  served: string;
}

type SimSection = {
  id: string;
  simulation_url: string | null;
  simulation_served_url?: string | null;
};

/** A section row, as far as the republish propagation below is concerned. */
type PackagedSimSection = SimSection & { simulation_id?: string | null };

/**
 * The memory, built from a bootstrap read. Only sections whose served URL actually DIFFERS are
 * kept: for every other section the stored value is already the live one, so there is nothing to
 * remember and nothing to go stale.
 */
export function rememberServedSimUrls(
  sections: readonly SimSection[],
): Map<string, RememberedServedUrl> {
  const out = new Map<string, RememberedServedUrl>();
  for (const s of sections) {
    if (s.simulation_url && s.simulation_served_url && s.simulation_served_url !== s.simulation_url) {
      out.set(s.id, { stored: s.simulation_url, served: s.simulation_served_url });
    }
  }
  return out;
}

/**
 * The URL to mount for one section: the row's own served value when it has one, else what the
 * pointer resolved to at load — but only while the row still stores the value that was resolved
 * from — else the stored URL, which is what the editor did before any of this existed.
 */
export function servedSimulationUrl(
  section: SimSection,
  remembered: ReadonlyMap<string, RememberedServedUrl>,
): string | null {
  if (section.simulation_served_url) return section.simulation_served_url;
  const known = remembered.get(section.id);
  return known && known.stored === section.simulation_url ? known.served : section.simulation_url;
}

/**
 * The two halves the server joins to build a served URL: the live revision's entry document, and
 * the section's OWN stored query. `resolveSimulationUrl` is
 * `getSimPublicUrl(active_revision_entry_key) + storedQuery`, and the query is load-bearing —
 * `?section=` is what the pool dispatches on and what the poster/variant identity reads, so every
 * section of one package has a different served URL over the same revision document.
 */
const revisionBaseOf = (url: string): string => {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
};
const queryOf = (url: string): string => {
  const q = url.indexOf('?');
  return q === -1 ? '' : url.slice(q);
};

/**
 * Carry an IN-SESSION REPUBLISH across to the sibling sections of the same package.
 *
 * `simulation_served_url` is computed per response, and only the section that was regenerated gets
 * a response. Its siblings keep the value they were handed at editor bootstrap — the revision that
 * was live when the page opened — so after a republish the editor is asking for two different
 * revision documents for one package. Nothing 404s (a retired revision stays in storage; nothing in
 * production calls `RevisionService.gc()`), so what is lost is RESIDENCY: `packageKeyOf` is
 * origin+path, so the two URLs are two different packages to `simDocumentSwitch`, and every hop
 * between siblings becomes `navigate` — a full document boot behind the spinner — instead of the
 * one postMessage a same-package hop costs. Exactly the sections most likely to be revisited, and
 * only until the next PATCH or a page reload puts them back in step.
 *
 * The pointer is per SIMULATION, so a moved revision moves the whole package: the new base is
 * joined to each sibling's own stored query, which is precisely what the server would return if it
 * were asked again.
 *
 * A no-op unless a served revision actually moved — a drag, a trim or an undo/redo restore all come
 * back resolved against the same pointer, so they compare equal and the input array is returned
 * unchanged (identity preserved, because the editor memoises on it).
 */
export function withRepublishedServedUrls<T extends PackagedSimSection>(
  next: T[],
  prev: readonly T[],
): T[] {
  // Only rows the editor already had can have MOVED; a row appearing for the first time is not
  // evidence of a republish, it is just a row the memory has never seen.
  const before = new Map<string, string | null>();
  for (const s of prev) {
    before.set(s.id, s.simulation_served_url ? revisionBaseOf(s.simulation_served_url) : null);
  }

  const moved = new Map<string, string>();   // simulation_id → the revision that is live now
  for (const s of next) {
    if (!s.simulation_id || !s.simulation_served_url) continue;
    const was = before.get(s.id);
    if (was === undefined || was === null) continue;
    const now = revisionBaseOf(s.simulation_served_url);
    if (now !== was) moved.set(s.simulation_id, now);
  }
  if (moved.size === 0) return next;

  return next.map((s) => {
    const base = s.simulation_id ? moved.get(s.simulation_id) : undefined;
    if (!base || !s.simulation_url) return s;
    const served = base + queryOf(s.simulation_url);
    return served === s.simulation_served_url ? s : { ...s, simulation_served_url: served };
  });
}
