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
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { enqueueJob } from '../../queue/index.js';
import { ExportRefused, buildExportPlan } from '../../services/export/exportPlan.js';

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
  const plan = row.plan as { warnings?: unknown } | null;
  const warnings = Array.isArray(plan?.warnings)
    ? plan.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  return {
    id: row.id,
    status: row.status,
    quality_state: row.quality_state,
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

  // POST /api/v1/projects/:id/export — start a linear video export.
  app.post<{ Params: { id: string }; Body: { allow_degraded?: boolean } | null }>(
    '/api/v1/projects/:id/export',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      // The dark-ship gate, before anything else: OFF means this URL behaves as if the feature
      // does not exist — 404, indistinguishable from the pre-058 world.
      if (!exportEnabled()) return reply.code(404).send({ message: 'Not found' });

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
          return reply.code(err.statusCode).send({ code: err.code, message: err.message });
        }
        throw err;
      }
      if (!plan) return reply.code(404).send({ message: 'Project not found' });

      // CONSENT: when any simulation window will render as a fallback (Phase 1: every one of
      // them), the export is degraded, and a degraded master must never be something the user
      // finds out about from the file. 409 `degraded_only` carries the warnings so the client
      // can show exactly what will be missing; `allow_degraded: true` is informed consent.
      const wouldDegrade = plan.timeline.some(
        (w) => w.kind === 'sim-capture' || w.kind === 'poster-fallback',
      );
      if (wouldDegrade && request.body?.allow_degraded !== true) {
        return reply.code(409).send({
          code: 'degraded_only',
          message:
            'This export will include simulations as still images, not live captures. '
            + 'Confirm to export anyway.',
          warnings: plan.warnings,
        });
      }

      try {
        const [row] = await db.insert(project_exports).values({
          project_id: project.id,
          requested_by: user.id,
          status: 'queued',
        }).returning();
        enqueueJob('project_export', { exportId: row.id });
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
        request.log.error({ err, projectId: project.id }, 'failed to start project export');
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
