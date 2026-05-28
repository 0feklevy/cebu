import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { scripts, projects } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { ScriptValidator } from '../../services/script/ScriptValidator.js';
import { DialogueTurnSchema, ScriptSchema } from 'shared';
import { ApiKeyService } from '../../services/secrets/ApiKeyService.js';
import { UsageTrackingService } from '../../services/usage/UsageTrackingService.js';
import { LLMService } from '../../services/llm/LLMService.js';
import { system_prompts, hosts } from '../../db/schema.js';

const validator = new ScriptValidator();

export async function registerScriptRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/projects/:id/script/generate — triggers pipeline via SSE
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/script/generate',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const jobId = `${project.id}-script-${Date.now()}`;
      // The actual pipeline runs via the SSE stream endpoint.
      // Return the job_id so the client can track it.
      return reply.code(202).send({ job_id: jobId });
    },
  );

  // GET /api/v1/projects/:id/script
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/script',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const script = await db.query.scripts.findFirst({
        where: eq(scripts.project_id, project.id),
        orderBy: [desc(scripts.version)],
      });
      if (!script) return reply.code(404).send({ message: 'No script yet' });

      return reply.send(script);
    },
  );

  // GET /api/v1/projects/:id/script/:version
  app.get<{ Params: { id: string; version: string } }>(
    '/api/v1/projects/:id/script/:version',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const script = await db.query.scripts.findFirst({
        where: and(
          eq(scripts.project_id, project.id),
          eq(scripts.version, parseInt(request.params.version, 10)),
        ),
      });
      if (!script) return reply.code(404).send({ message: 'Script version not found' });

      return reply.send(script);
    },
  );

  // PATCH /api/v1/projects/:id/script/:version/turns/:turn_index
  app.patch<{ Params: { id: string; version: string; turn_index: string } }>(
    '/api/v1/projects/:id/script/:version/turns/:turn_index',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sourceScript = await db.query.scripts.findFirst({
        where: and(
          eq(scripts.project_id, project.id),
          eq(scripts.version, parseInt(request.params.version, 10)),
        ),
      });
      if (!sourceScript) return reply.code(404).send({ message: 'Script not found' });
      if (!sourceScript.body_json) return reply.code(400).send({ message: 'Script has no body' });

      const turnIndex = parseInt(request.params.turn_index, 10);
      const patch = DialogueTurnSchema.partial().safeParse(request.body);
      if (!patch.success) return reply.code(400).send({ message: patch.error.message });

      const bodyJson = sourceScript.body_json as { turns: unknown[] };
      if (!Array.isArray(bodyJson.turns) || turnIndex >= bodyJson.turns.length) {
        return reply.code(400).send({ message: 'Turn index out of range' });
      }

      // Merge patch into turn
      bodyJson.turns[turnIndex] = {
        ...(bodyJson.turns[turnIndex] as object),
        ...patch.data,
      };

      // Validate new body
      const validation = validator.validate(bodyJson);
      if (!validation.valid) {
        return reply.code(422).send({
          error_type: 'parsing_error',
          message: 'Edit produced invalid script',
          errors: validation.errors,
        });
      }

      // Update in-place — editor ops don't bump version, only the pipeline does
      await db
        .update(scripts)
        .set({ body_json: bodyJson as unknown as Record<string, unknown> })
        .where(eq(scripts.id, sourceScript.id));

      return reply.send({ new_version: sourceScript.version });
    },
  );

  // POST /api/v1/projects/:id/script/:version/turns/:turn_index/regenerate
  app.post<{ Params: { id: string; version: string; turn_index: string }; Body: { hint?: string } }>(
    '/api/v1/projects/:id/script/:version/turns/:turn_index/regenerate',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sourceScript = await db.query.scripts.findFirst({
        where: and(
          eq(scripts.project_id, project.id),
          eq(scripts.version, parseInt(request.params.version, 10)),
        ),
      });
      if (!sourceScript?.body_json) return reply.code(404).send({ message: 'Script not found' });

      const turnIndex = parseInt(request.params.turn_index, 10);
      const bodyJson = sourceScript.body_json as { turns: unknown[] };
      if (!Array.isArray(bodyJson.turns) || turnIndex >= bodyJson.turns.length) {
        return reply.code(400).send({ message: 'Turn index out of range' });
      }

      const turn = bodyJson.turns[turnIndex] as { speaker: string; text: string; emotion: string };
      const hint = (request.body as { hint?: string }).hint;

      // Single-turn LLM regeneration
      const apiKeyService = new ApiKeyService();
      const usageTracking = new UsageTrackingService();
      const llm = new LLMService(apiKeyService, usageTracking);

      const hostA = project.host_a_id
        ? await db.query.hosts.findFirst({ where: eq(hosts.id, project.host_a_id) })
        : null;
      const hostB = project.host_b_id
        ? await db.query.hosts.findFirst({ where: eq(hosts.id, project.host_b_id) })
        : null;

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 60_000);

      try {
        const result = await llm.sendStructured({
          task: 'single_turn_regen',
          systemPrompt: `You are rewriting a single podcast dialogue turn.
Host A: ${hostA?.name ?? 'Host A'} (${hostA?.role ?? 'Expert'})
Host B: ${hostB?.name ?? 'Host B'} (${hostB?.role ?? 'Curious learner'})
Keep the same speaker (${turn.speaker}), same topic, same JSON schema.
Output ONLY the JSON turn object.`,
          userPrompt: `Current turn:
${JSON.stringify(turn, null, 2)}
${hint ? `\nUser hint: ${hint}` : ''}

Rewrite this turn to be more engaging. Output only the JSON object.`,
          schema: DialogueTurnSchema,
          userId: user.id,
          projectId: project.id,
          abortSignal: abortController.signal,
        });

        // Apply the new turn and update in-place
        bodyJson.turns[turnIndex] = result.data;

        await db
          .update(scripts)
          .set({ body_json: bodyJson as unknown as Record<string, unknown> })
          .where(eq(scripts.id, sourceScript.id));

        return reply.send({ new_version: sourceScript.version, turn: result.data });
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  // POST /api/v1/projects/:id/script/:version/approve
  app.post<{ Params: { id: string; version: string } }>(
    '/api/v1/projects/:id/script/:version/approve',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const script = await db.query.scripts.findFirst({
        where: and(
          eq(scripts.project_id, project.id),
          eq(scripts.version, parseInt(request.params.version, 10)),
        ),
      });
      if (!script) return reply.code(404).send({ message: 'Script not found' });
      if (script.status !== 'ready') {
        return reply.code(400).send({ message: `Script is not ready (status: ${script.status})` });
      }

      const approvedAt = new Date();
      await db.update(scripts).set({ status: 'approved', approved_at: approvedAt }).where(eq(scripts.id, script.id));
      await db.update(projects).set({ status: 'approved' }).where(eq(projects.id, project.id));

      return reply.send({ approved_at: approvedAt.toISOString() });
    },
  );

  // PUT /api/v1/projects/:id/script/:version/turns — replace full turns array (split/merge/swap)
  app.put<{ Params: { id: string; version: string } }>(
    '/api/v1/projects/:id/script/:version/turns',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sourceScript = await db.query.scripts.findFirst({
        where: and(
          eq(scripts.project_id, project.id),
          eq(scripts.version, parseInt(request.params.version, 10)),
        ),
      });
      if (!sourceScript?.body_json) return reply.code(404).send({ message: 'Script not found' });

      const body = z.object({ turns: z.array(z.unknown()) }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const newBodyJson = { ...(sourceScript.body_json as object), turns: body.data.turns };
      const validation = validator.validate(newBodyJson);
      if (!validation.valid) {
        return reply.code(422).send({ error_type: 'parsing_error', message: 'Invalid turns', errors: validation.errors });
      }

      await db
        .update(scripts)
        .set({ body_json: newBodyJson as unknown as Record<string, unknown> })
        .where(eq(scripts.id, sourceScript.id));

      return reply.send({ new_version: sourceScript.version });
    },
  );

  // List all versions
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/script/versions',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const versions = await db.query.scripts.findMany({
        where: eq(scripts.project_id, project.id),
        orderBy: [desc(scripts.version)],
        columns: { body_json: false, draft_body_json: false },
      });
      return reply.send(versions);
    },
  );
}
