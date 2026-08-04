/**
 * The service that owns a package's publication history (Priority 7.1/7.2).
 *
 * A revision is an immutable set of storage paths plus a row describing what was built. Publishing
 * is therefore not "overwrite the package" any more — it is "write a new revision, then move one
 * pointer". This service owns the pointer and the state machine around it
 * (shared/src/sim/simRevision.ts); nothing else in the product may write
 * `simulations.active_revision_id` or `simulation_revisions.status`.
 *
 * WHY EVERY WRITE IS A TRANSACTION
 * Activation touches three things that must agree or the package is unserveable: the outgoing
 * revision's status, the incoming revision's status, and the pointer. A crash between any two of
 * them leaves either two active revisions (the serving layer cannot choose) or a pointer naming a
 * revision whose row says it is retired (the serving layer refuses). Neither is recoverable without
 * a human, so the three writes are one transaction and there is no partial outcome to recover from.
 *
 * WHY THE DATABASE, NOT THIS FILE, IS THE CORRECTNESS ARGUMENT
 * `uniq_sim_revisions_one_active` is a partial unique index on (simulation_id) WHERE status='active'
 * (migration 050). Two concurrent activations that both read "R1 is active" would both compute a
 * valid-looking plan; the index is what makes exactly one of them commit. The `FOR UPDATE` row locks
 * below serialise callers so that the loser gets a comprehensible error instead of a constraint
 * violation — but if the locks were removed the system would still be CORRECT, just ruder. That
 * ordering of responsibilities is deliberate: never move a uniqueness guarantee into application
 * code that a second process can bypass.
 *
 * LOCK ORDER IS ALWAYS simulations → simulation_revisions
 * Activation needs both. Taking them in a fixed order in every path means two activations can never
 * hold the lock the other one is waiting for, so the failure mode is a queue, not a deadlock.
 */

import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { simulation_revisions, simulations } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

import {
  SIM_REVISION_STATUSES,
  canTransition,
  isValidRevisionId,
  rollbackTargetFor,
  type SimRevisionRecord,
  type SimRevisionStatus,
} from 'shared/src/sim/simRevision';

// ─── Types ────────────────────────────────────────────────────────────────────────────────────

/**
 * Any drizzle Postgres handle over this schema — the live postgres-js pool, or a transaction, or a
 * PGlite instance in tests. Widened to the base class on purpose: the tests exercise the real SQL
 * (partial indexes, row locks, constraint violations) against a real Postgres engine instead of a
 * fake that would have to re-implement the very constraints under test.
 */
export type RevisionDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface CreateDraftInput {
  simulationId: string;
  /** Supply one only to reproduce a specific revision (a re-run); otherwise a fresh id is minted. */
  revisionId?: string;
  manifestHash?: string | null;
  bridgeProtocolVersion?: number | null;
  runtimeProtocolVersion?: number | null;
  /** Set when this draft exists because a rollback republished an older revision's bytes. */
  rollbackOfRevisionId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Evidence recorded when a revision passes validation + canary. */
export interface CanaryPassedInput {
  manifestHash?: string;
  bridgeProtocolVersion?: number;
  runtimeProtocolVersion?: number;
  metadata?: Record<string, unknown>;
}

export interface ActivationResult {
  /** The revision that is now active. */
  revision: SimRevisionRecord;
  /** The revision that was active before, in its new (retired / rolled_back) state. */
  previous: SimRevisionRecord | null;
  /**
   * False when the requested revision was ALREADY the active one. Distinguished from `true` so a
   * caller can tell "I moved the pointer" from "the pointer was already there" — a publish pipeline
   * that retries must not report a second activation it did not perform.
   */
  changed: boolean;
}

// ─── Errors ───────────────────────────────────────────────────────────────────────────────────

export class RevisionNotFoundError extends Error {
  constructor(public readonly revisionId: string) {
    super(`Revision ${revisionId} does not exist`);
    this.name = 'RevisionNotFoundError';
  }
}

export class SimulationNotFoundError extends Error {
  constructor(public readonly simulationId: string) {
    super(`Simulation ${simulationId} does not exist`);
    this.name = 'SimulationNotFoundError';
  }
}

/**
 * A refused status change. Carries the three facts needed to act on it — where the revision actually
 * is, where the caller thought it could go, and what is legal from here — because the usual cause is
 * a pipeline resuming from the wrong step, and "illegal transition" alone does not say which step.
 */
export class IllegalRevisionTransitionError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly from: SimRevisionStatus,
    public readonly to: SimRevisionStatus,
  ) {
    super(
      `Revision ${revisionId} cannot go ${from} → ${to}. ` +
        `Legal from ${from}: ${legalTargets(from).join(', ') || '(none — terminal)'}`,
    );
    this.name = 'IllegalRevisionTransitionError';
  }
}

/**
 * Another activation won the race for this simulation.
 *
 * Thrown INSTEAD of retrying. A blind retry would re-run the state machine against whatever the
 * winner left behind and could activate a revision the caller never asked for — the caller asked to
 * publish revision X on top of the world it observed, and that world no longer exists.
 */
export class RevisionActivationConflictError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly activeRevisionId: string | null,
    options?: { cause?: unknown },
  ) {
    super(
      `Activation of revision ${revisionId} lost a race — ` +
        (activeRevisionId
          ? `revision ${activeRevisionId} is now active for this simulation`
          : 'the simulation has no active revision any more') +
        '. Re-read the current state and decide again; this was not retried.',
      options,
    );
    this.name = 'RevisionActivationConflictError';
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────────────────────

/** Name of the partial unique index that enforces one active revision (migration 050). */
export const ONE_ACTIVE_INDEX = 'uniq_sim_revisions_one_active';

export class RevisionService {
  constructor(private readonly database: RevisionDatabase = db) {}

  // ── Creation ────────────────────────────────────────────────────────────────────────────────

  /**
   * Open a new revision in `draft`. Nothing has been uploaded yet; the revision id it returns is
   * what every storage path for this build must be constructed from.
   */
  async createDraft(input: CreateDraftInput): Promise<SimRevisionRecord> {
    assertNonEmpty(input.simulationId, 'simulationId');
    const id = input.revisionId ?? mintRevisionId();
    if (!isValidRevisionId(id)) {
      throw new Error(
        `RevisionService: ${JSON.stringify(id)} is not a valid revision id — it appears verbatim in storage paths and must match [A-Za-z0-9_-]{8,64}`,
      );
    }
    if (input.rollbackOfRevisionId != null && !isValidRevisionId(input.rollbackOfRevisionId)) {
      throw new Error(`RevisionService: rollbackOfRevisionId ${JSON.stringify(input.rollbackOfRevisionId)} is not a valid revision id`);
    }

    return this.database.transaction(async (tx) => {
      // The lock is on the simulation, not on the revisions: `revision_number` is MAX+1 and two
      // concurrent drafts would otherwise read the same MAX, then collide on
      // uniq_sim_revisions_number — a constraint violation where a queue was wanted.
      const [sim] = await tx
        .select({ id: simulations.id })
        .from(simulations)
        .where(eq(simulations.id, input.simulationId))
        .for('update');
      if (!sim) throw new SimulationNotFoundError(input.simulationId);

      const [{ highest }] = await tx
        .select({ highest: sql<number | null>`max(${simulation_revisions.revision_number})` })
        .from(simulation_revisions)
        .where(eq(simulation_revisions.simulation_id, input.simulationId));

      const [row] = await tx
        .insert(simulation_revisions)
        .values({
          id,
          simulation_id: input.simulationId,
          revision_number: (highest ?? 0) + 1,
          status: 'draft' satisfies SimRevisionStatus,
          manifest_hash: input.manifestHash ?? null,
          bridge_protocol_version: input.bridgeProtocolVersion ?? null,
          runtime_protocol_version: input.runtimeProtocolVersion ?? null,
          rollback_of_revision_id: input.rollbackOfRevisionId ?? null,
          metadata: input.metadata ?? null,
        })
        .returning();

      if (!row) throw new Error(`RevisionService: draft ${id} was not returned by the insert — revision not created`);
      return toRecord(row);
    });
  }

  // ── Linear status changes ───────────────────────────────────────────────────────────────────

  markUploading(revisionId: string): Promise<SimRevisionRecord> {
    return this.transition(revisionId, 'uploading');
  }

  markValidating(revisionId: string): Promise<SimRevisionRecord> {
    return this.transition(revisionId, 'validating');
  }

  /**
   * Record that the stored bytes verified and the canary passed.
   *
   * The manifest hash and protocol versions are written HERE rather than at draft time because
   * before validation they are an intention, and a row that carries an intention is indistinguishable
   * from one that carries a proof.
   */
  markCanaryPassed(revisionId: string, evidence: CanaryPassedInput = {}): Promise<SimRevisionRecord> {
    const patch: MutableRevisionColumns = {};
    if (evidence.manifestHash !== undefined) patch.manifest_hash = evidence.manifestHash;
    if (evidence.bridgeProtocolVersion !== undefined) patch.bridge_protocol_version = evidence.bridgeProtocolVersion;
    if (evidence.runtimeProtocolVersion !== undefined) patch.runtime_protocol_version = evidence.runtimeProtocolVersion;
    return this.transition(revisionId, 'canary_passed', patch, evidence.metadata);
  }

  /**
   * Terminal failure. `failed` has no outgoing transitions, so this revision can never be served —
   * which is the point: a half-written package must not become activatable by a later step that
   * forgets to check why it stopped.
   */
  markFailed(revisionId: string, reason: string): Promise<SimRevisionRecord> {
    assertNonEmpty(reason, 'reason');
    return this.transition(revisionId, 'failed', {}, { failureReason: reason, failedAt: new Date().toISOString() });
  }

  // ── The pointer ─────────────────────────────────────────────────────────────────────────────

  /**
   * Make this revision the one that is served. Single transaction: retire the incumbent, activate
   * the target, move the pointer.
   */
  activate(revisionId: string): Promise<ActivationResult> {
    return this.runActivation(revisionId, 'retired');
  }

  /**
   * Withdraw the active revision and put an earlier one back.
   *
   * Identical mechanics to `activate` with one difference that exists purely for the audit: the
   * outgoing revision becomes `rolled_back`, not `retired`. `retired` means "something newer took
   * over"; `rolled_back` means "a human decided this was wrong". After an incident the first
   * question is which of those happened, and a single status for both cannot answer it.
   */
  rollbackTo(revisionId: string): Promise<ActivationResult> {
    return this.runActivation(revisionId, 'rolled_back');
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────

  async getRevision(revisionId: string): Promise<SimRevisionRecord | null> {
    assertRevisionId(revisionId);
    const [row] = await this.database
      .select()
      .from(simulation_revisions)
      .where(eq(simulation_revisions.id, revisionId));
    return row ? toRecord(row) : null;
  }

  /** Newest revision number first — the order a human reads a publication history in. */
  async listRevisions(simulationId: string): Promise<SimRevisionRecord[]> {
    assertNonEmpty(simulationId, 'simulationId');
    const rows = await this.database
      .select()
      .from(simulation_revisions)
      .where(eq(simulation_revisions.simulation_id, simulationId))
      .orderBy(desc(simulation_revisions.revision_number), asc(simulation_revisions.id));
    return rows.map(toRecord);
  }

  /**
   * The revision currently being served, read from the STATUS and not from the pointer.
   *
   * The status column is the one the database constrains to be unique, so it is the value that
   * cannot be wrong. Reading `simulations.active_revision_id` instead would trust a column nothing
   * enforces; it is a cache of this answer, and `activate` is what keeps it honest.
   */
  async getActive(simulationId: string): Promise<SimRevisionRecord | null> {
    assertNonEmpty(simulationId, 'simulationId');
    const [row] = await this.database
      .select()
      .from(simulation_revisions)
      .where(
        and(
          eq(simulation_revisions.simulation_id, simulationId),
          eq(simulation_revisions.status, 'active' satisfies SimRevisionStatus),
        ),
      );
    return row ? toRecord(row) : null;
  }

  /**
   * Which revision `rollbackTo` should be called with: the most recently ACTIVATED revision that is
   * not the current one. The ordering is by activation instant, never by revision number — see
   * rollbackTargetFor.
   */
  async getRollbackTarget(simulationId: string): Promise<SimRevisionRecord | null> {
    const [history, active] = await Promise.all([
      this.listRevisions(simulationId),
      this.getActive(simulationId),
    ]);
    return rollbackTargetFor(history, active?.id ?? null);
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────────

  /**
   * Every non-activation status change. Reads the CURRENT status under a row lock and refuses
   * anything `canTransition` rejects, so a caller can never move a revision by asserting where it
   * came from — the row is the only source of that.
   */
  private async transition(
    revisionId: string,
    to: SimRevisionStatus,
    patch: MutableRevisionColumns = {},
    metadataPatch?: Record<string, unknown>,
  ): Promise<SimRevisionRecord> {
    assertRevisionId(revisionId);
    if (to === 'active') {
      // Reaching 'active' also has to retire the incumbent and move the pointer. A path that set
      // only the status would produce a row the serving layer treats as live while
      // simulations.active_revision_id still names the old one.
      throw new Error('RevisionService: use activate() / rollbackTo() to make a revision active');
    }

    return this.database.transaction(async (tx) => {
      const locked = await lockRevision(tx, revisionId);
      const { row: current } = locked;
      assertTransition(revisionId, statusOf(current), to);

      const [row] = await tx
        .update(simulation_revisions)
        .set({
          ...patch,
          ...(metadataPatch ? { metadata: mergeMetadata(metadataPatch) } : {}),
          status: to,
        })
        // Redundant under the row lock, and kept anyway: it makes the update itself express the
        // precondition, so the write cannot silently apply to a status nobody checked.
        .where(and(eq(simulation_revisions.id, revisionId), eq(simulation_revisions.status, current.status)))
        .returning();

      if (!row) {
        throw new Error(`RevisionService: revision ${revisionId} changed status concurrently — ${to} not applied`);
      }

      // `active → failed` is a legal transition, and it leaves the pointer naming a revision that
      // is no longer servable. Clearing it in the SAME transaction returns the package to the
      // legacy mutable path, which still serves; leaving it would point the serving layer at a
      // revision it must refuse, i.e. a package that renders nothing.
      if (current.status === 'active' && locked.pointer === revisionId) {
        logger.warn(
          { simulationId: locked.simulationId, revisionId, status: to },
          '[revisions] active revision left the active state — clearing the pointer to the legacy path',
        );
        await tx
          .update(simulations)
          .set({ active_revision_id: null })
          .where(eq(simulations.id, locked.simulationId));
      }
      return toRecord(row);
    });
  }

  private async runActivation(
    revisionId: string,
    outgoing: 'retired' | 'rolled_back',
  ): Promise<ActivationResult> {
    assertRevisionId(revisionId);
    try {
      return await this.database.transaction(async (tx) => this.activateWithin(tx, revisionId, outgoing));
    } catch (err) {
      if (!isOneActiveViolation(err)) throw err;
      // The partial unique index refused the write, so a concurrent activation committed first. The
      // transaction is gone; re-read on the pool to report WHO won, and do not retry — see
      // RevisionActivationConflictError.
      const [row] = await this.database
        .select({ id: simulation_revisions.id, simulation_id: simulation_revisions.simulation_id })
        .from(simulation_revisions)
        .where(eq(simulation_revisions.id, revisionId));
      const winner = row ? await this.getActive(row.simulation_id) : null;
      throw new RevisionActivationConflictError(revisionId, winner?.id ?? null, { cause: err });
    }
  }

  private async activateWithin(
    tx: RevisionDatabase,
    revisionId: string,
    outgoing: 'retired' | 'rolled_back',
  ): Promise<ActivationResult> {
    const { row: target, simulationId, pointer } = await lockRevision(tx, revisionId);

    const [incumbent] = await tx
      .select()
      .from(simulation_revisions)
      .where(
        and(
          eq(simulation_revisions.simulation_id, simulationId),
          eq(simulation_revisions.status, 'active' satisfies SimRevisionStatus),
        ),
      )
      .for('update');

    if (incumbent && incumbent.id === revisionId) {
      // Already active. Not an error and not a transition: the caller's intent is satisfied, and
      // failing a retry of a successful activation would make publishing non-resumable.
      if (pointer !== revisionId) {
        // The status column is the constrained one, so it wins. This can only be reached if
        // something outside this service wrote the pointer.
        logger.warn(
          { simulationId, pointer, active: revisionId },
          '[revisions] pointer disagreed with the active revision — repairing to the active row',
        );
        await tx
          .update(simulations)
          .set({ active_revision_id: revisionId })
          .where(eq(simulations.id, simulationId));
      }
      return { revision: toRecord(target), previous: null, changed: false };
    }

    let previous: SimRevisionRecord | null = null;
    if (incumbent) {
      assertTransition(incumbent.id, statusOf(incumbent), outgoing);
      // Retire BEFORE activating. The partial unique index is checked per statement, so activating
      // first would violate it inside our own transaction — correctly, but for the wrong reason.
      const [retired] = await tx
        .update(simulation_revisions)
        .set({
          status: outgoing,
          retired_at: sql`clock_timestamp()`,
          ...(outgoing === 'rolled_back'
            ? { metadata: mergeMetadata({ rolledBackTo: revisionId, rolledBackAt: new Date().toISOString() }) }
            : {}),
        })
        .where(and(eq(simulation_revisions.id, incumbent.id), eq(simulation_revisions.status, 'active')))
        .returning();
      if (!retired) {
        throw new Error(`RevisionService: incumbent ${incumbent.id} was no longer active — activation abandoned`);
      }
      previous = toRecord(retired);
    }

    assertTransition(revisionId, statusOf(target), 'active');
    const [activated] = await tx
      .update(simulation_revisions)
      .set({
        status: 'active' satisfies SimRevisionStatus,
        // clock_timestamp(), not now(): now() is the transaction start, so two revisions activated
        // in one transaction would tie — and rollbackTargetFor orders on exactly this column, so a
        // tie makes "which was served most recently" unanswerable.
        activated_at: sql`clock_timestamp()`,
        // A revision that is live is not withdrawn; leaving the old stamp would produce a row that
        // is both (and the DDL refuses it).
        retired_at: null,
      })
      .where(and(eq(simulation_revisions.id, revisionId), eq(simulation_revisions.status, target.status)))
      .returning();
    if (!activated) {
      throw new Error(`RevisionService: revision ${revisionId} changed status concurrently — activation abandoned`);
    }

    await tx
      .update(simulations)
      .set({ active_revision_id: revisionId })
      .where(eq(simulations.id, simulationId));

    logger.info(
      { simulationId, revisionId, previous: previous?.id ?? null, outgoing },
      '[revisions] activation committed',
    );
    return { revision: toRecord(activated), previous, changed: true };
  }
}

export const revisionService = new RevisionService();

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────

type RevisionRow = typeof simulation_revisions.$inferSelect;

/** The columns a status change is allowed to carry along with it. */
interface MutableRevisionColumns {
  manifest_hash?: string | null;
  bridge_protocol_version?: number | null;
  runtime_protocol_version?: number | null;
}

/**
 * 22 URL-safe characters of CSPRNG output (128 bits).
 *
 * Random rather than sequential because the id is baked into immutable storage paths and into the
 * `packageRevision` identity axis: a derived or ordered id would let a renumbering, a restore or a
 * re-import change a path that clients already cache as immutable.
 */
export function mintRevisionId(): string {
  return randomBytes(16).toString('base64url');
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`RevisionService: ${field} is required`);
  }
}

function assertRevisionId(revisionId: string): void {
  if (!isValidRevisionId(revisionId)) {
    throw new Error(`RevisionService: ${JSON.stringify(revisionId)} is not a valid revision id`);
  }
}

function assertTransition(revisionId: string, from: SimRevisionStatus, to: SimRevisionStatus): void {
  if (!canTransition(from, to)) throw new IllegalRevisionTransitionError(revisionId, from, to);
}

function legalTargets(from: SimRevisionStatus): SimRevisionStatus[] {
  return SIM_REVISION_STATUSES.filter((to) => canTransition(from, to));
}

/**
 * A stored status that is not one this build knows about is a hard stop, not a default.
 *
 * Defaulting would let a row written by a newer deployment be transitioned by an older one using
 * rules that do not describe it — the older node would decide the revision is in some familiar
 * state and move it somewhere the newer node considers impossible.
 */
function statusOf(row: { id: string; status: string }): SimRevisionStatus {
  if (!(SIM_REVISION_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(
      `RevisionService: revision ${row.id} has status ${JSON.stringify(row.status)}, which this build does not know`,
    );
  }
  return row.status as SimRevisionStatus;
}

interface LockedRevision {
  row: RevisionRow;
  simulationId: string;
  /** `simulations.active_revision_id` as it stands under the lock. */
  pointer: string | null;
}

/**
 * Take both locks a revision write needs, ALWAYS in the order simulations → simulation_revisions.
 *
 * Every mutating path goes through here, including the ones that look like they only touch a single
 * revision row: `active → failed` has to clear the pointer, so a path that had locked only the
 * revision would have to reach for the simulation lock second and could then deadlock against an
 * activation holding them the other way round. One helper is what keeps the order impossible to get
 * wrong at a call site.
 *
 * The first read is deliberately unlocked and nothing is decided from it — it exists only to learn
 * which simulation to lock. The authoritative read of the same row happens after both locks are
 * held.
 */
async function lockRevision(tx: RevisionDatabase, revisionId: string): Promise<LockedRevision> {
  const [probe] = await tx
    .select({ simulation_id: simulation_revisions.simulation_id })
    .from(simulation_revisions)
    .where(eq(simulation_revisions.id, revisionId));
  if (!probe) throw new RevisionNotFoundError(revisionId);

  const [sim] = await tx
    .select({ id: simulations.id, pointer: simulations.active_revision_id })
    .from(simulations)
    .where(eq(simulations.id, probe.simulation_id))
    .for('update');
  if (!sim) throw new SimulationNotFoundError(probe.simulation_id);

  const [row] = await tx
    .select()
    .from(simulation_revisions)
    .where(eq(simulation_revisions.id, revisionId))
    .for('update');
  // Deleted between the probe and the lock. The simulation lock cannot prevent that (a DELETE takes
  // its own row lock), so the second miss is reported rather than assumed impossible.
  if (!row) throw new RevisionNotFoundError(revisionId);

  return { row, simulationId: sim.id, pointer: sim.pointer };
}

/**
 * Merge into `metadata` in SQL rather than read-modify-write in JS.
 *
 * The read-modify-write version loses whatever another writer added between the two statements. The
 * `||` operator applies to the row as it is at write time, so concurrent annotations from different
 * stages of the pipeline accumulate instead of overwriting each other.
 */
function mergeMetadata(patch: Record<string, unknown>): ReturnType<typeof sql> {
  return sql`coalesce(${simulation_revisions.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

/**
 * Did this error come from the one-active partial index?
 *
 * Matched on the constraint name and not on the SQLSTATE alone: 23505 is also what
 * uniq_sim_revisions_number raises, and that one means "two drafts raced", which is retryable and
 * must not be reported to the operator as a lost activation race.
 *
 * postgres.js exposes the name as `constraint_name`, PGlite as `constraint`; the message is checked
 * last so that a driver exposing neither still classifies correctly rather than silently widening
 * every unique violation into a conflict.
 */
export function isOneActiveViolation(err: unknown): boolean {
  const e = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown; message?: unknown };
  if (e?.code !== '23505') return false;
  if (e.constraint_name === ONE_ACTIVE_INDEX || e.constraint === ONE_ACTIVE_INDEX) return true;
  return typeof e.message === 'string' && e.message.includes(ONE_ACTIVE_INDEX);
}

function toRecord(row: RevisionRow): SimRevisionRecord {
  return {
    id: row.id,
    simulationId: row.simulation_id,
    revisionNumber: row.revision_number,
    status: statusOf(row),
    manifestHash: row.manifest_hash,
    bridgeProtocolVersion: row.bridge_protocol_version,
    runtimeProtocolVersion: row.runtime_protocol_version,
    createdAt: row.created_at.toISOString(),
    activatedAt: row.activated_at ? row.activated_at.toISOString() : null,
    retiredAt: row.retired_at ? row.retired_at.toISOString() : null,
    rollbackOfRevisionId: row.rollback_of_revision_id,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
  };
}
