/**
 * security-003 — email-derived authority must require a PROVEN address.
 *
 * `firebaseAuthMiddleware` hands out two things purely on the strength of the string in
 * `decoded.email`, and Firebase will happily mint that string for anyone who types it into a
 * sign-up form:
 *
 *   (a) BOOTSTRAP ADMIN — an address listed in ADMIN_EMAILS is granted `is_admin`.
 *   (b) INVITE CLAIMING — a pending migration-042 collaborator invite addressed to that string is
 *       bound to the new user row. The more reachable half: an invited address usually has NO
 *       Firebase account yet, so learning the address is enough to register it and take the invite.
 *
 * Both are gated here on `decoded.email_verified === true`. What is deliberately NOT done is
 * rejecting unverified users — they authenticate, get a row, and use the product exactly as
 * before; they are only denied authority that the address itself was owed. And because the gate is
 * re-evaluated on every request rather than frozen at row creation, verifying later is enough.
 *
 * The suite drives the real middleware over a fake db that records the writes, so the assertions
 * are about what would actually hit Postgres, not about which branch ran.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

/** Records every write the middleware attempts, keyed by table. */
const store = vi.hoisted(() => {
  const s = {
    existingUser: undefined as Record<string, unknown> | undefined,
    updates: [] as Array<{ table: string; set: Record<string, unknown>; where: unknown }>,
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
    seq: 0,
    reset() {
      s.existingUser = undefined;
      s.updates = [];
      s.inserts = [];
      s.seq = 0;
    },
  };
  return s;
});

vi.mock('../../services/firebase.js', () => ({
  getFirebaseAdmin: () => ({ auth: () => ({ verifyIdToken: mocks.verifyIdToken }) }),
}));

vi.mock('../../db/index.js', () => ({
  db: {
    query: { users: { findFirst: async () => store.existingUser } },
    update: (table: { __table: string }) => ({
      set: (set: Record<string, unknown>) => ({
        // Drizzle's update builder is a thenable, and the invite claim calls `.catch()` on it.
        where: (where: unknown) => {
          store.updates.push({ table: table.__table, set, where });
          return Promise.resolve(undefined);
        },
      }),
    }),
    insert: (table: { __table: string }) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          store.inserts.push({ table: table.__table, values });
          store.seq += 1;
          return [{ id: `${table.__table}-${store.seq}`, ...values }];
        },
      }),
    }),
  },
}));

// Named marker columns rather than symbols, so a recorded WHERE says which column it constrained.
vi.mock('../../db/schema.js', () => ({
  users: { __table: 'users', id: 'users.id', firebase_uid: 'users.firebase_uid' },
  orgs: { __table: 'orgs', id: 'orgs.id' },
  collaborators: {
    __table: 'collaborators',
    user_id: 'collaborators.user_id',
    invited_email: 'collaborators.invited_email',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
}));

const { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } = await import('../firebase-auth.js');

const ADMIN = 'founder@flowvid.test';
const ORDINARY = 'someone@example.test';
const INVITED = 'invitee@example.test';

type Token = {
  uid: string;
  email?: string;
  email_verified?: unknown;
  name?: string;
  firebase?: { sign_in_provider: string };
};

/** Email/password. Firebase mints these with email_verified false until the address is confirmed. */
const password = (email: string, verified: boolean, uid = 'uid-pw'): Token => ({
  uid,
  email,
  email_verified: verified,
  firebase: { sign_in_provider: 'password' },
});

/** Google. Firebase asserts email_verified because Google verified the address before minting. */
const google = (email: string, uid = 'uid-google'): Token => ({
  uid,
  email,
  email_verified: true,
  firebase: { sign_in_provider: 'google.com' },
});

/** Anonymous. No email at all, so no email-derived authority is even expressible. */
const anonymous = (uid = 'uid-anon'): Token => ({ uid, firebase: { sign_in_provider: 'anonymous' } });

/** An existing users row, as `db.query.users.findFirst` would return it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'user-existing',
  firebase_uid: 'uid-pw',
  email: null,
  display_name: null,
  is_anonymous: false,
  is_admin: false,
  default_org_id: 'org-existing',
  ...over,
});

async function auth(token: Token) {
  mocks.verifyIdToken.mockResolvedValue(token);
  const request = { headers: { authorization: 'Bearer t' }, query: {} } as unknown as FastifyRequest;
  const sent: { code?: number } = {};
  const reply = {
    code(c: number) {
      sent.code = c;
      return reply;
    },
    send() {
      return reply;
    },
  };
  await firebaseAuthMiddleware(request, reply as unknown as FastifyReply);
  return { request, sent };
}

const userInsert = () => store.inserts.find((i) => i.table === 'users');
const userUpdate = () => store.updates.find((u) => u.table === 'users');
const inviteClaims = () => store.updates.filter((u) => u.table === 'collaborators');

/**
 * What this request did to `is_admin`: the value inserted for a new row, the value written by an
 * update, or `undefined` for "left alone" (which is what a non-grant looks like on an existing row).
 */
function adminGrant(): unknown {
  const inserted = userInsert();
  return inserted ? inserted.values.is_admin : userUpdate()?.set.is_admin;
}

/** The addresses whose pending invites this request tried to bind. */
function claimedEmails(): unknown[] {
  return inviteClaims().map((u) => {
    const parts = (u.where as { parts?: Array<{ op: string; col: unknown; val: unknown }> }).parts ?? [];
    return parts.find((p) => p.op === 'eq' && p.col === 'collaborators.invited_email')?.val;
  });
}

const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

beforeEach(() => {
  vi.clearAllMocks();
  store.reset();
  process.env.ADMIN_EMAILS = `noise@example.test, ${ADMIN}`;
});

afterAll(() => {
  if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
});

describe('(a) ADMIN_EMAILS bootstrap requires a proven address', () => {
  it('grants admin to a NEW user whose verified address is listed', async () => {
    await auth(password(ADMIN, true));
    expect(adminGrant()).toBe(true);
  });

  it('refuses admin to a NEW user whose listed address is UNVERIFIED', async () => {
    // The escalation: Firebase will create this account for whoever typed the address.
    await auth(password(ADMIN, false));
    expect(adminGrant()).toBe(false);
  });

  it('promotes an EXISTING non-admin whose verified address is listed', async () => {
    store.existingUser = row();
    await auth(password(ADMIN, true));
    expect(userUpdate()?.set.is_admin).toBe(true);
  });

  it('leaves an EXISTING non-admin alone when the listed address is UNVERIFIED', async () => {
    store.existingUser = row();
    await auth(password(ADMIN, false));
    // Not `false` — the request must not touch the column at all, so it cannot race a
    // legitimate promotion made elsewhere.
    expect(userUpdate()?.set).not.toHaveProperty('is_admin');
  });

  it('never grants admin to an ordinary address, verified or not', async () => {
    await auth(password(ORDINARY, true));
    expect(adminGrant()).toBe(false);
    store.reset();
    store.existingUser = row();
    await auth(password(ORDINARY, false));
    expect(userUpdate()?.set).not.toHaveProperty('is_admin');
  });

  it('does NOT demote an existing admin who happens to be signed in unverified', async () => {
    // The gate withholds a grant; it is not a revocation. Demoting here would let an attacker
    // who squats a listed address lock the real admin out of their own console.
    store.existingUser = row({ is_admin: true });
    await auth(password(ADMIN, false));
    expect(userUpdate()?.set).not.toHaveProperty('is_admin');
  });
});

describe('(b) migration-042 invite claiming requires a proven address', () => {
  it('claims pending invites for a NEW user with a verified address', async () => {
    await auth(password(INVITED, true));
    expect(claimedEmails()).toEqual([INVITED]);
    expect(inviteClaims()[0].set).toEqual({ user_id: 'users-2' });
  });

  it('claims NOTHING for a NEW user whose address is UNVERIFIED', async () => {
    // The most reachable half of security-003: an invited address usually has no Firebase
    // account yet, so an attacker who learns it can register it and take the invitation.
    await auth(password(INVITED, false));
    expect(inviteClaims()).toEqual([]);
  });

  it('matches the invite on the lowercased address, as migration 042 stores it', async () => {
    await auth(password('Invitee@Example.TEST', true));
    expect(claimedEmails()).toEqual([INVITED]);
  });

  it('claims for a verified OAuth user', async () => {
    await auth(google(INVITED));
    expect(claimedEmails()).toEqual([INVITED]);
  });
});

describe('verifying later is enough — no decision is frozen at row creation', () => {
  it('promotes on a LATER request once the listed address becomes verified', async () => {
    await auth(password(ADMIN, false));
    expect(userInsert()?.values.is_admin).toBe(false);
    const created = userInsert()!.values;

    store.reset();
    store.existingUser = row({ ...created, id: 'user-existing', is_admin: false });
    await auth(password(ADMIN, true));
    expect(userUpdate()?.set.is_admin).toBe(true);
  });

  it('claims a still-pending invite on a LATER request once the address becomes verified', async () => {
    // Without this the fix would strand the honest invitee: the old code only ever claimed at row
    // creation, so an account that signed up before verifying could never claim at all.
    await auth(password(INVITED, false));
    expect(inviteClaims()).toEqual([]);

    store.reset();
    store.existingUser = row({ email: INVITED });
    await auth(password(INVITED, true));
    expect(claimedEmails()).toEqual([INVITED]);
    expect(inviteClaims()[0].set).toEqual({ user_id: 'user-existing' });
  });
});

describe('the gate fails closed on anything that is not a literal true', () => {
  it('withholds both grants when email_verified is absent', async () => {
    await auth({ uid: 'uid-x', email: ADMIN, firebase: { sign_in_provider: 'password' } });
    expect(adminGrant()).toBe(false);
    expect(inviteClaims()).toEqual([]);
  });

  it('withholds both grants for a truthy non-boolean email_verified', async () => {
    await auth({ uid: 'uid-x', email: ADMIN, email_verified: 'true', firebase: { sign_in_provider: 'password' } });
    expect(adminGrant()).toBe(false);
    expect(inviteClaims()).toEqual([]);
  });
});

describe('non-email authentication is untouched', () => {
  it('lets a NEW anonymous user in, with a row, no admin, and no invite claim', async () => {
    const { request, sent } = await auth(anonymous());
    expect(sent.code).toBeUndefined();
    expect(request.dbUser).toBeDefined();
    expect(userInsert()?.values).toMatchObject({ is_anonymous: true, is_admin: false, email: null });
    expect(inviteClaims()).toEqual([]);
  });

  it('lets a RETURNING anonymous user in and grants it nothing', async () => {
    store.existingUser = row({ firebase_uid: 'uid-anon', is_anonymous: true });
    const { request, sent } = await auth(anonymous());
    expect(sent.code).toBeUndefined();
    expect(request.dbUser).toBeDefined();
    expect(userUpdate()?.set).not.toHaveProperty('is_admin');
    expect(inviteClaims()).toEqual([]);
  });

  it('grants admin to a verified OAuth user, so the gate needs no provider allowlist', async () => {
    // Google asserts email_verified itself, which is the whole reason the gate can be uniform.
    await auth(google(ADMIN));
    expect(adminGrant()).toBe(true);
  });

  it('promotes an EXISTING user signing in through verified OAuth', async () => {
    store.existingUser = row({ firebase_uid: 'uid-google', email: ADMIN });
    await auth(google(ADMIN));
    expect(userUpdate()?.set.is_admin).toBe(true);
  });

  it('grants an EXISTING verified OAuth user with an ordinary address no admin', async () => {
    store.existingUser = row({ firebase_uid: 'uid-google', email: ORDINARY });
    await auth(google(ORDINARY));
    expect(userUpdate()?.set).not.toHaveProperty('is_admin');
  });

  it('withholds both grants from an OAuth provider that does NOT assert verification', async () => {
    // The gate is a property of the token, not of the provider name. A federated provider that
    // declines to assert email_verified (or a future OIDC tenant that cannot) must not be trusted
    // just because it is "OAuth" — that is precisely why there is no provider allowlist.
    await auth({ uid: 'uid-oidc', email: ADMIN, email_verified: false, firebase: { sign_in_provider: 'oidc.partner' } });
    expect(adminGrant()).toBe(false);
    expect(inviteClaims()).toEqual([]);
  });
});

describe('unverified users are NOT rejected — only their address is untrusted', () => {
  it('signs a brand-new unverified user in and gives them an org and a row', async () => {
    const { request, sent } = await auth(password(ORDINARY, false));
    expect(sent.code).toBeUndefined();
    expect(request.firebaseUser).toBeDefined();
    expect(request.dbUser).toBeDefined();
    expect(store.inserts.map((i) => i.table)).toEqual(['orgs', 'users']);
    // Their address is still stored — it is their identity, it is just not a credential.
    expect(userInsert()?.values.email).toBe(ORDINARY);
  });

  it('keeps refreshing an existing unverified user normally', async () => {
    store.existingUser = row({ email: ORDINARY });
    const { request, sent } = await auth(password(ORDINARY, false));
    expect(sent.code).toBeUndefined();
    expect(request.dbUser).toBeDefined();
    expect(userUpdate()?.set).toMatchObject({ email: ORDINARY });
    expect(userUpdate()?.set.last_seen_at).toBeInstanceOf(Date);
  });

  it('still rejects a token Firebase itself refuses', async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error('bad token'));
    const request = { headers: { authorization: 'Bearer t' }, query: {} } as unknown as FastifyRequest;
    const sent: { code?: number } = {};
    const reply = {
      code(c: number) {
        sent.code = c;
        return reply;
      },
      send() {
        return reply;
      },
    };
    await firebaseAuthMiddleware(request, reply as unknown as FastifyReply);
    expect(sent.code).toBe(401);
  });
});

describe('the optional middleware derives no authority from an email', () => {
  it('attaches an existing row and grants nothing, even for a verified listed address', async () => {
    store.existingUser = row({ email: ADMIN });
    mocks.verifyIdToken.mockResolvedValue(google(ADMIN));
    const request = { headers: { authorization: 'Bearer t' }, query: {} } as unknown as FastifyRequest;
    await firebaseAuthOptionalMiddleware(request, {} as unknown as FastifyReply);
    expect(request.dbUser).toBeDefined();
    expect(store.updates).toEqual([]);
    expect(store.inserts).toEqual([]);
  });
});
