/**
 * "Save bridge" / "load bridge" — the HTTP surface (migration 079).
 *
 * Four routes, and a deliberate asymmetry in what they do:
 *
 *   save / list / delete / fit  — plain CRUD plus a read-only judgement.
 *   apply                       — the ARTIFACT path only. It re-runs the judgement itself and
 *                                 answers 409 with the verdict when the paste is not proven safe,
 *                                 and the CLIENT then falls back to the existing generate endpoint
 *                                 carrying the preset's recipe. The recipe path deliberately has
 *                                 no server-side route of its own: generation already exists, is
 *                                 already streamed, already validated — a second door into it
 *                                 would be a second place for its rules to drift.
 *
 * Ownership model: presets are USER-owned (crossing projects is their purpose), so list/delete
 * check only identity. Save and apply also require the PROJECT to be editable — they read from or
 * write into a project's section, and visibility of a preset must never imply writability of a
 * project (same separation importEligibility.ts enforces for media imports).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { timeline_sections, simulations } from '../../db/schema.js';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { SavedBridgeService } from '../../services/simulation/SavedBridgeService.js';
import { SimulationService } from '../../services/simulation/SimulationService.js';
import { SimulationImportService } from '../../services/simulation/SimulationImportService.js';
import { describeSetupTarget, resolveSetupTarget, type SetupTarget } from '../../services/simulation/portableSetup.js';
import { LLMService } from '../../services/llm/LLMService.js';
import { ApiKeyService } from '../../services/secrets/ApiKeyService.js';
import { UsageTrackingService } from '../../services/usage/UsageTrackingService.js';
import { logger } from '../../lib/logger.js';

const SaveBody = z.object({ label: z.string().trim().min(1).max(120) });

let _svc: SavedBridgeService | undefined;
const svc = () => (_svc ??= new SavedBridgeService(getStorageAdapter()));
let _sim: SimulationService | undefined;
// Same wiring as sections.controller: the apply republishes a package, which needs the full
// service — storage AND the LLM stack (unused on this path, required by the constructor).
const sim = () => (_sim ??= new SimulationService(getStorageAdapter(), new LLMService(new ApiKeyService(), new UsageTrackingService())));

export async function registerBridgePresetRoutes(app: FastifyInstance): Promise<void> {
  // ── The user's presets ──────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/bridge-presets',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const presets = await svc().listForUser(request.dbUser!.id);
      return reply.send({ presets });
    },
  );

  app.delete<{ Params: { presetId: string } }>(
    '/api/v1/bridge-presets/:presetId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const gone = await svc().deleteForUser(request.dbUser!.id, request.params.presetId);
      // 404 either way when it is not the caller's: a preset id must not be probeable.
      return gone ? reply.send({ ok: true }) : reply.code(404).send({ message: 'Preset not found' });
    },
  );

  // ── Save: snapshot THIS section's bridge setup under a label ───────────────────────────────
  app.post<{ Params: { id: string; sectionId: string } }>(
    '/api/v1/projects/:id/sections/:sectionId/bridge-presets',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const parsed = SaveBody.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ message: 'A label between 1 and 120 characters is required' });

      try {
        const preset = await svc().saveFromSection({
          userId: user.id,
          projectId: project.id,
          sectionId: request.params.sectionId,
          label: parsed.data.label,
        });
        return reply.code(201).send({ preset });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        if (status >= 500) {
          logger.error({ evt: 'bridge_preset_save_failed', err: (e as Error).name }, '[BridgePreset] save failed');
          return reply.code(500).send({ message: 'Could not save this bridge' });
        }
        return reply.code(status).send({ message: (e as Error).message });
      }
    },
  );

  /**
   * Where this setup would land on this section — the same question for /fit and /apply, so the
   * sentence the dialog shows and the decision the apply takes cannot come apart.
   */
  async function setupTarget(
    userId: string,
    presetId: string,
    projectId: string,
    sectionSimulationId: string | null,
    bring: boolean,
  ): Promise<{ target: SetupTarget; sourceName: string | null } | null> {
    const preset = await svc().presetForApply(userId, presetId);
    if (!preset) return null;
    const sourceId = preset.source_simulation_id;
    const source = sourceId
      ? await db.query.simulations.findFirst({ where: eq(simulations.id, sourceId), columns: { id: true, name: true, project_id: true } })
      : null;
    const existingImport = sourceId && !sectionSimulationId
      ? await db.query.simulations.findFirst({
          where: and(eq(simulations.project_id, projectId), eq(simulations.imported_from_simulation_id, sourceId)),
          columns: { id: true },
        })
      : null;
    const target = resolveSetupTarget(
      { sourceSimulationId: sourceId, sourceSimulationName: source?.name ?? null, sourceExists: !!source },
      {
        sectionSimulationId,
        sourceIsInThisProject: !!source && source.project_id === projectId,
        existingImportId: existingImport?.id ?? null,
      },
      bring,
    );
    return { target, sourceName: source?.name ?? null };
  }

  // ── Fit: which path WOULD a load take. Read-only — the Load button's tooltip ───────────────
  app.get<{ Params: { id: string; sectionId: string; presetId: string } }>(
    '/api/v1/projects/:id/sections/:sectionId/bridge-presets/:presetId/fit',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const section = await db.query.timeline_sections.findFirst({
        where: and(eq(timeline_sections.id, request.params.sectionId), eq(timeline_sections.project_id, project.id)),
      });
      if (!section) return reply.code(404).send({ message: 'Section not found' });

      // A section with NO simulation used to be a 400 here, which made the Load button dead on a
      // fresh section — the one case a saved setup is most wanted in (owner ruling 2026-09-03).
      // It is answered now: where the setup would land, and whether its package can come along.
      const resolved = await setupTarget(user.id, request.params.presetId, project.id, section.simulation_id ?? null, true);
      if (!resolved) return reply.code(404).send({ message: 'Preset not found' });
      const bring = {
        needed: resolved.target.use !== 'section',
        possible: resolved.target.use !== 'refuse',
        source_name: resolved.sourceName,
        description: describeSetupTarget(resolved.target, resolved.sourceName),
      };

      if (!section.simulation_id) {
        // Nothing to verify a script against yet; the load will bring the package and then judge.
        return reply.send({ path: 'recipe', description: bring.description, verdict: { path: 'recipe', why: 'no-target-simulation', missing: [] }, bring });
      }

      const fit = await svc().judgeFit({
        userId: user.id,
        presetId: request.params.presetId,
        simulationId: section.simulation_id,
      });
      if (!fit) return reply.code(404).send({ message: 'Preset not found' });
      return reply.send({ path: fit.verdict.path, description: fit.description, verdict: fit.verdict, bring });
    },
  );

  // ── Apply: the ARTIFACT path, and only when re-verification proves it ──────────────────────
  app.post<{ Params: { id: string; sectionId: string; presetId: string }; Body: { bring_simulation?: boolean } }>(
    '/api/v1/projects/:id/sections/:sectionId/bridge-presets/:presetId/apply',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const section = await db.query.timeline_sections.findFirst({
        where: and(eq(timeline_sections.id, request.params.sectionId), eq(timeline_sections.project_id, project.id)),
      });
      if (!section) return reply.code(404).send({ message: 'Section not found' });

      // ── The setup brings its simulation (owner ruling 2026-09-03) ────────────────────────────
      // A fresh section in another project has nothing to load onto. With `bring_simulation`, the
      // setup's own package comes with it: already here → attach it; already imported once →
      // attach that copy (migration 084 remembers which); otherwise import it, which copies rows
      // and no bytes (the blob store dedups). A section that ALREADY has a simulation is never
      // swapped — the creator is looking at it.
      let targetSimulationId = section.simulation_id ?? null;
      let brought: { simulation: typeof simulations.$inferSelect; imported: boolean } | null = null;
      if (!targetSimulationId) {
        const bring = request.body?.bring_simulation === true;
        const resolved = await setupTarget(user.id, request.params.presetId, project.id, null, bring);
        if (!resolved) return reply.code(404).send({ message: 'Preset not found' });
        const t = resolved.target;
        if (t.use === 'refuse') return reply.code(400).send({ message: t.reason });

        if (t.use === 'import') {
          const importer = new SimulationImportService(getStorageAdapter());
          const result = await importer.importSimulation({
            destProjectId: project.id,
            sourceSimulationId: t.sourceSimulationId,
            who: { uid: user.id, shareToken: null },
            user,
          });
          if (!result.ok) return reply.code(result.status).send({ message: result.message });
          targetSimulationId = result.simulation.id;
          brought = { simulation: result.simulation, imported: true };
        } else {
          targetSimulationId = t.simulationId;
          const row = await db.query.simulations.findFirst({ where: eq(simulations.id, targetSimulationId) });
          brought = row ? { simulation: row, imported: false } : null;
        }

        // Attach it before the paste: everything below reads the section's simulation.
        await db.update(timeline_sections)
          .set({ simulation_id: targetSimulationId })
          .where(eq(timeline_sections.id, section.id));
      }

      // Judged HERE, not trusted from the client's earlier /fit call: a replace can activate a new
      // revision between the two requests, and a stale yes pasted anyway is the silently-dead
      // section this whole feature is built to prevent.
      const fit = await svc().judgeFit({
        userId: user.id,
        presetId: request.params.presetId,
        simulationId: targetSimulationId,
      });
      if (!fit) return reply.code(404).send({ message: 'Preset not found' });
      if (fit.verdict.path !== 'artifact') {
        // Not an error — an instruction. The client falls back to the generate endpoint with the
        // preset's recipe (returned by /bridge-presets), which still skips the authoring work.
        // `brought` travels with the refusal: the package IS in the project now and attached to
        // the section, and the client has to know that before it regenerates against it.
        return reply.code(409).send({ path: fit.verdict.path, description: fit.description, verdict: fit.verdict, brought });
      }

      const simRow = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, targetSimulationId), eq(simulations.project_id, project.id)),
      });
      if (!simRow) return reply.code(404).send({ message: 'Simulation not found in this project' });

      // The preset row, re-read for its full fields (judgeFit returned the public shape).
      const full = await svc().presetForApply(user.id, request.params.presetId);
      if (!full?.main_body) return reply.code(409).send({ message: 'Preset has no saved script' });

      let updated: Record<string, unknown> | undefined;
      const { sectionUrl, bridgeHash } = await sim().applySavedBridgeBody({
        simId: simRow.id,
        sectionId: section.id,
        projectId: project.id,
        body: full.main_body,
        entryKey: simRow.entry_file && !simRow.entry_file.startsWith('http') ? simRow.entry_file : undefined,
        persistSection: async (tx, result) => {
          const [row] = await tx
            .update(timeline_sections)
            .set({
              simple_ui: full.simple_ui,
              auto_script: full.auto_script,
              sim_prompt: full.sim_prompt,
              sim_script: 'main',
              sim_meta: {
                planVersion: '7',
                generatedBy: 'preset',
                presetId: full.id,
                presetLabel: full.label,
                prompt: full.sim_prompt ?? undefined,
                uiControls: full.ui_controls ?? undefined,
                sourceHash: full.source_hash ?? undefined,
                bridgeHash: result.bridgeHash,
                generatedAt: new Date().toISOString(),
                supportsRuntimeParams: true,
                // runtimeValidated removed in lockstep with sections.controller (sim-review P2).
                conversationHistory: full.conversation_history ?? undefined,
              },
              simulation_url: result.sectionUrl,
            })
            .where(eq(timeline_sections.id, section.id))
            .returning();
          if (!row) throw new Error('This section was removed during the load.');
          updated = row as Record<string, unknown>;
        },
      });

      logger.info({ evt: 'bridge_preset_applied', presetId: full.id, sectionId: section.id, bridgeHash },
        '[BridgePreset] artifact applied');
      // `brought` tells the client a simulation arrived with the setup, so its list and its
      // preview pick it up without a reload.
      return reply.send({ section: updated, sectionUrl, path: 'artifact', brought });
    },
  );
}
