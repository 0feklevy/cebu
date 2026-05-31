import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { projects, video_files, timeline_sections } from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';

/** Build the same PlayerConfig shape used by player.controller.ts */
async function buildPlayerConfig(projectId: string) {
  const storage = getStorageAdapter();

  const allVideos = await db.query.video_files.findMany({
    where: eq(video_files.project_id, projectId),
    orderBy: [asc(video_files.created_at)],
  });

  const sections = await db.query.timeline_sections.findMany({
    where: eq(timeline_sections.project_id, projectId),
    orderBy: [asc(timeline_sections.start_sec)],
  });

  const mainVideos = allVideos.filter((v) => !v.is_broll);
  const brollVideos = allVideos.filter((v) => v.is_broll);

  const segments = mainVideos.map((v) => {
    const hls_url = v.hls_master_key
      ? storage.getPublicUrl(v.hls_master_key)
      : v.hls_360p_key
        ? storage.getPublicUrl(v.hls_360p_key)
        : null;

    const simulations = sections
      .filter((s) => s.video_file_id === v.id && s.track !== 'broll')
      .map((s) => ({
        id:             s.id,
        start_sec:      s.start_sec,
        end_sec:        s.end_sec,
        simulation_url: s.simulation_url ?? null,
        simulation_id:  s.simulation_id  ?? null,
        sim_script:     s.sim_script     ?? null,
        simple_ui:      s.simple_ui      ?? false,
        auto_script:    s.auto_script    ?? true,
        label:          s.label,
        type:           s.type,
      }));

    return {
      id:           v.id,
      label:        v.filename,
      duration_sec: v.duration_sec ?? 0,
      hls_url,
      fallback_url: hls_url,
      hls_status:   v.hls_status,
      simulations,
    };
  });

  const brollVideoMap = new Map(brollVideos.map((v) => [v.id, v]));
  const brollClips = sections
    .filter((s) => s.track === 'broll')
    .map((s) => {
      const bv = brollVideoMap.get(s.video_file_id);
      if (!bv) return null;
      const hls_url = bv.hls_master_key
        ? storage.getPublicUrl(bv.hls_master_key)
        : bv.hls_360p_key
          ? storage.getPublicUrl(bv.hls_360p_key)
          : null;
      if (!hls_url) return null;
      return {
        id:                s.id,
        hls_url,
        global_offset_sec: s.global_offset_sec ?? 0,
        start_sec:         s.start_sec,
        end_sec:           s.end_sec,
        label:             s.label,
      };
    })
    .filter(Boolean);

  return { segments, brollClips };
}

export async function registerShareRoutes(app: FastifyInstance): Promise<void> {

  // ── Public: GET /api/v1/share/:shareToken ─────────────────────────────────
  // Returns player config for a shared project — no authentication required.
  app.get<{ Params: { shareToken: string } }>(
    '/api/v1/share/:shareToken',
    async (request, reply: FastifyReply) => {
      const project = await db.query.projects.findFirst({
        where: eq(projects.share_token, request.params.shareToken),
      });
      if (!project || !project.share_token) {
        return reply.code(404).send({ message: 'Shared video not found or link has been revoked' });
      }

      const { segments, brollClips } = await buildPlayerConfig(project.id);

      return reply.send({
        project_id:  project.id,
        title:       project.title,
        segments,
        broll_clips: brollClips,
      });
    },
  );

  // ── Auth: GET /api/v1/projects/:id/share ─────────────────────────────────
  // Returns current share token info (null shareToken if not shared).
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      if (!project.share_token) {
        return reply.send({ shareToken: null, shareUrl: null });
      }
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
      return reply.send({
        shareToken: project.share_token,
        shareUrl:   `${appUrl}/v/${project.share_token}`,
      });
    },
  );

  // ── Auth: POST /api/v1/projects/:id/share ────────────────────────────────
  // Generate (or return existing) share token. Idempotent.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // Idempotent — return existing token if already set
      if (project.share_token) {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
        return reply.send({
          shareToken: project.share_token,
          shareUrl:   `${appUrl}/v/${project.share_token}`,
        });
      }

      // Generate a 22-char URL-safe random token
      const shareToken = randomBytes(16).toString('base64url');

      await db
        .update(projects)
        .set({ share_token: shareToken, share_enabled_at: new Date() })
        .where(eq(projects.id, project.id));

      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
      return reply.code(201).send({
        shareToken,
        shareUrl: `${appUrl}/v/${shareToken}`,
      });
    },
  );

  // ── Auth: DELETE /api/v1/projects/:id/share ──────────────────────────────
  // Revoke the share token — all existing shared links become invalid.
  app.delete<{ Params: { id: string } }>(
    '/api/v1/projects/:id/share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      await db
        .update(projects)
        .set({ share_token: null, share_enabled_at: null })
        .where(eq(projects.id, project.id));

      return reply.code(204).send();
    },
  );
}
