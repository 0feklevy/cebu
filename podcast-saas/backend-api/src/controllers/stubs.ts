import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const NOT_IMPLEMENTED = {
  error_type: 'not_implemented',
  message: 'This endpoint is scaffolded for Phase 2 and not yet implemented.',
  phase: 2,
};

// All Phase 2+ API namespaces are registered here as stubs.
// They return 501 so Phase 2 can replace them without schema changes.
export async function registerPhase2StubRoutes(app: FastifyInstance): Promise<void> {
  const stub = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(501).send(NOT_IMPLEMENTED);

  // Layer 6 — Avatar visual generation (Phase 2)

  // Layer 6 — Avatar visual generation
  app.post('/api/v1/projects/:id/assets/generate', stub);
  app.get('/api/v1/projects/:id/assets', stub);

  // Layer 7-9 — B-roll, composition, rendering
  app.post('/api/v1/projects/:id/render', stub);
  app.get('/api/v1/projects/:id/render/:render_id', stub);

  // Layer 10 — Per-scene regeneration
  app.post('/api/v1/projects/:id/scenes/:scene_id/regenerate', stub);

  // Layer 12 — Export
  app.post('/api/v1/projects/:id/export', stub);
  app.get('/api/v1/projects/:id/export/:format', stub);

  // Admin Phase 2+ routes
  app.get('/api/admin/v1/billing', stub);
  app.get('/api/admin/v1/renders', stub);
}
