import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { projects, timeline_sections, simulations } from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { SimulationService, type ConversationMessage } from '../../services/simulation/SimulationService.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { LLMService } from '../../services/llm/LLMService.js';
import { ApiKeyService } from '../../services/secrets/ApiKeyService.js';
import { UsageTrackingService } from '../../services/usage/UsageTrackingService.js';

const _llmService = new LLMService(new ApiKeyService(), new UsageTrackingService());

/** Resolve a simulation's entry_file (may be a storage key or a legacy full URL) to a public URL. */
function resolveSimEntryUrl(entryFile: string | null): string | null {
  if (!entryFile) return null;
  // New rows store the storage key; old rows stored the full URL (backward compat).
  return entryFile.startsWith('http') ? entryFile : getStorageAdapter().getSimPublicUrl(entryFile);
}

export async function registerSectionsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/projects/:id/sections
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/sections',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sections = await db.query.timeline_sections.findMany({
        where: eq(timeline_sections.project_id, project.id),
        orderBy: [asc(timeline_sections.sort_order), asc(timeline_sections.start_sec)],
      });

      return reply.send(sections);
    },
  );

  // POST /api/v1/projects/:id/sections
  app.post<{
    Params: { id: string };
    Body: {
      video_file_id: string;
      start_sec: number;
      end_sec: number;
      type: string;
      label?: string;
      notes?: string;
      simulation_url?: string;
      simulation_id?: string;
      sim_script?: string;
    };
  }>(
    '/api/v1/projects/:id/sections',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const { video_file_id, start_sec, end_sec, type, label, notes, simulation_url, simulation_id, sim_script } = request.body;
      if (!video_file_id || start_sec == null || end_sec == null || !type) {
        return reply.code(400).send({ message: 'video_file_id, start_sec, end_sec, and type are required' });
      }
      if (start_sec >= end_sec) {
        return reply.code(400).send({ message: 'start_sec must be less than end_sec' });
      }

      // Resolve simulation_url from simulation_id if provided
      let resolvedSimUrl = simulation_url ?? null;
      if (simulation_id && !resolvedSimUrl) {
        const sim = await db.query.simulations.findFirst({ where: eq(simulations.id, simulation_id) });
        resolvedSimUrl = resolveSimEntryUrl(sim?.entry_file ?? null);
      }

      const [section] = await db
        .insert(timeline_sections)
        .values({
          project_id: project.id,
          video_file_id,
          start_sec,
          end_sec,
          type,
          label: label ?? null,
          notes: notes ?? null,
          simulation_url: resolvedSimUrl,
          simulation_id: simulation_id ?? null,
          sim_script: sim_script ?? null,
        })
        .returning();

      return reply.code(201).send(section);
    },
  );

  // PATCH /api/v1/projects/:id/sections/:sid
  app.patch<{
    Params: { id: string; sid: string };
    Body: Partial<{
      start_sec: number;
      end_sec: number;
      type: string;
      label: string;
      notes: string;
      sort_order: number;
      simulation_url: string;
      simulation_id: string;
      sim_script: string;
      global_offset_sec: number;
      clip_source_video_id: string | null;
      clip_in_sec: number;
    }>;
  }>(
    '/api/v1/projects/:id/sections/:sid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const existing = await db.query.timeline_sections.findFirst({
        where: and(
          eq(timeline_sections.id, request.params.sid),
          eq(timeline_sections.project_id, project.id),
        ),
      });
      if (!existing) return reply.code(404).send({ message: 'Section not found' });

      const { simulation_id, sim_script, clip_source_video_id, clip_in_sec, ...rest } = request.body;

      if (rest.start_sec != null && rest.end_sec != null && rest.start_sec >= rest.end_sec) {
        return reply.code(400).send({ message: 'start_sec must be less than end_sec' });
      }

      // When simulation_id is provided AND changed, denormalize entry_file → simulation_url.
      // If simulation_id is unchanged, leave simulation_url alone — this preserves the
      // generated bridge URL (section_id.html?v=hash) set by the SSE generation endpoint.
      let resolvedSimUrl: string | null | undefined = rest.simulation_url;
      if (simulation_id !== undefined && simulation_id !== existing.simulation_id) {
        if (simulation_id) {
          const sim = await db.query.simulations.findFirst({ where: eq(simulations.id, simulation_id) });
          resolvedSimUrl = resolveSimEntryUrl(sim?.entry_file ?? null);
        } else {
          resolvedSimUrl = null;
        }
      }

      const patch: Record<string, unknown> = { ...rest };
      if (simulation_id !== undefined)       patch.simulation_id        = simulation_id || null;
      if (sim_script !== undefined)          patch.sim_script           = sim_script || null;
      if (resolvedSimUrl !== undefined)      patch.simulation_url       = resolvedSimUrl;
      if (clip_source_video_id !== undefined) patch.clip_source_video_id = clip_source_video_id ?? null;
      if (clip_in_sec !== undefined)         patch.clip_in_sec          = clip_in_sec;

      const [updated] = await db
        .update(timeline_sections)
        .set(patch)
        .where(eq(timeline_sections.id, existing.id))
        .returning();

      return reply.send(updated);
    },
  );

  // ── Shared helpers for sim-script generation ──────────────────────────────────

  function classifySimulationError(err: unknown): string {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (err.name === 'AbortError' || msg.includes('generation cancelled')) return 'aborted';
      if (msg.includes('overloaded') || msg.includes('529'))                 return 'ai_overloaded';
      if (msg.includes('rate_limit') || msg.includes('429'))                 return 'limit_exceeded';
      if (msg.includes('no html entry') || msg.includes('not found'))        return 'not_found';
      if (msg.includes('non-json plan'))                                     return 'validation_error';
    }
    return 'generation_error';
  }

  const ERROR_MESSAGES: Record<string, string> = {
    aborted:          'Generation was cancelled.',
    ai_overloaded:    'AI is busy right now. Please try again in a moment.',
    limit_exceeded:   'Rate limit reached. Please wait before trying again.',
    not_found:        'Simulation files not found. Please re-upload the simulation.',
    validation_error: 'AI returned an unexpected response. Please try a different prompt.',
    generation_error: 'Generation failed. Please try again or simplify your prompt.',
  };

  // GET /api/v1/projects/:id/sections/:sid/generate-sim-script/stream
  // SSE streaming endpoint — auth via ?token= query param (EventSource limitation)
  app.get<{
    Params:      { id: string; sid: string };
    Querystring: { prompt?: string; simple_ui?: string; auto_script?: string };
  }>(
    '/api/v1/projects/:id/sections/:sid/generate-sim-script/stream',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const section = await db.query.timeline_sections.findFirst({
        where: and(
          eq(timeline_sections.id, request.params.sid),
          eq(timeline_sections.project_id, project.id),
        ),
      });
      if (!section) return reply.code(404).send({ message: 'Section not found' });
      if (section.type !== 'simulation') return reply.code(400).send({ message: 'Section is not a simulation section' });
      if (!section.simulation_id)        return reply.code(400).send({ message: 'Section has no simulation selected' });

      const rawPrompt = String(request.query.prompt ?? '').trim();
      if (!rawPrompt || rawPrompt.length > 1000) {
        return reply.code(400).send({ message: 'prompt is required (max 1000 chars)' });
      }
      const simpleUi   = request.query.simple_ui   === 'true';
      const autoScript = request.query.auto_script  !== 'false';

      // ── All validation done — switch to SSE mode ──────────────────────────────
      // Must set CORS header manually — reply.raw bypasses the @fastify/cors plugin
      const origin = request.headers.origin;
      reply.raw.setHeader('Access-Control-Allow-Origin', origin ?? '*');
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');

      const sendEvent = (event: string, data: object) => {
        try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* socket closed */ }
      };

      sendEvent('connected', {});

      const keepAlive = setInterval(() => {
        try { reply.raw.write(': keep-alive\n\n'); } catch { /* socket closed */ }
      }, 15_000);

      const controller = new AbortController();
      request.raw.on('close', () => {
        controller.abort();
        clearInterval(keepAlive);
      });

      try {
        const svc = new SimulationService(getStorageAdapter(), _llmService);

        // Read stored metadata safely — handle all planVersions (3, 4, 5) and missing fields
        const storedMeta = section.sim_meta as (Record<string, unknown> & {
          planVersion?: string;
          sourceHash?: string;
          supportsRuntimeParams?: boolean;
          generatedBy?: string;
          conversationHistory?: ConversationMessage[];
        }) | null;

        // canReuse: prompt unchanged + bridge exists + bridge was generated by LLM with runtime params.
        // Old planVersion 3/4 bridges compiled toggles in — they do NOT support runtime params.
        // Use supportsRuntimeParams (set in planVersion 5+) rather than checking planVersion string.
        const supportsRuntimeParams =
          storedMeta?.supportsRuntimeParams === true ||
          (storedMeta?.generatedBy === 'llm' && storedMeta?.planVersion === '5');
        const canReuse =
          section.sim_prompt === rawPrompt &&
          !!section.simulation_url &&
          supportsRuntimeParams;

        const savedHistory = (storedMeta?.conversationHistory as ConversationMessage[] | undefined) ?? [];

        const patch: Record<string, unknown> = { simple_ui: simpleUi, auto_script: autoScript, sim_script: 'main' };
        let sectionUrl: string;

        if (canReuse) {
          sendEvent('status', { status: 'Toggle updated — bridge handles it at runtime.', type: 'info' });
          ({ sectionUrl } = svc.reuseBridgeScript(section.simulation_url!));
        } else {
          const result = await svc.generateBridgeScript({
            simId:               section.simulation_id,
            sectionId:           section.id,
            projectId:           project.id,
            userId:              user.id,
            prompt:              rawPrompt,
            simpleUi,
            autoScript,
            storedSourceHash:    storedMeta?.sourceHash,   // service owns hash invalidation
            conversationHistory: savedHistory.length > 0 ? savedHistory : undefined,
            onEvent:             sendEvent,
            signal:              controller.signal,
          });
          sectionUrl = result.sectionUrl;
          patch.sim_prompt = rawPrompt;
          // Build sim_meta from typed result — no recomputation needed
          patch.sim_meta = {
            planVersion:        '5',
            generatedBy:        'llm',
            sourceHash:         result.sourceHash,
            bridgeHash:         result.bridgeHash,
            generatedAt:        new Date().toISOString(),
            provider:           result.provider,
            model:              result.model,
            confidence:         result.confidence,
            confidenceLevel:    result.confidenceLevel,
            contextTruncated:   result.contextTruncated,
            retryCount:         result.retryCount,
            retryReason:        result.retryReason,
            warnings:           result.warnings,
            validationErrors:   result.validationErrors,
            validationWarnings: result.validationWarnings,
            supportsRuntimeParams: true,
            runtimeValidated:   false,   // Playwright-based runtime validation is Phase 5
            conversationHistory: result.conversationHistory,
          };
        }

        patch.simulation_url = sectionUrl;

        if (!controller.signal.aborted) {
          const [updated] = await db
            .update(timeline_sections)
            .set(patch)
            .where(eq(timeline_sections.id, section.id))
            .returning();

          sendEvent('done', { section: updated });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const errorType = classifySimulationError(err);
          sendEvent('error', {
            error:     ERROR_MESSAGES[errorType] ?? ERROR_MESSAGES.generation_error,
            errorType,
          });
        }
      } finally {
        clearInterval(keepAlive);
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    },
  );

  // POST /api/v1/projects/:id/sections/:sid/generate-sim-script
  const GenerateSimScriptSchema = z.object({
    prompt:      z.string().min(1).max(1000),
    simple_ui:   z.boolean(),
    auto_script: z.boolean(),
  });

  app.post<{ Params: { id: string; sid: string } }>(
    '/api/v1/projects/:id/sections/:sid/generate-sim-script',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const section = await db.query.timeline_sections.findFirst({
        where: and(
          eq(timeline_sections.id, request.params.sid),
          eq(timeline_sections.project_id, project.id),
        ),
      });
      if (!section) return reply.code(404).send({ message: 'Section not found' });
      if (section.type !== 'simulation') return reply.code(400).send({ message: 'Section is not a simulation section' });
      if (!section.simulation_id) return reply.code(400).send({ message: 'Section has no simulation selected' });

      const body = GenerateSimScriptSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });
      const { prompt, simple_ui, auto_script } = body.data;

      const svc = new SimulationService(getStorageAdapter(), _llmService);

      // canReuse: same prompt + bridge exists + supportsRuntimeParams (planVersion 5+)
      const storedMeta2 = section.sim_meta as (Record<string, unknown> & {
        planVersion?: string; supportsRuntimeParams?: boolean; generatedBy?: string;
        sourceHash?: string; conversationHistory?: ConversationMessage[];
      }) | null;
      const supportsRuntimeParams2 =
        storedMeta2?.supportsRuntimeParams === true ||
        (storedMeta2?.generatedBy === 'llm' && storedMeta2?.planVersion === '5');
      const canReuse =
        section.sim_prompt === prompt &&
        !!section.simulation_url &&
        supportsRuntimeParams2;

      let sectionUrl: string;
      const patch: Record<string, unknown> = { simple_ui, auto_script, sim_script: 'main' };

      if (canReuse) {
        ({ sectionUrl } = svc.reuseBridgeScript(section.simulation_url!));
      } else {
        const savedHistory2 = (storedMeta2?.conversationHistory as ConversationMessage[] | undefined) ?? [];
        const result2 = await svc.generateBridgeScript({
          simId:            section.simulation_id,
          sectionId:        section.id,
          projectId:        project.id,
          userId:           user.id,
          prompt,
          simpleUi:         simple_ui,
          autoScript:       auto_script,
          storedSourceHash: storedMeta2?.sourceHash,
          conversationHistory: savedHistory2.length > 0 ? savedHistory2 : undefined,
        });
        sectionUrl = result2.sectionUrl;
        patch.sim_prompt = prompt;
        patch.sim_meta = {
          planVersion:        '5',
          generatedBy:        'llm',
          sourceHash:         result2.sourceHash,
          bridgeHash:         result2.bridgeHash,
          generatedAt:        new Date().toISOString(),
          provider:           result2.provider,
          model:              result2.model,
          confidence:         result2.confidence,
          confidenceLevel:    result2.confidenceLevel,
          contextTruncated:   result2.contextTruncated,
          retryCount:         result2.retryCount,
          retryReason:        result2.retryReason,
          warnings:           result2.warnings,
          validationErrors:   result2.validationErrors,
          validationWarnings: result2.validationWarnings,
          supportsRuntimeParams: true,
          runtimeValidated:   false,
          conversationHistory: result2.conversationHistory,
        };
      }

      patch.simulation_url = sectionUrl;

      const [updated] = await db
        .update(timeline_sections)
        .set(patch)
        .where(eq(timeline_sections.id, section.id))
        .returning();

      return reply.send(updated);
    },
  );

  // DELETE /api/v1/projects/:id/sections/:sid
  app.delete<{ Params: { id: string; sid: string } }>(
    '/api/v1/projects/:id/sections/:sid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const existing = await db.query.timeline_sections.findFirst({
        where: and(
          eq(timeline_sections.id, request.params.sid),
          eq(timeline_sections.project_id, project.id),
        ),
      });
      if (!existing) return reply.code(404).send({ message: 'Section not found' });

      await db.delete(timeline_sections).where(eq(timeline_sections.id, existing.id));

      return reply.code(204).send();
    },
  );
}
