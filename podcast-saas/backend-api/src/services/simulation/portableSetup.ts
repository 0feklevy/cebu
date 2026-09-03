/**
 * A saved setup travels between projects (owner ruling 2026-09-03: "like duplicate, but across
 * projects").
 *
 * A setup is a section's whole configuration under a name — the prompt, the generated script, the
 * kept controls, Minimal UI and Auto-script — saved against the simulation it was built for. It
 * was already loadable onto a section that HAD that simulation, and the Load dialog already
 * offered to bring the package in. What it could not do is the case that matters: a fresh section
 * in another project, which has no simulation at all. There the Load button was disabled, the fit
 * endpoint refused with 400, and the only way through was to go to the import gallery first, find
 * the package by name, import it, come back, and load. Three screens for one intent.
 *
 * This module is the decision half, pure and testable: given what the section has, what the setup
 * remembers, and what the project already holds, say which simulation the setup should be applied
 * to and how it got there.
 */

export interface SetupSourceFacts {
  /** The simulation the setup was saved against; null once that row is gone. */
  sourceSimulationId: string | null;
  /** Its name, for the sentence the dialog shows. */
  sourceSimulationName: string | null;
  /** False when the source row no longer exists — the setup is then a recipe with nothing to cook. */
  sourceExists: boolean;
}

export interface TargetProjectFacts {
  /** The simulation the section currently points at, or null for a fresh section. */
  sectionSimulationId: string | null;
  /** True when the setup's source simulation lives in THIS project already. */
  sourceIsInThisProject: boolean;
  /**
   * A copy of the source already imported into this project (migration 084), if any. Reusing it
   * is what keeps a second load from minting a second row.
   */
  existingImportId: string | null;
}

export type SetupTarget =
  /** Apply onto what the section already has. */
  | { use: 'section'; simulationId: string; brought: false }
  /** The setup's own simulation is already here — attach it to the section, then apply. */
  | { use: 'source'; simulationId: string; brought: false }
  /** A previous load already brought a copy in — attach that, then apply. */
  | { use: 'existing-import'; simulationId: string; brought: false }
  /** Nothing here to use: import the source (bytes are deduplicated), attach, then apply. */
  | { use: 'import'; sourceSimulationId: string; brought: true }
  /** Cannot proceed, with the reason a person can act on. */
  | { use: 'refuse'; reason: string };

/**
 * Which simulation this setup should land on.
 *
 * `bring` is the caller's intent: false keeps today's behaviour (apply onto the section's own
 * simulation, refuse when there is none), true allows the setup to bring its package with it.
 * Bringing NEVER replaces a simulation the section already has — that would silently swap the
 * thing the creator is looking at — unless the section has none.
 */
export function resolveSetupTarget(
  source: SetupSourceFacts,
  target: TargetProjectFacts,
  bring: boolean,
): SetupTarget {
  if (target.sectionSimulationId) {
    return { use: 'section', simulationId: target.sectionSimulationId, brought: false };
  }
  if (!bring) {
    return {
      use: 'refuse',
      reason: source.sourceExists
        ? 'This section has no simulation. Load it again with “bring the simulation too”, or pick one first.'
        : 'This section has no simulation to load onto.',
    };
  }
  if (!source.sourceSimulationId || !source.sourceExists) {
    return {
      use: 'refuse',
      reason: 'This setup’s simulation no longer exists, so it cannot be brought into this project. Pick a simulation for the section first.',
    };
  }
  if (target.sourceIsInThisProject) {
    return { use: 'source', simulationId: source.sourceSimulationId, brought: false };
  }
  if (target.existingImportId) {
    return { use: 'existing-import', simulationId: target.existingImportId, brought: false };
  }
  return { use: 'import', sourceSimulationId: source.sourceSimulationId, brought: true };
}

/** What the dialog says about a setup before it is loaded onto this section. */
export function describeSetupTarget(t: SetupTarget, sourceName: string | null): string {
  const named = sourceName ? `“${sourceName}”` : 'its simulation';
  switch (t.use) {
    case 'section': return 'Loads onto this section’s simulation.';
    case 'source': return `Attaches ${named}, which this project already has, and loads onto it.`;
    case 'existing-import': return `Attaches the copy of ${named} this project already received, and loads onto it.`;
    case 'import': return `Brings ${named} into this project — nothing is stored twice — and loads onto it.`;
    case 'refuse': return t.reason;
  }
}
