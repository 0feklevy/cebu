// Ask-the-Avatar — interactive avatar conversation + visual Library.
// Public conversation endpoints (used by viewers, possibly anonymous) +
// authenticated project-library management (used by the editor).
//
// Library model:
//   • basic     — this project's editor media (images + ready sims), AUTO-SYNCED
//                 from the project (no manual import/upload).
//   • extended  — GLOBAL pool (project_id = null) of every visual the avatar has
//                 generated for any viewer of any video; reused everywhere.
// At runtime the avatar prefers basic, then global extended, over generating new.
import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { rateLimit } from '../../lib/rateLimit.js';
import { and, or, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { uploadWithFallback } from '../../services/storage/uploadWithFallback.js';
import { projects, avatar_visuals, admin_settings, users } from '../../db/schema.js';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import {
  getSessionToken, isAnamConfigured, listAnamResource, upsertVideoPersona,
  enrichAvatarConfigFromAnam, buildAvatarDisplay,
  ensureKnowledgeGroup, ensureKnowledgeTool, uploadKnowledgeDocument, listKnowledgeDocuments, deleteKnowledgeDocument, listSystemTools,
  type AvatarPersonaConfig,
} from '../../services/avatar/anamService.js';
import { encryptKey } from '../../services/secrets/ApiKeyService.js';
import { resolveAnamKeyForProject } from '../../services/avatar/anamKey.js';
import { analyzeVisual, generateLibrarySimulation, editLibrarySimulation } from '../../services/avatar/visualService.js';
import { analyzeAndGenerateImage, generateLibraryImage } from '../../services/avatar/imageService.js';
import { listVisuals, updateVisual, deleteVisual, syncBasicLibrary } from '../../services/avatar/libraryService.js';
import { saveTurns, getTurns, getProfile, extractAndSaveFacts, type Turn } from '../../services/avatar/memoryService.js';
import { CHARACTERS, DEFAULT_CHARACTER_ID } from '../../services/avatar/characters.js';
import { logger } from '../../lib/logger.js';

// Read avatar_config defensively: normally a jsonb object, but tolerate a legacy
// double-encoded JSON string so a merge-write never spreads a string into
// numeric-index keys (which would corrupt the column).
function asPersonaConfig(v: unknown): AvatarPersonaConfig {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as AvatarPersonaConfig;
  if (typeof v === 'string') {
    try { const o = JSON.parse(v); if (o && typeof o === 'object' && !Array.isArray(o)) return o as AvatarPersonaConfig; } catch { /* ignore */ }
  }
  return {};
}

export async function registerAvatarRoutes(app: FastifyInstance): Promise<void> {
  // ── Public: health ─────────────────────────────────────────────────────────
  app.get('/api/v1/avatar/health', async () => ({
    ok: true,
    anam: isAnamConfigured(),
    openai: Boolean(process.env.OPENAI_API_KEY),
    defaultCharacter: DEFAULT_CHARACTER_ID,
    characters: Object.keys(CHARACTERS),
  }));

  // ── Public: start an avatar session (applies the video's saved persona config) ─
  app.post('/api/v1/avatar/start', { preHandler: [firebaseAuthOptionalMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { character_id?: string; projectId?: string };
    let cfg: AvatarPersonaConfig | undefined;
    let apiKey: string | undefined;
    if (body.projectId) {
      const project = await db.query.projects.findFirst({ where: eq(projects.id, body.projectId), columns: { avatar_config: true, visibility: true, created_by: true } }).catch(() => null);
      if (!project) return reply.code(404).send({ message: 'Project not found' });
      // A PRIVATE project's avatar/persona isn't anonymously accessible (review security-004).
      // Public/unlisted stay open (unlisted is reached via a share link, where the avatar is
      // part of viewing); the owner is always allowed.
      const isOwner = !!request.dbUser?.id && project.created_by === request.dbUser.id;
      if (project.visibility === 'private' && !isOwner) {
        return reply.code(404).send({ message: 'Project not found' });
      }
      cfg = (project.avatar_config as AvatarPersonaConfig | null) ?? undefined;
      apiKey = await resolveAnamKeyForProject(body.projectId).catch(() => undefined);
      // Resolve the selected avatar's display name/image (and default voice) from
      // Anam when they were not persisted — otherwise the popup falls back to the
      // default character's image/name (the "always Einstein" bug). Only when a
      // custom avatar is chosen but its identity fields are missing.
      if (cfg?.avatarId && (!cfg.avatarName || !cfg.avatarImageUrl || !cfg.voiceId)) {
        cfg = await enrichAvatarConfigFromAnam(cfg, apiKey).catch(() => cfg);
      }
    }
    const characterId = body.character_id ?? cfg?.characterId ?? DEFAULT_CHARACTER_ID;
    try {
      const info = await getSessionToken(characterId, cfg, apiKey);
      return reply.send({
        provider: 'anam',
        sessionToken: info.token,
        characterId: info.characterId,
        voiceSensitivity: info.voiceSensitivity,
        avatarDisplay: buildAvatarDisplay(info.characterId, cfg, info.voiceSensitivity),
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      logger.warn({ err }, '[Avatar] start failed');
      return reply.code(status).send({ message: status >= 500 ? 'Avatar session failed' : (err as Error).message });
    }
  });

  // ── Public: end session (no-op; token cache handles expiry) ─────────────────
  app.post('/api/v1/avatar/end', async (_request, reply) => reply.send({ ok: true }));

  // ── Public: visual analysis ────────────────────────────────────────────────
  app.post('/api/v1/avatar/visual/analyze', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { message?: string; characterId?: string; context?: string; projectId?: string };
    if (!body.message || typeof body.message !== 'string') return reply.send({ type: 'none' });
    // Unauthenticated + billable: per-IP rate limit + input cap to bound cost-DoS (security-003).
    if (!rateLimit(`avatar-visual:${request.ip}`, 30, 60_000)) return reply.code(429).send({ type: 'none' });
    const message = body.message.slice(0, 4000);
    const characterId = body.characterId && CHARACTERS[body.characterId] ? body.characterId : DEFAULT_CHARACTER_ID;
    // Keep the project's basic library fresh so it's preferred at retrieval (throttled).
    if (body.projectId) syncBasicLibrary(body.projectId).catch(() => {});
    try {
      const result = await analyzeVisual(message, characterId, body.context, { projectId: body.projectId ?? null });
      return reply.send(result);
    } catch (err) {
      logger.warn({ err }, '[Avatar] visual/analyze failed');
      return reply.send({ type: 'none' });
    }
  });

  // ── Public: image analysis ─────────────────────────────────────────────────
  app.post('/api/v1/avatar/image/analyze', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { userMessage?: string; characterId?: string; conversationContext?: string; projectId?: string };
    if (!body.userMessage || typeof body.userMessage !== 'string') {
      return reply.send({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' });
    }
    // Unauthenticated + runs billable gpt-image-1: tighter per-IP cap + input cap (security-003).
    if (!rateLimit(`avatar-image:${request.ip}`, 10, 60_000)) {
      return reply.code(429).send({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' });
    }
    const userMessage = body.userMessage.slice(0, 4000);
    const characterId = body.characterId && CHARACTERS[body.characterId] ? body.characterId : DEFAULT_CHARACTER_ID;
    if (body.projectId) syncBasicLibrary(body.projectId).catch(() => {});
    try {
      const result = await analyzeAndGenerateImage(userMessage, characterId, body.conversationContext, body.projectId ?? null);
      return reply.send(result);
    } catch (err) {
      logger.warn({ err }, '[Avatar] image/analyze failed');
      return reply.send({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' });
    }
  });

  // ── Public: read the basic + global extended library for a project (viewer) ─
  app.get<{ Params: { id: string } }>(
    '/api/v1/avatar/projects/:id/library',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      await syncBasicLibrary(request.params.id).catch(() => {});
      const q = request.query as { scope?: string; type?: string; q?: string; page?: string };
      const result = await listVisuals({
        projectId: request.params.id, includeGlobal: true,
        scope: q.scope === 'basic' || q.scope === 'extended' ? q.scope : undefined,
        type: q.type, q: q.q, page: q.page ? parseInt(q.page, 10) : 1, limit: 60,
      });
      return reply.send(result);
    },
  );

  // ── Public: conversation memory ────────────────────────────────────────────
  const MemorySchema = z.object({
    sessionKey: z.string().min(1).max(200),
    characterId: z.string().max(64).optional(),
    projectId: z.string().uuid().optional(),
    turns: z.array(z.object({ role: z.enum(['user', 'persona']), content: z.string() })).max(40),
  });

  app.get('/api/v1/avatar/memory', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionKey = (request.query as { sessionKey?: string }).sessionKey;
    if (!sessionKey) return reply.send({ turns: [], profile: {} });
    try {
      const [turns, profile] = await Promise.all([getTurns(sessionKey), getProfile(sessionKey)]);
      return reply.send({ turns, profile });
    } catch {
      return reply.send({ turns: [], profile: {} });
    }
  });

  app.post('/api/v1/avatar/memory', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = MemorySchema.safeParse(request.body);
    if (!parsed.success) return reply.send({ ok: false });
    const { sessionKey, characterId, projectId, turns } = parsed.data;
    try {
      await saveTurns(sessionKey, characterId ?? DEFAULT_CHARACTER_ID, projectId ?? null, turns as Turn[]);
      extractAndSaveFacts(sessionKey, turns as Turn[]).catch(() => {});
      return reply.send({ ok: true });
    } catch {
      return reply.send({ ok: false });
    }
  });

  // ── Authenticated library management (editor) ──────────────────────────────

  async function requireOwnedProject(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const user = request.dbUser!;
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
    });
    if (!project) {
      reply.code(404).send({ message: 'Project not found' });
      return null;
    }
    return project;
  }

  // A visual the editor may manage: this project's basic items OR a global extended item.
  async function findManageableVisual(projectId: string, visualId: string) {
    const [row] = await db.select().from(avatar_visuals)
      .where(and(eq(avatar_visuals.id, visualId), or(eq(avatar_visuals.project_id, projectId), isNull(avatar_visuals.project_id)))).limit(1);
    return row ?? null;
  }

  // GET — basic (this project, auto-synced) + global extended
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/library',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      await syncBasicLibrary(project.id, true).catch(() => {});
      const q = request.query as { scope?: string; type?: string; q?: string; page?: string };
      const result = await listVisuals({
        projectId: project.id, includeGlobal: true,
        scope: q.scope === 'basic' || q.scope === 'extended' ? q.scope : undefined,
        type: q.type, q: q.q, page: q.page ? parseInt(q.page, 10) : 1, limit: 60,
      });
      return reply.send(result);
    },
  );

  // POST generate-image — text → image saved to the GLOBAL extended library
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/library/generate-image',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const body = (request.body ?? {}) as { prompt?: string; dallePrompt?: string; caption?: string; characterId?: string };
      if (!body.prompt && !body.dallePrompt) return reply.code(400).send({ message: 'prompt is required' });
      try {
        const res = await generateLibraryImage({
          prompt: body.prompt ?? body.dallePrompt!, dallePrompt: body.dallePrompt,
          characterId: body.characterId && CHARACTERS[body.characterId] ? body.characterId : DEFAULT_CHARACTER_ID,
          caption: body.caption, createdBy: request.dbUser!.id,
        });
        return reply.send({ ok: true, item: res!.row, imageUrl: res!.imageUrl });
      } catch (err) {
        logger.error({ err }, '[Avatar] library image generation failed');
        return reply.code(500).send({ message: 'Image generation failed' });
      }
    },
  );

  // POST generate-simulation — text → sim saved to the GLOBAL extended library
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/library/generate-simulation',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const body = (request.body ?? {}) as { prompt?: string; caption?: string; characterId?: string };
      if (!body.prompt) return reply.code(400).send({ message: 'prompt is required' });
      try {
        const res = await generateLibrarySimulation({
          prompt: body.prompt, caption: body.caption,
          characterId: body.characterId && CHARACTERS[body.characterId] ? body.characterId : DEFAULT_CHARACTER_ID,
          createdBy: request.dbUser!.id,
        });
        return reply.send({ ok: true, item: res!.row, simulationUrl: res!.simulationUrl });
      } catch (err) {
        logger.error({ err }, '[Avatar] library simulation generation failed');
        return reply.code(500).send({ message: 'Simulation generation failed' });
      }
    },
  );

  // POST :visualId/edit-simulation — AI-refine a single-file simulation in place
  app.post<{ Params: { id: string; visualId: string } }>(
    '/api/v1/projects/:id/avatar/library/:visualId/edit-simulation',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; visualId: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      if (!(await findManageableVisual(project.id, request.params.visualId))) return reply.code(404).send({ message: 'Visual not found' });
      const body = (request.body ?? {}) as { instructions?: string };
      if (!body.instructions) return reply.code(400).send({ message: 'instructions are required' });
      try {
        const res = await editLibrarySimulation(request.params.visualId, body.instructions);
        return reply.send({ ok: true, simulationUrl: res.simulationUrl });
      } catch (err) {
        logger.warn({ err }, '[Avatar] library simulation edit failed');
        return reply.code(400).send({ message: 'Could not edit the simulation' });
      }
    },
  );

  // PATCH — update caption / alt text / scope
  app.patch<{ Params: { id: string; visualId: string } }>(
    '/api/v1/projects/:id/avatar/library/:visualId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; visualId: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      if (!(await findManageableVisual(project.id, request.params.visualId))) return reply.code(404).send({ message: 'Visual not found' });
      const body = (request.body ?? {}) as { caption?: string; altText?: string; scope?: 'basic' | 'extended' };
      const ok = await updateVisual(request.params.visualId, body);
      return reply.send({ ok });
    },
  );

  // DELETE — remove a library visual (editor-sourced "basic" rows keep their media)
  app.delete<{ Params: { id: string; visualId: string } }>(
    '/api/v1/projects/:id/avatar/library/:visualId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; visualId: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      if (!(await findManageableVisual(project.id, request.params.visualId))) return reply.code(404).send({ message: 'Visual not found' });
      const ok = await deleteVisual(request.params.visualId);
      return reply.code(ok ? 204 : 404).send();
    },
  );

  // ── Per-video avatar persona config (editor) ───────────────────────────────

  // GET — the video's saved avatar persona config (defaults to {})
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/config',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const row = await db.query.projects.findFirst({ where: eq(projects.id, project.id), columns: { avatar_config: true } });
      return reply.send({ config: (row?.avatar_config as AvatarPersonaConfig | null) ?? {} });
    },
  );

  // PUT — save the video's avatar persona config (stored per-video on the server)
  const AvatarConfigSchema = z.object({
    characterId: z.string().max(40).optional(),
    name: z.string().max(120).optional(),
    avatarName: z.string().max(120).optional(),
    avatarVariantName: z.string().max(120).optional(),
    avatarImageUrl: z.string().max(2048).optional(),
    systemPrompt: z.string().max(20000).optional(),
    knowledge: z.string().max(40000).optional(),
    greeting: z.string().max(2000).optional(),
    languageCode: z.string().max(12).optional(),
    avatarId: z.string().max(80).optional(),
    avatarModel: z.string().max(40).optional(),
    voiceId: z.string().max(80).optional(),
    voiceName: z.string().max(120).optional(),
    llmId: z.string().max(80).optional(),
    maxSessionLengthSeconds: z.number().int().min(60).max(3600).optional(),
    skipGreeting: z.boolean().optional(),
    uninterruptibleGreeting: z.boolean().optional(),
    voiceSensitivity: z.number().min(0).max(1).optional(),
    toolIds: z.array(z.string().max(80)).max(20).optional(),
    avatarCircles: z.object({
      enabled: z.boolean(),
      visibility: z.enum(['broll', 'always', 'none']).optional(),
      count: z.union([z.literal(1), z.literal(2)]),
      faces: z.array(z.object({
        speaker: z.enum(['host_a', 'host_b']),
        side: z.enum(['left', 'right']),
        imageUrl: z.string().max(2048).optional(),
        label: z.string().max(120).optional(),
      })).max(2).optional(),
      barStyle: z.enum(['bars', 'solid', 'gradient']).optional(),
      numberOfBars: z.number().min(8).max(512).optional(),
      sensitivity: z.number().min(0).max(1).optional(),
      barWidth: z.number().min(1).max(64).optional(),
      innerRadius: z.number().min(0).max(600).optional(),
      smoothness: z.number().min(0).max(1).optional(),
      minHeight: z.number().min(0).max(600).optional(),
      maxHeight: z.number().min(1).max(1200).optional(),
      rotationOffset: z.number().min(0).max(360).optional(),
      lowFreqCutPct: z.number().min(0).max(100).optional(),
      highFreqCutPct: z.number().min(0).max(100).optional(),
      colorMode: z.enum(['solid', 'gradient']).optional(),
      barColor: z.string().max(32).optional(),
      gradientEnd: z.string().max(32).optional(),
      background: z.string().max(32).optional(),
      roundedBars: z.boolean().optional(),
      circleSize: z.number().min(16).max(800).optional(),
      circleOpacity: z.number().min(0).max(1).optional(),
      circleLayout: z.enum(['corners', 'right-stack']).optional(),
      circleSideInsetPct: z.number().min(0).max(45).optional(),
      circleBottomPct: z.number().min(0).max(70).optional(),
      circleGapPct: z.number().min(0).max(20).optional(),
      showCenterCircle: z.boolean().optional(),
    }).optional(),
  });

  app.put<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/config',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const parsed = AvatarConfigSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.message });
      const incoming = parsed.data as AvatarPersonaConfig;
      const existing = (project.avatar_config as AvatarPersonaConfig | null) ?? {};
      const characterId = incoming.characterId ?? existing.characterId ?? DEFAULT_CHARACTER_ID;
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const avatarChanged = Boolean(incoming.avatarId && incoming.avatarId !== existing.avatarId);
      const staleExistingVoice = Boolean(avatarChanged && existing.voiceId && incoming.voiceId === existing.voiceId);

      // Server/feature-managed fields carry over from the saved config (the PUT
      // rebuilds avatar_config from the form, so anything not in the form must be
      // preserved explicitly); user fields come from `incoming`.
      const effectiveBase: AvatarPersonaConfig = {
        ...incoming,
        knowledgeGroupId: existing.knowledgeGroupId,
        knowledgeToolId: existing.knowledgeToolId,
        transcriptDocId: existing.transcriptDocId,
        avatarCircles: incoming.avatarCircles ?? existing.avatarCircles,
      };
      const effective = await enrichAvatarConfigFromAnam(effectiveBase, apiKey, {
        forceDefaultVoice: staleExistingVoice || !effectiveBase.voiceId,
      }).catch(() => effectiveBase);

      // Save the settings AS a real Anam persona (created/updated in the account)
      // and store its id for this video, so the session loads it exactly.
      let personaId: string | undefined;
      let personaError: string | undefined;
      try {
        personaId = await upsertVideoPersona(characterId, effective, apiKey, existing.personaId);
      } catch (e) {
        personaError = (e as Error).message; // non-fatal: still save config, session falls back
        personaId = undefined;
      }

      const toSave: AvatarPersonaConfig = { ...effective, ...(personaId ? { personaId } : {}) };
      await db.update(projects).set({ avatar_config: toSave, updated_at: new Date() }).where(eq(projects.id, project.id));
      return reply.send({ ok: true, config: toSave, personaId, personaError });
    },
  );

  // GET — list the Anam avatars / voices / llms / personas available to this
  // video's key (the owner's BYOK key when enabled, else the shared key).
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/anam-resources',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const kindRaw = (request.query as { kind?: string }).kind;
      const kind = (['avatars', 'voices', 'llms', 'personas'] as const).find((k) => k === kindRaw);
      if (!kind) return reply.code(400).send({ message: 'kind must be avatars|voices|llms|personas' });
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const result = await listAnamResource(kind, apiKey).catch(() => ({ data: [] }));
      return reply.send(result);
    },
  );

  // GET — selectable Anam SYSTEM tools (end_call, change_language, skip_turn)
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/tools',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const tools = await listSystemTools(apiKey).catch(() => []);
      return reply.send({ tools });
    },
  );

  // ── Knowledge base (RAG) documents ─────────────────────────────────────────

  // POST — upload a document; lazily creates the group + RAG tool for this video.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/knowledge/documents',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const data = await request.file();
      if (!data) return reply.code(400).send({ message: 'No file uploaded' });
      const ext = (data.filename?.split('.').pop() ?? '').toLowerCase();
      if (!['pdf', 'txt', 'md', 'docx', 'csv'].includes(ext)) {
        return reply.code(400).send({ message: 'Supported: PDF, TXT, MD, DOCX, CSV' });
      }
      const buf = await data.toBuffer();
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const existing = (project.avatar_config as AvatarPersonaConfig | null) ?? {};
      try {
        const groupId = await ensureKnowledgeGroup(`${project.title ?? 'Video'} knowledge`, apiKey, existing.knowledgeGroupId);
        await uploadKnowledgeDocument(groupId, buf, data.filename ?? 'document', data.mimetype, apiKey);
        const toolId = await ensureKnowledgeTool(groupId, project.title ?? project.id.slice(0, 8), apiKey, existing.knowledgeToolId);
        const merged: AvatarPersonaConfig = { ...existing, knowledgeGroupId: groupId, knowledgeToolId: toolId };
        await db.update(projects).set({ avatar_config: merged, updated_at: new Date() }).where(eq(projects.id, project.id));
        return reply.send({ ok: true, knowledgeGroupId: groupId, knowledgeToolId: toolId });
      } catch (e) {
        return reply.code(502).send({ message: (e as Error).message });
      }
    },
  );

  // GET — list documents in this video's knowledge group
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/knowledge/documents',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const cfg = (project.avatar_config as AvatarPersonaConfig | null) ?? {};
      if (!cfg.knowledgeGroupId) return reply.send({ data: [] });
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const docs = await listKnowledgeDocuments(cfg.knowledgeGroupId, apiKey).catch(() => ({ data: [] }));
      return reply.send(docs);
    },
  );

  // DELETE — remove a document from the knowledge group
  app.delete<{ Params: { id: string; docId: string } }>(
    '/api/v1/projects/:id/avatar/knowledge/documents/:docId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; docId: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const ok = await deleteKnowledgeDocument(request.params.docId, apiKey).catch(() => false);
      return reply.code(ok ? 204 : 502).send();
    },
  );

  // ── Avatar circles (audio-reactive overlays shown during b-roll) ───────────

  const AvatarCirclesSchema = AvatarConfigSchema.shape.avatarCircles.unwrap();

  // GET — this video's avatar-circles config (defaults to null/disabled).
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/circles',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const cfg = asPersonaConfig(project.avatar_config);
      return reply.send({ config: cfg.avatarCircles ?? null });
    },
  );

  // PUT — save the avatar-circles config (merged into avatar_config, decoupled
  // from the Anam persona save).
  app.put<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/circles',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const parsed = AvatarCirclesSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.message });
      const existing = asPersonaConfig(project.avatar_config);
      const merged: AvatarPersonaConfig = { ...existing, avatarCircles: parsed.data };
      await db.update(projects).set({ avatar_config: merged, updated_at: new Date() }).where(eq(projects.id, project.id));
      return reply.send({ ok: true, config: parsed.data });
    },
  );

  // POST — upload an avatar face image for a circle; returns its public URL.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/circle-face',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const data = await request.file();
      if (!data) return reply.code(400).send({ message: 'No file uploaded' });
      const mime = data.mimetype.toLowerCase().split(';')[0].trim();
      if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mime)) {
        return reply.code(400).send({ message: 'Only JPEG, PNG, and WebP images are supported' });
      }
      const buf = await data.toBuffer();
      if (buf.length > 8 * 1024 * 1024) return reply.code(413).send({ message: 'Image must be 8MB or smaller' });
      const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
      const key = `avatar-circles/${project.id}/${randomUUID()}${ext}`;
      const url = await uploadWithFallback(key, buf, mime);
      return reply.code(201).send({ url });
    },
  );

  // ── BYOK: the signed-in user's own Anam API key ────────────────────────────

  // Tells the UI whether the BYOK key field should be shown + whether one is set.
  app.get('/api/v1/avatar/byok-status', { preHandler: [firebaseAuthMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const [settings] = await db.select({ byok: admin_settings.avatar_byok_enabled }).from(admin_settings).limit(1);
    const user = request.dbUser!;
    return reply.send({ byokEnabled: Boolean(settings?.byok), hasKey: Boolean(user.anam_api_key_encrypted) });
  });

  // Save / clear the user's own Anam API key (encrypted at rest). Never returned.
  app.put('/api/v1/avatar/my-key', { preHandler: [firebaseAuthMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { apiKey?: string };
    const key = (body.apiKey ?? '').trim();
    const user = request.dbUser!;
    await db.update(users).set({ anam_api_key_encrypted: key ? encryptKey(key) : null }).where(eq(users.id, user.id));
    return reply.send({ ok: true, hasKey: Boolean(key) });
  });
}
