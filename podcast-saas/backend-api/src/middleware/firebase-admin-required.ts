import type { FastifyRequest, FastifyReply } from 'fastify';
import { firebaseAuthMiddleware } from './firebase-auth.js';

export async function firebaseAdminRequired(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await firebaseAuthMiddleware(request, reply);
  if (reply.sent) return;

  if (!request.dbUser?.is_admin) {
    return reply.code(403).send({ error_type: 'connection_error', message: 'Admin access required' });
  }
}
