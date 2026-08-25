/**
 * What happens to a project's bytes when the project is deleted, once bytes can be SHARED.
 *
 * ── THE REQUIREMENT, AND WHY MOST OF IT IS ALREADY SATISFIED ──────────────────────────────────
 * Stated plainly: on deletion, anything still in use elsewhere must survive; anything unused must
 * go. The instinct is to COPY the in-use files somewhere safe before deleting the project.
 *
 * For content-addressed media that copy is unnecessary, and actively harmful. A blob lives at
 * `blobs/<digest>` — a key derived from the CONTENT, owned by no project. Deleting a project
 * removes its rows; the blob row is untouched and still referenced by whoever else pointed at it;
 * and migration 078's foreign key means Postgres itself refuses to delete a referenced blob.
 * Copying here would re-create the second copy the whole feature exists to remove, and would turn
 * "delete a project" into an operation that moves gigabytes and can fail halfway.
 *
 * ── WHERE THE REQUIREMENT IS EXACTLY RIGHT, THOUGH ────────────────────────────────────────────
 * Not everything is content-addressed. Two kinds of object are still owned by a project's PATH:
 *
 *   • rows that predate dedup and carry their own `storage_key`;
 *   • simulation trees, whose prefix is literally `simulations/{projectId}/{simulationId}` — the
 *     owning project's id is IN the path.
 *
 * For those, sharing means one project's content living under another project's prefix, and the
 * owner's concern is precisely correct: delete the project and you delete bytes somebody else is
 * serving. Those objects must be ADOPTED — copied once into the neutral blob namespace and the
 * surviving references re-pointed — before the project goes.
 *
 * So the plan has three dispositions, and which one an object gets is not a judgement call.
 *
 * ── THE DIRECTION OF DOUBT ────────────────────────────────────────────────────────────────────
 * "I could not determine whether this is referenced" resolves to KEEP, never to delete. A leaked
 * object costs storage and can be swept later once the question is answerable; a wrongly deleted
 * one is somebody's video, gone, with the row that explained it gone in the same transaction.
 */

/** One object the project owns, as far as the caller could establish. */
export interface OwnedObject {
  key: string;
  /**
   * How many references exist from OUTSIDE this project.
   *
   * `null` means "not determined" — a failed query, an adapter that could not list, a table the
   * caller does not know about. It is deliberately distinct from `0`.
   */
  externalRefs: number | null;
  /** True when the key is in the content-addressed namespace and therefore owned by no project. */
  contentAddressed: boolean;
}

export type ObjectDisposition =
  /** Nothing to do: the bytes are not the project's to lose. */
  | { action: 'keep'; key: string; why: 'content-addressed' | 'reference-state-unknown' }
  /** In use elsewhere and path-owned: copy into the neutral namespace, re-point, then release. */
  | { action: 'adopt'; key: string; why: 'referenced-elsewhere' }
  /** Nothing outside this project points at it. */
  | { action: 'delete'; key: string; why: 'unreferenced' };

export interface DeletionPlan {
  dispositions: ObjectDisposition[];
  /** Deletion may only proceed once every adoption has actually completed. */
  adoptionsRequired: number;
  /**
   * Objects whose reference state could not be established. Non-zero means the plan is INCOMPLETE
   * rather than wrong: those are kept, and an operator gets told why rather than discovering a
   * slow leak months later.
   */
  undetermined: number;
}

/** Is this key in the namespace migration 078 owns? */
export function isContentAddressedKey(key: string): boolean {
  return /^blobs\//.test(key);
}

/**
 * Decide what happens to every object a project owns. Pure: no database, no bucket, so each
 * branch is provable on its own.
 */
export function planProjectDeletion(objects: OwnedObject[]): DeletionPlan {
  const dispositions = objects.map((o): ObjectDisposition => {
    // Checked FIRST, and before the reference count is even consulted. A content-addressed object
    // is never the project's to delete or to copy, whatever its current reference count happens to
    // be — including zero, because a count of zero at this instant races an import in flight. The
    // sweeper, which works on the blob table under its own grace period, is the only thing allowed
    // to remove these.
    if (o.contentAddressed || isContentAddressedKey(o.key)) {
      return { action: 'keep', key: o.key, why: 'content-addressed' };
    }
    // The direction of doubt.
    // A NEGATIVE count is nonsense, and it is nonsense that points the wrong way: `-1 > 0` is
    // false, so left alone it reads as "nothing references this" and the object is deleted. It is
    // a broken aggregate, not an answer. (Caught by this module's own test.)
    if (o.externalRefs === null || !Number.isFinite(o.externalRefs) || o.externalRefs < 0) {
      return { action: 'keep', key: o.key, why: 'reference-state-unknown' };
    }
    if (o.externalRefs > 0) {
      return { action: 'adopt', key: o.key, why: 'referenced-elsewhere' };
    }
    return { action: 'delete', key: o.key, why: 'unreferenced' };
  });

  return {
    dispositions,
    adoptionsRequired: dispositions.filter((d) => d.action === 'adopt').length,
    undetermined: dispositions.filter((d) => d.action === 'keep' && d.why === 'reference-state-unknown').length,
  };
}

/**
 * May the project's rows be removed yet?
 *
 * The ordering that makes the guarantee real: every adoption must have COMPLETED — the copy
 * finished and the surviving reference re-pointed — before the project row goes. Delete first and
 * adopt afterwards and a crash in between destroys exactly the bytes the adoption existed to save.
 */
export function readyToDelete(plan: DeletionPlan, adoptionsCompleted: number): { ready: boolean; reason: string | null } {
  if (!Number.isFinite(adoptionsCompleted) || adoptionsCompleted < 0) {
    return { ready: false, reason: 'adoption progress is not a usable number' };
  }
  if (adoptionsCompleted < plan.adoptionsRequired) {
    return {
      ready: false,
      reason: `${plan.adoptionsRequired - adoptionsCompleted} shared object(s) still to adopt — deleting now would destroy bytes another project serves`,
    };
  }
  return { ready: true, reason: null };
}

/** The keys that may actually be removed, in the order an executor should take them. */
export function deletableKeys(plan: DeletionPlan): string[] {
  return plan.dispositions.filter((d) => d.action === 'delete').map((d) => d.key);
}

/** The keys that must be copied into the neutral namespace first. */
export function adoptableKeys(plan: DeletionPlan): string[] {
  return plan.dispositions.filter((d) => d.action === 'adopt').map((d) => d.key);
}
