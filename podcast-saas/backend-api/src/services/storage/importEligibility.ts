/**
 * May this person pull THAT project's simulation into THIS one?
 *
 * The `+` that imports an existing simulation instead of re-uploading is, underneath, a request to
 * make one project reference another project's stored content. That is a read of somebody else's
 * material, and the fact that it is cheap for us is not a reason to make it free for them.
 *
 * ── WHY THIS IS ITS OWN MODULE, AND PURE ──────────────────────────────────────────────────────
 * The dedup layer will happily merge any two byte-identical files, and it is right to: that
 * decision is about STORAGE. Whether a person may cause the merge is a different question with a
 * different answer, and putting the two in one function is how a storage optimisation quietly
 * becomes a way to read private projects.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────────
 * You may import from a project you could already open. Nothing more permissive, because the
 * import makes the content yours to serve from a project you control — under YOUR visibility, on
 * YOUR permalink — and there is no taking that back once it is published.
 *
 *   • own it, or collaborate on it        → yes
 *   • it is public                        → yes
 *   • it is unlisted and you hold the link→ yes, and only with the token in hand
 *   • private and not yours               → no, and the answer must not reveal that it exists
 *
 * ── THE PART THAT IS EASY TO GET WRONG ────────────────────────────────────────────────────────
 * The DESTINATION matters as much as the source. Importing into a project you cannot edit is not
 * a read of the source, it is a WRITE to the destination — so both sides are checked, and the
 * destination is checked first: refusing on the destination reveals nothing about whether the
 * source exists.
 */

/** What we know about the person asking. */
export interface Requester {
  /** Null for an anonymous caller. */
  uid: string | null;
  /** Share token presented with the request, if any. */
  shareToken?: string | null;
}

/** What we know about either end of the import. */
export interface ProjectFacts {
  id: string;
  visibility: 'private' | 'unlisted' | 'public';
  ownerId: string;
  /** True when the requester is a collaborator on this project. */
  isCollaborator: boolean;
  /** The project's own share token, when it has one. */
  shareToken?: string | null;
}

export type ImportVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /**
       * `not-found` is used for every refusal the requester is not entitled to distinguish from
       * absence. A caller who cannot see a private project must not learn it exists.
       */
      reason: 'destination-not-editable' | 'not-found' | 'same-project';
      /** Suggested HTTP status. 404 for anything that must not confirm existence. */
      status: 403 | 404 | 400;
    };

/** Could this requester OPEN the source project at all? */
export function mayReadProject(p: ProjectFacts, who: Requester): boolean {
  if (who.uid && p.ownerId === who.uid) return true;
  if (p.isCollaborator) return true;
  if (p.visibility === 'public') return true;
  if (p.visibility === 'unlisted') {
    // The link IS the credential, so it has to be presented — and it has to be non-empty on both
    // sides. An unlisted project with no token, compared against a caller with no token, would
    // otherwise match `undefined === undefined` and open every unlisted project to everyone.
    const held = who.shareToken ?? '';
    const real = p.shareToken ?? '';
    return real.length > 0 && held === real;
  }
  return false;
}

/** May this requester WRITE to the destination project? Ownership or collaboration only. */
export function mayWriteProject(p: ProjectFacts, who: Requester): boolean {
  if (!who.uid) return false;
  return p.ownerId === who.uid || p.isCollaborator;
}

/**
 * The whole decision. Pure, so every branch is provable without a database.
 *
 * Order is deliberate and is part of the security property, not an implementation detail:
 * destination first, then the degenerate case, then the source. Checking the source first would
 * let a caller with no rights anywhere distinguish "that project does not exist" from "you cannot
 * write here", which is an existence oracle for private projects.
 */
export function judgeImport(input: {
  source: ProjectFacts | null;
  destination: ProjectFacts | null;
  who: Requester;
}): ImportVerdict {
  const { source, destination, who } = input;

  if (!destination || !mayWriteProject(destination, who)) {
    return { allowed: false, reason: 'destination-not-editable', status: 403 };
  }
  if (source && source.id === destination.id) {
    // Not a security matter — it would create a second row pointing at the same content inside one
    // project, which is not what the button means and reads as a bug to whoever clicked it.
    return { allowed: false, reason: 'same-project', status: 400 };
  }
  if (!source || !mayReadProject(source, who)) {
    // Same answer for "no such project" and "not yours": the requester is not entitled to tell
    // those apart.
    return { allowed: false, reason: 'not-found', status: 404 };
  }
  return { allowed: true };
}
