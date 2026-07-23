import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { timeline_sections, simulations, video_files } from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { SimulationService, type ConversationMessage } from '../../services/simulation/SimulationService.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { LLMService } from '../../services/llm/LLMService.js';
import { ApiKeyService } from '../../services/secrets/ApiKeyService.js';
import { UsageTrackingService } from '../../services/usage/UsageTrackingService.js';

const _llmService = new LLMService(new ApiKeyService(), new UsageTrackingService());

// Single shared SimulationService for this controller. The bridge.js read-modify-write
// lock (SimulationService.withBridgeLock) lives in a per-INSTANCE map, so a new instance
// per request only serialized retries within one call — two different sections of the SAME
// simulation generating concurrently each read the same bridge.js and the later write
// clobbered the earlier section's entry. Sharing one instance (hence one bridgeLocks map)
// across requests makes the lock effective process-wide. Lazily constructed so the storage
// adapter is resolved AFTER the startup R2→local probe (getStorageAdapter can be flipped to
// local at boot). (backend-101; still process-local — a cluster needs a durable advisory lock.)
let _simService: SimulationService | null = null;
function getSimService(): SimulationService {
  if (!_simService) _simService = new SimulationService(getStorageAdapter(), _llmService);
  return _simService;
}

// Per-section generation lock: two near-simultaneous generate requests for the SAME section
// (double-click, retry, two editor tabs) both read the same conversationHistory and race the
// final write, so the later one clobbers the earlier and the merged bridge can reference a URL
// that was never persisted. We let only one generation per section proceed at a time (backend-005).
const activeSimGenerations = new Set<string>();

// Hard ceiling on a single sim-script generation so a hung LLM provider can't pin an open SSE
// socket + keep-alive forever with the user stuck on "Generating…" (backend-007).
const SIM_GEN_TIMEOUT_MS = 120_000;

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
      const project = await editableProject(request.params.id, user);
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
      sort_order?: number | null;
      simulation_url?: string;
      simulation_id?: string;
      sim_script?: string;
      sim_prompt?: string | null;
      sim_meta?: unknown;
      track?: 'main' | 'broll' | 'audio';
      global_offset_sec?: number | null;
      clip_source_video_id?: string | null;
      clip_in_sec?: number | null;
      broll_volume?: number;
      simple_ui?: boolean;
      auto_script?: boolean;
      clip_source_image_id?: string | null;
      camera_movement?: string;
      clip_source_audio_id?: string | null;
    };
  }>(
    '/api/v1/projects/:id/sections',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const {
        video_file_id,
        start_sec,
        end_sec,
        type,
        label,
        notes,
        sort_order,
        simulation_url,
        simulation_id,
        sim_script,
        sim_prompt,
        sim_meta,
        track,
        global_offset_sec,
        clip_source_video_id,
        clip_in_sec,
        broll_volume,
        simple_ui,
        auto_script,
        clip_source_image_id,
        camera_movement,
        clip_source_audio_id,
      } = request.body;
      if (!video_file_id || start_sec == null || end_sec == null || !type) {
        return reply.code(400).send({ message: 'video_file_id, start_sec, end_sec, and type are required' });
      }
      if (start_sec >= end_sec) {
        return reply.code(400).send({ message: 'start_sec must be less than end_sec' });
      }

      const videoFile = await db.query.video_files.findFirst({
        where: and(eq(video_files.id, video_file_id), eq(video_files.project_id, project.id)),
      });
      if (!videoFile) return reply.code(404).send({ message: 'Video not found' });

      // Resolve simulation_url from simulation_id if provided
      let resolvedSimUrl = simulation_url ?? null;
      if (simulation_id && !resolvedSimUrl) {
        const sim = await db.query.simulations.findFirst({
          where: and(eq(simulations.id, simulation_id), eq(simulations.project_id, project.id)),
        });
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
          sort_order: sort_order ?? null,
          simulation_url: resolvedSimUrl,
          simulation_id: simulation_id ?? null,
          sim_script: sim_script ?? null,
          // sim_prompt/sim_meta carry the simulation's generation prompt + bridge plan so a
          // duplicated simulation section keeps its full config instead of losing it. (duplicate-section)
          sim_prompt: sim_prompt ?? null,
          sim_meta: sim_meta ?? null,
          track: track ?? 'main',
          global_offset_sec: global_offset_sec ?? null,
          clip_source_video_id: clip_source_video_id ?? null,
          clip_in_sec: clip_in_sec ?? 0,
          broll_volume: broll_volume == null ? 1.0 : Math.max(0, Math.min(1, broll_volume)),
          simple_ui: simple_ui ?? false,
          auto_script: auto_script ?? true,
          clip_source_image_id: clip_source_image_id ?? null,
          camera_movement: camera_movement ?? 'zoom_in',
          clip_source_audio_id: clip_source_audio_id ?? null,
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
      sim_prompt: string | null;
      sim_meta: unknown;
      global_offset_sec: number;
      clip_source_video_id: string | null;
      clip_in_sec: number;
      broll_volume: number;
      simple_ui: boolean;
      auto_script: boolean;
      clip_source_image_id?: string | null;
      camera_movement?: string;
      track?: 'main' | 'broll' | 'audio';
      clip_source_audio_id?: string | null;
    }>;
  }>(
    '/api/v1/projects/:id/sections/:sid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const existing = await db.query.timeline_sections.findFirst({
        where: and(
          eq(timeline_sections.id, request.params.sid),
          eq(timeline_sections.project_id, project.id),
        ),
      });
      if (!existing) return reply.code(404).send({ message: 'Section not found' });

      const { simulation_id, sim_script, sim_prompt, sim_meta, clip_source_video_id, clip_in_sec, broll_volume, clip_source_image_id, camera_movement, clip_source_audio_id, ...rest } = request.body;

      if (rest.start_sec != null && rest.end_sec != null && rest.start_sec >= rest.end_sec) {
        return reply.code(400).send({ message: 'start_sec must be less than end_sec' });
      }

      // When simulation_id is provided AND changed, denormalize entry_file → simulation_url.
      // If simulation_id is unchanged, leave simulation_url alone — this preserves the
      // generated bridge URL (section_id.html?v=hash) set by the SSE generation endpoint.
      // An EXPLICIT simulation_url in the same request (undo/redo restore) wins over the
      // recompute — the restore is putting back a known-good bridge URL. (sim-persistence fix)
      let resolvedSimUrl: string | null | undefined = rest.simulation_url;
      if (simulation_id !== undefined && simulation_id !== existing.simulation_id && rest.simulation_url === undefined) {
        if (simulation_id) {
          const sim = await db.query.simulations.findFirst({
            where: and(eq(simulations.id, simulation_id), eq(simulations.project_id, project.id)),
          });
          resolvedSimUrl = resolveSimEntryUrl(sim?.entry_file ?? null);
        } else {
          resolvedSimUrl = null;
        }
      }

      const patch: Record<string, unknown> = { ...rest };
      if (simulation_id !== undefined)       patch.simulation_id        = simulation_id || null;
      // A CHANGED simulation invalidates the previously generated bridge: clear the stale
      // sim_meta/sim_script so the UI stops claiming a bridge exists and the next Generate
      // can't wrongly short-circuit through canReuse. Explicit values below (undo restore)
      // still win over this clear. (sim-persistence fix)
      if (simulation_id !== undefined && (simulation_id || null) !== existing.simulation_id) {
        patch.sim_meta = null;
        patch.sim_script = null;
      }
      if (sim_script !== undefined)          patch.sim_script           = sim_script || null;
      if (sim_prompt !== undefined)          patch.sim_prompt           = sim_prompt || null;
      if (sim_meta !== undefined)            patch.sim_meta             = sim_meta ?? null;
      if (resolvedSimUrl !== undefined)      patch.simulation_url       = resolvedSimUrl;
      if (clip_source_video_id !== undefined) patch.clip_source_video_id = clip_source_video_id ?? null;
      if (clip_in_sec !== undefined)         patch.clip_in_sec          = clip_in_sec;
      if (broll_volume !== undefined)        patch.broll_volume         = Math.max(0, Math.min(1, broll_volume));
      if (clip_source_image_id !== undefined) patch.clip_source_image_id = clip_source_image_id ?? null;
      if (camera_movement !== undefined)     patch.camera_movement      = camera_movement;
      if (clip_source_audio_id !== undefined) patch.clip_source_audio_id = clip_source_audio_id ?? null;

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
      const project = await editableProject(request.params.id, user);
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

      // Reject a concurrent generation on the same section rather than racing the DB write.
      if (activeSimGenerations.has(section.id)) {
        sendEvent('error', { error: 'A generation is already running for this section. Please wait for it to finish.', errorType: 'generation_error' });
        try { reply.raw.end(); } catch { /* already closed */ }
        return;
      }
      activeSimGenerations.add(section.id);

      const keepAlive = setInterval(() => {
        try { reply.raw.write(': keep-alive\n\n'); } catch { /* socket closed */ }
      }, 15_000);

      const controller = new AbortController();
      request.raw.on('close', () => {
        controller.abort();
        clearInterval(keepAlive);
      });
      // Deadline: abort the LLM call if it stalls, and surface a timeout the client can act on.
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, SIM_GEN_TIMEOUT_MS);

      try {
        const svc = getSimService();

        // Read stored metadata safely — handle all planVersions (3, 4, 5) and missing fields
        const storedMeta = section.sim_meta as (Record<string, unknown> & {
          planVersion?: string;
          sourceHash?: string;
          prompt?: string;
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
        // Compare against the prompt that BUILT the current bridge (sim_meta.prompt). sim_prompt is
        // user-editable via a plain Save now, so it can drift from the bridge; falling back to it
        // only for legacy rows generated before meta.prompt existed. (sim-persistence fix)
        const builtPrompt = (typeof storedMeta?.prompt === 'string' ? storedMeta.prompt : undefined) ?? section.sim_prompt;
        // The stored URL must be scoped to THIS section: a duplicated section carries the SOURCE's
        // ?section=<sourceId> URL, and a sim switch leaves a raw entry URL — both must regenerate
        // their own bridge entry instead of silently reusing someone else's. (sim-persistence fix)
        const urlIsOwn = !!section.simulation_url?.includes(`section=${section.id}`);
        const canReuse =
          builtPrompt === rawPrompt &&
          urlIsOwn &&
          supportsRuntimeParams;

        const savedHistory = (storedMeta?.conversationHistory as ConversationMessage[] | undefined) ?? [];

        const patch: Record<string, unknown> = { simple_ui: simpleUi, auto_script: autoScript, sim_script: 'main' };
        let sectionUrl: string;

        if (canReuse) {
          sendEvent('status', { status: 'Toggle updated — bridge handles it at runtime.', type: 'info' });
          ({ sectionUrl } = svc.reuseBridgeScript(section.simulation_url!));
        } else {
          // Look up the simulation row to pass entryKey — used when storage listing is denied
          const simRow = await db.query.simulations.findFirst({
            where: and(eq(simulations.id, section.simulation_id), eq(simulations.project_id, project.id)),
          });
          const result = await svc.generateBridgeScript({
            simId:               section.simulation_id,
            sectionId:           section.id,
            projectId:           project.id,
            userId:              user.id,
            prompt:              rawPrompt,
            simpleUi,
            autoScript,
            entryKey:            simRow?.entry_file && !simRow.entry_file.startsWith('http') ? simRow.entry_file : undefined,
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
            // The prompt this bridge was built from — canReuse compares against THIS (not the
            // user-editable sim_prompt) so a saved-but-not-generated prompt edit still regenerates.
            prompt:             rawPrompt,
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

          // The section (or project) could have been deleted during the long generation, so
          // the update can match zero rows — emit an error rather than `done` with undefined
          // (backend-014).
          if (updated) sendEvent('done', { section: updated });
          else sendEvent('error', { error: 'This section was removed during generation.', errorType: 'generation_error' });
        }
      } catch (err) {
        if (timedOut) {
          // Our own deadline fired — the client is still connected, so tell it to stop.
          sendEvent('error', { error: 'Generation timed out. Please try again.', errorType: 'generation_error' });
        } else if (!controller.signal.aborted) {
          const errorType = classifySimulationError(err);
          sendEvent('error', {
            error:     ERROR_MESSAGES[errorType] ?? ERROR_MESSAGES.generation_error,
            errorType,
          });
        }
      } finally {
        clearTimeout(timeout);
        clearInterval(keepAlive);
        activeSimGenerations.delete(section.id);
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
      const project = await editableProject(request.params.id, user);
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

      // Same per-section serialization as the SSE path. The lock is released in
      // `finally` — a 'finish'-only listener never fires on a client disconnect
      // mid-generation ('close' is emitted instead), which left the section
      // permanently 409-locked until restart (backend-004).
      if (activeSimGenerations.has(section.id)) {
        return reply.code(409).send({ message: 'A generation is already running for this section. Please wait for it to finish.' });
      }
      activeSimGenerations.add(section.id);

      // Mirror the SSE sibling: stop the (billable) LLM generation when the
      // client goes away, and enforce the same stall deadline.
      const controller = new AbortController();
      request.raw.on('close', () => controller.abort());
      const timeout = setTimeout(() => controller.abort(), SIM_GEN_TIMEOUT_MS);

      try {
      const svc = getSimService();

      // canReuse: same prompt + bridge exists + supportsRuntimeParams (planVersion 5+)
      const storedMeta2 = section.sim_meta as (Record<string, unknown> & {
        planVersion?: string; supportsRuntimeParams?: boolean; generatedBy?: string;
        sourceHash?: string; prompt?: string; conversationHistory?: ConversationMessage[];
      }) | null;
      const supportsRuntimeParams2 =
        storedMeta2?.supportsRuntimeParams === true ||
        (storedMeta2?.generatedBy === 'llm' && storedMeta2?.planVersion === '5');
      // Mirror the SSE sibling: compare against the prompt that BUILT the bridge (meta.prompt,
      // sim_prompt fallback for legacy rows) and require the URL to be scoped to THIS section
      // (a duplicate carries the source's ?section= URL; a sim switch leaves a raw entry URL).
      const builtPrompt2 = (typeof storedMeta2?.prompt === 'string' ? storedMeta2.prompt : undefined) ?? section.sim_prompt;
      const urlIsOwn2 = !!section.simulation_url?.includes(`section=${section.id}`);
      const canReuse =
        builtPrompt2 === prompt &&
        urlIsOwn2 &&
        supportsRuntimeParams2;

      let sectionUrl: string;
      const patch: Record<string, unknown> = { simple_ui, auto_script, sim_script: 'main' };

      if (canReuse) {
        ({ sectionUrl } = svc.reuseBridgeScript(section.simulation_url!));
      } else {
        // Look up the simulation row to pass entryKey — used when storage listing is denied
        const simRow2 = await db.query.simulations.findFirst({
          where: and(eq(simulations.id, section.simulation_id), eq(simulations.project_id, project.id)),
        });
        const savedHistory2 = (storedMeta2?.conversationHistory as ConversationMessage[] | undefined) ?? [];
        const result2 = await svc.generateBridgeScript({
          simId:            section.simulation_id,
          sectionId:        section.id,
          projectId:        project.id,
          userId:           user.id,
          prompt,
          simpleUi:         simple_ui,
          autoScript:       auto_script,
          entryKey:         simRow2?.entry_file && !simRow2.entry_file.startsWith('http') ? simRow2.entry_file : undefined,
          storedSourceHash: storedMeta2?.sourceHash,
          conversationHistory: savedHistory2.length > 0 ? savedHistory2 : undefined,
          signal:           controller.signal,
        });
        sectionUrl = result2.sectionUrl;
        patch.sim_prompt = prompt;
        patch.sim_meta = {
          planVersion:        '5',
          generatedBy:        'llm',
          prompt,   // the prompt this bridge was built from — canReuse compares against this
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
      } finally {
        clearTimeout(timeout);
        activeSimGenerations.delete(section.id);
      }
    },
  );

  // DELETE /api/v1/projects/:id/sections/:sid
  app.delete<{ Params: { id: string; sid: string } }>(
    '/api/v1/projects/:id/sections/:sid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
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
