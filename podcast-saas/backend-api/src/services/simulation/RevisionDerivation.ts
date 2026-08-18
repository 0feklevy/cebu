/**
 * DERIVING A NEW REVISION FROM THE ONE THAT IS LIVE (audit D-04).
 *
 * THE DEFECT THIS ENDS
 * "Replace simulation" and "Publish guidance" wrote into `simulations/<project>/<sim>/…` — the
 * mutable prefix that WAS the package. Once a simulation has an `active_revision_id` nothing reads
 * that prefix: the player, the capture container and `buildPlayerConfig` all resolve
 * `<prefix>/revisions/<active>/…`. Both operations completed, returned success, and changed
 * nothing anybody could see. 9a79c56 made them refuse instead of lie; this module is what lets
 * them actually do the work.
 *
 * ONE SHAPE, FOUR STEPS, SHARED BY EVERY WRITER
 *
 *     derive from the ACTIVE revision → transform → draft/upload/validate → CAS activate
 *
 * The alternative — each writer staging its own revision — is two copies of an eight-call sequence
 * in which the interesting parts are the failure paths: which status a half-written draft is left
 * in, whether the pointer read that seeds the compare-and-set happened before or after the bytes
 * were built, whether an abort between validation and activation leaves an activatable stale
 * build. Two copies agree until one changes.
 *
 * WHY IT IS A COMPARE-AND-SET AND NOT A LOCK
 * `expectedActiveRevisionId` is the pointer this call READ, at the top, before a single byte was
 * built. It is handed to `RevisionService.activate` unchanged. A concurrent publication that wins
 * the pointer in between therefore makes THIS activation lose — `RevisionConflict`, whole
 * transaction rolled back, draft marked failed, nothing served changed. A process-local lock (the
 * shape `withGuidanceLock` and `withBridgeLock` use) cannot do this: three call sites each build
 * their own service instance with their own empty lock map, and two API processes share nothing at
 * all. The index behind the CAS is cluster-wide; a `Map` in one process is not.
 *
 * THE DERIVED REVISION IS NOT THE BASE REVISION WITH EDITS
 * Every byte is written to a prefix containing an id that has never been used, so a reader cannot
 * observe a partial write — it is reading a different prefix entirely. The base revision's bytes
 * are never touched, which is what makes a rollback to it meaningful, and it is why the new
 * revision's URL IS the cache bust: `resolveSimulationUrl` composes the served URL from
 * `active_revision_entry_key`, so moving the pointer changes the URL of every section of the
 * package in one row update instead of N.
 *
 * WHAT A DERIVED REVISION DELIBERATELY DOES NOT INHERIT
 * `posters` and `canary` reset. Both describe BYTES, and these are different bytes: a poster
 * captured from the base is keyed on the base's package revision, and a canary verdict earned by
 * the base says nothing about a package whose entry document just changed. Carrying either forward
 * would be the same class of error as the pre-050 code that let a canary against one package
 * decide how the player treats another. The visible consequence, stated plainly: publishing
 * guidance or replacing files drops the package back to `package_class = null` until it is
 * canaried again — which the player already reads as "unproven → legacy path", its safe default.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { sim_revisions, simulations } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import type { StorageService } from '../storage/StorageService.js';
import { RevisionService, type RevisionDbTx } from './RevisionService.js';
import { revisionFileKey, revisionManifestKey } from 'shared/sim/simRevision';
import {
  BRIDGE_CAPABILITIES_KEY,
  detectBridgeCapabilities,
  detectEntryCapabilities,
} from 'shared/sim/bridgeCapability';
import {
  SIM_MANIFEST_VERSION,
  type SimFileRole,
  type SimManifest,
  type SimManifestFile,
} from 'shared/sim/simManifest';

/**
 * The active revision's package could not be read, so no derivation is possible.
 *
 * Its own type because the caller's correct response differs from every other failure here: the
 * package that is being served is unreadable, which is an operational problem with the bytes, not
 * a conflict to retry and not a fault in the upload.
 */
export class ActiveRevisionUnreadable extends Error {
  readonly code = 'SIM_ACTIVE_REVISION_UNREADABLE';
  constructor(readonly revisionId: string, readonly detail: string) {
    super(
      `The active package revision (${revisionId}) could not be read, so this upload cannot be ` +
      `checked against the bridge that is actually being served: ${detail}`,
    );
    this.name = 'ActiveRevisionUnreadable';
  }
}

/**
 * This simulation has no active revision — it still serves from its mutable prefix.
 *
 * Thrown rather than returned as a null result so a caller cannot forget the case: every caller of
 * `deriveRevision` has a legacy path it must take instead, and silently doing nothing is the
 * failure mode this whole area exists to remove. Callers route on `readActiveRevisionId` up front;
 * this is the backstop for the pointer moving in between.
 */
export class NoActiveRevision extends Error {
  readonly code = 'SIM_NO_ACTIVE_REVISION';
  constructor(readonly simulationId: string) {
    super(`simulation ${simulationId} has no active revision`);
    this.name = 'NoActiveRevision';
  }
}

/** The live package a derivation starts from — read-only, and lazy about bytes. */
export interface BasePackageView {
  revisionId: string;
  /** The simulation's OWN prefix, as the row records it. `activate()` refuses any other. */
  storagePrefix: string;
  manifest: SimManifest;
  /** `manifest.entry`, hoisted because every transform needs it. */
  entryManifestPath: string;
  /**
   * `sim_revisions.metadata` of the base — the capability record among it.
   *
   * A transform needs this to avoid DOWNGRADING facts it cannot re-derive: `activate()` projects
   * `bridge_ack_capable` and `requires_import_maps` onto the simulations row from the NEW
   * revision's metadata, so a derivation that records nothing turns a proven capability back into
   * UNKNOWN and re-arms exactly the bounded cover P0.5 and P0.8 exist to remove.
   */
  metadata: Record<string, unknown> | null;
  /** Every base file, by manifest path. */
  byPath: ReadonlyMap<string, SimManifestFile>;
  /** Bytes of one base file. Throws when the path is not in the manifest. */
  read(manifestPath: string): Promise<Buffer>;
  /** Bytes of one base file, or null when it is absent from the manifest or unreadable. */
  readOptional(manifestPath: string): Promise<Buffer | null>;
}

/**
 * One file of the derived revision.
 *
 * `read` is a thunk, not a Buffer: a package can be 250 MB across a thousand files and the staging
 * loop streams it one file at a time. A transform that returns bytes it already holds simply
 * closes over them.
 */
export interface DerivedFile {
  manifestPath: string;
  role: SimFileRole;
  contentType: string;
  read: () => Promise<Buffer>;
}

/** What a transform returns: the COMPLETE file list of the new revision, and its entry. */
export interface DerivationPlan {
  files: DerivedFile[];
  entryManifestPath: string;
  /** Merged into the draft row's metadata, alongside the provenance this module records. */
  metadata?: Record<string, unknown>;
}

export type DerivationTransform = (base: BasePackageView) => Promise<DerivationPlan> | DerivationPlan;

export interface DerivationResult {
  revisionId: string;
  revisionNumber: number;
  /** The pointer value the compare-and-set was made against. */
  baseRevisionId: string;
  storagePrefix: string;
  entryManifestPath: string;
  /** Full storage key of the new entry document — what `active_revision_entry_key` becomes. */
  entryKey: string;
  files: SimManifestFile[];
}

/** The abort a caller's signal produces, named so callers can classify it like every other one. */
function derivationAbortError(): Error {
  const err = new Error('publication cancelled');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw derivationAbortError();
}

/**
 * The pointer, read from the row.
 *
 * Callers route on this IMMEDIATELY BEFORE writing rather than on a row loaded at the top of a
 * request: a simulation that gained its first revision in between would otherwise take the legacy
 * branch and write to a prefix nobody serves — this bug, arriving through the door that was left
 * open for it.
 */
export async function readActiveRevisionId(simulationId: string): Promise<string | null> {
  const [row] = await db
    .select({ active_revision_id: simulations.active_revision_id })
    .from(simulations)
    .where(eq(simulations.id, simulationId));
  return row?.active_revision_id ?? null;
}

/**
 * The manifest of a derived revision.
 *
 * Fields that describe the PACKAGE carry forward from the base — protocol versions, variants,
 * quality profiles, declared external dependencies — because a derivation changes some files, not
 * what kind of package this is. Fields that describe BYTES are recomputed or reset; see the module
 * header for why `posters` and `canary` are among them.
 */
export function buildDerivedManifest(opts: {
  base: SimManifest;
  simulationId: string;
  projectId: string;
  revisionId: string;
  revisionNumber: number;
  entryPath: string;
  files: SimManifestFile[];
  createdBy: string;
  generatedFrom?: SimManifest['generatedFrom'];
}): SimManifest {
  return {
    ...opts.base,
    manifestVersion: SIM_MANIFEST_VERSION,
    // Taken from the CALLER, not carried forward. `buildLegacyManifest` fills `projectId` from
    // `projectIdFromPrefix`, which yields an EMPTY STRING for any prefix it does not recognise —
    // so a base migrated from an unusual prefix carries a manifest that cannot say which project
    // it belongs to. Spreading that forward would propagate the blank through every future
    // revision; writing what the caller knows corrects it at the next publication.
    simulationId: opts.simulationId,
    projectId: opts.projectId,
    revisionId: opts.revisionId,
    revisionNumber: opts.revisionNumber,
    entry: opts.entryPath,
    runtime: opts.files.filter((f) => f.role === 'runtime').map((f) => f.path),
    files: opts.files,
    // Reset, not inherited — the base's posters are keyed on the base's package revision and its
    // paths are not in these files[]. `validateManifest` would reject them; more importantly they
    // would be a claim about bytes that were never captured.
    posters: [],
    canary: { classification: null, ranAt: null, engine: null },
    generatedFrom: opts.generatedFrom ?? opts.base.generatedFrom ?? {},
    createdAt: new Date().toISOString(),
    createdBy: opts.createdBy,
  };
}

/** Load the live package a derivation builds on. */
export async function readBasePackage(
  storage: Pick<StorageService, 'readObject'>,
  opts: {
    simulationId: string;
    storagePrefix: string;
    revisionId: string;
    /** The base revision row's metadata, when the caller has already loaded it. */
    metadata?: Record<string, unknown> | null;
  },
): Promise<BasePackageView> {
  const { storagePrefix, revisionId } = opts;
  const manifestKey = revisionManifestKey(storagePrefix, revisionId);

  let manifest: SimManifest;
  try {
    manifest = JSON.parse((await storage.readObject(manifestKey)).toString('utf-8')) as SimManifest;
  } catch (err) {
    throw new ActiveRevisionUnreadable(revisionId, `manifest ${manifestKey}: ${(err as Error).message}`);
  }
  if (!manifest.entry) {
    throw new ActiveRevisionUnreadable(revisionId, 'the manifest names no entry document');
  }

  const byPath = new Map((manifest.files ?? []).map((f) => [f.path, f]));
  const read = async (manifestPath: string): Promise<Buffer> => {
    if (!byPath.has(manifestPath)) {
      throw new ActiveRevisionUnreadable(revisionId, `${manifestPath} is not in the manifest`);
    }
    try {
      return await storage.readObject(revisionFileKey(storagePrefix, revisionId, manifestPath));
    } catch (err) {
      throw new ActiveRevisionUnreadable(revisionId, `${manifestPath}: ${(err as Error).message}`);
    }
  };

  return {
    revisionId,
    storagePrefix,
    manifest,
    entryManifestPath: manifest.entry,
    metadata: opts.metadata ?? null,
    byPath,
    read,
    readOptional: async (p) => (byPath.has(p) ? read(p).catch(() => null) : null),
  };
}

/**
 * The capability record a derived revision publishes (audit P0.5 / P0.8).
 *
 * Detected from the bytes THIS derivation is about to write, layered over whatever the base
 * recorded. Two rules, both about never manufacturing a confident `false`:
 *
 *   - the bridge half is detected ONLY when the derived package actually has a bridge.
 *     `detectBridgeCapabilities('')` returns `scriptApplied: false` — a claim about a bridge that
 *     does not exist, which the apply gate would act on;
 *   - anything this derivation cannot answer falls back to the BASE's record, because a file
 *     carried across byte-for-byte has exactly the capabilities it had before. Absent in both
 *     stays absent, and absent reads as UNKNOWN.
 */
export function derivedCapabilities(opts: {
  baseMetadata: Record<string, unknown> | null;
  /** The bridge the NEW revision will contain, or null when it will contain none. */
  bridgeJs: string | null;
  /** The entry document the NEW revision will contain, after every injection. */
  entryHtml: string;
}): Record<string, unknown> {
  const inherited = opts.baseMetadata?.[BRIDGE_CAPABILITIES_KEY];
  const carried = inherited && typeof inherited === 'object' ? inherited as Record<string, unknown> : {};
  return {
    ...carried,
    ...(opts.bridgeJs !== null ? detectBridgeCapabilities(opts.bridgeJs) : {}),
    ...detectEntryCapabilities(opts.entryHtml),
  };
}

/**
 * Derive, stage, validate and activate a new revision from the one that is live.
 *
 * Nothing outside the new revision's own prefix is written until the activation transaction, and
 * that transaction is the only thing that changes which bytes are served. Every failure before it
 * leaves the live package untouched and the abandoned draft marked `failed`, with its bytes in a
 * prefix nothing references.
 *
 * `onActivated` runs INSIDE that transaction, after the pointer flip. That placement is the whole
 * reason it exists: a caller's "this operation finished" row write — a status, a published
 * guidance payload — has to commit with the pointer or not at all. Written after `activate()`
 * returns, it would be a second transaction that can fail on its own, leaving a package that is
 * live and a row that says the job never finished. That is precisely the b-roll defect this branch
 * already fixed once (ef651a9: the adoption path published and left the job row in flight forever)
 * and it is not being reintroduced here.
 */
export async function deriveRevision(opts: {
  storage: StorageService;
  revisions?: RevisionService;
  simulationId: string;
  /** Descriptive only — it lands in the manifest; nothing resolves a path from it. */
  projectId: string;
  createdBy: string;
  /** Recorded on the draft row so an orphaned prefix can be traced to what made it. */
  trigger: string;
  transform: DerivationTransform;
  onActivated?: (tx: RevisionDbTx, result: DerivationResult) => Promise<void>;
  signal?: AbortSignal;
}): Promise<DerivationResult> {
  const revisions = opts.revisions ?? new RevisionService(opts.storage);

  // ── (1) THE POINTER READ THAT SEEDS THE COMPARE-AND-SET ────────────────────────────────────────
  // Taken before anything is built, and handed to activate() unchanged. Re-reading it later would
  // turn the CAS into "observe whoever won, then overwrite them".
  const [simRow] = await db
    .select({
      storage_prefix: simulations.storage_prefix,
      active_revision_id: simulations.active_revision_id,
    })
    .from(simulations)
    .where(eq(simulations.id, opts.simulationId));
  if (!simRow) throw new Error(`simulation ${opts.simulationId} not found`);
  if (!simRow.active_revision_id) throw new NoActiveRevision(opts.simulationId);

  const baseRevisionId = simRow.active_revision_id;
  // The row's OWN prefix. `activate()` refuses any other, and a derivation must write where the
  // pointer will be able to find it.
  const storagePrefix = (simRow.storage_prefix ?? '').replace(/\/+$/, '');

  // ── (2) DERIVE + TRANSFORM ─────────────────────────────────────────────────────────────────────
  const [baseRow] = await db
    .select({ metadata: sim_revisions.metadata })
    .from(sim_revisions)
    .where(and(
      eq(sim_revisions.id, baseRevisionId),
      eq(sim_revisions.simulation_id, opts.simulationId),
    ));
  const base = await readBasePackage(opts.storage, {
    simulationId: opts.simulationId,
    storagePrefix,
    revisionId: baseRevisionId,
    metadata: (baseRow?.metadata as Record<string, unknown> | null) ?? null,
  });
  const plan = await opts.transform(base);
  if (plan.files.length === 0) {
    throw new Error('derivation produced no files — refusing to publish an empty revision');
  }
  if (!plan.files.some((f) => f.manifestPath === plan.entryManifestPath)) {
    throw new Error(`derivation entry ${plan.entryManifestPath} is not among the files it produced`);
  }

  // ── (3) DRAFT → UPLOAD → VALIDATE ──────────────────────────────────────────────────────────────
  throwIfAborted(opts.signal);   // cheap bail BEFORE the draft row exists
  const draft = await revisions.createDraft({
    simulationId: opts.simulationId,
    createdBy: opts.createdBy,
    metadata: { trigger: opts.trigger, baseRevisionId, ...(plan.metadata ?? {}) },
  });
  const uploading = await revisions.beginUpload(opts.simulationId, draft.id);

  const files: SimManifestFile[] = [];
  try {
    for (const item of plan.files) {
      throwIfAborted(opts.signal);
      files.push(await revisions.writeFile(uploading, storagePrefix, {
        manifestPath: item.manifestPath,
        bytes: await item.read(),
        contentType: item.contentType,
        role: item.role,
      }));
    }
  } catch (err) {
    // Abandoned where it stands: bytes in a never-referenced prefix, row failed, live package
    // untouched. The GC sweeps the prefix; the row records what made it.
    await revisions.markFailed(opts.simulationId, draft.id, 'uploading', String(err).slice(0, 500))
      .catch(() => undefined);
    throw err;
  }

  const validating = await revisions.finishUpload(opts.simulationId, draft.id);
  const manifest = buildDerivedManifest({
    base: base.manifest,
    simulationId: opts.simulationId,
    projectId: opts.projectId,
    revisionId: draft.id,
    revisionNumber: draft.revisionNumber,
    entryPath: plan.entryManifestPath,
    files,
    createdBy: opts.createdBy,
  });

  // PR #31's capture-compatibility gate lives inside validate(): a package that cannot render
  // without a network is refused HERE, before it can become active, rather than months later as a
  // dead black canvas inside the capture container. Nothing in this module re-implements it.
  const verdict = await revisions.validate(opts.simulationId, validating, storagePrefix, { manifest });
  if (!verdict.ok) {
    // validate() already marked the revision failed, with every problem recorded on the row.
    throw new Error(
      'Revision failed verification: '
      + JSON.stringify({ manifest: verdict.problems, storage: verdict.verified.problems }).slice(0, 500),
    );
  }

  // ── (4) LAST ABORT POINT — after the build, before anything is served ──────────────────────────
  if (opts.signal?.aborted) {
    await revisions.markFailed(opts.simulationId, draft.id, 'canary_passed', 'publication aborted before activation')
      .catch(() => undefined);
    throw derivationAbortError();
  }

  const result: DerivationResult = {
    revisionId: draft.id,
    revisionNumber: draft.revisionNumber,
    baseRevisionId,
    storagePrefix,
    entryManifestPath: plan.entryManifestPath,
    entryKey: revisionFileKey(storagePrefix, draft.id, plan.entryManifestPath),
    files,
  };

  // ── (5) ACTIVATE: one transaction — demote, promote, pointer flip, caller's hook ────────────────
  try {
    await revisions.activate({
      simulationId: opts.simulationId,
      revisionId: draft.id,
      storagePrefix,
      expectedActiveRevisionId: baseRevisionId,
      supersede: 'retired',
      onActivated: opts.onActivated ? (tx) => opts.onActivated!(tx, result) : undefined,
    });
  } catch (err) {
    // A lost CAS (someone else activated first) or a throwing hook both roll the WHOLE transaction
    // back, so nothing this call staged is referenced anywhere. Retire the draft so a stale build
    // can never be activated later by something else.
    await revisions.markFailed(opts.simulationId, draft.id, 'canary_passed',
      `activation failed: ${String(err).slice(0, 300)}`).catch(() => undefined);
    throw err;
  }

  logger.info(
    { simulationId: opts.simulationId, trigger: opts.trigger, revisionId: draft.id,
      revisionNumber: draft.revisionNumber, baseRevisionId, files: files.length },
    'derived revision published and activated',
  );
  return result;
}
