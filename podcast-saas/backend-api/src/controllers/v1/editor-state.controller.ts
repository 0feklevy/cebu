import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq, asc, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  video_files, timeline_sections, simulations, video_generation_jobs, image_files, audio_files,
} from '../../db/schema.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { withServedSimulationUrls } from '../../services/simulation/simulationUrlResolver.js';
import { logger } from '../../lib/logger.js';

/**
 * The simulation rows, with the degraded read every other simulation-touching path already has.
 *
 * `db.query.simulations.findMany()` with NO `columns` list selects whatever the Drizzle schema
 * declares — which now includes `bridge_ack_capable` (migration 055) and `requires_import_maps`
 * (migration 057). An app image deployed AHEAD of its migrations therefore raises Postgres 42703
 * (`column does not exist`) here, and because this endpoint is the editor's single bootstrap read,
 * that one missing column takes down the whole editor: videos, sections, images, audio and b-roll
 * jobs with it. `sections.controller` already guards its own pointer read for exactly this reason;
 * this is the same guard.
 *
 * It RETRIES rather than degrading to an empty list, which is the difference that matters here.
 * The pointer read in `sections.controller` can safely fall back to `[]` — every section then uses
 * its stored URL, which is the pre-migration behaviour. `[]` here would tell the editor the project
 * has no simulations at all, so the retry drops exactly the two post-migration columns and returns
 * every row otherwise whole: the editor gets precisely what it had before those migrations, and
 * both facts read UNKNOWN, which is the state both consumers already handle. A failure of the
 * retry is a real database failure, not a migration lag, and is left to surface.
 */
async function loadSimulations(projectId: string) {
  const query = { where: eq(simulations.project_id, projectId), orderBy: [desc(simulations.created_at)] };
  try {
    return await db.query.simulations.findMany(query);
  } catch (err) {
    logger.error({ err, projectId }, 'editor-state: full simulation read failed — retrying without the post-migration capability columns');
    return await db.query.simulations.findMany({
      ...query,
      columns: { bridge_ack_capable: false, requires_import_maps: false },
    });
  }
}

// Aggregate editor bootstrap (loadperf-003). The editor previously opened with 6 parallel list
// round-trips (videos, sections, simulations, broll jobs, images, audio). This returns all of
// them in ONE request. Each list is shaped IDENTICALLY to its standalone GET endpoint so the
// client types are unchanged — keep them in sync if those endpoints change.
export async function registerEditorStateRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/editor-state',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const storage = getStorageAdapter();

      const [videoRows, sections, simRows, brollJobs, images, audioFiles] = await Promise.all([
        db.query.video_files.findMany({ where: eq(video_files.project_id, project.id), orderBy: [desc(video_files.created_at)] }),
        db.query.timeline_sections.findMany({ where: eq(timeline_sections.project_id, project.id), orderBy: [asc(timeline_sections.sort_order), asc(timeline_sections.start_sec)] }),
        loadSimulations(project.id),
        db.query.video_generation_jobs.findMany({ where: eq(video_generation_jobs.project_id, project.id), orderBy: [desc(video_generation_jobs.created_at)] }),
        db.query.image_files.findMany({ where: eq(image_files.project_id, project.id), orderBy: [desc(image_files.created_at)] }),
        db.query.audio_files.findMany({ where: eq(audio_files.project_id, project.id), orderBy: [desc(audio_files.created_at)] }),
      ]);

      // Same URL shaping as GET /videos (presigned raw + public HLS — local HMAC ops, done in parallel).
      const videos = await Promise.all(videoRows.map(async (v) => ({
        ...v,
        hls_url: (v.hls_master_key && v.hls_status === 'ready') ? storage.getPublicUrl(v.hls_master_key) : null,
        raw_url: v.storage_key ? await storage.getPresignedDownloadUrl(v.storage_key, 3600).catch(() => null) : null,
      })));

      // Same entry_file shaping as GET /simulations.
      const simulationsOut = simRows.map(r => ({
        ...r,
        entry_file: r.entry_file
          ? (r.entry_file.startsWith('http') ? r.entry_file : storage.getSimPublicUrl(r.entry_file))
          : r.entry_file,
      }));

      // Same served-URL shaping as GET /sections: the stored `simulation_url` is what a section
      // last published, which after any republish or rollback is a RETIRED revision's bytes. The
      // live bytes are behind `simulations.active_revision_entry_key`, and resolving that pointer
      // on the way out is the only place it happens (audit §9.6). No extra round-trip — the
      // simulation rows this needs were already loaded above, which is this endpoint's whole point.
      const sectionsOut = withServedSimulationUrls(sections, simRows, storage);

      return reply.send({ videos, sections: sectionsOut, simulations: simulationsOut, brollJobs, images, audioFiles });
    },
  );
}
