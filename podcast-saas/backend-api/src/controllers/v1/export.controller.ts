/**
 * Linear video export endpoints (plan doc "THE DECISION", Phase 1) — replacing the 501 stubs
 * that reserved this URL space in `controllers/stubs.ts`.
 *
 * ASYNC, and POST returns the EXPORT id, not a file: an encode is minutes of ffmpeg, so the work
 * runs as the `project_export` job and the client polls the GET. Owner-only, exactly like
 * duplicate and DELETE (`projects.created_by`): an export reads every byte of the project's media
 * and produces a downloadable master.
 *
 * 42P01 (migration 058 rolled back under an image that still serves these routes) answers 503 on
 * EVERY route that touches the table — the same deployed-feature-removed posture the duplication
 * endpoints take, for the same reasons: the GET is polled, and a 503 ends the poll on a statement
 * that is true, while an unhandled 500 spends the client's failure budget on a state the server
 * refuses to name.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { project_exports, projects } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { enqueueProjectExport } from '../../queue/index.js';
import { ExportRefused, admitCaptureWorkload, buildExportPlan } from '../../services/export/exportPlan.js';
import { EXPORT_GRID } from '../../services/export/types.js';
import { fingerprintPlan } from '../../services/export/planFingerprint.js';
import { ConsentInvalid, issueConsentToken, verifyConsentToken } from '../../services/export/consentToken.js';

/**
 * The sections a degraded export would replace with a still, named.
 *
 * "This export will include simulations as still images" was true of nothing in particular: it did
 * not say which, and it implied ALL of them. A user with eleven simulations and one broken package
 * was told their whole video would be a slideshow.
 */
function affectedSections(plan: { timeline: readonly unknown[] }): Array<{
  section_id: string; label: string | null; will_use_still: boolean;
}> {
  return (plan.timeline as Array<{ kind: string; sectionId?: string; label?: string | null }>)
    .filter((w) => w.kind === 'poster-fallback')
    .map((w) => ({
      section_id: String(w.sectionId ?? ''),
      label: w.label ?? null,
      // `will`, not `may`: the planner already decided this one. A live capture that might yet fail
      // is a different statement, and conflating them is what made the old warning untrustworthy.
      will_use_still: true,
    }));
}

/**
 * SHIPS DARK until Phase 2: the feature flag gates the POST, and OFF answers 404 — exactly what
 * the 501 stub's URL used to be to the outside world. Read PER REQUEST, not at registration, so
 * flipping the env in a test (or a restartless config reload) takes effect immediately.
 */
const exportEnabled = (): boolean => process.env.LINEAR_EXPORT_ENABLED === 'true';

/** Presigned download lifetime — same 6h the podcast render downloads use. */
const DL_TTL = 6 * 60 * 60;

const UNAVAILABLE = { message: 'Exporting videos is temporarily unavailable.' };
const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string } | null)?.code === '42P01';

/** The poll/response shape. `warnings` come from the stored plan — the honest omission record. */
function exportBody(row: typeof project_exports.$inferSelect, downloadUrl: string | null) {
  // Warnings describe what the run DID, so they come from `effective_plan` — the frozen snapshot
  // records what was asked for and never changes. Before the run produces one, the snapshot's own
  // planning warnings are the honest answer.
  const runtime = row.effective_plan as { warnings?: unknown } | null;
  const frozen = row.plan as { warnings?: unknown } | null;
  const source = Array.isArray(runtime?.warnings) ? runtime.warnings : frozen?.warnings;
  const warnings = Array.isArray(source)
    ? source.filter((w): w is string => typeof w === 'string')
    : [];
  const terminal = row.status === 'ready';
  return {
    id: row.id,
    status: row.status,
    // Only a FINISHED export has a quality. The column defaults to 'full', so reporting it verbatim
    // told every poll that a queued or still-capturing export was already full quality — the one
    // claim this feature must never make early, since it is exactly what the user is waiting to
    // learn. Null until the master exists.
    quality_state: terminal ? row.quality_state : null,
    degradation_policy: row.degradation_policy,
    // The COLUMN, not a warning count: warnings include planning advisories that are not
    // degradation at all, so counting them reported degradation where none happened.
    degraded_windows: row.degraded_windows,
    // What the run is doing now, and how far into it. `objects_done/total` alone could not say:
    // a simulation capture is minutes long, and the counter sat still for all of it.
    current_phase: row.current_phase,
    phase_done: row.phase_done,
    phase_total: row.phase_total,
    current_section_id: row.current_section_id,
    current_section_label: row.current_section_label,
    capture_stage: row.capture_stage,
    frames_done: row.frames_done,
    frames_total: row.frames_total,
    // Whether trying again could plausibly work, from the recorded failure rather than guessed by
    // the client from a message string.
    retryable: (row.failure as { retryable?: boolean } | null)?.retryable ?? null,
    // A strict export that failed on capture CAN be retried with stills — but only by asking, and
    // never automatically. This says the option exists; it does not take it.
    degraded_retry_available:
      row.status === 'failed'
      && (row.failure as { code?: string } | null)?.code === 'capture_failed_strict'
      && row.degradation_policy === 'forbid',
    objects_total: row.objects_total,
    objects_done: row.objects_done,
    error: row.error,
    cancel_requested: row.cancel_requested,
    warnings,
    download_url: downloadUrl,
  };
}

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  /**
   * GET /api/v1/projects/:id/export/preview — what an export WOULD do, without doing any of it.
   *
   * The consent dialog used to be driven by a 409 from the start endpoint, which meant asking "what
   * will this cost me?" required attempting the thing. This answers the question directly: no row is
   * inserted, no job is enqueued, nothing is charged, and the caller gets the sections that would be
   * replaced by stills plus a token to confirm with. Owner-only, like every other route here.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/export/preview',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      if (!exportEnabled()) return reply.code(404).send({ message: 'Not found' });
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      let plan: Awaited<ReturnType<typeof buildExportPlan>>;
      try {
        plan = await buildExportPlan(project.id, storage);
      } catch (err) {
        if (err instanceof ExportRefused) {
          return reply.code(err.statusCode).send({ code: err.code, message: err.message });
        }
        throw err;
      }
      if (!plan) return reply.code(404).send({ message: 'Project not found' });

      const fingerprint = fingerprintPlan(plan as unknown as Record<string, unknown>);
      const affected = affectedSections(plan);
      const inadmissible = admitCaptureWorkload(plan.timeline, EXPORT_GRID.fps);
      return reply.code(200).send({
        plan_fingerprint: fingerprint,
        // Sections the planner ALREADY resolved to a still — these will definitely be stills.
        affected_sections: affected,
        // …and the ones that will be rendered live, which may still fail. Kept separate on purpose:
        // conflating "will" with "may" is what made the old warning untrustworthy.
        live_sections: plan.timeline.filter((w) => w.kind === 'sim-capture').length,
        may_use_still: plan.timeline.some((w) => w.kind === 'sim-capture'),
        will_use_still: affected.length > 0,
        warnings: plan.warnings,
        admissible: inadmissible === null,
        refusal: inadmissible ? { code: inadmissible.code, message: inadmissible.message } : null,
        consent_token: affected.length > 0
          ? issueConsentToken({ projectId: project.id, userId: user.id, fingerprint, nowMs: Date.now() })
          : null,
      });
    },
  );

  // POST /api/v1/projects/:id/export — start a linear video export.
  app.post<{ Params: { id: string }; Body: { consent_token?: unknown } | null }>(
    '/api/v1/projects/:id/export',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      // The dark-ship gate, before anything else: OFF means this URL behaves as if the feature
      // does not exist — 404, indistinguishable from the pre-058 world.
      if (!exportEnabled()) {
        logger.info(
          { projectId: request.params.id },
          'export: refused — LINEAR_EXPORT_ENABLED is off, answering 404',
        );
        return reply.code(404).send({ message: 'Not found' });
      }

      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const { liveExportFor, EXPORT_IN_FLIGHT_STATUSES } =
        await import('../../services/export/ProjectExportService.js');

      // Already running? Join the in-flight job instead of starting a second encode — the
      // partial unique index would reject the insert anyway, but answering with the existing job
      // makes a double-click idempotent instead of an error. `liveExportFor` is what decides
      // "actually running": a row stranded by a deploy is failed HERE, inside the request of the
      // user who clicked again, rather than blocking the project forever.
      let inflight: Awaited<ReturnType<typeof liveExportFor>>;
      try {
        inflight = await liveExportFor(project.id);
      } catch (err) {
        if (isMissingTable(err)) return reply.code(503).send(UNAVAILABLE);
        throw err;
      }
      if (inflight) {
        logger.info(
          { projectId: project.id, exportId: inflight.id, status: inflight.status },
          'export: joined already-running export',
        );
        return reply.code(202).send({ export_id: inflight.id, status: inflight.status, already_running: true });
      }

      // The dry run, HERE, synchronously — for two answers the user must get before a job row
      // exists: a refusal (branching) with its real reason instead of a poll that ends in
      // `failed`, and the DEGRADED-CONSENT gate below.
      let plan: Awaited<ReturnType<typeof buildExportPlan>>;
      try {
        plan = await buildExportPlan(project.id, storage);
      } catch (err) {
        if (err instanceof ExportRefused) {
          logger.info(
            { projectId: project.id, code: err.code, statusCode: err.statusCode },
            'export: refused by plan',
          );
          return reply.code(err.statusCode).send({ code: err.code, message: err.message });
        }
        throw err;
      }
      if (!plan) return reply.code(404).send({ message: 'Project not found' });

      // ADMISSION before enqueue. An export whose capture workload cannot finish inside the
      // per-section budgets is not a job that might be slow — it is a promise the system cannot
      // keep, and letting it in occupies the worker for the full budget before failing. Refusing at
      // the door is both truthful and the only thing that stops one impossible project from
      // starving every other tenant's queue.
      const inadmissible = admitCaptureWorkload(plan.timeline, EXPORT_GRID.fps);
      if (inadmissible) {
        logger.info(
          { projectId: project.id, code: inadmissible.code, detail: inadmissible.detail },
          'export: refused before enqueue — capture workload not admissible',
        );
        return reply.code(inadmissible.statusCode).send({
          code: inadmissible.code,
          message: inadmissible.message,
        });
      }

      // CONSENT is for degradation that is KNOWN BEFORE THE RUN — a window the planner already
      // resolved to a poster because the package cannot be captured. A `sim-capture` window is the
      // opposite of that: it is the promise to render the simulation live, and treating it as
      // degradation asked every user to pre-approve a slideshow before anything had failed, which
      // both trained them to click through the warning and made the strict contract unreachable.
      const planSnapshot = plan as unknown as Record<string, unknown>;
      const planFingerprint = fingerprintPlan(planSnapshot);
      const wouldDegrade = plan.timeline.some((w) => w.kind === 'poster-fallback');

      // The consent TOKEN, not a boolean. `allow_degraded: true` could be sent by anything that
      // could reach this endpoint, said nothing about what was being agreed to, and survived any
      // amount of drift — a stale tab could spend it on a project rewritten since. A token names
      // this user, this project and this exact plan, and expires.
      let degradationPolicy: 'forbid' | 'allow_poster' = 'forbid';
      if (request.body?.consent_token !== undefined) {
        try {
          verifyConsentToken({
            token: request.body.consent_token,
            projectId: project.id,
            userId: user.id,
            fingerprint: planFingerprint,
            nowMs: Date.now(),
          });
          degradationPolicy = 'allow_poster';
        } catch (err) {
          const reason = err instanceof ConsentInvalid ? err.reason : 'malformed';
          logger.info({ projectId: project.id, reason }, 'export: consent rejected — re-prompting');
          return reply.code(409).send({
            code: 'degraded_only',
            message: err instanceof Error ? err.message : 'Confirm again to export with still images.',
            reason,
            warnings: plan.warnings,
            affected_sections: affectedSections(plan),
            consent_token: wouldDegrade
              ? issueConsentToken({ projectId: project.id, userId: user.id, fingerprint: planFingerprint, nowMs: Date.now() })
              : null,
            plan_fingerprint: planFingerprint,
          });
        }
      }

      if (wouldDegrade && degradationPolicy !== 'allow_poster') {
        logger.info(
          { projectId: project.id, planWarnings: plan.warnings.length },
          'export: degraded consent required — answering 409 degraded_only',
        );
        return reply.code(409).send({
          code: 'degraded_only',
          message:
            'Some simulations in this project cannot be rendered and would be exported as still '
            + 'images. Confirm to export anyway.',
          warnings: plan.warnings,
          affected_sections: affectedSections(plan),
          consent_token: issueConsentToken({
            projectId: project.id, userId: user.id, fingerprint: planFingerprint, nowMs: Date.now(),
          }),
          plan_fingerprint: planFingerprint,
        });
      }

      try {
        // The answer is FROZEN on the row here, at creation. Previously it lived only in this
        // request body: the controller read it, logged it, and dropped it — so the worker degraded
        // whatever failed, with no way to know what had been agreed to, and a retry or duplicate
        // delivery had no answer at all.
        // THE SNAPSHOT. The plan computed above — the exact one whose consequences were just
        // described to the user — is what the worker will execute. Storing it here, with its
        // fingerprint, is what closes the gap in which the project could be edited between the
        // answer and the render: the worker no longer re-plans, so there is nothing to drift.
        const [row] = await db.insert(project_exports).values({
          project_id: project.id,
          requested_by: user.id,
          status: 'queued',
          degradation_policy: degradationPolicy,
          plan: planSnapshot,
          plan_fingerprint: planFingerprint,
          objects_total: Array.isArray(plan.timeline) ? plan.timeline.length : 0,
        }).returning();
        // AWAITED, and no inline fallback. A fire-and-forget send that fails leaves a `queued` row
        // nothing will ever pick up, and the user watches a progress bar for a job that does not
        // exist. Failing here lets the row be marked failed and the caller told the truth.
        try {
          await enqueueProjectExport(row.id);
        } catch (err) {
          await db.update(project_exports)
            .set({
              status: 'failed',
              error: 'Exporting videos is temporarily unavailable. Please try again in a few minutes.',
              failure: {
                code: 'export_queue_unavailable',
                retryable: true,
                phase: 'planning',
                detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
              },
              finished_at: new Date(),
              updated_at: new Date(),
            })
            .where(eq(project_exports.id, row.id))
            .catch(() => {});
          logger.error({ err, projectId: project.id, exportId: row.id }, 'export: durable enqueue failed');
          return reply.code(503).send({
            code: 'export_queue_unavailable',
            message: 'Exporting videos is temporarily unavailable. Please try again in a few minutes.',
            retryable: true,
          });
        }
        logger.info(
          { projectId: project.id, exportId: row.id, degradationPolicy, planFingerprint },
          'export: accepted — job enqueued',
        );
        return reply.code(202).send({ export_id: row.id, status: 'queued' });
      } catch (err) {
        // 23505 = the in-flight partial unique index; someone won the race between read & insert.
        if ((err as { code?: string } | null)?.code === '23505') {
          const [existing] = await db.select().from(project_exports).where(and(
            eq(project_exports.project_id, project.id),
            inArray(project_exports.status, [...EXPORT_IN_FLIGHT_STATUSES]),
          ));
          if (existing) {
            return reply.code(202).send({ export_id: existing.id, status: existing.status, already_running: true });
          }
        }
        // The table can also vanish between the read above and this insert.
        if (isMissingTable(err)) return reply.code(503).send(UNAVAILABLE);
        logger.error({ err, projectId: project.id }, 'failed to start project export');
        return reply.code(500).send({ message: 'Could not start the export. Please try again.' });
      }
    },
  );

  // GET /api/v1/projects/:id/exports/:exportId — progress; presigned download when ready.
  app.get<{ Params: { id: string; exportId: string } }>(
    '/api/v1/projects/:id/exports/:exportId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      let row: typeof project_exports.$inferSelect | undefined;
      try {
        [row] = await db.select().from(project_exports).where(and(
          eq(project_exports.id, request.params.exportId),
          eq(project_exports.project_id, project.id),
        ));
      } catch (err) {
        if (isMissingTable(err)) return reply.code(503).send(UNAVAILABLE);
        throw err;
      }
      if (!row) return reply.code(404).send({ message: 'Export not found' });

      // Presigned per poll (podcast-render's shape): the URL is short-lived by design, and a
      // failure to presign degrades to "no link yet" rather than failing the poll.
      const downloadUrl = row.status === 'ready' && row.output_key
        ? await storage.getPresignedDownloadUrl(row.output_key, DL_TTL).catch(() => null)
        : null;
      return reply.send(exportBody(row, downloadUrl));
    },
  );

  // POST /api/v1/projects/:id/exports/:exportId/cancel — request a stop.
  app.post<{ Params: { id: string; exportId: string } }>(
    '/api/v1/projects/:id/exports/:exportId/cancel',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const { EXPORT_IN_FLIGHT_STATUSES } =
        await import('../../services/export/ProjectExportService.js');

      // FENCED: the flag lands only on a row that is still in flight. The RUNNER is the only
      // writer of terminal status — it honours the flag between phases and aborts the assembler —
      // so the poll can never observe `failed` while ffmpeg still holds the work directory.
      let updated: (typeof project_exports.$inferSelect)[];
      try {
        updated = await db.update(project_exports)
          .set({ cancel_requested: true, updated_at: new Date() })
          .where(and(
            eq(project_exports.id, request.params.exportId),
            eq(project_exports.project_id, project.id),
            inArray(project_exports.status, [...EXPORT_IN_FLIGHT_STATUSES]),
          ))
          .returning();
      } catch (err) {
        if (isMissingTable(err)) return reply.code(503).send(UNAVAILABLE);
        throw err;
      }
      if (updated.length > 0) {
        return reply.code(202).send(exportBody(updated[0], null));
      }

      // Nothing in flight to cancel: distinguish "no such export" from "already finished".
      let row: typeof project_exports.$inferSelect | undefined;
      try {
        [row] = await db.select().from(project_exports).where(and(
          eq(project_exports.id, request.params.exportId),
          eq(project_exports.project_id, project.id),
        ));
      } catch (err) {
        if (isMissingTable(err)) return reply.code(503).send(UNAVAILABLE);
        throw err;
      }
      if (!row) return reply.code(404).send({ message: 'Export not found' });
      return reply.code(409).send({ message: `This export already finished (${row.status}).` });
    },
  );
}
