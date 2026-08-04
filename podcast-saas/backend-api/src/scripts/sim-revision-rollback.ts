/**
 * Roll a simulation's active package back to a previously-published immutable revision.
 *
 * WHAT MAKES A ROLLBACK SAFE HERE
 * Publication never overwrites: every revision's files live under a prefix containing its own id,
 * so the previous revision's bytes are still exactly where they were. Rolling back is therefore a
 * pointer move and nothing else — no restore, no re-upload, no window in which half of one revision
 * is being served with half of another.
 *
 * THE ONE WAY THAT GOES WRONG
 * A pointer moved to a revision whose objects are gone. It fails identically to a rollback that
 * never happened, except that the package is now DOWN instead of merely wrong — a sweep that ran
 * too eagerly, a bucket lifecycle rule, a partial delete. So this script reads the target's
 * manifest and verifies EVERY file it names — existence and SHA-256 — before it will move anything.
 * That check is the reason the script exists; the pointer move is one line.
 *
 * SAFETY POSTURE, matching the rest of the rollout tooling:
 *   • DRY RUN BY DEFAULT. `--apply` is the only thing that writes.
 *   • Refuses a target whose status cannot serve. `rolled_back` and `retired` can be restored
 *     (their bytes are retained by definition); a `draft`, `uploading`, `validating` or `failed`
 *     revision has never been proven and is not a place to retreat to.
 *   • Refuses a target that was never active. A revision that has passed its canary but never
 *     served is a roll-FORWARD; publishing it is the publication pipeline's job, with the canary
 *     and manifest gates that implies.
 *   • Emits an audit record either way, so a dry run is a reviewable artefact and an applied run is
 *     a record of who moved what, from where, to where.
 *
 * Usage:
 *   tsx src/scripts/sim-revision-rollback.ts --sim <simulationId> [--to <revisionId>] [--apply] [--json]
 */

import {
  loadRevisionManifest,
  verifyPresentationConfigs,
  verifyStoredFiles,
  type RevisionStorage,
  type RevisionStore,
} from '../services/simulation/PublicationService.js';
import {
  canTransition,
  mustRetainBytes,
  revisionFileKey,
  rollbackTargetFor,
  type SimRevisionRecord,
} from 'shared/src/sim/simRevision';
import { computeManifestHash } from 'shared/src/sim/simManifest';

/**
 * Exit codes, so a rollout script can branch without parsing text.
 *
 * | Code | Meaning |
 * |---|---|
 * | 0  | plan printed (dry run) or rollback applied |
 * | 2  | bad arguments |
 * | 3  | simulation not found |
 * | 4  | no usable rollback target — nothing was ever active, or `--to` names a revision this simulation does not have |
 * | 5  | **the target's status cannot serve** — it was never active, or its bytes are not retained |
 * | 6  | **the target's manifest is missing, unreadable, or describes something else** |
 * | 7  | **the target's bytes are not all present** — a file is missing or its hash does not match |
 * | 8  | the target is already the active revision — there is nothing to roll back |
 * | 9  | the pointer move failed |
 * | 10 | the revision store is unavailable in this build |
 *
 * Codes 5, 6 and 7 are refusals, not errors to work around. Rolling back to a revision whose bytes
 * were swept takes the package from wrong to down.
 */
export const EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  SIM_NOT_FOUND: 3,
  NO_ROLLBACK_TARGET: 4,
  TARGET_NOT_SERVABLE: 5,
  TARGET_MANIFEST_INVALID: 6,
  TARGET_BYTES_MISSING: 7,
  TARGET_ALREADY_ACTIVE: 8,
  WRITE_FAILED: 9,
  STORE_UNAVAILABLE: 10,
} as const;

export interface Args {
  simulationId: string;
  /** Explicit target. Overrides `rollbackTargetFor`. */
  to: string | null;
  apply: boolean;
  json: boolean;
}

/**
 * Parse argv.
 *
 * A flag immediately following another flag is NOT taken as its value: `--sim --apply` means the
 * operator forgot the id, and resolving it to the literal string "--apply" would turn a typo into
 * a "simulation not found" that reads like a real answer.
 */
export function parseArgs(argv: readonly string[]): Args | null {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i < 0 || i + 1 >= argv.length) return null;
    const value = argv[i + 1];
    return value.startsWith('--') ? null : value;
  };
  const simulationId = get('--sim');
  if (!simulationId) return null;
  return {
    simulationId,
    to: get('--to'),
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
  };
}

// ─── Ports ────────────────────────────────────────────────────────────────────────────────────

export type RollbackStore = Pick<
  RevisionStore,
  'listRevisions' | 'getRevision' | 'getActiveRevisionId' | 'rollbackToRevision'
>;

export interface RollbackSimulationRow {
  id: string;
  projectId: string;
  name: string;
}

export interface RollbackDeps {
  revisions: RollbackStore;
  storage: Pick<RevisionStorage, 'readObject' | 'objectExists'>;
  findSimulation(simulationId: string): Promise<RollbackSimulationRow | null>;
  now?: () => Date;
  /** Who is running this. Recorded in the audit record; never used to authorise anything. */
  operator?: string | null;
}

// ─── Plan / audit ─────────────────────────────────────────────────────────────────────────────

export interface RollbackPlan {
  simulationId: string;
  simulationName: string;
  projectId: string;
  fromRevisionId: string | null;
  fromRevisionNumber: number | null;
  toRevisionId: string;
  toRevisionNumber: number;
  toStatus: SimRevisionRecord['status'];
  toActivatedAt: string | null;
  manifestHash: string | null;
  filesVerified: number;
  bytesVerified: number;
  variantKeys: string[];
  posterCount: number;
  /** Whether the target came from `--to` or from `rollbackTargetFor`. */
  selectedBy: 'explicit' | 'default';
}

export interface RollbackAudit {
  kind: 'sim-revision-rollback';
  at: string;
  operator: string | null;
  simulationId: string;
  projectId: string;
  fromRevisionId: string | null;
  toRevisionId: string;
  toRevisionNumber: number;
  manifestHash: string | null;
  filesVerified: number;
  bytesVerified: number;
  applied: boolean;
  reason: string;
}

export interface RollbackOutcome {
  exitCode: number;
  applied: boolean;
  plan: RollbackPlan | null;
  audit: RollbackAudit | null;
  /** Human-readable output, in order. `main` prints these. */
  lines: string[];
  /** Set for every non-zero exit. */
  error: string | null;
}

const refuse = (exitCode: number, error: string, lines: string[] = []): RollbackOutcome => ({
  exitCode,
  applied: false,
  plan: null,
  audit: null,
  lines: [...lines, `REFUSED: ${error}`],
  error,
});

// ─── The run ──────────────────────────────────────────────────────────────────────────────────

/**
 * Everything the CLI does, with no process, no clock and no I/O of its own.
 *
 * Written this way because the exit-code table is the contract other scripts branch on, and a table
 * that can only be exercised by spawning a process is a table that gets tested by asserting that
 * `process.exit` exits.
 */
export async function runRollback(deps: RollbackDeps, args: Args): Promise<RollbackOutcome> {
  const now = deps.now ?? (() => new Date());
  const lines: string[] = [];

  const sim = await deps.findSimulation(args.simulationId);
  if (!sim) return refuse(EXIT.SIM_NOT_FOUND, `simulation ${args.simulationId} not found.`, lines);

  const activeId = await deps.revisions.getActiveRevisionId(sim.id);
  const revisions = await deps.revisions.listRevisions(sim.id);

  let target: SimRevisionRecord | null;
  let selectedBy: RollbackPlan['selectedBy'];
  if (args.to) {
    target = revisions.find((r) => r.id === args.to) ?? null;
    selectedBy = 'explicit';
    if (!target) {
      return refuse(
        EXIT.NO_ROLLBACK_TARGET,
        `revision ${args.to} does not belong to simulation ${sim.id}.`,
        lines,
      );
    }
  } else {
    // Ordered by when each revision was last ACTIVE, not by number: a rollback re-activates an
    // older number, so after one rollback the highest number is no longer the most recent, and
    // rolling back by number again would restore the revision that was just withdrawn.
    target = rollbackTargetFor(revisions, activeId);
    selectedBy = 'default';
    if (!target) {
      return refuse(
        EXIT.NO_ROLLBACK_TARGET,
        `simulation ${sim.id} has no previously-active revision to roll back to.`,
        lines,
      );
    }
  }

  if (target.id === activeId) {
    return refuse(EXIT.TARGET_ALREADY_ACTIVE, `revision ${target.id} is already active.`, lines);
  }

  // `mustRetainBytes` is the promise that this revision's objects were not swept; `canTransition`
  // is the state machine's own answer to "may this become active again"; `activatedAt` separates a
  // rollback from a roll-forward. All three, because each rules out a different way of being wrong.
  if (!mustRetainBytes(target.status) || !canTransition(target.status, 'active') || target.activatedAt === null) {
    return refuse(
      EXIT.TARGET_NOT_SERVABLE,
      `revision ${target.id} is '${target.status}'${target.activatedAt === null ? ' and was never active' : ''} — ` +
      'it cannot be rolled back to.',
      lines,
    );
  }

  const loaded = await loadRevisionManifest(deps.storage, sim.projectId, sim.id, target.id);
  if ('error' in loaded) {
    return refuse(EXIT.TARGET_MANIFEST_INVALID, `revision ${target.id}: ${loaded.error}`, lines);
  }
  const manifest = loaded.manifest;

  const manifestHash = computeManifestHash(manifest);
  if (target.manifestHash && target.manifestHash !== manifestHash) {
    // The row and the stored manifest disagree about what this revision IS. One of them describes
    // a package that is not there, and there is no way to tell which.
    return refuse(
      EXIT.TARGET_MANIFEST_INVALID,
      `revision ${target.id}: the stored manifest hashes to ${manifestHash}, but the row records ${target.manifestHash}.`,
      lines,
    );
  }

  const keyFor = (path: string): string => revisionFileKey(sim.projectId, sim.id, target!.id, path);

  const fileProblems = await verifyStoredFiles(deps.storage, keyFor, manifest.files);
  if (fileProblems.length > 0) {
    return refuse(
      EXIT.TARGET_BYTES_MISSING,
      `revision ${target.id} is missing or has altered ${fileProblems.length} of its ${manifest.files.length} file(s): ` +
      fileProblems.map((p) => `${p.path} (${p.reason}${p.detail ? `: ${p.detail}` : ''})`).join('; '),
      lines,
    );
  }

  const configProblems = await verifyPresentationConfigs(deps.storage, keyFor, manifest);
  if (configProblems.length > 0) {
    return refuse(
      EXIT.TARGET_MANIFEST_INVALID,
      `revision ${target.id} has ${configProblems.length} presentation config(s) that do not match its manifest: ` +
      configProblems.map((p) => `${p.variantKey}/${p.configHash} (${p.reason})`).join('; '),
      lines,
    );
  }

  const from = activeId ? (revisions.find((r) => r.id === activeId) ?? null) : null;
  const plan: RollbackPlan = {
    simulationId: sim.id,
    simulationName: sim.name,
    projectId: sim.projectId,
    fromRevisionId: activeId,
    fromRevisionNumber: from?.revisionNumber ?? null,
    toRevisionId: target.id,
    toRevisionNumber: target.revisionNumber,
    toStatus: target.status,
    toActivatedAt: target.activatedAt,
    manifestHash,
    filesVerified: manifest.files.length,
    bytesVerified: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
    variantKeys: manifest.variants.map((v) => v.variantKey),
    posterCount: manifest.posters.length,
    selectedBy,
  };

  const reason = args.to
    ? `operator named revision ${args.to}`
    : 'most recently active revision other than the current one';

  const audit: RollbackAudit = {
    kind: 'sim-revision-rollback',
    at: now().toISOString(),
    operator: deps.operator ?? null,
    simulationId: sim.id,
    projectId: sim.projectId,
    fromRevisionId: activeId,
    toRevisionId: target.id,
    toRevisionNumber: target.revisionNumber,
    manifestHash,
    filesVerified: plan.filesVerified,
    bytesVerified: plan.bytesVerified,
    applied: false,
    reason,
  };

  lines.push(...describePlan(plan));

  if (!args.apply) {
    lines.push('', 'DRY RUN — nothing written. Re-run with --apply to move the pointer.');
    return { exitCode: EXIT.OK, applied: false, plan, audit, lines, error: null };
  }

  try {
    await deps.revisions.rollbackToRevision({
      simulationId: sim.id,
      targetRevisionId: target.id,
      // The pointer this run READ. A store that finds a different value must reject: something else
      // moved the pointer while these checks were running, and it was not this operator.
      expectedCurrentActiveId: activeId,
      reason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: EXIT.WRITE_FAILED,
      applied: false,
      plan,
      audit,
      lines: [...lines, `WRITE FAILED: ${message}`],
      error: message,
    };
  }

  const appliedAudit: RollbackAudit = { ...audit, applied: true };
  lines.push(
    '',
    'ROLLED BACK.',
    `  pointer  : ${activeId ?? '(none)'} → ${target.id}`,
    `  serving  : revision #${target.revisionNumber}, ${plan.filesVerified} file(s), manifest ${manifestHash}`,
    `  withdrawn: ${activeId ?? '(none)'} is now 'rolled_back' — its bytes are retained and it can be restored`,
  );
  return { exitCode: EXIT.OK, applied: true, plan, audit: appliedAudit, lines, error: null };
}

export function describePlan(plan: RollbackPlan): string[] {
  return [
    `PLAN for ${plan.simulationName} (${plan.simulationId})`,
    `  from      : ${plan.fromRevisionId ?? '(no active revision)'}` +
      (plan.fromRevisionNumber !== null ? ` (#${plan.fromRevisionNumber})` : ''),
    `  to        : ${plan.toRevisionId} (#${plan.toRevisionNumber}, ${plan.toStatus}, ` +
      `last active ${plan.toActivatedAt ?? 'never'}) [${plan.selectedBy}]`,
    `  manifest  : ${plan.manifestHash}`,
    `  verified  : ${plan.filesVerified} file(s), ${plan.bytesVerified} byte(s), every hash matched`,
    `  variants  : ${plan.variantKeys.join(', ') || '(none)'}`,
    `  posters   : ${plan.posterCount}`,
  ];
}

// ─── Wiring ───────────────────────────────────────────────────────────────────────────────────

/**
 * The revision table is owned by `RevisionService`, which ships with the revision migration. It is
 * resolved dynamically and shape-checked rather than statically bound, so this CLI is a complete,
 * exercisable unit before that module exists — and so a build without it refuses with one clear
 * exit code instead of failing somewhere inside the rollback.
 */
const REVISION_SERVICE_MODULE = '../services/simulation/RevisionService.js';

export const REQUIRED_STORE_METHODS = [
  'listRevisions',
  'getRevision',
  'getActiveRevisionId',
  'rollbackToRevision',
] as const;

/** The exported `revisionStore`, if the module really provides the whole port. */
export function asRollbackStore(mod: unknown): RollbackStore | null {
  const candidate = (mod as { revisionStore?: unknown } | null | undefined)?.revisionStore;
  if (!candidate || typeof candidate !== 'object') return null;
  const obj = candidate as Record<string, unknown>;
  for (const method of REQUIRED_STORE_METHODS) {
    if (typeof obj[method] !== 'function') return null;
  }
  return candidate as RollbackStore;
}

async function loadDeps(): Promise<RollbackDeps | null> {
  // Imported here rather than at module scope so that importing this file — from a test, or to read
  // its exit-code table — does not open a database pool.
  const [{ db }, { simulations }, { eq }, { getStorageAdapter }] = await Promise.all([
    import('../db/index.js'),
    import('../db/schema.js'),
    import('drizzle-orm'),
    import('../services/storage/getStorageAdapter.js'),
  ]);

  let store: RollbackStore | null = null;
  try {
    store = asRollbackStore(await import(REVISION_SERVICE_MODULE));
  } catch {
    store = null;
  }
  if (!store) return null;

  return {
    revisions: store,
    storage: getStorageAdapter(),
    findSimulation: async (simulationId: string) => {
      const row = await db.query.simulations.findFirst({ where: eq(simulations.id, simulationId) });
      return row ? { id: row.id, projectId: row.project_id, name: row.name } : null;
    },
    operator: process.env.USER ?? null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write('usage: sim-revision-rollback --sim <simulationId> [--to <revisionId>] [--apply] [--json]\n');
    process.exit(EXIT.BAD_ARGS);
    return;
  }

  const deps = await loadDeps();
  if (!deps) {
    process.stderr.write(
      'REFUSED: no revision store is available in this build — the immutable-revision pipeline is not installed.\n',
    );
    process.exit(EXIT.STORE_UNAVAILABLE);
    return;
  }

  const outcome = await runRollback(deps, args);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          exitCode: outcome.exitCode,
          applied: outcome.applied,
          error: outcome.error,
          plan: outcome.plan,
          audit: outcome.audit,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const line of outcome.lines) process.stdout.write(`${line}\n`);
    if (outcome.audit) process.stdout.write(`\nAUDIT ${JSON.stringify(outcome.audit)}\n`);
  }

  process.exit(outcome.exitCode);
}

// Only run when invoked directly — importing this module from a test must not execute it.
if (process.argv[1] && process.argv[1].includes('sim-revision-rollback')) {
  void main();
}
