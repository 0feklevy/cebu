/**
 * Linear video export — the job body (plan doc "THE DECISION", Phase 1).
 *
 * COPIES THE DUPLICATION DISCIPLINE VERBATIM, because the failure modes are the same shape:
 * a multi-minute job on the inline driver (no durability, no retries), a partial unique index
 * that makes a dead in-flight row a PERMANENT block on the project, and a poll that will follow
 * whatever the row says forever. So:
 *
 *   • `claim()` is a conditional UPDATE (CAS) from `queued` or from a stale in-flight status —
 *     a second delivery of the same export does nothing instead of encoding twice;
 *   • a live run beats an unref'd 15 s heartbeat onto `updated_at`, which is what makes
 *     "untouched for EXPORT_STALE_AFTER_MS" a sound death test;
 *   • every status write after the claim is FENCED (`WHERE status IN in-flight`): a run that was
 *     reaped or superseded must not drag a terminal row back to life or overwrite its successor;
 *   • failures are CLASSIFIED and stored with the real reason — the row is all anyone has after
 *     the work directory is deleted (`classifyExportFailure`, mirroring
 *     `classifyDuplicationFailure`; one convention, not two);
 *   • `sweepAbandonedExports` + `liveExportFor` reap rows nothing is running, on a timer and
 *     inside the very request that wants to start a new one.
 *
 * WHAT IS DIFFERENT FROM DUPLICATION, AND WHY
 *   • `cancel_requested`: an encode is worth interrupting, a byte copy is not. The endpoint sets
 *     the flag; the RUNNER honours it between phases (and via the assembler's AbortSignal) and is
 *     the only writer of terminal status — so the poll can never see a terminal row while ffmpeg
 *     still holds the work directory.
 *   • Phases are `planning → capturing → assembling → uploading`. `capturing` captures each scripted
 *     sim window when a capture backend is injected AND available on this host, uploading the gated
 *     clip to the export's own write-once section key so it splices like any other source; with no
 *     backend (the shipped default), or on a capture that is unavailable or fails its sanity gate,
 *     the window resolves to its poster still. Every substitution is recorded as a warning, because
 *     a degraded export must be degraded LOUDLY, and `quality_state` becomes `degraded`.
 *   • The output lands at a versioned write-once key and `output_key` is set only in the terminal
 *     `ready` write: a SIGTERM'd encode leaves a well-formed, playable partial MP4, so nothing
 *     upstream of the exit-0 gate may ever become the published pointer.
 */

import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { db } from '../../db/index.js';
import { project_exports } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import type { StorageService } from '../storage/StorageService.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { IMMUTABLE_CACHE_CONTROL } from 'shared/sim/simRevision';

import { ExportRefused, buildExportPlan } from './exportPlan.js';
import type { ExportPhase, ExportPlan, LinearAssembler, PosterFallbackWindow, ClipWindow } from './types.js';
import { CaptureUnavailable, CaptureGateFailed, type SimCaptureBackend } from './capture/captureTypes.js';

// ── Liveness ──────────────────────────────────────────────────────────────────────────────────

/**
 * Same numbers, same argument as duplication: the heartbeat is what makes staleness a sound
 * liveness test, because per-phase progress writes can legitimately go minutes apart while
 * ffmpeg grinds through one long encode. Twenty missed beats before the row is declared dead.
 */
export const EXPORT_HEARTBEAT_MS = 15_000;
export const EXPORT_STALE_AFTER_MS = 20 * EXPORT_HEARTBEAT_MS;

/** The moment before which an in-flight export row is no longer believed to be running. */
export function exportStaleBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - EXPORT_STALE_AFTER_MS);
}

/** The in-flight statuses migration 058's partial unique index refuses a second row for. */
export const EXPORT_IN_FLIGHT_STATUSES = ['queued', 'planning', 'capturing', 'assembling', 'uploading'] as const;

/** What a reaped run tells the user. Actionable, because the action is simply "try again". */
export const EXPORT_ABANDONED_MESSAGE =
  'The export stopped before it finished (the server restarted). No video was published; you can start it again.';

/** What a honoured cancellation tells the user. */
export const EXPORT_CANCELLED_MESSAGE = 'The export was cancelled. No video was published.';

// ── Failure classification ────────────────────────────────────────────────────────────────────

export interface ExportFailure {
  code: string;
  retryable: boolean;
  /** One sentence for the user. Never a stack, never an internal identifier. */
  userMessage: string;
  /** For the operator: the real error. Stored in the plan's failure block, never rendered. */
  detail: string;
}

/** Cap on the stored sentence — `error` is unconstrained TEXT, a UI strip is not. */
const MAX_STORED_ERROR = 500;

/**
 * Turn whatever `run()` threw into something the row can hold and a person can act on —
 * `classifyDuplicationFailure`'s pattern, applied to this job. The bare generic is the LAST
 * resort, never the default: a refusal carries its own code, message and retryability, and an
 * unrecognised error is reported RETRYABLE, because telling someone to give up on an export that
 * would have worked is worse than letting them press a button twice.
 */
export function classifyExportFailure(err: unknown): ExportFailure {
  const detailOf = (e: unknown): string =>
    e instanceof Error ? `${e.name}: ${e.message}` : String(e);

  if (err instanceof ExportRefused) {
    return { code: err.code, retryable: err.retryable, userMessage: err.message, detail: detailOf(err) };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    // The assembler honoured the AbortSignal: cancellation surfacing as a throw, not a failure
    // of the encode. Not retryable in the "same click" sense — the user asked for the stop.
    return { code: 'export_cancelled', retryable: false, userMessage: EXPORT_CANCELLED_MESSAGE, detail: detailOf(err) };
  }
  return {
    code: 'unknown',
    retryable: true,
    userMessage: 'The export failed. No video was published; you can try again.',
    detail: detailOf(err),
  };
}

/** The two answers to "may this export ship a still instead of a live simulation?". */
export type DegradationPolicy = 'forbid' | 'allow_poster';

/**
 * Read the policy frozen on the row. Anything unrecognised — an older row, a hand-edited value —
 * reads as `forbid`, because the failure direction matters: guessing `allow_poster` ships a
 * slideshow the user never agreed to, while guessing `forbid` at worst fails an export the user can
 * retry with explicit consent.
 */
export function degradationPolicyOf(row: { degradation_policy?: string | null }): DegradationPolicy {
  return row.degradation_policy === 'allow_poster' ? 'allow_poster' : 'forbid';
}

/**
 * A simulation window could not be captured while the export was forbidden from degrading.
 *
 * This is the whole point of the strict contract: the user asked for a video of their simulations,
 * and a still image is not a worse version of that — it is a different artifact. Publishing one
 * anyway is the failure the entire capture incident exists to prevent, and it is worse than
 * publishing nothing, because nothing is visible and a silent slideshow is not.
 */
export class StrictCaptureFailed extends ExportRefused {
  constructor(section: string, reason: string, retryable: boolean) {
    super(
      `The simulation "${section}" could not be rendered, so the export was stopped. `
        + 'No video was published. You can try again, or export with still images instead.',
      422,
      'capture_failed_strict',
      retryable,
    );
    this.detail = `${section}: ${reason}`;
  }
  detail: string;
}

// ── The assembler seam ────────────────────────────────────────────────────────────────────────

/**
 * Load the sibling's `LinearAssembler.ts` implementation, which must export
 * `createLinearAssembler(): LinearAssembler`. Loaded lazily and BY VARIABLE so this module (and
 * everything that imports it — the queue registry, the server) still loads in a build where the
 * sibling has not landed; a run in such a build is refused with the honest reason instead of
 * crashing module resolution for the whole process.
 */
async function loadAssembler(): Promise<LinearAssembler> {
  const modulePath = './LinearAssembler.js';
  let mod: { createLinearAssembler?: () => LinearAssembler };
  try {
    mod = (await import(modulePath)) as { createLinearAssembler?: () => LinearAssembler };
  } catch {
    throw new ExportRefused(
      'Video assembly is not available on this server yet.',
      503, 'assembler_unavailable', false,
    );
  }
  if (typeof mod.createLinearAssembler !== 'function') {
    throw new ExportRefused(
      'Video assembly is not available on this server yet.',
      503, 'assembler_unavailable', false,
    );
  }
  return mod.createLinearAssembler();
}

/** Buffers up to this size upload via `uploadFile` (which can set Cache-Control); above, stream. */
const UPLOAD_BUFFER_MAX_BYTES = 256 * 1024 * 1024;

// ── Service ───────────────────────────────────────────────────────────────────────────────────

export class ProjectExportService {
  constructor(
    private readonly storage: StorageService = getStorageAdapter(),
    /** Injectable for tests; production resolves the sibling implementation lazily in run(). */
    private readonly assembler: LinearAssembler | null = null,
    /**
     * The simulation capture backend. **Null by default, and that is the shipped Phase-1 state**:
     * with no provider every sim window resolves to its poster still, which is the path that has
     * been verified end to end. A real backend (the isolated container capture worker) is INJECTED
     * only once it is deployed and its container-verification checklist
     * (`md-files/EXPORT-CAPTURE-ISOLATION.md`) has passed on a Linux host — because that path
     * cannot be verified on a developer machine (beginFrame is macOS-blocked, measured). When a
     * provider is present and reports `isAvailable()`, a captured window becomes an ordinary
     * spliced clip; a capture that is unavailable or fails its sanity gate degrades to the poster
     * fallback, loudly. The default therefore changes nothing until an operator switches it on.
     */
    private readonly captureProvider: SimCaptureBackend | null = null,
  ) {}

  /**
   * Take exclusive ownership of an export row for this process, or refuse to run.
   *
   * A conditional UPDATE, not a read-then-write: the row moves to `planning` only from `queued`,
   * or from an in-flight status that has gone `EXPORT_STALE_AFTER_MS` without a heartbeat. Zero
   * rows updated means somebody else holds it and this delivery must do nothing — the durable
   * driver is at-least-once, and a second delivery must not start a second encode.
   */
  private async claim(exportId: string, now: Date): Promise<boolean> {
    const claimed = await db.update(project_exports)
      .set({ status: 'planning', updated_at: now })
      .where(and(
        eq(project_exports.id, exportId),
        or(
          eq(project_exports.status, 'queued'),
          and(
            inArray(project_exports.status, [...EXPORT_IN_FLIGHT_STATUSES]),
            lt(project_exports.updated_at, exportStaleBefore(now)),
          ),
        ),
      ))
      .returning({ id: project_exports.id });
    return claimed.length > 0;
  }

  /**
   * `cancel_requested`, honoured between phases. Throws the refusal that classifies as
   * `export_cancelled` so the ordinary failure path records it — one terminal writer, one fence.
   */
  private async throwIfCancelRequested(exportId: string): Promise<void> {
    const [row] = await db.select({ cancel_requested: project_exports.cancel_requested })
      .from(project_exports).where(eq(project_exports.id, exportId));
    if (row?.cancel_requested) {
      throw new ExportRefused(EXPORT_CANCELLED_MESSAGE, 409, 'export_cancelled', false);
    }
  }

  /**
   * The ingest gate. Every MUTABLE source (raw video masters, audio assets, images, posters —
   * the keys replace/re-upload flows overwrite in place) is re-HEADed and compared against the
   * identity the plan froze. Sim-revision sources are skipped: their bytes are immutable by the
   * revision model, and their identity is the manifest hash the plan already carries.
   *
   * A mismatch means the user edited mid-export. Refused as `source_changed`, RETRYABLE — the
   * next attempt re-plans against the new bytes — because the alternative is a master spliced
   * from two generations of one file, which nobody authored and no one can debug.
   */
  private async assertSourceIdentity(plan: ExportPlan): Promise<void> {
    for (const src of plan.sources) {
      if (src.kind === 'sim-revision') continue;
      const head = await this.storage.headObject(src.storageKey).catch(() => null);
      if (!head) {
        throw new ExportRefused(
          'A media file this export needs was removed while it was running. Start the export again.',
          409, 'source_changed', true,
        );
      }
      const sizeMismatch = src.sizeBytes !== null && head.size !== null && head.size !== src.sizeBytes;
      const etagMismatch = src.etag !== null && head.etag !== null && head.etag !== src.etag;
      if (sizeMismatch || etagMismatch) {
        throw new ExportRefused(
          'The project’s media changed while the export was running, so this export was stopped '
          + 'before it could mix old and new versions. Start it again to export the current media.',
          409, 'source_changed', true,
        );
      }
    }
  }

  /** A status/progress write that must not resurrect a row this run no longer owns. */
  private async fencedUpdate(exportId: string, values: Partial<typeof project_exports.$inferInsert>): Promise<void> {
    await db.update(project_exports)
      .set({ ...values, updated_at: new Date() })
      .where(and(
        eq(project_exports.id, exportId),
        inArray(project_exports.status, [...EXPORT_IN_FLIGHT_STATUSES]),
      ));
  }

  /**
   * Execute one queued export end to end. Every failure path marks the row `failed` with the
   * REAL reason; the only thing written to storage before the terminal `ready` is the master at
   * a write-once key nothing points to until `output_key` is set.
   */
  async run(exportId: string): Promise<void> {
    const [job] = await db.select().from(project_exports).where(eq(project_exports.id, exportId));
    if (!job) throw new Error(`export ${exportId} not found`);
    if (job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled') return;
    if (!(await this.claim(exportId, new Date()))) {
      logger.warn({ exportId, status: job.status }, 'export: already running elsewhere — not starting a second encode');
      return;
    }

    // Liveness on a TIMER, not only per phase: one encode can legitimately outlast any sane gap
    // between two progress writes. Unref'd: a pending beat must never hold the process open.
    const heartbeat = setInterval(() => {
      void db.update(project_exports)
        .set({ updated_at: new Date() })
        .where(eq(project_exports.id, exportId))
        .catch((err: unknown) => logger.debug({ err, exportId }, 'export: heartbeat failed'));
    }, EXPORT_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    // The abort side of cancellation: between phases the flag is polled explicitly; DURING the
    // assemble it is polled on the heartbeat cadence and translated into the AbortSignal the
    // assembler contract requires (SIGTERM first, escalate — see types.ts).
    const abort = new AbortController();
    const cancelWatch = setInterval(() => {
      void db.select({ cancel_requested: project_exports.cancel_requested })
        .from(project_exports).where(eq(project_exports.id, exportId))
        .then(([r]) => { if (r?.cancel_requested) abort.abort(); })
        .catch((err: unknown) => logger.debug({ err, exportId }, 'export: cancel poll failed'));
    }, EXPORT_HEARTBEAT_MS);
    if (typeof cancelWatch.unref === 'function') cancelWatch.unref();

    // Hoisted so the catch can say WHERE it died — the coarsest useful fact about a failure.
    let phase: ExportPhase = 'planning';
    let workDir: string | null = null;
    try {
      // ─── planning ───────────────────────────────────────────────────────────────────────────
      logger.info({ exportId, projectId: job.project_id }, 'export: run started — planning');
      const plan = await buildExportPlan(job.project_id, this.storage);
      if (!plan) throw new ExportRefused('The project no longer exists.', 404, 'project_missing', false);

      // The plan is stored BEFORE any work: it is the only artefact that can answer "why does
      // the master look like that?" after the work directory is gone. Fenced, like every write.
      await this.fencedUpdate(exportId, {
        plan: plan as unknown as Record<string, unknown>,
        objects_total: plan.timeline.length,
      });
      logger.info({
        exportId,
        windows: plan.timeline.length,
        simWindows: plan.timeline.filter((w) => w.kind === 'sim-capture').length,
        planWarnings: plan.warnings.length,
      }, 'export: plan built');

      await assertDiskHeadroom(plan, exportId);
      await this.throwIfCancelRequested(exportId);

      // ─── capturing ──────────────────────────────────────────────────────────────────────────
      // Each scripted sim window is captured if a backend is present and can run here; otherwise —
      // and on any capture that is unavailable or fails its sanity gate — it resolves to the
      // poster still. Recorded PER WINDOW, because a degraded export must degrade LOUDLY: the user
      // is told exactly which sections became stills, and `quality_state` becomes `degraded` at the
      // ready write. With no provider (the shipped default) this is every sim window, unchanged
      // from before capture existed.
      phase = 'capturing';
      await this.fencedUpdate(exportId, { status: 'capturing' });
      const toPoster = (w: { sectionId: string; label: string | null; startSec: number; endSec: number; posterKey: string | null }): PosterFallbackWindow => ({
        kind: 'poster-fallback', sectionId: w.sectionId, label: w.label,
        startSec: w.startSec, endSec: w.endSec, posterKey: w.posterKey,
      });
      const name = (w: { sectionId: string; label?: string | null }): string => w.label ?? `section ${w.sectionId}`;
      // ONE availability check, not one per window: `isAvailable` is a host preflight, not a
      // per-section fact, and calling it N times would launch N browsers to learn one answer.
      const backend = this.captureProvider;
      const canCapture = backend ? await backend.isAvailable().catch(() => false) : false;
      // The policy the user actually agreed to, read from the row rather than re-derived. A retry,
      // a restart, or a duplicate delivery of this job therefore honours the same answer.
      const policy = degradationPolicyOf(job);
      logger.info(
        { exportId, captureBackend: backend != null, captureAvailable: canCapture },
        'export: capturing phase started',
      );

      let done = 0;
      const captured: ExportPlan['timeline'] = [];
      for (const w of plan.timeline) {
        done += 1;
        // Advisory per-window progress so the client's bar advances during the (slow) capture phase
        // instead of sitting at 0% until it ends. Unfenced like the assembler's counter: a lost
        // write costs one poll tick, not correctness — the FENCED status writes are what gate.
        void db.update(project_exports)
          .set({ objects_done: done, updated_at: new Date() })
          .where(eq(project_exports.id, exportId))
          .catch((err: unknown) => logger.debug({ err, exportId }, 'export: capture progress write failed'));
        if (w.kind !== 'sim-capture') { captured.push(w); continue; }
        await this.throwIfCancelRequested(exportId);

        if (!canCapture || !backend || !w.servedUrl) {
          if (policy === 'forbid') {
            // Strict mode: infrastructure that cannot render is a truthful, RETRYABLE failure, not
            // grounds to quietly ship a still. The user asked for the simulation.
            throw new StrictCaptureFailed(
              name(w),
              !w.servedUrl ? 'the simulation has no capturable package' : 'no capture backend is available on this host',
              Boolean(w.servedUrl),
            );
          }
          logger.info({ exportId, section: name(w) }, 'export: sim window degraded — capture unavailable');
          captured.push(toPoster(w));
          plan.warnings.push(
            w.posterKey
              ? `${name(w)}: simulation capture is not available — exported as its poster still with silence`
              : `${name(w)}: simulation capture is not available and no poster still exists — the base video plays through this window`,
          );
          continue;
        }

        try {
          const result = await backend.captureSection({
            servedSimUrl: w.servedUrl, sectionId: w.sectionId,
            simpleUi: w.simpleUi, autoScript: w.autoScript, uiHide: w.uiHide ?? [],
            durationSec: w.endSec - w.startSec, fps: plan.grid.fps,
            width: plan.grid.w, height: plan.grid.h, configHash: w.configHash ?? '', posterKey: w.posterKey ?? '',
          }, abort.signal);

          if (result.gate === 'failed' || !result.clipPath) {
            logger.warn(
              { exportId, section: name(w), reason: result.reason ?? 'backend returned frames, not a clip' },
              'export: sim window degraded — capture rejected',
            );
            // A render that ran but did not pass — or a backend that produced only frames, which
            // this service does not encode (a documented gap; the production backend returns a
            // clip). Either way, degrade to the poster with the reason, never a wrong frame.
            captured.push(toPoster(w));
            plan.warnings.push(
              result.gate === 'failed'
                ? `${name(w)}: the captured render did not pass the sanity gate (${result.reason ?? 'no reason'}; renderer "${result.rendererString}") — exported as its poster still`
                : `${name(w)}: the capture backend returned frames this service cannot encode — exported as its poster still`,
            );
            continue;
          }

          // A gated clip. Upload it to the export's own write-once section key and splice it exactly
          // as any other source clip — the assembler downloads it by key like everything else, so a
          // captured sim travels the identical, already-verified path. `sourceVideoFileId` carries
          // the section id: audit-only (the splice keys off `storageKey`), honest about origin.
          const clipKey = `exports/${job.project_id}/${exportId}/sections/${w.sectionId}.mp4`;
          await this.storage.uploadFile(clipKey, await readFile(result.clipPath), 'video/mp4', IMMUTABLE_CACHE_CONTROL);
          // The clip had to outlive the capture job's own scratch directory, so the backend leaves it
          // in a sibling temp dir and the OWNERSHIP passes here, to the code that consumes it. Once
          // the bytes are in storage nothing needs the local copy, and "the OS tmp reaper will get
          // it" is not true when the operator points EXPORT_CAPTURE_WORKDIR at a real directory —
          // which is exactly what the container-capture setup requires. Left alone, every captured
          // section leaks an MP4 onto the worker host permanently.
          await rm(dirname(result.clipPath), { recursive: true, force: true }).catch(() => {});
          const clip: ClipWindow = {
            kind: 'clip', sectionId: w.sectionId, label: w.label, startSec: w.startSec, endSec: w.endSec,
            sourceVideoFileId: w.sectionId, storageKey: clipKey,
            sourceInSec: 0, sourceOutSec: w.endSec - w.startSec, sourceRole: 'clip',
          };
          logger.info({ exportId, section: name(w), clipKey }, 'export: sim window captured');
          captured.push(clip);
        } catch (err) {
          // Cancellation is NEVER degradation. It arrives here as an abort from the same signal the
          // capture was given, and a generic catch that turned it into a poster would publish a
          // slideshow for a user who pressed stop. Rethrow before any policy is consulted.
          if (err instanceof Error && err.name === 'AbortError') throw err;
          if (err instanceof ExportRefused) throw err;

          const failReason = err instanceof CaptureGateFailed
            ? `${err.message} (renderer "${err.rendererString}")`
            : err instanceof Error ? err.message : String(err);

          if (policy === 'forbid') {
            // Every strict failure lands here: unavailable, exception, timeout, missing clip,
            // invalid artifact, failed gate. None of them may publish a master.
            logger.warn({ err, exportId, section: name(w) }, 'export: strict mode — capture failed, failing the export');
            throw new StrictCaptureFailed(name(w), failReason, !(err instanceof CaptureGateFailed));
          }

          logger.warn({ err, exportId, section: name(w) }, 'export: sim window degraded — capture failed');
          if (!(err instanceof CaptureUnavailable)) {
            // A real render failure (gate-hard, crash, timeout). One window failing must never fail
            // the whole export — degrade this window loudly and carry on.
            const reason = err instanceof CaptureGateFailed
              ? `${err.message} (renderer "${err.rendererString}")`
              : err instanceof Error ? err.message : String(err);
            plan.warnings.push(`${name(w)}: simulation capture failed (${reason}) — exported as its poster still`);
          } else {
            plan.warnings.push(`${name(w)}: simulation capture is not available — exported as its poster still with silence`);
          }
          captured.push(toPoster(w));
        }
      }
      plan.timeline = captured;
      await this.fencedUpdate(exportId, {
        plan: plan as unknown as Record<string, unknown>,
        objects_done: done,
      });
      await this.throwIfCancelRequested(exportId);

      // ─── assembling ─────────────────────────────────────────────────────────────────────────
      phase = 'assembling';
      await this.fencedUpdate(exportId, { status: 'assembling', objects_done: 0 });
      logger.info(
        {
          exportId,
          windows: plan.timeline.length,
          degradedWindows: plan.timeline.filter((w) => w.kind === 'poster-fallback').length,
        },
        'export: assembling phase started',
      );
      // INGEST GATE: every mutable source must still be the bytes the plan froze. A re-upload or
      // "replace" mid-export would otherwise splice two generations of one file into a master
      // nobody authored. Classified `source_changed`, retryable — a fresh attempt re-plans
      // against the new bytes and succeeds.
      await this.assertSourceIdentity(plan);
      workDir = await mkdtemp(join(tmpdir(), 'project-export-'));
      const assembler = this.assembler ?? await loadAssembler();
      const total = plan.timeline.length;
      let lastLoggedBucket = -1;
      const { masterPath } = await assembler.assemble(
        plan,
        workDir,
        (pct) => {
          // Unfenced on purpose, like duplication's object counter: progress is advisory, and a
          // lost write costs one poll tick, not correctness. The FENCED writes are status writes.
          const clamped = Math.max(0, Math.min(100, pct));
          // One log line per quarter, not per ffmpeg tick.
          const bucket = Math.floor(clamped / 25);
          if (bucket > lastLoggedBucket) {
            lastLoggedBucket = bucket;
            logger.info({ exportId, pct: Math.round(clamped) }, 'export: assembling progress');
          }
          void db.update(project_exports)
            .set({ objects_done: Math.round((clamped / 100) * total), updated_at: new Date() })
            .where(eq(project_exports.id, exportId))
            .catch((err: unknown) => logger.debug({ err, exportId }, 'export: progress write failed'));
        },
        abort.signal,
      );
      if (abort.signal.aborted) {
        // The assembler returned despite the abort (raced the last frame). The user asked for a
        // stop, so a stop is what they get — nothing is published.
        throw new ExportRefused(EXPORT_CANCELLED_MESSAGE, 409, 'export_cancelled', false);
      }
      await this.throwIfCancelRequested(exportId);

      // ─── uploading ──────────────────────────────────────────────────────────────────────────
      phase = 'uploading';
      await this.fencedUpdate(exportId, { status: 'uploading' });
      // Versioned, write-once, never overwritten across exports (plan doc contract). Nothing
      // points at it until the terminal write below sets output_key.
      const outputKey = `exports/${job.project_id}/${exportId}/master.mp4`;
      const { size } = await stat(masterPath);
      logger.info({ exportId, sizeBytes: size }, 'export: uploading master');
      if (size <= UPLOAD_BUFFER_MAX_BYTES) {
        // The buffered path can set Cache-Control; the key is write-once, so immutable is right.
        await this.storage.uploadFile(outputKey, await readFile(masterPath), 'video/mp4', IMMUTABLE_CACHE_CONTROL);
      } else {
        // `uploadStream` has no cache-control parameter yet; a large master streams without it
        // rather than transiting the heap. Downloads are presigned per poll, so the cost is a
        // weaker CDN hint, not a correctness gap.
        await this.storage.uploadStream(outputKey, createReadStream(masterPath), 'video/mp4', size);
      }

      // Terminal `ready`, FENCED: a run that was reaped mid-upload must not publish behind the
      // back of whoever owns the row now. output_key is set here and nowhere else.
      //
      // `quality_state` lands with it: `degraded` whenever ANY window resolved to its poster
      // fallback or any planned layer was skipped — the one fact a list view needs without
      // parsing the plan. In Phase 1 an export with simulations is ALWAYS degraded, and the row
      // says so rather than letting `ready` imply "the full composition".
      const degraded = plan.timeline.some((w) => w.kind === 'poster-fallback')
        || plan.warnings.some((w) => w.endsWith('— skipped'));
      const [readyRow] = await db.update(project_exports)
        .set({
          status: 'ready',
          quality_state: degraded ? 'degraded' : 'full',
          output_key: outputKey,
          objects_done: total,
          plan: plan as unknown as Record<string, unknown>,
          finished_at: new Date(),
          updated_at: new Date(),
        })
        .where(and(
          eq(project_exports.id, exportId),
          inArray(project_exports.status, [...EXPORT_IN_FLIGHT_STATUSES]),
        ))
        .returning({ id: project_exports.id });
      if (!readyRow) {
        // The fence held: someone reaped or superseded this run. The uploaded master is an
        // orphan at a write-once key — harmless, reapable — and the row's owner keeps its word.
        logger.warn({ exportId }, 'export: finished but no longer owns its row — not publishing');
        return;
      }
      logger.info({ exportId, projectId: job.project_id, outputKey }, 'project export ready');
    } catch (err) {
      // THE FAILURE IS THE PRODUCT HERE — recorded, never flattened. The classification keeps
      // the real reason (code + retryability + the operator detail in the plan's failure block);
      // the bare generic is only what an UNRECOGNISED error earns.
      const failure = classifyExportFailure(err);
      const stored = `${failure.userMessage} [${failure.code}]`.slice(0, MAX_STORED_ERROR);
      logger.error(
        { err, exportId, projectId: job.project_id, phase, code: failure.code, retryable: failure.retryable },
        'project export failed',
      );
      // A HONOURED CANCELLATION IS NOT A FAILURE. `cancelled` is its own terminal status: the
      // system did exactly what the user asked, and folding that into `failed` would make every
      // cancel read as a defect — in the UI, in the logs, and in any error-rate metric.
      const terminal = failure.code === 'export_cancelled' ? 'cancelled' : 'failed';
      // FENCED like the success path: a reaped run must not overwrite its successor's terminal
      // state. `plan` is merged, not replaced — the planning phase's real plan survives next to
      // the reason the run stopped.
      await db.update(project_exports).set({
        status: terminal, error: stored, finished_at: new Date(), updated_at: new Date(),
        plan: sql`COALESCE(${project_exports.plan}, '{}'::jsonb) || ${JSON.stringify({
          failure: { code: failure.code, retryable: failure.retryable, phase, detail: failure.detail.slice(0, 4000) },
        })}::jsonb`,
      }).where(and(
        eq(project_exports.id, exportId),
        inArray(project_exports.status, [...EXPORT_IN_FLIGHT_STATUSES]),
      )).catch((e: unknown) => {
        logger.error({ err: e, exportId }, 'export: could not record the failure');
      });
      throw err;
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancelWatch);
      if (workDir) {
        await rm(workDir, { recursive: true, force: true })
          .catch((err: unknown) => logger.warn({ err, exportId, workDir }, 'export: work directory cleanup failed'));
      }
    }
  }
}

/**
 * The disk pre-flight, from the plan's own estimate. Refusing to start is recoverable; ENOSPC
 * forty minutes into an encode is a wasted encode plus an error nobody maps back to disk.
 * `retryable: true` — disk pressure is a server condition that changes without the user changing
 * anything, so the identical attempt genuinely can succeed later.
 *
 * A failed statfs is NOT a refusal: a filesystem that cannot answer is not a filesystem that is
 * known to be full, and blocking every export on an exotic fs error would be the wrong trade.
 */
async function assertDiskHeadroom(plan: ExportPlan, exportId: string): Promise<void> {
  let availableBytes: number;
  try {
    const fs = await statfs(tmpdir());
    availableBytes = fs.bavail * fs.bsize;
  } catch (err) {
    logger.warn({ err, exportId }, 'export: disk pre-flight unavailable — proceeding without it');
    return;
  }
  if (availableBytes < plan.requiredDiskBytes) {
    throw new ExportRefused(
      'The server does not have enough free work space for this export right now. Try again later.',
      507, 'insufficient_disk', true,
    );
  }
}

// ── Reaping abandoned runs ────────────────────────────────────────────────────────────────────

/**
 * Fail export rows that no process is running any more, so the project they block is free.
 * `sweepAbandonedDuplications`'s shape exactly: bounded per pass, the staleness rule and nothing
 * else, `finished_at` set because the row is terminal now.
 */
export async function sweepAbandonedExports(
  limit: number = 50,
  now: Date = new Date(),
): Promise<number> {
  const abandoned = and(
    inArray(project_exports.status, [...EXPORT_IN_FLIGHT_STATUSES]),
    lt(project_exports.updated_at, exportStaleBefore(now)),
  );
  const reaped = await db.update(project_exports)
    .set({ status: 'failed', error: EXPORT_ABANDONED_MESSAGE, finished_at: now, updated_at: now })
    .where(sql`${project_exports.id} IN (
      SELECT ${project_exports.id} FROM ${project_exports}
      WHERE ${abandoned} ORDER BY ${project_exports.updated_at} ASC LIMIT ${limit})`)
    .returning({ id: project_exports.id });
  if (reaped.length > 0) logger.warn({ reaped: reaped.length }, 'export: reaped abandoned runs');
  return reaped.length;
}

/**
 * The in-flight export of `projectId` a new request must defer to — or null, having FAILED a row
 * that nothing is running any more. `liveDuplicationFor`'s twin: the reaper frees the project on
 * a timer for someone who never comes back; this frees it inside the very request of someone who
 * clicked Export again on a visibly stuck job. The write is a CAS on the same staleness
 * condition, so a run that woke up between the read and the update keeps its row.
 */
export async function liveExportFor(
  projectId: string,
  now: Date = new Date(),
): Promise<typeof project_exports.$inferSelect | null> {
  const [inflight] = await db.select().from(project_exports).where(and(
    eq(project_exports.project_id, projectId),
    inArray(project_exports.status, [...EXPORT_IN_FLIGHT_STATUSES]),
  ));
  if (!inflight) return null;
  if (inflight.updated_at >= exportStaleBefore(now)) return inflight;

  const [reaped] = await db.update(project_exports)
    .set({ status: 'failed', error: EXPORT_ABANDONED_MESSAGE, finished_at: now, updated_at: now })
    .where(and(
      eq(project_exports.id, inflight.id),
      inArray(project_exports.status, [...EXPORT_IN_FLIGHT_STATUSES]),
      lt(project_exports.updated_at, exportStaleBefore(now)),
    ))
    .returning({ id: project_exports.id });
  if (!reaped) return inflight; // it moved under us — it is alive after all
  logger.warn({ projectId, exportId: inflight.id }, 'export: reaped an abandoned run so a new one can start');
  return null;
}

/** How often the reaper runs while the process is alive. Well under the poll's patience. */
export const EXPORT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Start the abandoned-run reaper. Returns a stop function. The `startDuplicationSweep` shape:
 * unref'd timer, one deferred kick at start (processes recycled faster than the interval are
 * exactly the ones that strand rows), missing table logged at debug — 058 may be rolled back.
 */
export function startExportSweep(intervalMs = EXPORT_SWEEP_INTERVAL_MS): () => void {
  const run = (): void => {
    void sweepAbandonedExports().catch((err: unknown) => {
      if ((err as { code?: string } | null)?.code === '42P01') {
        logger.debug('export reaper: table not migrated yet, nothing to reap');
        return;
      }
      logger.error({ err }, 'export reaper failed');
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  const kick = setTimeout(run, 0);
  if (typeof kick.unref === 'function') kick.unref();
  return () => { clearInterval(timer); clearTimeout(kick); };
}
