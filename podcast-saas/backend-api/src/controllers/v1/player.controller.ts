import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { projects, video_files, timeline_sections } from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';

// Public (no auth) endpoint — returns player config for a project's viewer page.
// This is the dynamic equivalent of interactive-podcast-react's constants/index.ts.

export async function registerPlayerRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/player-config',
    async (request, reply: FastifyReply) => {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, request.params.id),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const allVideos = await db.query.video_files.findMany({
        where: eq(video_files.project_id, project.id),
        orderBy: [asc(video_files.created_at)],
      });

      const sections = await db.query.timeline_sections.findMany({
        where: eq(timeline_sections.project_id, project.id),
        orderBy: [asc(timeline_sections.start_sec)],
      });

      // Main video segments (uploaded by user, not AI-generated broll sources)
      const mainVideos = allVideos.filter((v) => !v.is_broll);
      const brollVideos = allVideos.filter((v) => v.is_broll);

      const segments = mainVideos.map((v) => {
        const hls_url = v.hls_master_key
          ? storage.getPublicUrl(v.hls_master_key)
          : v.hls_360p_key
            ? storage.getPublicUrl(v.hls_360p_key)
            : null;
        const fallback_url = hls_url;

        // Only non-broll sections for this main video
        const simulations = sections
          .filter((s) => s.video_file_id === v.id && s.track !== 'broll')
          .map((s) => ({
            id:             s.id,
            start_sec:      s.start_sec,
            end_sec:        s.end_sec,
            simulation_url: s.simulation_url ?? null,
            simulation_id:  s.simulation_id  ?? null,
            sim_script:     s.sim_script     ?? null,
            label:          s.label,
            type:           s.type,
          }));

        return {
          id: v.id,
          label: v.filename,
          duration_sec: v.duration_sec ?? 0,
          hls_url,
          fallback_url,
          hls_status: v.hls_status,
          simulations,
        };
      });

      // Build broll_clips from broll sections — each broll section points to a broll video
      const brollVideoMap = new Map(brollVideos.map((v) => [v.id, v]));
      const brollClips = sections
        .filter((s) => s.track === 'broll')
        .map((s) => {
          const brollVid = brollVideoMap.get(s.video_file_id);
          if (!brollVid) return null;
          const hls_url = brollVid.hls_master_key
            ? storage.getPublicUrl(brollVid.hls_master_key)
            : brollVid.hls_360p_key
              ? storage.getPublicUrl(brollVid.hls_360p_key)
              : null;
          if (!hls_url) return null;
          return {
            id:               s.id,
            hls_url,
            global_offset_sec: s.global_offset_sec ?? 0,
            start_sec:         s.start_sec,
            end_sec:           s.end_sec,
            label:             s.label,
          };
        })
        .filter(Boolean);

      return reply.send({
        project_id: project.id,
        title: project.title,
        segments,
        broll_clips: brollClips,
      });
    },
  );
}
