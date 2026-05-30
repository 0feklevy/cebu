import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { projects, timeline_sections, simulations } from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { SimulationService, type BridgePlan } from '../../services/simulation/SimulationService.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';

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

      // When simulation_id is provided, denormalize entry_file → simulation_url
      let resolvedSimUrl: string | null | undefined = rest.simulation_url;
      if (simulation_id !== undefined) {
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

      const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? '';
      if (!anthropicApiKey) return reply.code(500).send({ message: 'ANTHROPIC_API_KEY not configured' });

      const svc = new SimulationService(getStorageAdapter(), anthropicApiKey);

      // Reuse stored plan when only toggles changed — skip Claude call
      const storedMeta = section.sim_meta as (Record<string, unknown> & { planVersion?: string }) | null;
      const canReuse = storedMeta?.planVersion === '3' && section.sim_prompt === prompt;

      let sectionUrl: string;
      const patch: Record<string, unknown> = { simple_ui, auto_script, sim_script: 'main' };

      if (canReuse) {
        ({ sectionUrl } = await svc.recompileBridgeScript({
          simId:       section.simulation_id,
          sectionId:   section.id,
          projectId:   project.id,
          simpleUi:    simple_ui,
          autoScript:  auto_script,
          existingPlan: storedMeta as unknown as BridgePlan,
        }));
        // sim_meta and sim_prompt unchanged — original AI plan is preserved
      } else {
        const { sectionUrl: url, plan } = await svc.generateBridgeScript({
          simId:      section.simulation_id,
          sectionId:  section.id,
          projectId:  project.id,
          prompt,
          simpleUi:   simple_ui,
          autoScript: auto_script,
        });
        sectionUrl = url;
        // Store full plan (planVersion '3') so future toggle changes can recompile without Claude
        patch.sim_prompt = prompt;
        patch.sim_meta   = { ...plan, planVersion: '3' };
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
