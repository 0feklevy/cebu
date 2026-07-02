import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq, asc, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  video_files, timeline_sections, simulations, video_generation_jobs, image_files, audio_files,
} from '../../db/schema.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';

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
        db.query.simulations.findMany({ where: eq(simulations.project_id, project.id), orderBy: [desc(simulations.created_at)] }),
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

      return reply.send({ videos, sections, simulations: simulationsOut, brollJobs, images, audioFiles });
    },
  );
}
