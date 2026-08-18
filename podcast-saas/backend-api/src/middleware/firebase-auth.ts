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

/**
 * The address this token PROVED control of, or undefined (security-003).
 *
 * Everything below that derives authority from an email — the ADMIN_EMAILS bootstrap and the
 * migration-042 invite claim — must read the address through here rather than off `decoded.email`,
 * which is only ever "the string this account was registered with". Firebase will mint that string
 * for whoever typed it into a sign-up form, so without this gate, learning an address is enough to
 * inherit whatever that address was owed: admin on a listed address, or a pending invite (the more
 * reachable one — an invited address usually has no Firebase account yet).
 *
 * `email_verified` is OPTIONAL on DecodedIdToken — absent entirely on tokens with no email
 * (anonymous, phone) and on any provider that declines to assert it — so `=== true` is the only
 * form that fails closed. Providers that verify the address themselves set it, so the gate needs no
 * per-provider allowlist: Google, the only OAuth provider wired into either frontend, mints
 * email_verified: true and passes straight through.
 *
 * Deliberately NOT a rejection. An unverified user still authenticates, still gets a user row, and
 * still uses the product; only the email-derived grants are withheld, and only while the token
 * says so. This is re-read on every request rather than frozen into the row at creation, so an
 * account that verifies later gets its grants on the next request.
 */
function provenEmail(decoded: DecodedIdToken): string | undefined {
  return decoded.email_verified === true ? decoded.email : undefined;
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

    const proven = provenEmail(decoded);
    const isBootstrapAdmin = isAdminEmail(proven);

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
      request.dbUser = newUser;
    }

    // Claim collaboration invites sent to this address before the account existed (migration 042),
    // so user_id-only access checks see them. Runs for existing users too, not just at row
    // creation: an account that signed up before verifying must still be able to claim once it
    // does, and freezing that at insert time would strand the honest invitee. Matches nothing on
    // the overwhelming majority of requests and rides idx_collaborators_email, so this is an index
    // lookup rather than a write on the hot auth path.
    const claimant = request.dbUser;
    if (proven && claimant) {
      await db
        .update(collaborators)
        .set({ user_id: claimant.id })
        .where(and(
          isNull(collaborators.user_id),
          eq(collaborators.invited_email, proven.toLowerCase()),
        ))
        .catch(() => {});
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
