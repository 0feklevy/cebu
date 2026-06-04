import type { FastifyInstance, FastifyReply } from 'fastify';
import { buildPlayerConfig } from '../../services/buildPlayerConfig.js';

// Public (no auth) endpoint — returns player config for a project's viewer page.
// This is the dynamic equivalent of interactive-podcast-react's constants/index.ts.

export async function registerPlayerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/player-config',
    async (request, reply: FastifyReply) => {
      const config = await buildPlayerConfig(request.params.id);
      if (!config) return reply.code(404).send({ message: 'Project not found' });
      return reply.send(config);
    },
  );
}
