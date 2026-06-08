// Admin · Avatar — a global window into all Ask-the-Avatar data:
// the full visual Library (basic + extended, every project + global),
// generated media, conversations, and configuration status.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { avatar_visuals, avatar_conversations, avatar_profiles, projects, admin_settings } from '../../../db/schema.js';
import { firebaseAdminRequired } from '../../../middleware/firebase-admin-required.js';
import { updateVisual, deleteVisual } from '../../../services/avatar/libraryService.js';
import { isAnamConfigured } from '../../../services/avatar/anamService.js';
import { CHARACTERS, DEFAULT_CHARACTER_ID } from '../../../services/avatar/characters.js';

export async function registerAdminAvatarRoutes(app: FastifyInstance): Promise<void> {
  // ── Config / health ────────────────────────────────────────────────────────
  app.get(
    '/api/admin/v1/avatar/config',
    { preHandler: [firebaseAdminRequired] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const [settings] = await db.select({ byok: admin_settings.avatar_byok_enabled }).from(admin_settings).limit(1);
      return reply.send({
        anam_configured: isAnamConfigured(),
        anam_api_key: Boolean(process.env.ANAM_API_KEY),
        persona_einstein: Boolean(process.env.ANAM_PERSONA_ID_EINSTEIN || process.env.ANAM_PERSONA_ID),
        persona_darwin: Boolean(process.env.ANAM_PERSONA_ID_DARWIN || process.env.ANAM_PERSONA_ID),
        persona_napoleon: Boolean(process.env.ANAM_PERSONA_ID_NAPOLEON),
        persona_archimedes: Boolean(process.env.ANAM_PERSONA_ID_ARCHIMEDES),
        openai: Boolean(process.env.OPENAI_API_KEY),
        default_character: DEFAULT_CHARACTER_ID,
        characters: Object.keys(CHARACTERS),
        byok_enabled: Boolean(settings?.byok),
      });
    },
  );

  // Toggle BYOK — when on, each video uses its owner's own Anam key (set in their
  // home Settings → Avatar); when off, everyone uses the shared server key.
  app.put(
    '/api/admin/v1/avatar/byok',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const enabled = Boolean((request.body as { enabled?: boolean } | undefined)?.enabled);
      await db.update(admin_settings).set({ avatar_byok_enabled: enabled }).where(eq(admin_settings.id, 1));
      return reply.send({ ok: true, byok_enabled: enabled });
    },
  );

  // ── Stats ──────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/v1/avatar/stats',
    { preHandler: [firebaseAdminRequired] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const [total, byType, byScope, bySource, convoCount, profileCount] = await Promise.all([
        db.select({ c: sql<number>`count(*)::int` }).from(avatar_visuals),
        db.select({ k: avatar_visuals.visual_type, c: sql<number>`count(*)::int` }).from(avatar_visuals).groupBy(avatar_visuals.visual_type),
        db.select({ k: avatar_visuals.scope, c: sql<number>`count(*)::int` }).from(avatar_visuals).groupBy(avatar_visuals.scope),
        db.select({ k: avatar_visuals.source, c: sql<number>`count(*)::int` }).from(avatar_visuals).groupBy(avatar_visuals.source),
        db.select({ c: sql<number>`count(*)::int` }).from(avatar_conversations),
        db.select({ c: sql<number>`count(*)::int` }).from(avatar_profiles),
      ]);
      const toMap = (rows: { k: string; c: number }[]) => rows.reduce((m, r) => ((m[r.k] = r.c), m), {} as Record<string, number>);
      return reply.send({
        total_visuals: total[0]?.c ?? 0,
        by_type: toMap(byType),
        by_scope: toMap(byScope),
        by_source: toMap(bySource),
        conversation_turns: convoCount[0]?.c ?? 0,
        profiles: profileCount[0]?.c ?? 0,
      });
    },
  );

  // ── Global gallery (every project + global) ────────────────────────────────
  app.get(
    '/api/admin/v1/avatar/gallery',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as { page?: string; limit?: string; type?: string; scope?: string; source?: string; character?: string; q?: string };
      const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
      const limit = Math.min(60, Math.max(1, parseInt(q.limit ?? '24', 10) || 24));

      const conds = [];
      if (q.type) conds.push(eq(avatar_visuals.visual_type, q.type));
      if (q.scope) conds.push(eq(avatar_visuals.scope, q.scope));
      if (q.source) conds.push(eq(avatar_visuals.source, q.source));
      if (q.character) conds.push(eq(avatar_visuals.character_id, q.character));
      if (q.q) conds.push(sql`(${avatar_visuals.caption} ILIKE ${'%' + q.q + '%'} OR ${avatar_visuals.lookup_key} ILIKE ${'%' + q.q + '%'})`);
      const where = conds.length ? and(...conds) : undefined;

      const items = await db
        .select({
          id: avatar_visuals.id,
          project_id: avatar_visuals.project_id,
          project_title: projects.title,
          scope: avatar_visuals.scope,
          source: avatar_visuals.source,
          character_id: avatar_visuals.character_id,
          visual_type: avatar_visuals.visual_type,
          caption: avatar_visuals.caption,
          alt_text: avatar_visuals.alt_text,
          image_url: avatar_visuals.image_url,
          sim_entry_url: avatar_visuals.sim_entry_url,
          visual_spec: avatar_visuals.visual_spec,
          use_count: avatar_visuals.use_count,
          created_at: avatar_visuals.created_at,
        })
        .from(avatar_visuals)
        .leftJoin(projects, eq(avatar_visuals.project_id, projects.id))
        .where(where)
        .orderBy(desc(avatar_visuals.created_at))
        .limit(limit)
        .offset((page - 1) * limit);

      const totalRows = await db.select({ c: sql<number>`count(*)::int` }).from(avatar_visuals).where(where);
      const typeRows = await db.select({ k: avatar_visuals.visual_type, c: sql<number>`count(*)::int` }).from(avatar_visuals).where(where).groupBy(avatar_visuals.visual_type);
      const typeCounts = typeRows.reduce((m, r) => ((m[r.k] = r.c), m), {} as Record<string, number>);

      return reply.send({ items, total: totalRows[0]?.c ?? 0, page, typeCounts });
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/admin/v1/avatar/gallery/:id',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const body = (request.body ?? {}) as { caption?: string; altText?: string; scope?: 'basic' | 'extended' };
      const ok = await updateVisual(request.params.id, body);
      return reply.send({ ok });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/v1/avatar/gallery/:id',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ok = await deleteVisual(request.params.id);
      return reply.send({ ok });
    },
  );

  // ── Conversations (recent sessions) ────────────────────────────────────────
  app.get(
    '/api/admin/v1/avatar/conversations',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as { limit?: string };
      const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? '100', 10) || 100));
      const rows = await db
        .select()
        .from(avatar_conversations)
        .orderBy(desc(avatar_conversations.created_at))
        .limit(limit);
      // group into sessions
      const sessions: Record<string, { session_key: string; character_id: string; project_id: string | null; turns: { role: string; content: string; created_at: Date }[] }> = {};
      for (const r of rows) {
        const s = (sessions[r.session_key] ??= { session_key: r.session_key, character_id: r.character_id, project_id: r.project_id, turns: [] });
        s.turns.push({ role: r.role, content: r.content, created_at: r.created_at });
      }
      return reply.send({ sessions: Object.values(sessions) });
    },
  );
}
