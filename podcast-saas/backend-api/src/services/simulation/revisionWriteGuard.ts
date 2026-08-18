/**
 * The two mutable-prefix writers that a revisioned package must refuse.
 *
 * Audit simulation-001 ("Replace simulation" is a silent no-op) and simulation-002 ("Publish
 * guidance" writes guidance.js and the entry HTML to the same unserved prefix) — one defect with
 * two front doors.
 *
 * WHAT IS ACTUALLY BROKEN
 * "Replace simulation" and "Publish guidance" both write into `simulations/<project>/<sim>/…` — the
 * mutable prefix that WAS the package. Once a simulation has an `active_revision_id`, nothing reads
 * that prefix any more: the player, the capture container and `buildPlayerConfig` all resolve
 * `<prefix>/revisions/<active>/…`. So both operations completed, returned success, and changed
 * nothing anybody could see. The bytes landed; they landed somewhere unserved.
 *
 * WHY REFUSE RATHER THAN REDIRECT
 * Writing into the active revision's prefix instead is not a smaller fix, it is the opposite one:
 * revision bytes are immutable by construction, and a package that can be rewritten in place gives
 * up every guarantee the revision layout exists to provide. The correct implementation derives a
 * NEW revision, validates it and compare-and-set activates it — planned, and dependent on
 * `RevisionService.validate`. Until it lands, a loud refusal is the honest state: the user learns
 * immediately that the operation did not happen, instead of discovering weeks later that a
 * "successful" replace never reached production.
 *
 * LEGACY SIMULATIONS ARE UNTOUCHED. `active_revision_id === null` means the mutable prefix really
 * is what is served, so those paths keep working exactly as before — the guard returns null and
 * every caller falls through to the code it already ran.
 */

/** The one code both endpoints emit. Stable: clients switch on it, so it never changes shape. */
export const SIM_REVISION_WRITE_UNSUPPORTED = 'SIM_REVISION_WRITE_UNSUPPORTED';

export type RevisionWriteOperation = 'replace' | 'publish-guidance';

export interface RevisionWriteRefusal {
  code: typeof SIM_REVISION_WRITE_UNSUPPORTED;
  /** Which operation was refused — the two have different remedies. */
  operation: RevisionWriteOperation;
  /** The revision that is actually being served. Named so a report can point at real bytes. */
  activeRevisionId: string;
  /** Human-readable, safe for an API body, an SSE frame and a log line. */
  message: string;
}

const MESSAGES: Record<RevisionWriteOperation, string> = {
  replace:
    'This simulation publishes from immutable package revisions, and replacing its files in place ' +
    'is not supported yet — the new files would be written to a location the player no longer ' +
    'reads, so the change would look successful and have no effect. Upload the new version as a ' +
    'NEW simulation and point the sections at it.',
  'publish-guidance':
    'This simulation publishes from immutable package revisions, and guidance cannot be published ' +
    'into it yet — the audio and overlay would be written to a location the player no longer ' +
    'reads, so the guidance would look published and never play. Your draft cues are unchanged ' +
    'and nothing was billed.',
};

/**
 * Does this simulation refuse mutable-prefix writes?
 *
 * Pure and total: a legacy row returns null, a revisioned row returns the refusal to emit. It takes
 * the row rather than the id so the call site reads as a question about the simulation.
 */
export function refuseRevisionWrite(
  sim: { active_revision_id?: string | null },
  operation: RevisionWriteOperation,
): RevisionWriteRefusal | null {
  const activeRevisionId = sim.active_revision_id ?? null;
  if (!activeRevisionId) return null;
  return {
    code: SIM_REVISION_WRITE_UNSUPPORTED,
    operation,
    activeRevisionId,
    message: MESSAGES[operation],
  };
}
