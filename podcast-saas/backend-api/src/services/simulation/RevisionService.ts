/**
 * Immutable package publication (Priority 7.4 / 7.5 / 7.6).
 *
 * WHAT THIS REPLACES
 * Publication used to overwrite one mutable prefix in place: bridge.js and the entry HTML are two
 * separate writes, and a viewer landing between them received new bridge bytes under the old cache
 * key. A half-updated package, durable on failure because neither write rolls the other back.
 *
 * Here, every file of a publication is written under a prefix containing a revision id that has
 * never been used before, so a concurrent reader cannot observe a partial write AT ALL — it is
 * reading a different prefix. Switching which revision is live is then one row update.
 *
 * NO IN-PROCESS LOCK, DELIBERATELY
 * `SimulationService.withBridgeLock` is per-instance, and three call sites each construct their own
 * `SimulationService` with its own empty lock map — so it does not actually serialise anything
 * across the cluster. This service takes no lock and does not need one:
 *
 *   (a) two concurrent publications write to two different never-reused prefixes, so they cannot
 *       collide on a key at all; and
 *   (b) every mutation that changes which bytes are served is a compare-and-set, backed by
 *       `uniq_sim_revisions_active` — a partial unique index, which is cluster-wide.
 *
 * That is a real improvement over the status quo rather than a reimplementation of it.
 *
 * WHAT IS AND IS NOT VERIFIED
 * Byte content is verified by reading every file back and re-hashing it — an upload that resolves is
 * not proof the object landed. Object METADATA (content type, cache control) is verified only where
 * the adapter can report it; where it cannot, the manifest records the value as declared and the
 * report says `unverified` rather than `ok`. A verification that cannot tell the difference between
 * "correct" and "cannot tell" is not a verification.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { simulations, sim_revisions } from '../../db/schema.js';
import type { StorageService, StoredObjectHead } from '../storage/StorageService.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { logger } from '../../lib/logger.js';
import { canaryReportPrepareMs } from 'shared/sim/prepareBudget';
import { createHash } from 'node:crypto';
import {
  canTransition,
  isValidRevisionId,
  mustRetainBytes,
  revisionFileKey,
  revisionManifestKey,
  revisionIdForPrefix,
  rollbackTargetFor,
  IMMUTABLE_CACHE_CONTROL,
  POINTER_CACHE_CONTROL,
  MANIFEST_FILENAME,
  type SimRevisionRecord,
  type SimRevisionStatus,
} from 'shared/sim/simRevision';
import {
  computeManifestHash,
  normalizeManifestPath,
  validateManifest,
  type ManifestProblem,
  type SimManifest,
  type SimManifestFile,
  type SimFileRole,
} from 'shared/sim/simManifest';
import { analyzeWeight, compareWeight, type WeightReport } from 'shared/sim/packageWeight';

/**
 * A mutation lost a compare-and-set.
 *
 * Distinct from a generic Error because the caller's correct response is different: a conflict means
 * someone else legitimately changed the world, so the operation must be re-read and retried, not
 * reported as a fault.
 */
export class RevisionConflict extends Error {
  constructor(readonly stage: string, readonly detail: string) {
    super(`revision ${stage}: ${detail}`);
    this.name = 'RevisionConflict';
  }
}

/** A published file failed verification. Publication must not proceed. */
export interface VerificationProblem {
  path: string;
  code: 'missing' | 'hash-mismatch' | 'size-mismatch' | 'content-type-mismatch' | 'cache-control-mismatch';
  detail: string;
}

export interface VerificationReport {
  /** Files whose stored BYTES were read back and matched their manifest hash. */
  bytesVerified: number;
  /** Files whose stored METADATA was observed and matched. */
  metadataVerified: number;
  /**
   * Files whose metadata could not be observed because the adapter does not report it. Counted
   * separately and never folded into `metadataVerified` — an unverifiable field must not be able to
   * masquerade as a verified one.
   */
  metadataUnverified: number;
  problems: VerificationProblem[];
}

const ACTIVATABLE_FROM: readonly SimRevisionStatus[] = ['canary_passed', 'retired', 'rolled_back'];

/** Row → the shared record shape. Timestamps become ISO strings; Drizzle hands back Date objects. */
/**
 * Smallest `keepLastN` that leaves a rollback possible.
 *
 * The newest retained revision is the one being served, so keeping one keeps only the present.
 * Two is the first value that also keeps a past to return to.
 */
export const GC_MIN_KEEP = 2;

/**
 * Default grace before an uncollected revision may be swept.
 *
 * Long enough that no realistic publication is still writing when it expires, and short enough that
 * abandoned drafts do not accumulate for a day. A publication that genuinely takes longer than this
 * is already failing for other reasons.
 */
export const GC_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Is this revision old enough to collect?
 *
 * Age is measured from `created_at`, which every revision has from the moment its row is written —
 * `activated_at` is null for exactly the in-flight rows this guard exists to protect.
 */
export function isCollectableByAge(
  r: { createdAt: string }, minAgeMs: number = GC_MIN_AGE_MS, now: number = Date.now(),
): boolean {
  const created = Date.parse(r.createdAt);
  // An unparseable timestamp is treated as TOO YOUNG. Refusing to collect costs storage; collecting
  // something in flight costs a publication.
  if (!Number.isFinite(created)) return false;
  return now - created >= Math.max(0, minAgeMs);
}

function toRecord(r: typeof sim_revisions.$inferSelect): SimRevisionRecord {
  const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
  return {
    id: r.id,
    simulationId: r.simulation_id,
    revisionNumber: r.revision_number,
    status: r.status as SimRevisionStatus,
    manifestHash: r.manifest_hash,
    bridgeProtocolVersion: r.bridge_protocol_version,
    runtimeProtocolVersion: r.runtime_protocol_version,
    createdAt: iso(r.created_at)!,
    activatedAt: iso(r.activated_at),
    retiredAt: iso(r.retired_at),
    rollbackOfRevisionId: r.rollback_of_revision_id,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  };
}

/**
 * SHA-256 of raw bytes.
 *
 * Deliberately node:crypto and NOT `shared/sim/sha256.sha256Hex`. That one takes a `string` and
 * UTF-8 encodes it — which agrees for text but is lossy for binary, so hashing a PNG through it
 * would produce a stable, confident, wrong digest. The manifest HASH still goes through the shared
 * pure-TS implementation (inside `computeManifestHash`), because that one has to agree across
 * backend, browser and the generated bridge; file bytes have no such constraint and must be exact.
 */
function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * A Postgres unique-constraint violation (23505), through whatever wrapper the driver applied.
 *
 * Checked structurally rather than by message text: drizzle, postgres.js and PGlite each re-wrap
 * driver errors differently, and a message match would pass in tests and miss in production.
 */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth += 1) {
    const rec = e as { code?: unknown; cause?: unknown };
    if (rec.code === '23505') return true;
    e = rec.cause;
  }
  return false;
}

export class RevisionService {
  constructor(private readonly storage: StorageService = getStorageAdapter()) {}

  // ── Draft ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Create a draft and allocate its revision number under the simulations row lock.
   *
   * `revision_counter + 1 ... RETURNING` takes the row lock for the duration of the transaction, so
   * two concurrent drafts serialise. `SELECT max(revision_number) + 1` would let both read the same
   * value and only collide on the uniqueness constraint LATER — after the caller has already begun
   * writing bytes to a prefix it must then abandon.
   */
  async createDraft(opts: {
    simulationId: string;
    createdBy?: string | null;
    rollbackOfRevisionId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<SimRevisionRecord> {
    return db.transaction(async (tx) => {
      const [sim] = await tx
        .update(simulations)
        .set({ revision_counter: sql`${simulations.revision_counter} + 1` })
        .where(eq(simulations.id, opts.simulationId))
        .returning({ counter: simulations.revision_counter });
      if (!sim) throw new RevisionConflict('createDraft', 'simulation not found');

      const [row] = await tx
        .insert(sim_revisions)
        .values({
          simulation_id: opts.simulationId,
          revision_number: sim.counter,
          status: 'draft',
          created_by: opts.createdBy ?? null,
          rollback_of_revision_id: opts.rollbackOfRevisionId ?? null,
          metadata: opts.metadata ?? null,
        })
        .returning();
      if (!row) throw new RevisionConflict('createDraft', 'insert returned no row');
      return toRecord(row);
    });
  }

  // ── Status transitions ─────────────────────────────────────────────────────────────────────────

  /**
   * One CAS shape for every status move.
   *
   * The `eq(status, from)` predicate is the whole point: `.where(eq(id, …))` alone is the shape that
   * already loses a claim elsewhere in this codebase, because it silently succeeds against a row
   * some other worker has already moved on.
   */
  private async transition(
    simulationId: string,
    revisionId: string,
    from: SimRevisionStatus,
    to: SimRevisionStatus,
    extra: Partial<typeof sim_revisions.$inferInsert> = {},
  ): Promise<SimRevisionRecord> {
    // Asserted in TS first so an illegal move is a readable programming error rather than a
    // conflict; the SQL predicate below is what actually enforces it against concurrency.
    if (!canTransition(from, to)) {
      throw new Error(`illegal revision transition ${from} → ${to}`);
    }
    const [row] = await db
      .update(sim_revisions)
      .set({ status: to, ...extra })
      .where(and(
        eq(sim_revisions.id, revisionId),
        eq(sim_revisions.simulation_id, simulationId),
        eq(sim_revisions.status, from),
      ))
      .returning();
    if (!row) throw new RevisionConflict(`${from}→${to}`, 'status moved under us');
    return toRecord(row);
  }

  beginUpload(simulationId: string, revisionId: string): Promise<SimRevisionRecord> {
    return this.transition(simulationId, revisionId, 'draft', 'uploading');
  }

  finishUpload(simulationId: string, revisionId: string): Promise<SimRevisionRecord> {
    return this.transition(simulationId, revisionId, 'uploading', 'validating');
  }

  // `async` so the refusal below arrives as a REJECTION. A synchronous throw from a method whose
  // signature promises a Promise escapes the caller's `.catch()` and surfaces as an unhandled
  // exception in whatever happens to be on the stack.
  async markFailed(
    simulationId: string,
    revisionId: string,
    from: SimRevisionStatus,
    error: string,
  ): Promise<SimRevisionRecord> {
    // THE ACTIVE REVISION CANNOT BE FAILED IN PLACE.
    //
    // `canTransition('active','failed')` is true, and this method touches only `sim_revisions` —
    // so a type-checked call left the simulation's pointer naming a `failed` revision. The player
    // reads the pointer and never the status, so it kept serving those bytes, while every future
    // activation and rollback was wedged permanently: the demote CAS expects the incumbent to be
    // `active` and it no longer is, and the pointer CAS expects NULL and it is not. Nothing detects
    // the divergence and the service has no repair path.
    //
    // Taking a live revision out of service means moving the pointer, which is what `rollback` is.
    if (from === 'active') {
      throw new RevisionConflict('active→failed',
        'the active revision cannot be failed in place — roll back to move the pointer first');
    }
    return this.transition(simulationId, revisionId, from, 'failed', {
      metadata: { error },
    });
  }

  // ── The single write path ──────────────────────────────────────────────────────────────────────

  /**
   * THE ONLY WRITE PATH into a revision prefix.
   *
   * Everything a caller supplies — customer bytes, generated runtime, posters, canary evidence —
   * goes through here, so the immutability invariant has exactly one chokepoint to defend. That
   * matters more than it might look: the object store has no versioning, no object lock and no
   * conditional writes, so a stray `uploadFile` to a revision key would silently succeed and
   * overwrite immutable bytes. Immutability here is a CODE-LEVEL invariant, not a storage guarantee,
   * and this function is where it lives.
   *
   * Two guards, both structural:
   *   - the revision must be in `uploading`, so nothing can be added to a package that has already
   *     been validated, canaried or activated; and
   *   - the composed key must parse back to THIS revision, so a traversing manifest path cannot
   *     write outside the prefix even if `normalizeManifestPath` were ever weakened.
   */
  async writeFile(
    rev: SimRevisionRecord,
    storagePrefix: string,
    opts: { manifestPath: string; bytes: Buffer; contentType: string; role: SimFileRole },
  ): Promise<SimManifestFile> {
    if (rev.status !== 'uploading') {
      throw new RevisionConflict('writeFile', `revision is ${rev.status}, not uploading`);
    }
    if (!isValidRevisionId(rev.id)) {
      throw new Error(`writeFile: invalid revision id ${rev.id}`);
    }
    const path = normalizeManifestPath(opts.manifestPath);
    if (path === null) {
      throw new Error(`writeFile: unrepresentable manifest path ${JSON.stringify(opts.manifestPath)}`);
    }
    const key = revisionFileKey(storagePrefix, rev.id, path);
    if (revisionIdForPrefix(key, storagePrefix) !== rev.id) {
      // Defence in depth: reaching here means a path escaped the prefix despite normalisation.
      throw new Error(`writeFile: composed key escapes revision prefix: ${key}`);
    }

    const cacheControl = cacheControlForRole(opts.role, path);
    await this.storage.uploadFile(key, opts.bytes, opts.contentType, cacheControl);

    return {
      path,
      role: opts.role,
      hash: sha256Bytes(opts.bytes),
      bytes: opts.bytes.length,
      contentType: opts.contentType,
      cacheControl,
    };
  }

  // ── Validation ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Validate the manifest, verify the stored bytes against it, write manifest.json, and move the
   * revision to `canary_passed` — or to `failed`, with every problem reported.
   *
   * Verification happens BEFORE the manifest is written, so a package that fails leaves no manifest
   * at all. A revision whose manifest exists is a revision whose bytes were checked.
   */
  async validate(
    simulationId: string,
    rev: SimRevisionRecord,
    storagePrefix: string,
    opts: { manifest: SimManifest; referencedPaths?: ReadonlySet<string> },
  ): Promise<{ ok: boolean; problems: ManifestProblem[]; verified: VerificationReport }> {
    const problems = validateManifest(opts.manifest, opts.referencedPaths ?? new Set());
    const verified = await this.verifyStoredBytes(rev, storagePrefix, opts.manifest);

    if (problems.length > 0 || verified.problems.length > 0) {
      await this.markFailed(
        simulationId,
        rev.id,
        'validating',
        JSON.stringify({ manifest: problems, storage: verified.problems }).slice(0, 4000),
      );
      return { ok: false, problems, verified };
    }

    const manifestHash = computeManifestHash(opts.manifest);
    const manifestBytes = Buffer.from(JSON.stringify(opts.manifest, null, 2), 'utf8');
    // The manifest is written through the same chokepoint as everything else, which requires the
    // revision to still be in `uploading`. It is written from the validating state, so it goes
    // direct — the one deliberate exception, and the reason it is spelled out rather than hidden.
    await this.storage.uploadFile(
      revisionManifestKey(storagePrefix, rev.id),
      manifestBytes,
      'application/json',
      IMMUTABLE_CACHE_CONTROL,
    );

    // Weight analysis is recorded WITH the revision, so an optimisation claim is a comparison of
    // two measurements taken by the same code over the same manifest — not two estimates. It is
    // advisory: these are the customer's own files, and a finding never blocks a publication.
    const weight = analyzeWeight(opts.manifest);

    await this.transition(simulationId, rev.id, 'validating', 'canary_passed', {
      metadata: {
        ...(rev.metadata ?? {}),
        weight: {
          totalBytes: weight.totalBytes,
          fileCount: weight.fileCount,
          byCategory: weight.byCategory,
          largest: weight.largest.slice(0, 5),
          findings: weight.findings,
        },
      },
      manifest_hash: manifestHash,
      entry_path: opts.manifest.entry,
      bridge_protocol_version: opts.manifest.bridgeProtocolVersion,
      runtime_protocol_version: opts.manifest.runtimeProtocolVersion,
    });

    return { ok: true, problems: [], verified };
  }

  /**
   * Read every published file back and check it against the manifest.
   *
   * An upload call that resolves is not proof the object landed — this is the same reasoning the
   * package backup script already applies, and the reason `manifest.files[].hash` can be described
   * as the hash of stored bytes rather than of bytes we intended to store.
   */
  async verifyStoredBytes(
    rev: SimRevisionRecord,
    storagePrefix: string,
    manifest: SimManifest,
  ): Promise<VerificationReport> {
    const report: VerificationReport = {
      bytesVerified: 0, metadataVerified: 0, metadataUnverified: 0, problems: [],
    };

    for (const f of manifest.files) {
      const key = revisionFileKey(storagePrefix, rev.id, f.path);

      let back: Buffer;
      try {
        back = await this.storage.readObject(key);
      } catch (err) {
        report.problems.push({ path: f.path, code: 'missing', detail: String(err).slice(0, 200) });
        continue;
      }

      if (back.length !== f.bytes) {
        report.problems.push({
          path: f.path, code: 'size-mismatch',
          detail: `stored ${back.length}, manifest ${f.bytes}`,
        });
        continue;
      }
      const actual = sha256Bytes(back);
      if (actual !== f.hash) {
        report.problems.push({
          path: f.path, code: 'hash-mismatch',
          detail: `stored ${actual.slice(0, 16)}…, manifest ${f.hash.slice(0, 16)}…`,
        });
        continue;
      }
      report.bytesVerified += 1;

      // Metadata is verified only where the adapter can observe it. Local disk stores none, so it
      // reports nulls — and those count as UNVERIFIED, never as a pass.
      let head: StoredObjectHead | null;
      try {
        head = await this.storage.headObject(key);
      } catch (err) {
        logger.warn({ key, err }, 'revision verify: headObject failed; metadata unverified');
        report.metadataUnverified += 1;
        continue;
      }
      if (!head || (head.contentType === null && head.cacheControl === null)) {
        report.metadataUnverified += 1;
        continue;
      }
      let mismatched = false;
      if (head.contentType !== null && head.contentType !== f.contentType) {
        report.problems.push({
          path: f.path, code: 'content-type-mismatch',
          detail: `stored ${head.contentType}, manifest ${f.contentType}`,
        });
        mismatched = true;
      }
      if (head.cacheControl !== null && head.cacheControl !== f.cacheControl) {
        report.problems.push({
          path: f.path, code: 'cache-control-mismatch',
          detail: `stored ${head.cacheControl}, manifest ${f.cacheControl}`,
        });
        mismatched = true;
      }
      if (!mismatched) report.metadataVerified += 1;
    }

    return report;
  }

  // ── Canary ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Record a canary verdict ON THE REVISION, never on the simulations row.
   *
   * The row's verdict is a PROJECTION of the active revision's, written only inside the activation
   * transaction. Writing it here would let a canary against a not-yet-active revision change how the
   * player treats the revision that IS active.
   */
  async recordCanary(
    simulationId: string,
    revisionId: string,
    verdict: { classification: string; report: unknown; ranAt: Date },
  ): Promise<void> {
    const [row] = await db
      .update(sim_revisions)
      .set({
        package_class: verdict.classification,
        canary_report: verdict.report,
        canary_at: verdict.ranAt,
      })
      .where(and(
        eq(sim_revisions.id, revisionId),
        eq(sim_revisions.simulation_id, simulationId),
        // CAS, for the same reason every other mutation here has one. Without it a late canary can
        // overwrite the verdict of a revision that has since been activated or failed — and a later
        // rollback would then project that stale verdict onto the simulations row.
        inArray(sim_revisions.status, ['uploading', 'validating', 'canary_passed']),
      ))
      .returning({ id: sim_revisions.id });
    if (!row) throw new RevisionConflict('recordCanary', 'revision is not accepting a verdict');
  }

  // ── Activation ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Make a revision live. One transaction, three compare-and-sets, in this order.
   *
   * DEMOTE BEFORE PROMOTE. `uniq_sim_revisions_active` is a partial unique INDEX, and an index
   * cannot be DEFERRABLE — so promoting first violates it mid-transaction and aborts an operation
   * that is entirely legal. The order is load-bearing, not stylistic.
   *
   * `expectedActiveRevisionId` is the pointer value the CALLER READ. Passing what the caller
   * believes, rather than re-reading inside, is what makes this a compare-and-set at all: a re-read
   * would simply observe whoever won the race and then happily overwrite them.
   */
  async activate(opts: {
    simulationId: string;
    revisionId: string;
    storagePrefix: string;
    expectedActiveRevisionId: string | null;
    supersede: 'retired' | 'rolled_back';
  }): Promise<{ activated: SimRevisionRecord; superseded: string | null }> {
    try {
      return await this.activateInTransaction(opts);
    } catch (err) {
      // `uniq_sim_revisions_active` is the cluster-wide backstop behind the three CAS predicates,
      // and it fires in a case the predicates cannot see: when the caller's expected pointer is
      // stale in the NULL direction, the demote is skipped entirely, so nothing demotes the real
      // incumbent and the promote collides with it.
      //
      // Left unmapped that surfaces as a raw 23505, which a caller cannot distinguish from a broken
      // database — and the correct response to the two is opposite: re-read and retry, versus page
      // someone. Losing to the index IS losing a compare-and-set, so it is reported as one.
      if (isUniqueViolation(err)) {
        throw new RevisionConflict('promote', 'another revision is already active');
      }
      throw err;
    }
  }

  private activateInTransaction(opts: {
    simulationId: string;
    revisionId: string;
    storagePrefix: string;
    expectedActiveRevisionId: string | null;
    supersede: 'retired' | 'rolled_back';
  }): Promise<{ activated: SimRevisionRecord; superseded: string | null }> {
    const { simulationId, revisionId, storagePrefix, expectedActiveRevisionId, supersede } = opts;

    return db.transaction(async (tx) => {
      const now = new Date();

      // (a) DEMOTE the incumbent.
      let superseded: string | null = null;
      if (expectedActiveRevisionId !== null && expectedActiveRevisionId !== revisionId) {
        const [demoted] = await tx
          .update(sim_revisions)
          .set({ status: supersede, retired_at: now })
          .where(and(
            eq(sim_revisions.id, expectedActiveRevisionId),
            eq(sim_revisions.simulation_id, simulationId),
            eq(sim_revisions.status, 'active'),
          ))
          .returning({ id: sim_revisions.id });
        if (!demoted) throw new RevisionConflict('demote', 'incumbent is no longer active');
        superseded = demoted.id;
      }

      // (b) PROMOTE the target. The status set is exactly canTransition(_, 'active')'s preimage,
      //     and the two NOT NULL predicates make an unvalidated revision unactivatable even by a
      //     caller that skipped validate() entirely.
      const [promoted] = await tx
        .update(sim_revisions)
        .set({ status: 'active', activated_at: now, retired_at: null })
        .where(and(
          eq(sim_revisions.id, revisionId),
          eq(sim_revisions.simulation_id, simulationId),
          inArray(sim_revisions.status, [...ACTIVATABLE_FROM]),
          isNotNull(sim_revisions.manifest_hash),
          isNotNull(sim_revisions.entry_path),
        ))
        .returning();
      if (!promoted) throw new RevisionConflict('promote', 'target is not activatable');

      // (c) FLIP THE POINTER — the mutation that actually changes which bytes are served.
      //
      //     IS NOT DISTINCT FROM, not eq(). The first activation of a simulation has a NULL
      //     incumbent, and `x = NULL` is never true in SQL — so eq() would make first activation
      //     impossible while looking exactly correct.
      //
      //     The three verdict columns are RE-PROJECTED here rather than cleared. Clearing would be
      //     safe on activate but wrong on rollback: rolling back to a revision that was canaried
      //     would discard a verdict that is perfectly valid for those exact bytes, demoting a proven
      //     package to the legacy path for no reason. A never-canaried target projects NULL, which
      //     the player already reads as "unproven → legacy path" — the safe default, unchanged.
      const [flipped] = await tx
        .update(simulations)
        .set({
          active_revision_id: promoted.id,
          active_revision_entry_key: revisionFileKey(storagePrefix, promoted.id, promoted.entry_path!),
          package_class: promoted.package_class,
          canary_report: promoted.canary_report,
          canary_at: promoted.canary_at,
          // DERIVED from the same report in the same statement, not left behind.
          //
          // `prepare_budget_ms` is read on the hot path as the lab anchor for this package. It has
          // no column on `sim_revisions`, so re-projecting the report while leaving the budget
          // alone produced exactly the split the per-revision verdict exists to prevent: after a
          // rollback the report described revision A while the budget still described B. Deriving
          // it here needs no new column, because the report it comes from is already being copied.
          prepare_budget_ms: canaryReportPrepareMs(
            promoted.canary_report as Parameters<typeof canaryReportPrepareMs>[0],
          ),
        })
        .where(and(
          eq(simulations.id, simulationId),
          sql`${simulations.active_revision_id} IS NOT DISTINCT FROM ${expectedActiveRevisionId}`,
        ))
        .returning({ id: simulations.id });
      if (!flipped) throw new RevisionConflict('pointer', 'active_revision_id moved under us');

      return { activated: toRecord(promoted), superseded };
    });
  }

  /**
   * Roll back to the most recently active revision that is not the current one.
   *
   * The target is chosen by `rollbackTargetFor`, which orders by activation time rather than by
   * revision number — a rollback re-activates an OLDER number, so after one rollback the highest
   * number is no longer the most recent, and rolling back again by number would restore the very
   * revision that was just withdrawn.
   */
  async rollback(opts: {
    simulationId: string;
    storagePrefix: string;
    expectedActiveRevisionId: string | null;
    reason: string;
  }): Promise<{ activated: SimRevisionRecord; superseded: string | null }> {
    const rows = await db
      .select()
      .from(sim_revisions)
      .where(eq(sim_revisions.simulation_id, opts.simulationId));
    const target = rollbackTargetFor(rows.map(toRecord), opts.expectedActiveRevisionId);
    if (!target) throw new RevisionConflict('rollback', 'no retained revision to roll back to');

    logger.warn(
      { simulationId: opts.simulationId, to: target.id, from: opts.expectedActiveRevisionId, reason: opts.reason },
      'sim revision rollback',
    );

    return this.activate({
      simulationId: opts.simulationId,
      revisionId: target.id,
      storagePrefix: opts.storagePrefix,
      expectedActiveRevisionId: opts.expectedActiveRevisionId,
      // 'rolled_back' rather than 'retired': the audit history has to be able to answer WHY a
      // revision stopped serving, and "a human judged it wrong" is not "something newer took over".
      supersede: 'rolled_back',
    });
  }

  // ── Garbage collection ─────────────────────────────────────────────────────────────────────────

  /**
   * Delete the bytes of revisions that are not retained.
   *
   * Two absolute refusals, both because the alternative is unrecoverable:
   *   - nothing outside a `/revisions/` prefix is ever touched, so the pre-revision mutable package
   *     survives. Migration 050's rollback reverts every simulation to that path, and it must still
   *     hold something servable; and
   *   - `mustRetainBytes(status)` revisions are never collected beyond `keepLastN`, because those
   *     are exactly the ones rollback can reach.
   */
  async gc(opts: {
    simulationId: string;
    storagePrefix: string;
    keepLastN: number;
    /** Grace period before an uncollected revision may be swept. Defaults to `GC_MIN_AGE_MS`. */
    minAgeMs?: number;
  }): Promise<{ deleted: string[] }> {
    const rows = await db
      .select()
      .from(sim_revisions)
      .where(eq(sim_revisions.simulation_id, opts.simulationId));
    const records = rows.map(toRecord);

    const retained = records
      .filter((r) => mustRetainBytes(r.status))
      .sort((a, b) => Date.parse(String(b.activatedAt)) - Date.parse(String(a.activatedAt)));
    // `keep` is the SINGLE authority for retention. An `if (status === 'active') continue` guard
    // used to sit in the loop below as belt-and-braces; it was unkillable by any mutation, because
    // the active revision always has the newest activated_at and so is always the first element of
    // `retained`. Unreachable defensive code that no test can falsify is a liability, not a
    // safeguard — it invites a future reader to weaken `keep` believing the guard still covers it.
    // `Math.max(1, NaN)` is NaN, and `slice(0, NaN)` is empty — which made `keep` empty and the
    // ACTIVE revision collectable. A keepLastN arriving from a query string is exactly how that
    // happens, so a non-integer is refused rather than coerced.
    // The floor is TWO, not one. `retained` is sorted newest-first and its first element is always
    // the ACTIVE revision, so `keepLastN: 1` keeps only what is currently served and collects every
    // retired revision — which is precisely the set `rollbackTargetFor` chooses from. A sweep with
    // the floor at 1 therefore made rollback permanently impossible while reporting success, and 1
    // was also what a non-finite value coerced to: the default annihilated the recovery path.
    const rawKeep = Number(opts.keepLastN);
    const keepN = Number.isFinite(rawKeep) ? Math.max(GC_MIN_KEEP, Math.floor(rawKeep)) : GC_MIN_KEEP;
    const keep = new Set(retained.slice(0, keepN).map((r) => r.id));

    const deleted: string[] = [];
    for (const r of records) {
      if (keep.has(r.id)) continue;
      const prefix = revisionFileKey(opts.storagePrefix, r.id, '').replace(/\/$/, '');
      if (revisionIdForPrefix(`${prefix}/${MANIFEST_FILENAME}`, opts.storagePrefix) !== r.id) {
        logger.error({ prefix, revisionId: r.id }, 'gc refused: prefix does not resolve to revision');
        continue;
      }
      // AGE GUARD. A revision still being uploaded has no `activated_at` and is not retained, so a
      // sweep running against a live publisher would delete its row and its prefix mid-write: the
      // publisher's own guard reads its in-memory record and never re-reads the row, so it keeps
      // writing files into a prefix with no row and fails only at the end. Nothing lists storage,
      // so those files are permanent orphans — the "next sweep reclaims" note below is true only of
      // bytes whose row this sweep itself deleted.
      if (!isCollectableByAge(r, opts.minAgeMs)) {
        logger.debug({ revisionId: r.id, status: r.status }, 'gc skipped: too young to collect');
        continue;
      }
      // ROW FIRST, then bytes. The reverse order leaves a window where a crash produces a retained
      // row whose bytes are gone — and `rollbackTargetFor` would then select it and `activate()`
      // would flip the pointer to a dead prefix, so the simulation serves nothing. Deleting the row
      // first can only orphan bytes, which nothing reads. Note they are NOT reclaimed later: no
      // sweep lists storage, so a crash between these two statements leaks that prefix permanently.
      // Deliberate — leaked bytes cost money, a stranded pointer costs a working simulation.
      const [gone] = await db.delete(sim_revisions).where(and(
        eq(sim_revisions.id, r.id),
        eq(sim_revisions.simulation_id, opts.simulationId),
        // CAS: the status must still be what was read. A revision activated between the read and
        // this delete must not be collected out from under the pointer.
        eq(sim_revisions.status, r.status),
      )).returning({ id: sim_revisions.id });
      if (!gone) {
        logger.warn({ revisionId: r.id }, 'gc skipped: revision changed status during the sweep');
        continue;
      }
      await this.storage.deleteWithPrefix(prefix);
      deleted.push(r.id);
    }
    return { deleted };
  }

  /**
   * Compare the weight of two revisions of one simulation.
   *
   * The point of recording weight at publication: an optimisation claim becomes checkable. Both
   * numbers were produced by the same analysis over a verified manifest, so the delta is a
   * comparison of measurements rather than of estimates.
   *
   * Returns null when either revision predates weight recording — an honest "cannot compare" beats
   * a zero that reads as "no change".
   */
  async compareRevisionWeight(simulationId: string, beforeId: string, afterId: string): Promise<
    { deltaBytes: number; deltaFiles: number; percentChange: number; improved: boolean } | null
  > {
    const rows = await db
      .select({ id: sim_revisions.id, metadata: sim_revisions.metadata })
      .from(sim_revisions)
      .where(eq(sim_revisions.simulation_id, simulationId));
    const weightOf = (id: string): WeightReport | null => {
      const m = rows.find((r) => r.id === id)?.metadata as { weight?: WeightReport } | null;
      return m?.weight && typeof m.weight.totalBytes === 'number' ? m.weight : null;
    };
    const before = weightOf(beforeId);
    const after = weightOf(afterId);
    if (!before || !after) return null;
    return compareWeight(before, after);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────────

  async listRevisions(simulationId: string): Promise<SimRevisionRecord[]> {
    const rows = await db
      .select()
      .from(sim_revisions)
      .where(eq(sim_revisions.simulation_id, simulationId));
    return rows.map(toRecord);
  }

  /** The pointer, read as one value so a caller's CAS uses what it actually saw. */
  async readPointer(simulationId: string): Promise<{ activeRevisionId: string | null; entryKey: string | null }> {
    const [row] = await db
      .select({
        activeRevisionId: simulations.active_revision_id,
        entryKey: simulations.active_revision_entry_key,
      })
      .from(simulations)
      .where(eq(simulations.id, simulationId));
    return { activeRevisionId: row?.activeRevisionId ?? null, entryKey: row?.entryKey ?? null };
  }

  /** Revisions stuck in a pre-publication status past `olderThanMs`. Never reaped at boot. */
  async staleDrafts(olderThanMs: number): Promise<SimRevisionRecord[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await db
      .select()
      .from(sim_revisions)
      .where(and(
        inArray(sim_revisions.status, ['draft', 'uploading', 'validating']),
        sql`${sim_revisions.created_at} < ${cutoff}`,
      ));
    return rows.map(toRecord);
  }
}

/**
 * The Cache-Control a revision file is STORED with.
 *
 * The entry document is the exception, and not because of its path: the boot snippet is injected at
 * SERVE time, so the bytes a viewer receives are not the bytes stored at that key. A year-long
 * immutable header would pin whichever snippet was live when the response was first cached — and it
 * would also freeze the CSP `frame-ancestors` list, which is deploy-dependent, so adding an app
 * origin could never reach an already-cached document.
 */
export function cacheControlForRole(role: SimFileRole, path: string): string {
  if (role === 'entry' || /\.html?$/i.test(path)) return POINTER_CACHE_CONTROL;
  return IMMUTABLE_CACHE_CONTROL;
}

/** Simulations still on the legacy mutable path. `isNull` is what makes 050 strictly additive. */
export async function legacySimulationIds(limit = 1000): Promise<string[]> {
  const rows = await db
    .select({ id: simulations.id })
    .from(simulations)
    .where(isNull(simulations.active_revision_id))
    .limit(limit);
  return rows.map((r) => r.id);
}
