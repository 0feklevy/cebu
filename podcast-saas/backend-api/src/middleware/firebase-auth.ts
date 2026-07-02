import type { FastifyRequest, FastifyReply } from 'fastify';
import { getFirebaseAdmin } from '../services/firebase.js';
import { db } from '../db/index.js';
import { users, orgs, collaborators } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import type { DecodedIdToken } from 'firebase-admin/auth';

// Emails listed in ADMIN_EMAILS (comma-separated) are auto-granted admin on every login.
function isAdminEmail(email: string | undefined): boolean {
  if (!email) return false;
  const list = (process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase());
  return list.includes(email.toLowerCase());
}

declare module 'fastify' {
  interface FastifyRequest {
    firebaseUser?: DecodedIdToken;
    dbUser?: typeof users.$inferSelect;
  }
}

export async function firebaseAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  // Also check query param for SSE streams (EventSource limitation)
  const tokenQuery = (request.query as Record<string, string>)?.token;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : tokenQuery;

  if (!token) {
    return reply.code(401).send({ error_type: 'connection_error', message: 'No auth token' });
  }

  try {
    const admin = getFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    request.firebaseUser = decoded;

    // Upsert the user row and their personal org
    const existing = await db.query.users.findFirst({
      where: eq(users.firebase_uid, decoded.uid),
    });

    const isBootstrapAdmin = isAdminEmail(decoded.email);

    if (existing) {
      const updates: Record<string, unknown> = {
        last_seen_at: new Date(),
        email: decoded.email ?? existing.email,
      };
      if (isBootstrapAdmin && !existing.is_admin) updates.is_admin = true;
      await db.update(users).set(updates).where(eq(users.id, existing.id));
      request.dbUser = { ...existing, ...updates } as typeof existing;
    } else {
      // Create org + user
      const [newOrg] = await db
        .insert(orgs)
        .values({ name: decoded.email ?? 'Personal' })
        .returning();
      const [newUser] = await db
        .insert(users)
        .values({
          firebase_uid: decoded.uid,
          email: decoded.email ?? null,
          display_name: decoded.name ?? null,
          is_anonymous: decoded.firebase?.sign_in_provider === 'anonymous',
          is_admin: isBootstrapAdmin,
          default_org_id: newOrg.id,
          last_seen_at: new Date(),
        })
        .returning();
      // Link org owner
      await db.update(orgs).set({ owner_user_id: newUser.id }).where(eq(orgs.id, newOrg.id));
      // Claim collaboration invites sent to this email before the account existed
      // (migration 042), so user_id-only access checks see them.
      if (newUser.email) {
        await db
          .update(collaborators)
          .set({ user_id: newUser.id })
          .where(and(
            isNull(collaborators.user_id),
            eq(collaborators.invited_email, newUser.email.toLowerCase()),
          ))
          .catch(() => {});
      }
      request.dbUser = newUser;
    }
  } catch {
    return reply.code(401).send({ error_type: 'connection_error', message: 'Invalid auth token' });
  }
}

export async function firebaseAuthOptionalMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return;

  try {
    const admin = getFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
    request.firebaseUser = decoded;
    const existing = await db.query.users.findFirst({
      where: eq(users.firebase_uid, decoded.uid),
    });
    if (existing) request.dbUser = existing;
  } catch {
    // Optional: silently fail
  }
}
