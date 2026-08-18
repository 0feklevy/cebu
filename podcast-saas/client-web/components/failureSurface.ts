'use client';

/**
 * One rule for every client-side write, in one place (silent-failures-ui review).
 *
 *   An optimistic update must be RECONCILED or ROLLED BACK, and a failure must REACH THE USER.
 *
 * The editor grew half a dozen `catch { /* ignore *\/ }` blocks around real writes. Each looked
 * harmless on its own; together they meant the product could fail in front of someone and say
 * nothing — a rename that snapped back on the next refresh, a Save that left the title applied and
 * the items not, a delete that appeared to work. `HomeSidebar`'s project rename/delete already
 * established the shape of the fix (log it, undo the optimistic guess, tell the user); this module
 * is that shape made reusable so the next write does not have to reinvent it.
 *
 * Deliberately NOT a toast system. Every call site here already owns a place to put a message —
 * an inline error line, a status banner — and a message rendered where the failed thing lives is
 * more useful than one that floats in a corner. `report` is a callback for exactly that reason.
 */

/**
 * User-facing text for anything a fetch/api call threw.
 *
 * The detail is appended rather than dropped: "Could not save this playlist." tells the user
 * nothing they can act on, while "Could not save this playlist. (409 the playlist was deleted)"
 * tells them why and what to do next. Values with no readable message (an aborted request, a
 * thrown non-Error) fall back to the sentence alone rather than printing "[object Object]".
 */
export function failureMessage(err: unknown, fallback: string): string {
  const detail = err instanceof Error
    ? err.message.trim()
    : typeof err === 'string' ? err.trim() : '';
  return detail && detail.toLowerCase() !== fallback.toLowerCase() ? `${fallback} (${detail})` : fallback;
}

export interface OptimisticWrite<T> {
  /** The write. Its resolved value is the server's version of the truth. */
  request: () => Promise<T>;
  /** Replace the optimistic guess with what the server actually stored. Success path only. */
  reconcile?: (result: T) => void;
  /** Undo the optimistic guess. Failure path only, and always before `report`. */
  rollback: () => void;
  /** Put the failure where the user is already looking. Failure path only. */
  report: (message: string) => void;
  /** The sentence the user reads if the write fails. */
  failureText: string;
}

/**
 * Run an optimistic write under the rule above.
 *
 * The caller has already applied its guess to local state when this is called; this decides what
 * happens to that guess. Returns whether the write succeeded, for callers that need to know (e.g.
 * to keep a dialog open).
 */
export async function commitOptimistic<T>(write: OptimisticWrite<T>): Promise<boolean> {
  try {
    const result = await write.request();
    write.reconcile?.(result);
    return true;
  } catch (err) {
    // Logged as well as shown: the sentence is for the user, the stack is for whoever they tell.
    console.error(write.failureText, err);
    write.rollback();
    write.report(failureMessage(err, write.failureText));
    return false;
  }
}
