/**
 * Staged publication of one immutable revision (Priority 7.4).
 *
 * THE PIPELINE, AND WHY IT IS IN THIS ORDER
 *
 *   create revision → upload every file → VERIFY THE STORED BYTES → serve the staged revision →
 *   canary → posters → write the manifest → verify the manifest → flip the pointer → retain
 *
 * Each step exists because the step before it cannot answer the question the step asks.
 *
 *  • VERIFY THE STORED BYTES is not paranoia about our own code. `uploadFile` reports success when
 *    the storage API returned 2xx; it has no opinion about what the object now contains. A truncated
 *    body, a proxy that re-encoded, a retried PUT that landed twice out of order, an adapter that
 *    silently wrote to a different key — every one of those reports success and stores something
 *    else. The only way to know what a viewer will receive is to read it back and hash it.
 *
 *  • THE MANIFEST IS WRITTEN LAST, after the canary report and the posters, and the pointer flips
 *    only after the manifest has been read back and re-verified. The manifest is what makes a
 *    revision resolvable; writing it first would mean an interrupted publication leaves a revision
 *    that *looks* complete and names files that were never uploaded. Written last, a partial
 *    revision is a directory of orphan objects that nothing can resolve — invisible, sweepable, and
 *    incapable of being served.
 *
 *  • NOTHING IS EVER OVERWRITTEN INSIDE A REVISION. A target key that already holds different bytes
 *    is refused, not skipped and not replaced: immutable cache headers (a year, `immutable`) are
 *    only correct because a revision URL cannot come to mean different bytes, and a single in-place
 *    overwrite retroactively invalidates that promise for every cache that already holds the old
 *    object. Refusing is also how a resumed publication is safe — identical bytes are a no-op,
 *    different bytes are a fault the operator has to see.
 *
 * FAILURE IS INVISIBLE, BY CONSTRUCTION
 * Everything before `activate` writes only to the NEW revision's own prefix and to that revision's
 * own row. The active pointer is not touched, so a publication that fails at any of those steps is
 * not a degraded live package — it is a live package that never changed. `activate` is the commit,
 * and it is a single compare-and-set: if another publication moved the pointer while this one was
 * running, this one refuses rather than clobbering it.
 *
 * `retain` runs AFTER the commit and therefore may never fail the publication. Marking a
 * now-serving revision `failed` would be a lie, and un-flipping the pointer to "undo" a completed
 * publication is a second, unreviewed pointer move. So `retain` verifies and REPORTS — its findings
 * arrive as warnings on a successful result.
 *
 * DEPENDENCIES ARE INJECTED, NOT IMPORTED
 * The revision table, the storage adapter, the canary driver, the poster capturer and the serving
 * layer all arrive through narrow ports. That is not for testability alone: it is what stops this
 * file from importing the whole product and, more importantly, what makes "which pointer did this
 * run read" and "which bytes did this run store" observable facts rather than global state.
 */

import { createHash } from 'node:crypto';

import type { CanaryCase, CanaryReport } from 'shared/src/sim/canaryContract';
import {
  POSTER_CONTENT_TYPES,
  formatsFor,
  posterIdentityString,
  posterStoragePath,
  sanitizeVariant,
  type PosterFormat,
  type PosterKey,
  type PosterSizeName,
} from 'shared/src/sim/posterIdentity';
import { isPresentable } from 'shared/src/sim/simFailurePolicy';
import {
  computeConfigHash,
  type SimAspectProfile,
  type SimPresentationConfig,
  type SimQualityProfile,
  type VariantKey,
} from 'shared/src/sim/simIdentity';
import {
  SIM_MANIFEST_VERSION,
  computeManifestHash,
  normalizeManifestPath,
  validateManifest,
  type SimFileRole,
  type SimManifest,
  type SimManifestFile,
  type SimManifestPoster,
} from 'shared/src/sim/simManifest';
import {
  CANARY_SUBDIR,
  IMMUTABLE_CACHE_CONTROL,
  MANIFEST_FILENAME,
  PACKAGE_SUBDIR,
  POSTERS_SUBDIR,
  RUNTIME_SUBDIR,
  canTransition,
  isValidRevisionId,
  mustRetainBytes,
  packageRevisionOf,
  revisionFileKey,
  revisionManifestKey,
  revisionPrefix,
  type SimRevisionRecord,
  type SimRevisionStatus,
} from 'shared/src/sim/simRevision';

import { classificationIsHonest, isCanaryReportComplete, judgeCanaryReport } from './canaryJudge.js';

// ─── Steps ────────────────────────────────────────────────────────────────────────────────────

export const PUBLICATION_STEPS = [
  'create-revision',
  'upload-files',
  'verify-bytes',
  'serve-staged',
  'canary',
  'posters',
  'write-manifest',
  'verify-manifest',
  'activate',
  'retain',
] as const;

export type PublicationStep = (typeof PUBLICATION_STEPS)[number];

/**
 * The commit point. Steps at or before it write only to the new revision; the step after it runs
 * on a package that is already live and therefore reports instead of failing.
 */
export const PUBLICATION_COMMIT_STEP: PublicationStep = 'activate';

export type PublicationFailureCode =
  /** The request could not describe a publishable package. Nothing was created. */
  | 'invalid-request'
  /** A caller-supplied path lands where this pipeline's own files live. */
  | 'reserved-path'
  /** A caller declared a hash its own bytes do not have. */
  | 'declared-hash-mismatch'
  /** A target key already exists holding DIFFERENT bytes. Never overwritten. */
  | 'key-conflict'
  | 'upload-failed'
  | 'readback-failed'
  /** What was read back is not what was written. */
  | 'stored-bytes-differ'
  | 'staged-unreachable'
  | 'canary-incomplete'
  | 'canary-dishonest'
  | 'canary-failed'
  /** The report describes a different package or revision than the one being published. */
  | 'canary-mismatched'
  | 'poster-capture-failed'
  /** The canary would grant the modern path, but a case has no poster to fall back to. */
  | 'poster-missing'
  | 'manifest-invalid'
  | 'manifest-readback-differs'
  | 'config-unreadable'
  | 'config-hash-mismatch'
  | 'missing-file'
  /** The pointer moved while this publication was running. */
  | 'activation-conflict'
  | 'store-error'
  | 'not-resumable';

export interface PublicationFailure {
  code: PublicationFailureCode;
  step: PublicationStep;
  message: string;
  detail?: string;
}

// ─── Ports ────────────────────────────────────────────────────────────────────────────────────

export interface RevisionPatch {
  status?: SimRevisionStatus;
  manifestHash?: string | null;
  bridgeProtocolVersion?: number | null;
  runtimeProtocolVersion?: number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The slice of the revision table this pipeline uses.
 *
 * `activateRevision` and `rollbackToRevision` are specified as ATOMIC: they move the pointer and
 * both affected rows together or not at all. That is a requirement on the implementation, not a
 * hint — a pointer that names a revision whose row still says `canary_passed` is a revision the
 * serving layer will refuse to serve (`isServable` is `status === 'active'`), which turns a
 * successful publication into an outage.
 */
export interface RevisionStore {
  createRevision(input: {
    simulationId: string;
    createdBy: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<SimRevisionRecord>;

  getRevision(revisionId: string): Promise<SimRevisionRecord | null>;
  listRevisions(simulationId: string): Promise<SimRevisionRecord[]>;
  getActiveRevisionId(simulationId: string): Promise<string | null>;
  updateRevision(revisionId: string, patch: RevisionPatch): Promise<SimRevisionRecord>;

  /**
   * Compare-and-set the active pointer.
   *
   * `expectedCurrentActiveId` is the pointer this publication READ before it started doing work. A
   * store that finds a different value must reject: the alternative is a slow publication silently
   * overwriting a newer one, which is exactly the "a message that is true about some past state is
   * applied to the present" defect the whole revision model exists to close.
   */
  activateRevision(input: {
    simulationId: string;
    revisionId: string;
    expectedCurrentActiveId: string | null;
  }): Promise<{ previousActiveId: string | null }>;

  /**
   * Restore a previously-active revision. Distinct from `activateRevision` because the revision it
   * moves AWAY from becomes `rolled_back`, not `retired` — that difference is the audit record of a
   * human judgement, and it is the first thing anyone asks for after an incident.
   */
  rollbackToRevision(input: {
    simulationId: string;
    targetRevisionId: string;
    expectedCurrentActiveId: string | null;
    reason: string;
  }): Promise<{ previousActiveId: string | null }>;
}

/** The slice of `StorageService` this pipeline uses. Satisfied structurally by every adapter. */
export interface RevisionStorage {
  uploadFile(path: string, data: Buffer, contentType: string, cacheControl?: string): Promise<string>;
  readObject(key: string): Promise<Buffer>;
  objectExists(key: string): Promise<boolean>;
}

export interface ProbeResult {
  ok: boolean;
  status: number;
  contentType: string | null;
}

/**
 * How a staged revision is reached before it is live.
 *
 * There is deliberately NO staging pointer. A revision file's URL is a pure function of its key, so
 * a staged revision is already addressable without anything mutable naming it — and a second
 * mutable pointer would be a second thing that can be stale, cached, or forgotten after a rollback.
 */
export interface StagedServingPort {
  /** The URL a browser loads for a storage key. */
  urlFor(storageKey: string): string;
  /** Confirm the staged bytes are reachable THROUGH the serving layer, not just the adapter. */
  probe(url: string): Promise<ProbeResult>;
}

export interface StagedCanaryInput {
  simulationId: string;
  projectId: string;
  revisionId: string;
  packageRevision: string;
  /** URL of the staged entry document. */
  entryUrl: string;
  /** URL for any other manifest-relative path of this revision. */
  urlFor(manifestPath: string): string;
  cases: readonly CanaryCase[];
}

export interface StagedCanaryPort {
  run(input: StagedCanaryInput): Promise<CanaryReport>;
}

/** One captured poster, ready to be stored inside the revision. */
export interface CapturedPoster {
  key: PosterKey;
  transparent: boolean;
  renditions: readonly {
    size: PosterSizeName;
    format: PosterFormat;
    bytes: Buffer;
    width: number;
    height: number;
  }[];
}

export interface StagedPosterInput extends StagedCanaryInput {
  /** The verdict the canary reached, so a capturer can skip work a failed package cannot use. */
  canary: CanaryReport;
}

export interface StagedPosterPort {
  capture(input: StagedPosterInput): Promise<readonly CapturedPoster[]>;
}

export interface PublicationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface PublicationDeps {
  revisions: RevisionStore;
  storage: RevisionStorage;
  serving: StagedServingPort;
  canary: StagedCanaryPort;
  posters: StagedPosterPort;
  /** Injected so a publication that takes minutes is stamped consistently and is reproducible. */
  now?: () => Date;
  logger?: PublicationLogger;
}

// ─── Request ──────────────────────────────────────────────────────────────────────────────────

export interface PublicationFile {
  /** Manifest-relative path: `package/…` for customer bytes, `runtime/…` for generated ones. */
  path: string;
  role: Extract<SimFileRole, 'entry' | 'runtime' | 'asset'>;
  contentType: string;
  bytes: Buffer;
  /**
   * The hash the caller believes these bytes have. CROSS-CHECKED, never trusted: a producer whose
   * declared hash disagrees with the buffer it handed over has already lost track of its own output,
   * and publishing it would put that disagreement into the manifest as if it were proof.
   */
  expectedHash?: string;
}

export interface PublicationVariant {
  variantKey: VariantKey;
  /**
   * Every presentation configuration this variant is published for. Aspect and quality are read
   * from the configuration itself — they are fields of `SimPresentationConfig`, and taking them
   * from anywhere else is how a poster ends up keyed for an aspect the section never requests.
   */
  configs: readonly SimPresentationConfig[];
}

export interface PublicationRequest {
  simulationId: string;
  projectId: string;
  createdBy?: string | null;
  files: readonly PublicationFile[];
  /** Manifest-relative path of the document the iframe loads. */
  entry: string;
  /** Manifest-relative paths of the generated boot runtime (bridge.js, guidance.js). */
  runtime: readonly string[];
  variants: readonly PublicationVariant[];
  externalDependencies?: readonly string[];
  /** What the entry HTML and runtime actually load, for the manifest's reference check. */
  referencedPaths?: readonly string[];
  bridgeProtocolVersion: number;
  runtimeProtocolVersion: number;
  generatedFrom?: SimManifest['generatedFrom'];
  /** Continue an interrupted publication instead of minting a new revision. */
  resumeRevisionId?: string;
  /** Refuse to publish unless the canary grants the activation-scoped path. */
  requireModern?: boolean;
}

// ─── Result ───────────────────────────────────────────────────────────────────────────────────

export interface PublicationCanarySummary {
  classification: CanaryReport['classification'];
  complete: boolean;
  honest: boolean;
  mayPublishAsModern: boolean;
  engine: string | null;
  ranAt: string | null;
}

export interface PublicationResult {
  ok: boolean;
  revisionId: string | null;
  revisionNumber: number | null;
  packageRevision: string | null;
  manifestHash: string | null;
  /** On success the last step; on failure the step that failed. */
  reachedStep: PublicationStep;
  completedSteps: PublicationStep[];
  failure: PublicationFailure | null;
  /** The pointer as it was read before any work. Unchanged unless `activate` completed. */
  previousActiveRevisionId: string | null;
  /** The pointer as it stands after this run. */
  activeRevisionId: string | null;
  /** The revision a rollback would restore after this publication. */
  retainedForRollbackId: string | null;
  stagedEntryUrl: string | null;
  canary: PublicationCanarySummary | null;
  /** Post-commit findings and non-fatal notes. Never a reason to fail. */
  warnings: string[];
}

// ─── Progress (resumability) ──────────────────────────────────────────────────────────────────

/**
 * What a resumed run needs in order to skip a step it already paid for.
 *
 * This is a HINT, never a proof: `verify-manifest` re-reads every file named by the STORED manifest
 * and re-hashes it, so a progress record that lies about what was uploaded cannot produce a
 * publishable revision — it can only produce a failure at the verify step.
 */
interface PublicationProgress {
  completedSteps: PublicationStep[];
  files: SimManifestFile[];
  posters: SimManifestPoster[];
  manifestHash: string | null;
  canary: PublicationCanarySummary | null;
}

const PROGRESS_KEY = 'publication';

function emptyProgress(): PublicationProgress {
  return { completedSteps: [], files: [], posters: [], manifestHash: null, canary: null };
}

/**
 * Read a progress record out of a JSONB blob.
 *
 * Anything unrecognised degrades to "nothing was completed", which re-runs steps rather than
 * skipping them. That is the safe direction: re-uploading an identical file is a no-op, whereas
 * skipping an upload that never happened produces a manifest naming bytes that do not exist.
 */
function readProgress(metadata: Record<string, unknown> | null | undefined): PublicationProgress {
  const raw = metadata?.[PROGRESS_KEY];
  if (!raw || typeof raw !== 'object') return emptyProgress();
  const p = raw as Partial<PublicationProgress>;
  const steps = Array.isArray(p.completedSteps)
    ? p.completedSteps.filter((s): s is PublicationStep =>
        (PUBLICATION_STEPS as readonly string[]).includes(s as string))
    : [];
  return {
    completedSteps: steps,
    files: Array.isArray(p.files) ? (p.files as SimManifestFile[]) : [],
    posters: Array.isArray(p.posters) ? (p.posters as SimManifestPoster[]) : [],
    manifestHash: typeof p.manifestHash === 'string' ? p.manifestHash : null,
    canary: p.canary && typeof p.canary === 'object' ? (p.canary as PublicationCanarySummary) : null,
  };
}

/** Statuses a publication can be picked back up from. `failed` is terminal by the state machine. */
const RESUMABLE_STATUSES: readonly SimRevisionStatus[] = ['draft', 'uploading', 'validating', 'canary_passed'];

/**
 * How far along the publication a status means the revision got.
 *
 * Only used to decide whether a status change has ALREADY happened; it is not an alternative to
 * `canTransition`, which remains the authority on whether a move is legal. `failed` ranks below
 * everything so that a failed revision can never be advanced by a resumed run.
 */
const STATUS_RANK: Readonly<Record<SimRevisionStatus, number>> = {
  failed: -1,
  draft: 0,
  uploading: 1,
  validating: 2,
  canary_passed: 3,
  active: 4,
  retired: 5,
  rolled_back: 5,
};

// ─── Paths this pipeline owns ─────────────────────────────────────────────────────────────────

/** Manifest-relative prefixes a caller may never write into — they are this pipeline's own. */
const RESERVED_PREFIXES = [`${POSTERS_SUBDIR}/`, `${CANARY_SUBDIR}/`, `${RUNTIME_SUBDIR}/presentation/`];

/** Where the canary's own evidence is retained with the revision it judged. */
export const CANARY_REPORT_PATH = `${CANARY_SUBDIR}/report.json`;

/**
 * Where one variant's presentation configuration is stored, manifest-relative.
 *
 * Under `runtime/` because it is GENERATED — the customer never authors it — and the layout keeps
 * customer bytes in `package/` precisely so a customer file can never shadow one of ours. It is
 * deliberately NOT listed in `manifest.runtime[]`: that array is the boot runtime a reader is
 * expected to load as script, and a JSON config in it would be fetched as one.
 */
export function presentationConfigPath(variantKey: VariantKey, configHash: string): string {
  return `${RUNTIME_SUBDIR}/presentation/${sanitizeVariant(variantKey)}/${configHash}.json`;
}

/**
 * Deterministic bytes for a stored presentation config.
 *
 * Normalised the same way `canonicalizeConfig` normalises before hashing — selectors deduplicated
 * and sorted, `transparent` reduced to a boolean, absent `initialState` written as null — so the
 * round trip `serialize → parse → computeConfigHash` returns the hash the manifest recorded. A
 * serializer that preserved the caller's incidental ordering would still hash the same today and
 * would stop doing so the moment anything re-serialised it.
 */
export function serializePresentationConfig(config: SimPresentationConfig): Buffer {
  const initial = config.initialState ?? null;
  const orderedInitial = initial
    ? Object.fromEntries(Object.keys(initial).sort().map((k) => [k, initial[k]]))
    : null;
  return Buffer.from(
    JSON.stringify(
      {
        simpleUi: config.simpleUi === true,
        hideSelectors: [...new Set(config.hideSelectors)].sort(),
        autoScript: config.autoScript === true,
        quality: config.quality,
        aspect: config.aspect,
        transparent: config.transparent === true,
        initialState: orderedInitial,
      },
      null,
      2,
    ),
    'utf8',
  );
}

const QUALITIES: readonly SimQualityProfile[] = ['high', 'balanced', 'low'];
const ASPECTS: readonly SimAspectProfile[] = ['wide', 'standard', 'portrait', 'native'];

/**
 * Parse a stored config back, or null.
 *
 * Strict about the two enum fields because they reach a storage path and a poster key: an unknown
 * `aspect` would mint a poster directory no activation can ask for, which presents as "the poster
 * silently stopped working" rather than as an error.
 */
export function parsePresentationConfig(raw: unknown): SimPresentationConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.simpleUi !== 'boolean' || typeof o.autoScript !== 'boolean') return null;
  if (!QUALITIES.includes(o.quality as SimQualityProfile)) return null;
  if (!ASPECTS.includes(o.aspect as SimAspectProfile)) return null;
  if (!Array.isArray(o.hideSelectors) || o.hideSelectors.some((s) => typeof s !== 'string')) return null;
  const initialState = o.initialState;
  if (initialState !== null && initialState !== undefined) {
    if (typeof initialState !== 'object' || Array.isArray(initialState)) return null;
    for (const v of Object.values(initialState as Record<string, unknown>)) {
      const t = typeof v;
      if (v !== null && t !== 'string' && t !== 'number' && t !== 'boolean') return null;
    }
  }
  return {
    simpleUi: o.simpleUi,
    hideSelectors: o.hideSelectors as string[],
    autoScript: o.autoScript,
    quality: o.quality as SimQualityProfile,
    aspect: o.aspect as SimAspectProfile,
    initialState: (initialState as SimPresentationConfig['initialState']) ?? null,
    transparent: o.transparent === true,
  };
}

// ─── Verification helpers (exported: the rollback CLI runs the same checks) ───────────────────

export const sha256OfBuffer = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export interface StoredFileProblem {
  path: string;
  reason: 'missing' | 'unreadable' | 'hash-mismatch' | 'size-mismatch';
  detail?: string;
}

/**
 * Every file a manifest names, checked against what storage actually holds.
 *
 * Used by BOTH publication (before the pointer flips forward) and rollback (before the pointer
 * flips back). One implementation, because "the bytes are all there" must mean the same thing in
 * both directions — a rollback to a revision whose objects were swept is worse than not rolling
 * back, and it would be discovered by exactly this check or not at all.
 */
export async function verifyStoredFiles(
  storage: Pick<RevisionStorage, 'readObject' | 'objectExists'>,
  keyFor: (manifestPath: string) => string,
  files: readonly SimManifestFile[],
): Promise<StoredFileProblem[]> {
  const problems: StoredFileProblem[] = [];
  for (const file of files) {
    const key = keyFor(file.path);
    let bytes: Buffer;
    try {
      if (!(await storage.objectExists(key))) {
        problems.push({ path: file.path, reason: 'missing' });
        continue;
      }
      bytes = await storage.readObject(key);
    } catch (err) {
      problems.push({ path: file.path, reason: 'unreadable', detail: messageOf(err) });
      continue;
    }
    const actual = sha256OfBuffer(bytes);
    if (actual !== file.hash) {
      problems.push({
        path: file.path,
        reason: 'hash-mismatch',
        detail: `manifest ${file.hash}, stored ${actual}`,
      });
      continue;
    }
    // Size is redundant with the hash for detecting corruption, but it is NOT redundant for
    // detecting a manifest whose byte counts were computed from a different form of the file —
    // which is what a caller-supplied `bytes` field would silently introduce.
    if (bytes.length !== file.bytes) {
      problems.push({
        path: file.path,
        reason: 'size-mismatch',
        detail: `manifest ${file.bytes}, stored ${bytes.length}`,
      });
    }
  }
  return problems;
}

export interface ConfigProblem {
  variantKey: string;
  configHash: string;
  path: string;
  reason: 'not-in-manifest' | 'unreadable' | 'unparseable' | 'hash-mismatch';
  detail?: string;
}

/**
 * Every variant's presentation configuration, re-hashed from the STORED bytes.
 *
 * The manifest claims "this variant is published for configuration X". The claim is only worth
 * something if the configuration the package will actually be presented with hashes to X — a
 * mismatch means posters were captured for one picture and the runtime will be handed another, and
 * neither side can detect it on its own because each is internally consistent.
 */
export async function verifyPresentationConfigs(
  storage: Pick<RevisionStorage, 'readObject' | 'objectExists'>,
  keyFor: (manifestPath: string) => string,
  manifest: Pick<SimManifest, 'variants' | 'files'>,
): Promise<ConfigProblem[]> {
  const problems: ConfigProblem[] = [];
  const known = new Set(manifest.files.map((f) => f.path));

  for (const variant of manifest.variants) {
    for (const configHash of variant.configHashes) {
      const path = presentationConfigPath(variant.variantKey, configHash);
      if (!known.has(path)) {
        problems.push({ variantKey: variant.variantKey, configHash, path, reason: 'not-in-manifest' });
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse((await storage.readObject(keyFor(path))).toString('utf8'));
      } catch (err) {
        problems.push({
          variantKey: variant.variantKey,
          configHash,
          path,
          reason: 'unreadable',
          detail: messageOf(err),
        });
        continue;
      }
      const config = parsePresentationConfig(raw);
      if (!config) {
        problems.push({ variantKey: variant.variantKey, configHash, path, reason: 'unparseable' });
        continue;
      }
      let actual: string;
      try {
        actual = computeConfigHash(config);
      } catch (err) {
        problems.push({
          variantKey: variant.variantKey,
          configHash,
          path,
          reason: 'unparseable',
          detail: messageOf(err),
        });
        continue;
      }
      if (actual !== configHash) {
        problems.push({
          variantKey: variant.variantKey,
          configHash,
          path,
          reason: 'hash-mismatch',
          detail: `stored config hashes to ${actual}`,
        });
      }
    }
  }
  return problems;
}

/**
 * Read and structurally check a revision's manifest.
 *
 * Returns the manifest only when it parses, is a version we understand, describes THIS revision,
 * and passes `validateManifest`. A manifest that describes another revision is the more dangerous
 * of the two failures: it is internally valid, so every check downstream of it passes while
 * describing bytes that live somewhere else entirely.
 */
export async function loadRevisionManifest(
  storage: Pick<RevisionStorage, 'readObject' | 'objectExists'>,
  projectId: string,
  simulationId: string,
  revisionId: string,
): Promise<{ manifest: SimManifest } | { error: string }> {
  const key = revisionManifestKey(projectId, simulationId, revisionId);
  let parsed: unknown;
  try {
    if (!(await storage.objectExists(key))) return { error: `manifest not found at ${key}` };
    parsed = JSON.parse((await storage.readObject(key)).toString('utf8'));
  } catch (err) {
    return { error: `manifest at ${key} is unreadable: ${messageOf(err)}` };
  }
  if (!parsed || typeof parsed !== 'object') return { error: `manifest at ${key} is not an object` };
  const manifest = parsed as SimManifest;
  if (manifest.manifestVersion !== SIM_MANIFEST_VERSION) {
    return { error: `manifest version ${String(manifest.manifestVersion)} is not supported` };
  }
  if (manifest.revisionId !== revisionId || manifest.simulationId !== simulationId) {
    return {
      error:
        `manifest at ${key} describes ${manifest.simulationId}/${manifest.revisionId}, ` +
        `not ${simulationId}/${revisionId}`,
    };
  }
  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    return { error: `manifest is invalid: ${problems.map((p) => `${p.code} (${p.detail})`).join('; ')}` };
  }
  return { manifest };
}

// ─── Internal error carrier ───────────────────────────────────────────────────────────────────

class StepError extends Error {
  constructor(
    readonly code: PublicationFailureCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const NO_LOG: PublicationLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ─── Service ──────────────────────────────────────────────────────────────────────────────────

export class PublicationService {
  private readonly now: () => Date;
  private readonly log: PublicationLogger;

  constructor(private readonly deps: PublicationDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.logger ?? NO_LOG;
  }

  async publish(request: PublicationRequest): Promise<PublicationResult> {
    // Read the pointer FIRST and keep it. Everything downstream compares against this value, so a
    // concurrent publication is detected at the commit rather than silently overwritten.
    let previousActiveId: string | null;
    try {
      previousActiveId = await this.deps.revisions.getActiveRevisionId(request.simulationId);
    } catch (err) {
      return failedResult(
        { code: 'store-error', step: 'create-revision', message: `cannot read the active pointer: ${messageOf(err)}` },
        { previousActiveRevisionId: null, activeRevisionId: null },
      );
    }

    const state: RunState = {
      request,
      revision: null,
      packageRevision: null,
      progress: emptyProgress(),
      metadata: null,
      canaryReport: null,
      stagedEntryUrl: null,
      previousActiveId,
      activeId: previousActiveId,
      retainedId: previousActiveId,
      warnings: [],
    };

    let reached: PublicationStep = PUBLICATION_STEPS[0];

    for (const step of PUBLICATION_STEPS) {
      if (state.progress.completedSteps.includes(step)) continue;
      reached = step;
      try {
        await this.runStep(step, state);
      } catch (err) {
        // `retain` runs after the commit. Its findings are reportable, never reversible: the
        // revision is already serving, and "undoing" a completed publication by moving the pointer
        // again is a second, unreviewed pointer move nobody asked for.
        if (step === 'retain') {
          state.warnings.push(`retain: ${messageOf(err)}`);
          state.progress.completedSteps.push(step);
          break;
        }
        return await this.abort(state, step, err);
      }
      state.progress.completedSteps.push(step);
      await this.persistProgress(state);
    }

    this.log.info(
      { simulationId: request.simulationId, revisionId: state.revision?.id, manifestHash: state.progress.manifestHash },
      '[publication] revision published',
    );

    return {
      ok: true,
      revisionId: state.revision?.id ?? null,
      revisionNumber: state.revision?.revisionNumber ?? null,
      packageRevision: state.packageRevision,
      manifestHash: state.progress.manifestHash,
      reachedStep: reached,
      completedSteps: [...state.progress.completedSteps],
      failure: null,
      previousActiveRevisionId: state.previousActiveId,
      activeRevisionId: state.activeId,
      retainedForRollbackId: state.retainedId,
      stagedEntryUrl: state.stagedEntryUrl,
      canary: state.progress.canary,
      warnings: state.warnings,
    };
  }

  // ── Step dispatch ───────────────────────────────────────────────────────────────────────────

  private async runStep(step: PublicationStep, state: RunState): Promise<void> {
    switch (step) {
      case 'create-revision': return this.stepCreateRevision(state);
      case 'upload-files': return this.stepUploadFiles(state);
      case 'verify-bytes': return this.stepVerifyBytes(state);
      case 'serve-staged': return this.stepServeStaged(state);
      case 'canary': return this.stepCanary(state);
      case 'posters': return this.stepPosters(state);
      case 'write-manifest': return this.stepWriteManifest(state);
      case 'verify-manifest': return this.stepVerifyManifest(state);
      case 'activate': return this.stepActivate(state);
      case 'retain': return this.stepRetain(state);
    }
  }

  // ── 1. create ───────────────────────────────────────────────────────────────────────────────

  private async stepCreateRevision(state: RunState): Promise<void> {
    const { request } = state;
    // Validate BEFORE anything is created. A malformed request that has already minted a revision
    // row leaves a `draft` nobody will ever finish, and the operator has to tell it apart from a
    // publication that is still running.
    validateRequest(request);

    if (request.resumeRevisionId) {
      const existing = await this.callStore(() => this.deps.revisions.getRevision(request.resumeRevisionId!));
      if (!existing) {
        throw new StepError('not-resumable', `revision ${request.resumeRevisionId} does not exist`);
      }
      if (existing.simulationId !== request.simulationId) {
        throw new StepError(
          'not-resumable',
          `revision ${existing.id} belongs to simulation ${existing.simulationId}, not ${request.simulationId}`,
        );
      }
      if (!RESUMABLE_STATUSES.includes(existing.status)) {
        // `failed` has no outgoing transitions by design, and `active`/`retired` are finished work.
        throw new StepError('not-resumable', `revision ${existing.id} is '${existing.status}' — publish a new revision`);
      }
      state.revision = existing;
      state.metadata = existing.metadata ?? null;
      state.progress = readProgress(existing.metadata);
      // `create-revision` is complete for a resumed run by definition; the loop is what marks it.
    } else {
      const created = await this.callStore(() =>
        this.deps.revisions.createRevision({
          simulationId: request.simulationId,
          createdBy: request.createdBy ?? null,
          metadata: { [PROGRESS_KEY]: emptyProgress() },
        }),
      );
      state.revision = created;
      state.metadata = created.metadata ?? null;
      state.progress = readProgress(created.metadata);
    }

    const revision = state.revision;
    if (!isValidRevisionId(revision.id)) {
      // The id becomes a path segment in every object this revision stores and the input to
      // `packageRevisionOf`. An id that is not URL-safe produces keys that cannot be served.
      throw new StepError('store-error', `revision id ${JSON.stringify(revision.id)} is not URL-safe`);
    }
    state.packageRevision = packageRevisionOf(revision.id);
  }

  // ── 2. upload ───────────────────────────────────────────────────────────────────────────────

  private async stepUploadFiles(state: RunState): Promise<void> {
    await this.transition(state, 'uploading');
    const files: SimManifestFile[] = [];

    for (const file of state.request.files) {
      const hash = sha256OfBuffer(file.bytes);
      if (file.expectedHash && file.expectedHash !== hash) {
        throw new StepError(
          'declared-hash-mismatch',
          `${file.path}: caller declared ${file.expectedHash} but the bytes hash to ${hash}`,
        );
      }
      await this.putOnce(state, file.path, file.bytes, file.contentType);
      files.push(manifestEntry(file.path, file.role, hash, file.bytes.length, file.contentType));
    }

    // Presentation configs are part of the revision's bytes, not of its description: the manifest
    // says which configurations exist, and these files are what "that configuration" IS.
    for (const variant of state.request.variants) {
      for (const configHash of distinctConfigHashes(variant)) {
        const config = variant.configs.find((c) => computeConfigHash(c) === configHash)!;
        const path = presentationConfigPath(variant.variantKey, configHash);
        const bytes = serializePresentationConfig(config);
        await this.putOnce(state, path, bytes, 'application/json');
        files.push(manifestEntry(path, 'runtime', sha256OfBuffer(bytes), bytes.length, 'application/json'));
      }
    }

    state.progress.files = files;
  }

  // ── 3. verify what was stored ───────────────────────────────────────────────────────────────

  private async stepVerifyBytes(state: RunState): Promise<void> {
    const problems = await verifyStoredFiles(
      this.deps.storage,
      (path) => this.keyFor(state, path),
      state.progress.files,
    );
    if (problems.length > 0) {
      throw new StepError(
        problems.every((p) => p.reason === 'missing') ? 'missing-file' : 'stored-bytes-differ',
        `${problems.length} stored file(s) do not match what was written`,
        describeFileProblems(problems),
      );
    }
  }

  // ── 4. serve the staged revision ────────────────────────────────────────────────────────────

  private async stepServeStaged(state: RunState): Promise<void> {
    const entryKey = this.keyFor(state, state.request.entry);
    const url = this.deps.serving.urlFor(entryKey);
    state.stagedEntryUrl = url;

    let probe: ProbeResult;
    try {
      probe = await this.deps.serving.probe(url);
    } catch (err) {
      throw new StepError('staged-unreachable', `staged entry ${url} could not be probed: ${messageOf(err)}`);
    }
    if (!probe.ok) {
      throw new StepError('staged-unreachable', `staged entry ${url} responded ${probe.status}`);
    }
    // A public object store that force-downgrades `text/html` to `text/plain` (Supabase does, as
    // anti-phishing) serves an iframe the literal source of the document. The bytes are correct and
    // every hash check passes; only a probe through the SERVING layer can see it.
    if (probe.contentType && !/^text\/html\b/i.test(probe.contentType)) {
      throw new StepError(
        'staged-unreachable',
        `staged entry ${url} is served as ${probe.contentType}, not text/html`,
      );
    }
  }

  // ── 5. canary ───────────────────────────────────────────────────────────────────────────────

  private async stepCanary(state: RunState): Promise<void> {
    const input = this.stagedInput(state);

    let report: CanaryReport;
    try {
      report = await this.deps.canary.run(input);
    } catch (err) {
      throw new StepError('canary-failed', `the canary run threw: ${messageOf(err)}`);
    }

    if (report.simulationId !== state.request.simulationId || report.packageRevision !== state.packageRevision) {
      // A report about another package would certify bytes nobody is publishing, and it would do so
      // while looking exactly like a passing run.
      throw new StepError(
        'canary-mismatched',
        `the report describes ${report.simulationId}@${report.packageRevision}, ` +
        `not ${state.request.simulationId}@${state.packageRevision}`,
      );
    }
    if (!isCanaryReportComplete(report)) {
      throw new StepError('canary-incomplete', 'the canary run left steps undecided — it observed nothing conclusive');
    }
    if (!classificationIsHonest(report)) {
      throw new StepError(
        'canary-dishonest',
        `the report is stamped '${report.classification}' but its own evidence does not support it`,
      );
    }

    const decision = judgeCanaryReport(report);
    if (!isPresentable(decision.classification)) {
      throw new StepError('canary-failed', `the canary classified this package as '${decision.classification}'`,
        decision.reasons.join('; '));
    }
    if (state.request.requireModern && !decision.mayPublishAsModern) {
      throw new StepError(
        'canary-failed',
        `the modern path was required but the canary granted '${decision.classification}'`,
        decision.reasons.join('; '),
      );
    }

    const bytes = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
    await this.putOnce(state, CANARY_REPORT_PATH, bytes, 'application/json');
    state.progress.files.push(
      manifestEntry(CANARY_REPORT_PATH, 'canary', sha256OfBuffer(bytes), bytes.length, 'application/json'),
    );

    state.canaryReport = report;
    state.progress.canary = {
      classification: decision.classification,
      complete: decision.complete,
      honest: decision.honest,
      mayPublishAsModern: decision.mayPublishAsModern,
      engine: report.engine,
      ranAt: report.finishedAt,
    };
  }

  // ── 6. posters ──────────────────────────────────────────────────────────────────────────────

  private async stepPosters(state: RunState): Promise<void> {
    const report = state.canaryReport ?? (await this.reloadCanaryReport(state));
    const input: StagedPosterInput = { ...this.stagedInput(state), canary: report };

    let captured: readonly CapturedPoster[];
    try {
      captured = await this.deps.posters.capture(input);
    } catch (err) {
      throw new StepError('poster-capture-failed', `poster capture threw: ${messageOf(err)}`);
    }

    const revPrefix = this.prefix(state);
    const posters: SimManifestPoster[] = [];

    for (const poster of captured) {
      if (poster.key.packageRevision !== state.packageRevision) {
        // A poster keyed for another revision is stored at a path no activation of THIS revision
        // will ever request — it would look captured and be permanently unreachable.
        throw new StepError(
          'poster-capture-failed',
          `poster ${posterIdentityString(poster.key)} is keyed for package revision ` +
          `${poster.key.packageRevision}, not ${state.packageRevision}`,
        );
      }
      if (poster.renditions.length === 0) {
        throw new StepError('poster-capture-failed', `poster ${posterIdentityString(poster.key)} has no renditions`);
      }
      const allowed = formatsFor(poster.transparent);
      const paths: string[] = [];

      for (const rendition of poster.renditions) {
        if (!allowed.includes(rendition.format)) {
          // A transparent capture stored as WebP paints an opaque rectangle over the video the
          // section is supposed to sit on top of.
          throw new StepError(
            'poster-capture-failed',
            `poster ${posterIdentityString(poster.key)}: format ${rendition.format} is not permitted for a ` +
            `${poster.transparent ? 'transparent' : 'opaque'} capture`,
          );
        }
        // Derived from `posterStoragePath` rather than re-spelled, so a poster inside a revision and
        // a poster on the legacy prefix can never disagree about the directory shape.
        const key = posterStoragePath(revPrefix, poster.key, rendition.size, rendition.format);
        const path = key.slice(revPrefix.length + 1);
        const contentType = POSTER_CONTENT_TYPES[rendition.format];
        await this.putOnce(state, path, rendition.bytes, contentType);
        state.progress.files.push(
          manifestEntry(path, 'poster', sha256OfBuffer(rendition.bytes), rendition.bytes.length, contentType),
        );
        paths.push(path);
      }

      posters.push({
        identity: posterIdentityString(poster.key),
        variantKey: poster.key.variantKey,
        configHash: poster.key.configHash,
        aspectProfile: poster.key.aspectProfile,
        qualityProfile: poster.key.qualityProfile,
        paths,
      });
    }

    // The modern failure policy offers `poster-only` as its FIRST recovery action. Publishing the
    // modern path with a case that has no poster publishes a promise the runtime cannot keep — the
    // same refusal `sim-canary-publish` makes, enforced here where the bytes are being written.
    if (state.progress.canary?.mayPublishAsModern) {
      const have = new Set(posters.map((p) => `${p.variantKey} ${p.configHash}`));
      const missing = this.casesFor(state)
        .map((c) => ({ c, k: `${c.variantKey} ${computeConfigHash(c.config)}` }))
        .filter(({ k }) => !have.has(k))
        .map(({ c }) => `${c.variantKey} @ ${c.aspectProfile}/${c.qualityProfile}`);
      if (missing.length > 0) {
        throw new StepError(
          'poster-missing',
          `this package would be granted the modern path but ${missing.length} case(s) have no poster`,
          missing.join(', '),
        );
      }
    }

    state.progress.posters = posters;
  }

  // ── 7. manifest, written LAST ───────────────────────────────────────────────────────────────

  private async stepWriteManifest(state: RunState): Promise<void> {
    const revision = this.requireRevision(state);
    const manifest = this.buildManifest(state, revision);

    const refs = new Set(state.request.referencedPaths ?? []);
    const problems = validateManifest(manifest, refs);
    if (problems.length > 0) {
      throw new StepError(
        'manifest-invalid',
        `${problems.length} manifest problem(s)`,
        problems.map((p) => `${p.code}: ${p.detail}`).join('; '),
      );
    }

    const manifestHash = computeManifestHash(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    // The manifest is what makes the revision resolvable, so it is the LAST object written. Until
    // this succeeds the revision is a set of orphan objects that nothing can resolve.
    await this.putOnce(state, MANIFEST_FILENAME, bytes, 'application/json');

    state.progress.manifestHash = manifestHash;
    state.revision = await this.callStore(() =>
      this.deps.revisions.updateRevision(revision.id, {
        manifestHash,
        bridgeProtocolVersion: state.request.bridgeProtocolVersion,
        runtimeProtocolVersion: state.request.runtimeProtocolVersion,
      }),
    );
  }

  // ── 8. verify the manifest against storage ──────────────────────────────────────────────────

  private async stepVerifyManifest(state: RunState): Promise<void> {
    const revision = this.requireRevision(state);
    await this.transition(state, 'validating');

    const loaded = await loadRevisionManifest(
      this.deps.storage,
      state.request.projectId,
      state.request.simulationId,
      revision.id,
    );
    if ('error' in loaded) throw new StepError('manifest-invalid', loaded.error);

    const stored = loaded.manifest;
    const storedHash = computeManifestHash(stored);
    if (state.progress.manifestHash && storedHash !== state.progress.manifestHash) {
      throw new StepError(
        'manifest-readback-differs',
        `the stored manifest hashes to ${storedHash}, not the ${state.progress.manifestHash} that was written`,
      );
    }

    // Verify from the STORED manifest, not from what this process remembers writing. The stored
    // manifest is what a reader will resolve, and it is the only description whose files a resumed
    // or interrupted run can be held to.
    const fileProblems = await verifyStoredFiles(
      this.deps.storage,
      (path) => this.keyFor(state, path),
      stored.files,
    );
    if (fileProblems.length > 0) {
      throw new StepError(
        fileProblems.every((p) => p.reason === 'missing') ? 'missing-file' : 'stored-bytes-differ',
        `${fileProblems.length} file(s) named by the manifest are missing or altered`,
        describeFileProblems(fileProblems),
      );
    }

    const configProblems = await verifyPresentationConfigs(
      this.deps.storage,
      (path) => this.keyFor(state, path),
      stored,
    );
    if (configProblems.length > 0) {
      const anyHashMismatch = configProblems.some((p) => p.reason === 'hash-mismatch');
      throw new StepError(
        anyHashMismatch ? 'config-hash-mismatch' : 'config-unreadable',
        `${configProblems.length} presentation config(s) do not match the manifest`,
        configProblems.map((p) => `${p.variantKey}/${p.configHash}: ${p.reason}${p.detail ? ` (${p.detail})` : ''}`).join('; '),
      );
    }

    state.progress.manifestHash = storedHash;
    await this.transition(state, 'canary_passed');
  }

  // ── 9. commit ───────────────────────────────────────────────────────────────────────────────

  private async stepActivate(state: RunState): Promise<void> {
    const revision = this.requireRevision(state);
    if (!state.progress.manifestHash) {
      // Belt and braces: the pointer may only move for a revision whose manifest was verified, and
      // the hash is the artefact of that verification.
      throw new StepError('manifest-invalid', 'refusing to activate a revision with no verified manifest');
    }

    let result: { previousActiveId: string | null };
    try {
      result = await this.deps.revisions.activateRevision({
        simulationId: state.request.simulationId,
        revisionId: revision.id,
        expectedCurrentActiveId: state.previousActiveId,
      });
    } catch (err) {
      throw new StepError(
        'activation-conflict',
        `the pointer could not be moved to ${revision.id}: ${messageOf(err)}`,
      );
    }
    state.activeId = revision.id;
    state.retainedId = result.previousActiveId;
  }

  // ── 10. retain ──────────────────────────────────────────────────────────────────────────────

  private async stepRetain(state: RunState): Promise<void> {
    const previousId = state.retainedId;
    if (!previousId) return;   // first publication of this package: there is nothing to retain

    const previous = await this.deps.revisions.getRevision(previousId);
    if (!previous) {
      throw new Error(`the superseded revision ${previousId} is no longer readable — rollback has no target`);
    }
    if (!mustRetainBytes(previous.status)) {
      throw new Error(
        `the superseded revision ${previousId} is '${previous.status}', a status whose bytes are not retained — ` +
        'rollback to it is not guaranteed',
      );
    }
    const key = revisionManifestKey(state.request.projectId, state.request.simulationId, previousId);
    if (!(await this.deps.storage.objectExists(key))) {
      throw new Error(`the superseded revision ${previousId} has no manifest at ${key} — it cannot be rolled back to`);
    }
  }

  // ── Failure ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Mark the revision failed and return. The pointer is deliberately untouched: every step before
   * the commit writes only to the new revision, so "the publication failed" and "the live package
   * is exactly as it was" are the same statement.
   */
  private async abort(state: RunState, step: PublicationStep, err: unknown): Promise<PublicationResult> {
    const stepErr = err instanceof StepError ? err : null;
    const failure: PublicationFailure = {
      code: stepErr?.code ?? 'store-error',
      step,
      message: stepErr ? stepErr.message : messageOf(err),
      detail: stepErr?.detail,
    };

    const warnings = [...state.warnings];
    if (state.revision && canTransition(state.revision.status, 'failed')) {
      try {
        await this.deps.revisions.updateRevision(state.revision.id, {
          status: 'failed',
          metadata: this.metadataWithProgress(state),
        });
      } catch (markErr) {
        // The pointer is still untouched, so the live package is fine either way; what is lost is
        // the tombstone, and an operator has to be told that rather than left to infer it.
        warnings.push(`could not mark revision ${state.revision.id} as failed: ${messageOf(markErr)}`);
      }
    }

    this.log.error(
      { simulationId: state.request.simulationId, revisionId: state.revision?.id, step, code: failure.code },
      `[publication] failed at ${step}: ${failure.message}`,
    );

    return {
      ok: false,
      revisionId: state.revision?.id ?? null,
      revisionNumber: state.revision?.revisionNumber ?? null,
      packageRevision: state.packageRevision,
      manifestHash: state.progress.manifestHash,
      reachedStep: step,
      completedSteps: [...state.progress.completedSteps],
      failure,
      previousActiveRevisionId: state.previousActiveId,
      // Untouched unless `activate` itself completed, which it cannot have if we are here.
      activeRevisionId: state.previousActiveId,
      retainedForRollbackId: state.previousActiveId,
      stagedEntryUrl: state.stagedEntryUrl,
      canary: state.progress.canary,
      warnings,
    };
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────────────────────

  private prefix(state: RunState): string {
    const revision = this.requireRevision(state);
    return revisionPrefix(state.request.projectId, state.request.simulationId, revision.id);
  }

  private keyFor(state: RunState, manifestPath: string): string {
    const revision = this.requireRevision(state);
    return revisionFileKey(state.request.projectId, state.request.simulationId, revision.id, manifestPath);
  }

  private requireRevision(state: RunState): SimRevisionRecord {
    if (!state.revision) throw new StepError('store-error', 'no revision has been created yet');
    return state.revision;
  }

  /**
   * Write one object, once.
   *
   * Identical bytes at the target key are a no-op (that is what makes a resumed publication safe).
   * DIFFERENT bytes are refused: silently skipping would publish a manifest whose hash describes
   * bytes nobody stored, and overwriting would break the immutability that a year-long `immutable`
   * cache header is predicated on.
   */
  private async putOnce(state: RunState, manifestPath: string, bytes: Buffer, contentType: string): Promise<void> {
    const key = this.keyFor(state, manifestPath);
    let exists: boolean;
    try {
      exists = await this.deps.storage.objectExists(key);
    } catch (err) {
      throw new StepError('upload-failed', `cannot determine whether ${key} exists: ${messageOf(err)}`);
    }

    if (exists) {
      let stored: Buffer;
      try {
        stored = await this.deps.storage.readObject(key);
      } catch (err) {
        throw new StepError('readback-failed', `${key} exists but cannot be read: ${messageOf(err)}`);
      }
      if (sha256OfBuffer(stored) === sha256OfBuffer(bytes)) return;
      throw new StepError(
        'key-conflict',
        `${key} already holds different bytes — a revision's files are never overwritten`,
        `stored ${sha256OfBuffer(stored)}, incoming ${sha256OfBuffer(bytes)}`,
      );
    }

    try {
      await this.deps.storage.uploadFile(key, bytes, contentType, IMMUTABLE_CACHE_CONTROL);
    } catch (err) {
      throw new StepError('upload-failed', `upload of ${key} failed: ${messageOf(err)}`);
    }
  }

  private casesFor(state: RunState): CanaryCase[] {
    const cases: CanaryCase[] = [];
    for (const variant of state.request.variants) {
      const seen = new Set<string>();
      for (const config of variant.configs) {
        const hash = computeConfigHash(config);
        if (seen.has(hash)) continue;   // the same picture, described twice
        seen.add(hash);
        cases.push({
          variantKey: variant.variantKey,
          config,
          aspectProfile: config.aspect,
          qualityProfile: config.quality,
        });
      }
    }
    return cases;
  }

  private stagedInput(state: RunState): StagedCanaryInput {
    const revision = this.requireRevision(state);
    return {
      simulationId: state.request.simulationId,
      projectId: state.request.projectId,
      revisionId: revision.id,
      packageRevision: state.packageRevision!,
      entryUrl: state.stagedEntryUrl ?? this.deps.serving.urlFor(this.keyFor(state, state.request.entry)),
      urlFor: (manifestPath: string) => this.deps.serving.urlFor(this.keyFor(state, manifestPath)),
      cases: this.casesFor(state),
    };
  }

  /** A resumed run rebuilds the canary report from the copy retained inside the revision. */
  private async reloadCanaryReport(state: RunState): Promise<CanaryReport> {
    const key = this.keyFor(state, CANARY_REPORT_PATH);
    try {
      return JSON.parse((await this.deps.storage.readObject(key)).toString('utf8')) as CanaryReport;
    } catch (err) {
      throw new StepError('readback-failed', `the retained canary report at ${key} is unreadable: ${messageOf(err)}`);
    }
  }

  private buildManifest(state: RunState, revision: SimRevisionRecord): SimManifest {
    const qualities = new Set<SimQualityProfile>();
    for (const variant of state.request.variants) {
      for (const config of variant.configs) qualities.add(config.quality);
    }

    return {
      manifestVersion: SIM_MANIFEST_VERSION,
      simulationId: state.request.simulationId,
      projectId: state.request.projectId,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      bridgeProtocolVersion: state.request.bridgeProtocolVersion,
      runtimeProtocolVersion: state.request.runtimeProtocolVersion,
      entry: state.request.entry,
      runtime: [...state.request.runtime],
      files: [...state.progress.files],
      variants: state.request.variants.map((v) => ({
        variantKey: v.variantKey,
        configHashes: distinctConfigHashes(v),
      })),
      posters: [...state.progress.posters],
      qualityProfiles: [...qualities],
      externalDependencies: [...new Set(state.request.externalDependencies ?? [])].sort(),
      generatedFrom: state.request.generatedFrom ?? {},
      canary: {
        classification: state.progress.canary?.classification ?? null,
        ranAt: state.progress.canary?.ranAt ?? null,
        engine: state.progress.canary?.engine ?? null,
      },
      createdAt: this.now().toISOString(),
      createdBy: state.request.createdBy ?? null,
    };
  }

  private metadataWithProgress(state: RunState): Record<string, unknown> {
    return { ...(state.metadata ?? {}), [PROGRESS_KEY]: state.progress };
  }

  private async persistProgress(state: RunState): Promise<void> {
    if (!state.revision) return;
    try {
      state.revision = await this.deps.revisions.updateRevision(state.revision.id, {
        metadata: this.metadataWithProgress(state),
      });
    } catch (err) {
      // Progress is an optimisation for resuming, never a correctness input — every step re-derives
      // or re-verifies what it needs. Losing it costs work on a resume; failing the publication over
      // it would cost the publication.
      state.warnings.push(`progress for step tracking was not persisted: ${messageOf(err)}`);
    }
  }

  /**
   * Advance the revision's status, or do nothing if it is already at or past the target.
   *
   * A resumed run re-enters the step that was interrupted, and that step's status change may
   * already have landed — `uploading → uploading` is trivially fine, but `canary_passed →
   * validating` is a BACKWARDS move that the state machine rightly refuses. Skipping it is correct:
   * the status records how far the revision got, and it did get there.
   */
  private async transition(state: RunState, to: SimRevisionStatus): Promise<void> {
    const revision = this.requireRevision(state);
    if (STATUS_RANK[revision.status] >= STATUS_RANK[to]) return;
    if (!canTransition(revision.status, to)) {
      throw new StepError('store-error', `revision ${revision.id} cannot go from '${revision.status}' to '${to}'`);
    }
    state.revision = await this.callStore(() => this.deps.revisions.updateRevision(revision.id, { status: to }));
  }

  private async callStore<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StepError) throw err;
      throw new StepError('store-error', messageOf(err));
    }
  }
}

// ─── Free helpers ─────────────────────────────────────────────────────────────────────────────

interface RunState {
  request: PublicationRequest;
  revision: SimRevisionRecord | null;
  packageRevision: string | null;
  progress: PublicationProgress;
  metadata: Record<string, unknown> | null;
  canaryReport: CanaryReport | null;
  stagedEntryUrl: string | null;
  previousActiveId: string | null;
  activeId: string | null;
  retainedId: string | null;
  warnings: string[];
}

function manifestEntry(
  path: string,
  role: SimFileRole,
  hash: string,
  bytes: number,
  contentType: string,
): SimManifestFile {
  return { path, role, hash, bytes, contentType, cacheControl: IMMUTABLE_CACHE_CONTROL };
}

function distinctConfigHashes(variant: PublicationVariant): string[] {
  return [...new Set(variant.configs.map((c) => computeConfigHash(c)))].sort();
}

const describeFileProblems = (problems: readonly StoredFileProblem[]): string =>
  problems.map((p) => `${p.path}: ${p.reason}${p.detail ? ` (${p.detail})` : ''}`).join('; ');

/**
 * Everything about a request that can be judged without touching storage.
 *
 * Runs before a revision row exists so a malformed request leaves nothing behind at all. Each check
 * refuses rather than repairs: a path that needs repair was produced by a caller that believed
 * something false about where its file was going.
 */
function validateRequest(request: PublicationRequest): void {
  const bad = (message: string, code: PublicationFailureCode = 'invalid-request'): never => {
    throw new StepError(code, message);
  };

  if (!request.simulationId?.trim()) bad('simulationId is required');
  if (!request.projectId?.trim()) bad('projectId is required');
  if (request.files.length === 0) bad('a revision with no files serves nothing');
  if (request.variants.length === 0) bad('a package with no variants serves nothing');

  const seenPath = new Set<string>();
  for (const file of request.files) {
    const norm = normalizeManifestPath(file.path);
    if (norm === null || norm !== file.path) {
      bad(`${JSON.stringify(file.path)} is not a normalized, prefix-relative path`);
    }
    if (seenPath.has(file.path)) bad(`${file.path} is listed twice — the second write would be a key conflict`);
    seenPath.add(file.path);

    if (file.path === MANIFEST_FILENAME) {
      bad(`${file.path} is this pipeline's own manifest`, 'reserved-path');
    }
    if (RESERVED_PREFIXES.some((p) => file.path.startsWith(p))) {
      bad(`${file.path} is inside a prefix this pipeline owns`, 'reserved-path');
    }
    // Customer bytes live under `package/` so that a customer file called `manifest.json`, or a
    // directory called `runtime`, cannot shadow ours. That has to be structural — a name-based
    // guard is a denylist, and the customer chooses the names.
    const expectedRoot = file.role === 'runtime' ? `${RUNTIME_SUBDIR}/` : `${PACKAGE_SUBDIR}/`;
    if (!file.path.startsWith(expectedRoot)) {
      bad(`${file.path} has role '${file.role}' and must live under ${expectedRoot}`, 'reserved-path');
    }
    if (!Buffer.isBuffer(file.bytes)) bad(`${file.path} has no bytes`);
    if (!file.contentType?.trim()) bad(`${file.path} has no content type`);
  }

  if (!seenPath.has(request.entry)) bad(`entry ${JSON.stringify(request.entry)} is not among the files`);
  if (request.files.filter((f) => f.role === 'entry').length !== 1) {
    bad('exactly one file must have role "entry" — the document the iframe loads');
  }
  if (request.files.find((f) => f.path === request.entry)?.role !== 'entry') {
    bad(`entry ${request.entry} does not have role "entry"`);
  }
  for (const runtimePath of request.runtime) {
    if (request.files.find((f) => f.path === runtimePath)?.role !== 'runtime') {
      bad(`runtime file ${runtimePath} is missing or does not have role "runtime"`);
    }
  }

  const seenVariant = new Set<string>();
  const seenSanitized = new Map<string, string>();
  for (const variant of request.variants) {
    if (!variant.variantKey?.trim()) bad('a variant must have a key');
    if (seenVariant.has(variant.variantKey)) bad(`variant ${variant.variantKey} is listed twice`);
    seenVariant.add(variant.variantKey);
    // Two variant keys that sanitize to one directory name would store their configs at the same
    // path: the second write conflicts, or — if the bytes happened to agree — one variant silently
    // adopts the other's configuration.
    const sanitized = sanitizeVariant(variant.variantKey);
    const clash = seenSanitized.get(sanitized);
    if (clash !== undefined) {
      bad(`variants ${clash} and ${variant.variantKey} both store their configs under ${sanitized}`);
    }
    seenSanitized.set(sanitized, variant.variantKey);

    if (variant.configs.length === 0) bad(`variant ${variant.variantKey} has no presentation configuration`);
    for (const config of variant.configs) {
      try {
        computeConfigHash(config);
      } catch (err) {
        bad(`variant ${variant.variantKey} has an unhashable configuration: ${messageOf(err)}`);
      }
      if (!QUALITIES.includes(config.quality)) bad(`variant ${variant.variantKey}: unknown quality ${String(config.quality)}`);
      if (!ASPECTS.includes(config.aspect)) bad(`variant ${variant.variantKey}: unknown aspect ${String(config.aspect)}`);
    }
  }

  if (!Number.isInteger(request.bridgeProtocolVersion)) bad('bridgeProtocolVersion must be an integer');
  if (!Number.isInteger(request.runtimeProtocolVersion)) bad('runtimeProtocolVersion must be an integer');
}

function failedResult(
  failure: PublicationFailure,
  pointers: { previousActiveRevisionId: string | null; activeRevisionId: string | null },
): PublicationResult {
  return {
    ok: false,
    revisionId: null,
    revisionNumber: null,
    packageRevision: null,
    manifestHash: null,
    reachedStep: failure.step,
    completedSteps: [],
    failure,
    previousActiveRevisionId: pointers.previousActiveRevisionId,
    activeRevisionId: pointers.activeRevisionId,
    retainedForRollbackId: pointers.activeRevisionId,
    stagedEntryUrl: null,
    canary: null,
    warnings: [],
  };
}
