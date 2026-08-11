import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { timeline_sections, simulations, video_files } from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import {
  SimulationService,
  type ConversationMessage,
  type SectionPersistHook,
} from '../../services/simulation/SimulationService.js';
import {
  SIM_UI_CONTROLS_PARAM_MAX_CHARS,
  SimUiSelectionSchema,
  normalizeSimUiSelection,
  readStoredUiControls,
  simUiSelectionsEqual,
  type SimUiSelection,
} from '../../services/simulation/SimUiControls.js';
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

// Hard BACKSTOP for a single sim-script generation so a hung LLM provider can't pin an open
// SSE socket forever (backend-007). This is the pathological ceiling, NOT the expected time:
// bridge_plan runs on claude-opus-4-8 with adaptive thinking (always on) + effort:'high' at
// max_tokens 32000, streamed — one call alone realistically takes 1.5-6 min, and a generation
// can make an initial call + one validation-retry call. The old 120s guard fired mid-thought on
// legitimate generations ("Generation timed out"); 15 min leaves room for the retry path while
// still killing a truly wedged provider. A stall-aware heartbeat (runSseGeneration) keeps the
// UI honest in the meantime so the long wait never looks frozen.
const SIM_GEN_TIMEOUT_MS = 900_000;

/** Resolve a simulation's entry_file (may be a storage key or a legacy full URL) to a public URL. */
function resolveSimEntryUrl(entryFile: string | null): string | null {
  if (!entryFile) return null;
  // New rows store the storage key; old rows stored the full URL (backward compat).
  return entryFile.startsWith('http') ? entryFile : getStorageAdapter().getSimPublicUrl(entryFile);
}

// ── Simulation-generation error mapping ───────────────────────────────────────
// Module scope + exported so the SSE/HTTP error contract is unit-testable without a route.

export function classifySimulationError(err: unknown): string {
  if (err instanceof Error) {
    // A lost activation compare-and-set: a CONCURRENT publication for the same simulation was
    // activated first. Nothing was overwritten (the loser's bytes sit in an inactive revision
    // prefix), so the correct client response is a retry, not a bug report. Matched by name
    // rather than instanceof so the check cannot be defeated by a second copy of the class.
    if (err.name === 'RevisionConflict') return 'conflict';
    const msg = err.message.toLowerCase();
    if (err.name === 'AbortError' || msg.includes('generation cancelled')) return 'aborted';
    if (msg.includes('overloaded') || msg.includes('529'))                 return 'ai_overloaded';
    if (msg.includes('rate_limit') || msg.includes('429'))                 return 'limit_exceeded';
    if (msg.includes('no html entry') || msg.includes('not found'))        return 'not_found';
    if (msg.includes('non-json plan'))                                     return 'validation_error';
  }
  return 'generation_error';
}

export const ERROR_MESSAGES: Record<string, string> = {
  aborted:          'Generation was cancelled.',
  ai_overloaded:    'AI is busy right now. Please try again in a moment.',
  limit_exceeded:   'Rate limit reached. Please wait before trying again.',
  not_found:        'Simulation files not found. Please re-upload the simulation.',
  validation_error: 'AI returned an unexpected response. Please try a different prompt.',
  conflict:         'A concurrent generation for this simulation completed first — nothing was overwritten. Please retry.',
  generation_error: 'Generation failed. Please try again or simplify your prompt.',
};

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

  // The generate request body (shared by the POST stream route, the POST non-stream route,
  // and — parsed from the query string — the legacy GET stream route). `prompt` is OPTIONAL:
  // an empty prompt WITH a ui_controls selection is the zero-LLM "minimize UI only" path
  // (owner direction 2026-07-30 — "generate without prompt ⇒ only minimize the ui").
  const GenerateSimScriptSchema = z
    .object({
      prompt:      z.string().max(1000).optional(),
      simple_ui:   z.boolean(),
      auto_script: z.boolean(),
      ui_controls: SimUiSelectionSchema.optional(),
    })
    .refine(d => (d.prompt?.trim().length ?? 0) > 0 || !!d.ui_controls, {
      message: 'Provide a prompt, or select UI controls to minimize.',
    });
  type GenerateSimScriptInput = z.infer<typeof GenerateSimScriptSchema>;
  type SectionRow = typeof timeline_sections.$inferSelect;

  /** Readable first-issue message from a Zod error, prefixed with the field path. */
  const firstZodMessage = (e: z.ZodError): string => {
    const i = e.issues[0];
    return i ? `${i.path.join('.') || 'request'}: ${i.message}` : 'Invalid request';
  };

  /**
   * The ONE place sim-script generation decides what to do and persists the result — shared
   * by every route (GET/POST stream + non-stream POST) so the canReuse / mechanical / LLM
   * decision, the planVersion-'7' sim_meta shape, and the DB write never drift between them.
   *
   * Three outcomes:
   *   • mechanical  — empty prompt + a selection ⇒ NO LLM: apply the Minimal-UI hide only.
   *   • reuse       — same prompt + own bridge + runtime-param bridge ⇒ no regeneration.
   *   • regenerate  — call the LLM (with the lean Minimal-UI contract block).
   */
  async function generateOrReuseSection(opts: {
    section:    SectionRow;
    project:    { id: string };
    user:       { id: string };
    input:      GenerateSimScriptInput;
    signal:     AbortSignal;
    onEvent?:   (event: string, data: object) => void;
  }): Promise<SectionRow> {
    const { section, project, user, input, signal, onEvent } = opts;
    const svc = getSimService();
    const rawPrompt = (input.prompt ?? '').trim();
    const simpleUi = input.simple_ui;
    const autoScript = input.auto_script;
    const uiControls: SimUiSelection | undefined =
      input.ui_controls ? normalizeSimUiSelection(input.ui_controls) : undefined;

    const storedMeta = section.sim_meta as (Record<string, unknown> & {
      planVersion?: string; sourceHash?: string; prompt?: string;
      supportsRuntimeParams?: boolean; generatedBy?: string;
      conversationHistory?: ConversationMessage[];
    }) | null;

    const patch: Record<string, unknown> = { simple_ui: simpleUi, auto_script: autoScript, sim_script: 'main' };

    // The section-row update runs INSIDE the revision-activation transaction, via the service's
    // persistSection hook (audit P0.4): the pointer flip and the section row commit or roll back
    // TOGETHER, so a client abort or crash can never leave a published revision the section does
    // not reference, or vice versa. Every patch field — not only simulation_url/sim_meta — goes
    // through this single in-transaction write. The hook throwing (section deleted mid-generation)
    // rolls the whole activation back.
    let updated: SectionRow | undefined;
    const persistPatch = async (
      tx: Parameters<SectionPersistHook>[0],
      finalPatch: Record<string, unknown>,
    ): Promise<void> => {
      const [row] = await tx
        .update(timeline_sections)
        .set(finalPatch)
        .where(eq(timeline_sections.id, section.id))
        .returning();
      if (!row) throw new Error('This section was removed during generation.');
      updated = row as SectionRow;
    };

    if (rawPrompt === '') {
      // ── Mechanical Minimal-UI path — zero LLM ────────────────────────────────
      // No prompt means "just minimize the UI as chosen": the hide is applied entirely at
      // runtime via params.hideSelectors; any existing demonstration body is preserved.
      const simRow = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, section.simulation_id!), eq(simulations.project_id, project.id)),
      });
      await svc.applyMinimalUiOnly({
        simId:     section.simulation_id!,
        sectionId: section.id,
        projectId: project.id,
        entryKey:  simRow?.entry_file && !simRow.entry_file.startsWith('http') ? simRow.entry_file : undefined,
        onEvent,
        signal,
        persistSection: async (tx, pub) => {
          // Preserve provenance: the bridge BODY is unchanged (uploadSectionBridge kept any existing
          // demo), so an LLM-authored section stays labeled 'llm' and keeps its prompt + provider/
          // model/confidence/etc. — only the UI selection changed. We do NOT null sim_prompt, and we
          // keep sim_meta.prompt so a later identical-prompt Generate can still canReuse. A section
          // with no prior bridge (fresh) has no provenance to keep ⇒ generatedBy:'mechanical'.
          await persistPatch(tx, {
            ...patch,
            sim_meta: {
              ...(storedMeta ?? {}),
              planVersion:           '7',
              generatedBy:           storedMeta?.generatedBy ?? 'mechanical',
              uiControls,
              bridgeHash:            pub.bridgeHash,
              generatedAt:           new Date().toISOString(),
              supportsRuntimeParams: true,
            },
            simulation_url: pub.sectionUrl,
          });
        },
      });
    } else {
      // ── canReuse: prompt unchanged + own bridge + runtime-param bridge + same selection ──
      const supportsRuntimeParams =
        storedMeta?.supportsRuntimeParams === true ||
        (storedMeta?.generatedBy === 'llm' && storedMeta?.planVersion === '5');
      const builtPrompt = (typeof storedMeta?.prompt === 'string' ? storedMeta.prompt : undefined) ?? section.sim_prompt;
      const urlIsOwn = !!section.simulation_url?.includes(`section=${section.id}`);
      const uiSelectionUnchanged = simUiSelectionsEqual(readStoredUiControls(storedMeta?.uiControls), uiControls);
      const canReuse = builtPrompt === rawPrompt && urlIsOwn && supportsRuntimeParams && uiSelectionUnchanged;

      if (canReuse) {
        onEvent?.('status', { status: 'Toggle updated — bridge handles it at runtime.', type: 'info' });
        const { sectionUrl } = svc.reuseBridgeScript(section.simulation_url!);
        // No publication happened — no revision, no activation transaction to join. The bare
        // toggle write keeps its own abort check, exactly as before.
        patch.simulation_url = sectionUrl;
        if (signal.aborted) throw new Error('generation cancelled');
        const [row] = await db
          .update(timeline_sections)
          .set(patch)
          .where(eq(timeline_sections.id, section.id))
          .returning();
        if (!row) throw new Error('This section was removed during generation.');
        return row;
      }

      const simRow = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, section.simulation_id!), eq(simulations.project_id, project.id)),
      });
      const savedHistory = (storedMeta?.conversationHistory as ConversationMessage[] | undefined) ?? [];
      await svc.generateBridgeScript({
        simId:               section.simulation_id!,
        sectionId:           section.id,
        projectId:           project.id,
        userId:              user.id,
        prompt:              rawPrompt,
        simpleUi,
        autoScript,
        uiControls,
        entryKey:            simRow?.entry_file && !simRow.entry_file.startsWith('http') ? simRow.entry_file : undefined,
        storedSourceHash:    storedMeta?.sourceHash,
        conversationHistory: savedHistory.length > 0 ? savedHistory : undefined,
        onEvent,
        signal,
        persistSection: async (tx, result) => {
          await persistPatch(tx, {
            ...patch,
            sim_prompt: rawPrompt,
            sim_meta: {
              planVersion:        '7',
              generatedBy:        'llm',
              prompt:             rawPrompt,
              uiControls,
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
              runtimeValidated:   false,
              conversationHistory: result.conversationHistory,
            },
            simulation_url: result.sectionUrl,
          });
        },
      });
    }

    // The service resolving means activation committed, which means the hook ran exactly once.
    // Guarded loudly so a service change that stops invoking the hook cannot silently return a
    // stale row. After this point an abort is ignored — the publication is already live.
    if (!updated) throw new Error('Generation completed but the section update never ran.');
    return updated;
  }

  /**
   * SSE transport wrapper shared by the GET (legacy) and POST stream routes: manifest of
   * headers, the per-section concurrency lock, the keep-alive, a stall-aware progress
   * heartbeat, the abort/deadline plumbing, and done/error framing. The route only parses
   * + validates its input (before any bytes are written) and hands it here.
   */
  async function runSseGeneration(
    request: import('fastify').FastifyRequest,
    reply: FastifyReply,
    ctx: { section: SectionRow; project: { id: string }; user: { id: string }; input: GenerateSimScriptInput },
  ): Promise<void> {
    const origin = request.headers.origin;
    reply.raw.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');

    let lastActivityMs = Date.now();
    const sendEvent = (event: string, data: object) => {
      if (event === 'status' || event === 'token') lastActivityMs = Date.now();
      try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* socket closed */ }
    };

    sendEvent('connected', {});

    if (activeSimGenerations.has(ctx.section.id)) {
      sendEvent('error', { error: 'A generation is already running for this section. Please wait for it to finish.', errorType: 'generation_error' });
      try { reply.raw.end(); } catch { /* already closed */ }
      return;
    }
    activeSimGenerations.add(ctx.section.id);

    const startMs = Date.now();
    // Keep-alive + a stall-aware progress heartbeat: adaptive-thinking models (Opus 4.8)
    // stream NO text during the (long) thinking phase, so the visible status would otherwise
    // freeze for minutes and read as "hung". When the stream has been quiet for >12s we emit
    // an elapsed-time status so the user can see it is still working (backend-007 follow-up).
    const keepAlive = setInterval(() => {
      try { reply.raw.write(': keep-alive\n\n'); } catch { /* socket closed */ }
      if (Date.now() - lastActivityMs > 12_000) {
        sendEvent('status', { status: `Still generating… (${Math.round((Date.now() - startMs) / 1000)}s)`, type: 'progress' });
      }
    }, 15_000);

    const controller = new AbortController();
    request.raw.on('close', () => { controller.abort(); clearInterval(keepAlive); });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, SIM_GEN_TIMEOUT_MS);

    try {
      const updated = await generateOrReuseSection({ ...ctx, signal: controller.signal, onEvent: sendEvent });
      if (!controller.signal.aborted) sendEvent('done', { section: updated });
    } catch (err) {
      if (timedOut) {
        sendEvent('error', { error: 'Generation timed out. Please try again.', errorType: 'generation_error' });
      } else if (!controller.signal.aborted) {
        const errorType = classifySimulationError(err);
        sendEvent('error', { error: ERROR_MESSAGES[errorType] ?? ERROR_MESSAGES.generation_error, errorType });
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(keepAlive);
      activeSimGenerations.delete(ctx.section.id);
      try { reply.raw.end(); } catch { /* already closed */ }
    }
  }

  // GET /api/v1/projects/:id/sections/:sid/generate-sim-script/stream
  // SSE streaming endpoint — auth via ?token= query param (EventSource limitation)
  app.get<{
    Params:      { id: string; sid: string };
    Querystring: { prompt?: string; simple_ui?: string; auto_script?: string; ui_controls?: string };
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

      // Legacy transport: EventSource can't POST, so prompt/toggles/ui_controls ride the
      // query string (auth via ?token=). New clients use the POST stream route below, which
      // carries the selection in the request BODY with no URL-size cap (the v0.1.x "Too many
      // UI controls" 400 was purely this query-length ceiling). Kept so an old editor tab that
      // is still open across a deploy keeps working.
      let legacyUiControls: unknown;
      const rawUiControls = request.query.ui_controls;
      if (typeof rawUiControls === 'string' && rawUiControls.length > 0) {
        if (rawUiControls.length > SIM_UI_CONTROLS_PARAM_MAX_CHARS) {
          return reply.code(400).send({ message: `ui_controls is too large for the legacy URL transport (max ${SIM_UI_CONTROLS_PARAM_MAX_CHARS} chars) — reload the editor to use the POST route.` });
        }
        try { legacyUiControls = JSON.parse(rawUiControls); }
        catch { return reply.code(400).send({ message: 'ui_controls must be valid JSON' }); }
      }
      const parsed = GenerateSimScriptSchema.safeParse({
        prompt:      request.query.prompt,
        simple_ui:   request.query.simple_ui === 'true',
        auto_script: request.query.auto_script !== 'false',
        ui_controls: legacyUiControls,
      });
      if (!parsed.success) {
        return reply.code(400).send({ message: firstZodMessage(parsed.error) });
      }

      await runSseGeneration(request, reply, { section, project, user, input: parsed.data });
    },
  );

  // POST /api/v1/projects/:id/sections/:sid/generate-sim-script/stream
  // Same SSE stream as the GET route, but the request BODY carries prompt + toggles + the
  // (uncapped) Minimal-UI selection, and auth uses the Authorization header. This is the
  // route the editor uses now: no URL-length limit on ui_controls, real HTTP status codes on
  // validation failure (EventSource could only surface those as a generic "connection lost").
  app.post<{ Params: { id: string; sid: string } }>(
    '/api/v1/projects/:id/sections/:sid/generate-sim-script/stream',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const section = await db.query.timeline_sections.findFirst({
        where: and(eq(timeline_sections.id, request.params.sid), eq(timeline_sections.project_id, project.id)),
      });
      if (!section) return reply.code(404).send({ message: 'Section not found' });
      if (section.type !== 'simulation') return reply.code(400).send({ message: 'Section is not a simulation section' });
      if (!section.simulation_id)        return reply.code(400).send({ message: 'Section has no simulation selected' });

      // Validate BEFORE hijacking the socket so a bad request is a clean HTTP 400/409.
      const parsed = GenerateSimScriptSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: firstZodMessage(parsed.error) });
      }

      await runSseGeneration(request, reply, { section, project, user, input: parsed.data });
    },
  );

  // POST /api/v1/projects/:id/sections/:sid/generate-sim-script
  // Non-stream sibling (used by tests / non-SSE callers). Same decision + persistence as the
  // stream routes via generateOrReuseSection — it just returns the section JSON instead of
  // an SSE `done` frame.
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
      if (!body.success) return reply.code(400).send({ message: firstZodMessage(body.error) });

      // Same per-section serialization as the SSE path. The lock is released in `finally` — a
      // 'finish'-only listener never fires on a client disconnect mid-generation ('close' is
      // emitted instead), which left the section permanently 409-locked until restart (backend-004).
      if (activeSimGenerations.has(section.id)) {
        return reply.code(409).send({ message: 'A generation is already running for this section. Please wait for it to finish.' });
      }
      activeSimGenerations.add(section.id);

      const controller = new AbortController();
      request.raw.on('close', () => controller.abort());
      const timeout = setTimeout(() => controller.abort(), SIM_GEN_TIMEOUT_MS);

      try {
        const updated = await generateOrReuseSection({
          section, project, user, input: body.data, signal: controller.signal,
        });
        return reply.send(updated);
      } catch (err) {
        const errorType = classifySimulationError(err);
        // 409 for a lost activation CAS: a concurrent publication won, nothing was overwritten,
        // and the client should simply retry. Reporting it as 500 was accurate about neither the
        // cause nor the remedy — and it pages, because a 5xx rate is what alerting watches.
        const status = errorType === 'not_found' ? 404
          : errorType === 'aborted'  ? 499
          : errorType === 'conflict' ? 409
          : 500;
        return reply.code(status).send({ message: ERROR_MESSAGES[errorType] ?? ERROR_MESSAGES.generation_error, errorType });
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
