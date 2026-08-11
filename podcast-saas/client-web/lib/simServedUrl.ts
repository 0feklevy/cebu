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
