/**
 * Resolving the immutable-revision pointer on the way OUT (audit §9.6, Stage 0).
 *
 * Since P0.4 a simulation's live bytes sit under an immutable revision prefix and
 * `simulations.active_revision_entry_key` is the pointer at them. The STORED
 * `timeline_sections.simulation_url` is deliberately NOT the authority:
 *
 *   - a section's URL is written only by the publication that generated THAT section, so every
 *     other section of the same package still names whatever revision was live when IT was last
 *     published — a retired one after any republish, and after a rollback that is true of every
 *     section including the one that published last;
 *   - rewriting them at activation would make the pointer flip an N-row, un-transacted rewrite,
 *     which is exactly the promise immutable publication exists to keep ("one compare-and-set");
 *   - sim-script reuse compares the RAW stored value (`urlIsOwn`, `reuseBridgeScript`), so the
 *     stored bytes-identity must keep meaning "what this section published", not "what is live".
 *
 * So the pointer is resolved HERE, on the way out, and nowhere else. This module is the one place
 * that knows how — it was a private closure inside buildPlayerConfig, which is why the EDITOR
 * (which reads `timeline_sections` straight from the DB) served retired bytes.
 *
 * Every consumer takes the pointer data explicitly: nothing in here reads the database, so the
 * caller decides how to batch the lookup and the semantics stay unit-testable.
 */

/** The fields of a `simulations` row the editor shaping depends on. */
export interface SimRevisionPointerRow {
  id: string;
  /** `simulations.active_revision_entry_key` — the storage key of the LIVE entry document. */
  active_revision_entry_key: string | null;
  /**
   * `simulations.requires_import_maps` (migration 057, audit P0.8) — does the LIVE entry document
   * need `<script type="importmap">` support to run at all? Optional on this interface because it
   * arrives in a later migration than the pointer: a row selected without it, or read from a
   * database that predates it, must read as UNKNOWN rather than as either answer.
   */
  requires_import_maps?: boolean | null;
  /**
   * `simulations.bridge_ack_capable` (migration 055, audit P0.5) — does the LIVE bridge post
   * SCRIPT_APPLIED? Optional, and for the same reason as the field above: absent (a narrow select,
   * a database that predates the migration, a package never republished) must read as UNKNOWN.
   *
   * The EDITOR needs this every bit as much as the viewer does, and had no route to it at all. Its
   * timeline slot is the same warm-then-dispatch pool: the document paints its boot scene long
   * before the playhead enters a section, so the apply gate holds the swap — and with the record
   * missing by construction the gate could only ever answer UNKNOWN, for every package.
   */
  bridge_ack_capable?: boolean | null;
}

/** The storage adapter surface used here — just the sim public-URL mapping. */
export interface SimPublicUrlSource {
  getSimPublicUrl(key: string): string;
}

/**
 * The URL a section's simulation is actually served from — the pointer flip made visible.
 *
 * Exact semantics, unchanged from the closure this replaces:
 *   - no pointer (legacy / un-revisioned simulation, or no row at all) → the stored URL verbatim,
 *     byte-identical to pre-migration-050 output;
 *   - no stored URL → null;
 *   - otherwise the public URL of the active revision's entry key, with the stored query string
 *     APPENDED VERBATIM. `?section=` and `?v=` are preserved exactly: the viewer's pool dispatches
 *     on `?section=`, and the poster/variant identity axis reads it. Dropping the query collapses
 *     every section of a package onto one variant key.
 */
export function resolveSimulationUrl(
  storedUrl: string | null | undefined,
  pointer: Pick<SimRevisionPointerRow, 'active_revision_entry_key'> | null | undefined,
  storage: SimPublicUrlSource,
): string | null {
  if (!pointer?.active_revision_entry_key || !storedUrl) return storedUrl ?? null;
  const q = storedUrl.includes('?') ? storedUrl.slice(storedUrl.indexOf('?')) : '';
  return storage.getSimPublicUrl(pointer.active_revision_entry_key) + q;
}

/** Index simulation rows by id for `simulationUrlResolver`. Rows may be a narrow column select. */
export function simRevisionPointers(
  rows: readonly SimRevisionPointerRow[],
): Map<string, SimRevisionPointerRow> {
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Bind a batch of pointer rows to a storage adapter, giving back the `(simId, storedUrl)` resolver
 * every read path uses. The caller loads the rows ONCE for the whole response — a per-section
 * lookup would be an N+1 on the hottest read path in the product.
 */
export function simulationUrlResolver(
  pointers: ReadonlyMap<string, Pick<SimRevisionPointerRow, 'active_revision_entry_key'>>,
  storage: SimPublicUrlSource,
): (simulationId: string | null | undefined, storedUrl: string | null | undefined) => string | null {
  return (simulationId, storedUrl) =>
    resolveSimulationUrl(storedUrl, simulationId ? pointers.get(simulationId) : undefined, storage);
}

/** The `timeline_sections` columns the editor shaping below reads. */
interface SimSectionRow {
  simulation_id: string | null;
  simulation_url: string | null;
}

/**
 * Editor shaping: every section keeps its STORED `simulation_url` byte-for-byte and gains
 * `simulation_served_url`, the bytes that are live right now, plus `requires_import_maps`, the
 * capability floor of those same bytes.
 *
 * The second field rides here rather than in a read of its own because it answers a question about
 * exactly the revision the first one resolves: the editor mounts the SERVED url in an iframe, and
 * whether that document can paint on this browser is a property of those bytes (audit P0.8). One
 * pointer row already loaded, two facts derived from it, no extra query on either bootstrap read.
 *
 * ADDITIVE, NOT A REWRITE — and that is a correctness requirement, not a style choice. The editor
 * sends section rows straight back to the API: `sectionPatchBody` (undo/redo restore) and
 * `sectionCreateBody` (duplicate section) both copy `simulation_url` verbatim into a PATCH/POST
 * body, and both endpoints store an explicit `simulation_url` as given. Overwriting the field on
 * read would therefore let a GET→PATCH round-trip persist a resolved URL — a revision id captured
 * at read time, written into a row whose whole purpose is to record what THIS section published.
 * A stale tab would persist a retired (eventually garbage-collected) revision key that way.
 *
 * The viewer does not need this shape: nothing it receives is ever written back, so
 * `buildPlayerConfig` resolves `simulation_url` in place.
 */
export function withServedSimulationUrls<T extends SimSectionRow>(
  sections: readonly T[],
  pointerRows: readonly SimRevisionPointerRow[],
  storage: SimPublicUrlSource,
): Array<T & {
  simulation_served_url: string | null;
  requires_import_maps: boolean | null;
  bridge_ack_capable: boolean | null;
}> {
  const pointers = simRevisionPointers(pointerRows);
  const resolve = simulationUrlResolver(pointers, storage);
  // THREE STATES, and the third is why neither of these is `?? false`. A section with no
  // simulation, a simulation with no row, a row selected without the column and a package
  // published before the migration all read the same: UNKNOWN. The editor's floor never downgrades
  // on unknown, and the editor's apply gate treats unknown as its own bounded case.
  const scalar = (simId: string | null, field: 'requires_import_maps' | 'bridge_ack_capable') => {
    const v = simId ? pointers.get(simId)?.[field] : undefined;
    return typeof v === 'boolean' ? v : null;
  };
  return sections.map((s) => ({
    ...s,
    simulation_served_url: resolve(s.simulation_id, s.simulation_url),
    requires_import_maps: scalar(s.simulation_id, 'requires_import_maps'),
    bridge_ack_capable: scalar(s.simulation_id, 'bridge_ack_capable'),
  }));
}
