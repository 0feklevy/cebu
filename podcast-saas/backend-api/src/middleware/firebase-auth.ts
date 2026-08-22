import type { FastifyRequest, FastifyReply } from 'fastify';
import { getFirebaseAdmin } from '../services/firebase.js';
import { db } from '../db/index.js';
import { users, orgs, collaborators } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { logger } from '../lib/logger.js';
import { classifyAuthFailure, AUTH_FAILURE_LEVEL } from './authFailureReason.js';

/**
 * observability-004 — say WHY a token was rejected.
 *
 * Both middlewares used to end in a bare `catch` that emitted nothing, so an expired token, a
 * drifted container clock, a deployment pointed at the wrong Firebase project, and a missing
 * FIREBASE_* env were all the same event from outside: a 401, or a silently anonymous request.
 * Three of those four fail EVERY request in the fleet.
 *
 * The reply is unchanged in both — this only adds the line that says what happened. The token is
 * never a field; `classifyAuthFailure` also scrubs it out of the vendor's own message.
 */
function logAuthFailure(err: unknown, token: string | undefined, where: 'required' | 'optional'): void {
  const failure = classifyAuthFailure(err, token);
  const payload = {
    evt: 'auth_verify_failed',
    reason: failure.reason,
    vendorCode: failure.vendorCode,
    detail: failure.detail,
    middleware: where,
  };
  const level = AUTH_FAILURE_LEVEL[failure.reason];
  logger[level](payload, '[Auth] token verification failed');
}

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

/**
 * The ONLY routes that may authenticate with `?token=` (security-011).
 *
 * The browser's `EventSource` cannot set an Authorization header, so an SSE stream has no other
 * way to carry a credential. That is a real constraint — but it was implemented by reading
 * `?token=` in this shared middleware, which meant EVERY route using it as a preHandler accepted
 * a live Firebase ID token in its URL, while exactly one client call site ever sent one.
 *
 * A credential in a URL does not stay in the URL. It is written to the nginx access log (which
 * logs `"$request"`), to browser history, and to the `Referer` header of anything the page then
 * loads. The app's own logging was hardened separately (`safeRequestPath`), which is exactly why
 * this looked fixed at a glance.
 *
 * Matched on the ROUTE PATTERN, not the request URL, so this cannot be widened by a path that
 * merely looks similar. Adding an entry here is a deliberate act with a reviewer attached.
 */
const QUERY_TOKEN_ROUTES: ReadonlySet<string> = new Set([
  '/api/v1/projects/:id/simulations/:simId/generate-guidance/stream',
  '/api/v1/projects/:id/simulations/:simId/publish-guidance/stream',
]);

/**
 * The bearer token for this request.
 *
 * The header is authoritative everywhere. The query fallback applies only on the allowlisted SSE
 * routes above — and only when no header was sent, so a client that can use the header still does.
 */
export function bearerTokenFor(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

  const routePattern = (request as { routeOptions?: { url?: string } }).routeOptions?.url;
  if (!routePattern || !QUERY_TOKEN_ROUTES.has(routePattern)) return undefined;
  const tokenQuery = (request.query as Record<string, string> | undefined)?.token;
  return typeof tokenQuery === 'string' && tokenQuery.length > 0 ? tokenQuery : undefined;
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
  const token = bearerTokenFor(request);

  if (!token) {
    return reply.code(401).send({ error_type: 'connection_error', message: 'No auth token' });
  }

  // The verify is its OWN try. It used to share one with the user upsert below, which meant a
  // Postgres outage was reported to the client as "Invalid auth token" and logged nothing at all —
  // an auth incident that was really a database incident. The reply is unchanged (see the second
  // catch); what is now different is that the log says which of the two happened.
  let decoded: DecodedIdToken;
  try {
    const admin = getFirebaseAdmin();
    decoded = await admin.auth().verifyIdToken(token);
  } catch (err) {
    logAuthFailure(err, token, 'required');
    return reply.code(401).send({ error_type: 'connection_error', message: 'Invalid auth token' });
  }
  request.firebaseUser = decoded;

  try {
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
  } catch (err) {
    // The token was GOOD; persisting the session was not. Same reply as before (changing it is a
    // behaviour change this stream is not making), but no longer indistinguishable in the log:
    // `reason` says the credential verified and the database is what failed.
    logger.error(
      { evt: 'auth_verify_failed', reason: 'session_persist_failed', uid: decoded.uid, err },
      '[Auth] token verified but the session could not be persisted',
    );
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
  } catch (err) {
    // Still falls through to anonymous — that is this middleware's contract and it is unchanged.
    // But "silently" was the bug: a fleet-wide verify outage looked exactly like ordinary
    // unauthenticated traffic, on the routes where that difference matters most.
    logAuthFailure(err, authHeader.slice(7), 'optional');
  }
}
