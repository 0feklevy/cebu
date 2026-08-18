/**
 * observability-004 — the middleware half.
 *
 * `authFailureReason.test.ts` pins the classifier. This pins that the middleware actually USES it:
 * before this, both middlewares wrapped everything in a bare `catch {}` and emitted nothing, so a
 * deployment whose FIREBASE_* env was missing 401'd every request in total silence.
 *
 * Two behaviours are deliberately held UNCHANGED and asserted here, because a logging change that
 * quietly alters an auth outcome is the worst possible trade: the required middleware still replies
 * 401 with the same body, and the optional middleware still falls through to anonymous.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn(), getAdmin: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('../../lib/logger.js', () => ({ logger: log }));
vi.mock('../../services/firebase.js', () => ({
  getFirebaseAdmin: () => mocks.getAdmin(),
}));

const db = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('../../db/index.js', () => ({
  db: {
    query: { users: { findFirst: (...a: unknown[]) => db.findFirst(...a) } },
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'u1' }] }) }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  users: { __table: 'users', id: 'id', firebase_uid: 'firebase_uid' },
  orgs: { __table: 'orgs', id: 'id' },
  collaborators: { __table: 'collaborators', user_id: 'user_id', invited_email: 'invited_email' },
}));
vi.mock('drizzle-orm', () => ({
  eq: () => ({}), and: () => ({}), isNull: () => ({}),
}));

const { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } = await import('../firebase-auth.js');

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.LIVE-CREDENTIAL-DO-NOT-LOG.signature';

function req(): FastifyRequest {
  return { headers: { authorization: `Bearer ${TOKEN}` }, query: {}, url: '/api/v1/projects' } as unknown as FastifyRequest;
}
function reply() {
  const sent: { code?: number; body?: unknown } = {};
  const r = { code(c: number) { sent.code = c; return r; }, send(b: unknown) { sent.body = b; return r; }, sent };
  return r as unknown as FastifyReply & { sent: typeof sent };
}

/** Every argument the middleware handed to any logger method, as one string. */
function allLogged(): string {
  return JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls, log.debug.mock.calls]);
}
function payloadsAt(level: 'debug' | 'warn' | 'error'): Array<Record<string, unknown>> {
  return log[level].mock.calls.map((c) => c[0] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockReturnValue({ auth: () => ({ verifyIdToken: mocks.verifyIdToken }) });
  db.findFirst.mockResolvedValue({ id: 'u1', firebase_uid: 'uid', email: null, is_admin: false });
});

describe('firebaseAuthMiddleware logs WHY a token was rejected', () => {
  it('logs an expired token quietly and still replies 401 unchanged', async () => {
    mocks.verifyIdToken.mockRejectedValue(Object.assign(new Error('Firebase ID token has expired.'), { code: 'auth/id-token-expired' }));
    const r = reply();
    await firebaseAuthMiddleware(req(), r);
    expect(r.sent.code).toBe(401);
    expect(r.sent.body).toEqual({ error_type: 'connection_error', message: 'Invalid auth token' });
    expect(payloadsAt('debug').some((p) => p.reason === 'token_expired'), 'an expired token produced no log line at all').toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a MISCONFIGURED PROJECT loudly — it is an outage, not a bad client', async () => {
    mocks.verifyIdToken.mockRejectedValue(Object.assign(
      new Error('Firebase ID token has incorrect "aud" (audience) claim. Expected "prod" but got "staging". Make sure the ID token comes from the same Firebase project as the service account used to authenticate this SDK.'),
      { code: 'auth/argument-error' },
    ));
    await firebaseAuthMiddleware(req(), reply());
    expect(payloadsAt('error').some((p) => p.reason === 'project_mismatch'), 'a project mismatch is indistinguishable from a junk token').toBe(true);
  });

  it('logs an UNCONFIGURED SDK loudly — every request 401s and nothing said so', async () => {
    mocks.getAdmin.mockImplementation(() => { throw new Error('Firebase Admin environment variables not configured'); });
    const r = reply();
    await firebaseAuthMiddleware(req(), r);
    expect(r.sent.code).toBe(401);
    expect(payloadsAt('error').some((p) => p.reason === 'admin_not_configured')).toBe(true);
  });

  it('logs clock skew as its own thing', async () => {
    mocks.verifyIdToken.mockRejectedValue(Object.assign(
      new Error('Firebase ID token has "iat" claim in the future.'), { code: 'auth/argument-error' },
    ));
    await firebaseAuthMiddleware(req(), reply());
    expect(payloadsAt('error').some((p) => p.reason === 'clock_skew')).toBe(true);
  });

  it('NEVER logs the token', async () => {
    for (const err of [
      Object.assign(new Error('Firebase ID token has expired.'), { code: 'auth/id-token-expired' }),
      Object.assign(new Error(`jwt malformed: ${TOKEN}`), { code: 'auth/argument-error' }),
    ]) {
      vi.clearAllMocks();
      mocks.getAdmin.mockReturnValue({ auth: () => ({ verifyIdToken: mocks.verifyIdToken }) });
      mocks.verifyIdToken.mockRejectedValue(err);
      await firebaseAuthMiddleware(req(), reply());
      expect(allLogged(), 'the id token reached the logs').not.toContain('LIVE-CREDENTIAL-DO-NOT-LOG');
    }
  });

  it('distinguishes a failure AFTER the token verified from a bad token', async () => {
    // The original `try` wrapped the user upsert too, so a Postgres outage was reported to the
    // client as "Invalid auth token" and logged nothing. The reply is deliberately left as-is
    // here; what changes is that the log now says the token was fine and the database was not.
    mocks.verifyIdToken.mockResolvedValue({ uid: 'uid-1', email: 'a@b.test', email_verified: true });
    db.findFirst.mockRejectedValue(new Error('terminating connection due to administrator command'));
    const r = reply();
    await firebaseAuthMiddleware(req(), r);
    expect(r.sent.code).toBe(401);
    const errors = payloadsAt('error');
    expect(errors.some((p) => p.reason === 'session_persist_failed'), 'a database outage still looks exactly like a bad token').toBe(true);
    expect(errors.some((p) => p.reason === 'token_malformed' || p.reason === 'unknown'), 'a db failure was mislabelled as a token problem').toBe(false);
  });
});

describe('firebaseAuthOptionalMiddleware', () => {
  it('still falls through to anonymous, but says why', async () => {
    mocks.verifyIdToken.mockRejectedValue(Object.assign(new Error('Firebase ID token has invalid signature.'), { code: 'auth/argument-error' }));
    const request = req();
    await firebaseAuthOptionalMiddleware(request, reply());
    expect(request.firebaseUser, 'the optional middleware must stay anonymous on a bad token').toBeUndefined();
    expect(payloadsAt('warn').some((p) => p.reason === 'token_malformed'), 'the optional path is still completely silent').toBe(true);
    expect(allLogged()).not.toContain('LIVE-CREDENTIAL-DO-NOT-LOG');
  });

  it('does not log at all when there is simply no Authorization header', async () => {
    const request = { headers: {}, query: {} } as unknown as FastifyRequest;
    await firebaseAuthOptionalMiddleware(request, reply());
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
  });
});
