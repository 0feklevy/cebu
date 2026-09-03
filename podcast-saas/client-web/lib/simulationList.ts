/**
 * How a simulation handed up from a child panel joins the editor's list.
 *
 * This existed as an inline `prev.map(s => s.id === sim.id ? sim : s)` in `VideoEditor`, and that
 * is a REPLACE: it can update a simulation the list already holds and can do nothing at all with
 * one it does not. Two of the three things that call it hand up a simulation this project has
 * never seen — the load dialog's Import button, and a saved setup that brings its own package —
 * so for those the new simulation was silently dropped and never reached the picker meant to
 * show it. Nothing threw; the option was simply absent.
 *
 * It lives here, as a pure function with its own tests, because the failure is invisible at the
 * call site: both spellings compile, both look correct, and only one of them is.
 */
export interface HasId { id: string }

/** Replace the entry with this id, or append it when the list has never seen it. */
export function upsertById<T extends HasId>(list: readonly T[], next: T): T[] {
  return list.some(item => item.id === next.id)
    ? list.map(item => (item.id === next.id ? next : item))
    : [...list, next];
}
