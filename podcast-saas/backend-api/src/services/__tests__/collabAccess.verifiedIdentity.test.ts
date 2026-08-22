/**
 * security-003 follow-up — collaborator authority must derive from a PROVEN address.
 *
 * WHAT a63aa4e FIXED, AND WHAT IT LEFT OPEN
 * a63aa4e gated `firebaseAuthMiddleware` so that only a token carrying `email_verified === true`
 * may run the migration-042 claim UPDATE that binds `collaborators.user_id`. That gate is real and
 * it holds. It was also not sufficient, because nothing downstream consulted it:
 *
 *   `collabAccess` authorized on `invited_email` OR `user_id`. An account that never ran the claim
 *   still matched the invite on the raw address column, so it received full collaborator EDIT
 *   authority anyway. The gate was bypassed not by defeating it but by routing around it.
 *
 * WHY THIS SUITE IS INTEGRATION-SHAPED AND NOT A UNIT TEST
 * The previous fix shipped with a thorough unit suite that asserted "no claim UPDATE ran for an
 * unverified token" — and that assertion was TRUE the whole time the hole was open. Asserting on
 * which writes happened can never see an authorization path that reads a different column. So this
 * suite asserts on the only thing that actually matters: whether the request is let in. It boots a
 * real Postgres (PGlite) with the real migrations, mounts the real collaborator routes behind the
 * REAL `firebaseAuthMiddleware`, and drives real HTTP requests. `editableProject` is exercised as
 * production reaches it, through `GET /collaborators`, and also called directly so the invariant is
 * pinned at the service seam too.
 *
 * THE INVARIANT
 * `collaborators.user_id` is the ONLY thing that grants collaborator authority, and the verified
 * claim in `firebaseAuthMiddleware` is the ONLY writer that sets it. `invited_email` is an
 * ADDRESSEE — who the invitation is for — never a credential.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { InjectOptions } from 'fastify';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import Fastify, { type FastifyInstance } from 'fastify';

import * as schema from '../../db/schema.js';

const h = vi.hoisted(() => ({
  dbRef: { current: null as unknown as Record<string, unknown> },
  verifyIdToken: vi.fn(),
}));

// The app db, bound to the per-suite PGlite instance.
vi.mock('../../db/index.js', () => ({
  db: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      const target = h.dbRef.current;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));

// Only Firebase's token verification is faked. The middleware itself is the real one, so the
// email_verified gate under test is production's, not a stand-in.
vi.mock('../../services/firebase.js', () => ({
  getFirebaseAdmin: () => ({ auth: () => ({ verifyIdToken: h.verifyIdToken }) }),
}));

import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { registerCollaboratorRoutes } from '../../controllers/v1/collaborators.controller.js';
import { editableProject, isCollaborator, type CollabUser } from '../collabAccess.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

const OWNER = 'owner@example.test';
const INVITED = 'invitee@example.test';

type Token = {
  uid: string;
  email?: string;
  email_verified?: boolean;
  firebase?: { sign_in_provider: string };
};

/** Email/password sign-in. Firebase mints these unverified until the address is confirmed. */
const account = (email: string, verified: boolean, uid = `uid-${email}`): Token => ({
  uid,
  email,
  email_verified: verified,
  firebase: { sign_in_provider: 'password' },
});

/** Anonymous sign-in — no email at all, so no email-derived authority is even expressible. */
const anonymous = (uid = 'uid-anon'): Token => ({ uid, firebase: { sign_in_provider: 'anonymous' } });

let pg: PGlite;
let app: FastifyInstance;

/** Raw SQL, for seeding and for observing what actually landed in the table. */
async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

/** A signed-in account: the `CollabUser` authorization sees, plus the token that produced it. */
type Identity = CollabUser & { token: Token };

/** Issue a request as a token or an already-signed-in identity, through the real middleware. */
async function as(
  who: Token | Identity,
  // `payload` is Fastify's OWN type, not `unknown`. With `unknown` the spread below does not
  // satisfy `InjectOptions`, so overload resolution falls through to the callback form of
  // `inject`, whose return type is `void & Promise<Response> & Chain` — and every `.statusCode`
  // and `.json()` on the result becomes a type error. Ten of them in this file, from one word.
  opts: { method: 'GET' | 'POST' | 'DELETE'; url: string; payload?: InjectOptions['payload'] },
) {
  h.verifyIdToken.mockResolvedValue('token' in who ? who.token : who);
  return app.inject({ ...opts, headers: { authorization: 'Bearer t' } });
}

/**
 * Sign in and return the identity exactly as an authorized handler would see it —
 * `request.dbUser` narrowed to the shape `collabAccess` consumes.
 */
async function signIn(token: Token): Promise<Identity> {
  const res = await as(token, { method: 'GET', url: '/__probe' });
  expect(res.statusCode).toBe(200);
  const { id, email } = res.json().user as CollabUser;
  return { id, email, token };
}

/** A project owned by `ownerId`, in that owner's personal org. */
async function seedProject(ownerId: string): Promise<string> {
  const [{ default_org_id }] = await sql<{ default_org_id: string }>(
    `SELECT default_org_id FROM users WHERE id = $1`, [ownerId]);
  const [{ id }] = await sql<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,'P') RETURNING id`,
    [default_org_id, ownerId]);
  return id;
}

const inviteRows = (contentId: string) =>
  sql<{ id: string; invited_email: string; user_id: string | null }>(
    `SELECT id, invited_email, user_id FROM collaborators WHERE content_id = $1`, [contentId]);

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;

  app = Fastify();
  // The identity probe returns what an authorized handler would receive, so the tests can hand the
  // very same object to `editableProject` that a controller would.
  app.get('/__probe', { preHandler: [firebaseAuthMiddleware] }, async (request, reply) =>
    reply.send({ user: { id: request.dbUser!.id, email: request.dbUser!.email } }));
  await registerCollaboratorRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pg?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec(`TRUNCATE collaborators, projects, playlists, users, orgs RESTART IDENTITY CASCADE`);
});

describe('an UNVERIFIED account inherits nothing from the invited address', () => {
  it('is DENIED authorization on the project it was invited to', async () => {
    // THE REGRESSION TEST. Every step here is production's: a real pending invite, a real
    // unverified sign-in through the real gate, and a real authorization decision.
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    expect((await as(owner, {
      method: 'POST', url: `/api/v1/projects/${projectId}/collaborators`, payload: { email: INVITED },
    })).statusCode).toBe(201);

    // Whoever learned the address registers it. Firebase hands them the account; it just will not
    // call the address verified.
    const attacker = await signIn(account(INVITED, false, 'uid-attacker'));

    // The claim correctly did not run — this is what a63aa4e already guaranteed.
    expect((await inviteRows(projectId))[0].user_id).toBeNull();

    // ...and the point of this suite: not having claimed must MEAN something.
    const res = await as(attacker, { method: 'GET', url: `/api/v1/projects/${projectId}/collaborators` });
    expect(res.statusCode).toBe(404);

    // Pinned at the service seam too, since every editing controller reaches authorization here.
    expect(await editableProject(projectId, attacker)).toBeUndefined();
    expect(await isCollaborator('project', projectId, attacker)).toBe(false);
  });

  it('is DENIED even when the address matches only by letter case', async () => {
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    await as(owner, {
      method: 'POST', url: `/api/v1/projects/${projectId}/collaborators`, payload: { email: INVITED },
    });

    const attacker = await signIn(account('Invitee@Example.TEST', false, 'uid-attacker'));
    expect(await editableProject(projectId, attacker)).toBeUndefined();
  });

  it('cannot REMOVE the invitation to free the address for a fresh attempt', async () => {
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    await as(owner, {
      method: 'POST', url: `/api/v1/projects/${projectId}/collaborators`, payload: { email: INVITED },
    });
    const [row] = await inviteRows(projectId);

    const attacker = await signIn(account(INVITED, false, 'uid-attacker'));
    const res = await as(attacker, {
      method: 'DELETE', url: `/api/v1/projects/${projectId}/collaborators/${row.id}`,
    });
    expect(res.statusCode).toBe(404);
    expect(await inviteRows(projectId)).toHaveLength(1);
  });
});

describe('a VERIFIED invitee claims the invitation and gets in', () => {
  it('acquires user_id on its first request and is then authorized', async () => {
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    await as(owner, {
      method: 'POST', url: `/api/v1/projects/${projectId}/collaborators`, payload: { email: INVITED },
    });

    const invitee = await signIn(account(INVITED, true));

    const [row] = await inviteRows(projectId);
    expect(row.user_id).toBe(invitee.id);

    expect(await editableProject(projectId, invitee)).toBeDefined();
    expect(await isCollaborator('project', projectId, invitee)).toBe(true);
    expect((await as(invitee, {
      method: 'GET', url: `/api/v1/projects/${projectId}/collaborators`,
    })).statusCode).toBe(200);
  });

  it('claims on a LATER request for an account that signed up before verifying', async () => {
    // The honest-invitee path: signing up unverified must not strand them permanently.
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    await as(owner, {
      method: 'POST', url: `/api/v1/projects/${projectId}/collaborators`, payload: { email: INVITED },
    });

    const before = await signIn(account(INVITED, false));
    expect(await editableProject(projectId, before)).toBeUndefined();

    const after = await signIn(account(INVITED, true));
    expect(after.id).toBe(before.id);                       // same account, now verified
    expect((await inviteRows(projectId))[0].user_id).toBe(after.id);
    expect(await editableProject(projectId, after)).toBeDefined();
  });

  it('may remove ITSELF once it has claimed', async () => {
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    await as(owner, {
      method: 'POST', url: `/api/v1/projects/${projectId}/collaborators`, payload: { email: INVITED },
    });
    const invitee = await signIn(account(INVITED, true));
    const [row] = await inviteRows(projectId);

    const res = await as(invitee, {
      method: 'DELETE', url: `/api/v1/projects/${projectId}/collaborators/${row.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect(await inviteRows(projectId)).toHaveLength(0);
  });
});

describe('invite creation records an ADDRESSEE, not a grant', () => {
  it('leaves the row PENDING even when an account with that address already exists', async () => {
    // The second hole: resolving the invite against `users.email` handed out `user_id` — the very
    // column that IS the authority — on the strength of an unverified string in the users table.
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    const existing = await signIn(account(INVITED, false));   // registered, never verified

    const res = await as(owner, {
      method: 'POST', url: `/api/v1/projects/${projectId}/collaborators`, payload: { email: INVITED },
    });
    expect(res.statusCode).toBe(201);

    const [row] = await inviteRows(projectId);
    expect(row.user_id).toBeNull();
    expect(res.json().collaborators[0].status).toBe('pending');
    expect(await editableProject(projectId, existing)).toBeUndefined();
  });

  it('still lets that existing account in once it verifies — invites are not lost', async () => {
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    await signIn(account(INVITED, false));
    await as(owner, {
      method: 'POST', url: `/api/v1/projects/${projectId}/collaborators`, payload: { email: INVITED },
    });

    const verified = await signIn(account(INVITED, true));
    expect(await editableProject(projectId, verified)).toBeDefined();
  });

  it('lowercases the stored address, so a claim can match it', async () => {
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    await as(owner, {
      method: 'POST', url: `/api/v1/projects/${projectId}/collaborators`, payload: { email: 'Invitee@Example.TEST' },
    });
    expect((await inviteRows(projectId))[0].invited_email).toBe(INVITED);
  });
});

describe('collaborators that already resolved keep working unchanged', () => {
  it('authorizes on user_id alone, with no email on the account at all', async () => {
    // The regression this fix must not cause. A resolved row is the post-claim steady state, and it
    // must not quietly depend on the address still matching.
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    const guest = await signIn(anonymous());
    expect(guest.email).toBeNull();

    await sql(
      `INSERT INTO collaborators (content_type, content_id, invited_email, user_id, invited_by)
       VALUES ('project',$1,$2,$3,$4)`, [projectId, INVITED, guest.id, owner.id]);

    expect(await editableProject(projectId, guest)).toBeDefined();
    expect(await isCollaborator('project', projectId, guest)).toBe(true);
    expect((await as(guest, {
      method: 'GET', url: `/api/v1/projects/${projectId}/collaborators`,
    })).statusCode).toBe(200);
  });

  it('lets a resolved collaborator remove itself', async () => {
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    const guest = await signIn(anonymous());
    await sql(
      `INSERT INTO collaborators (content_type, content_id, invited_email, user_id, invited_by)
       VALUES ('project',$1,$2,$3,$4)`, [projectId, INVITED, guest.id, owner.id]);
    const [row] = await inviteRows(projectId);

    expect((await as(guest, {
      method: 'DELETE', url: `/api/v1/projects/${projectId}/collaborators/${row.id}`,
    })).statusCode).toBe(204);
  });

  it("leaves the owner's own authority untouched", async () => {
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    expect(await editableProject(projectId, owner)).toBeDefined();
    expect((await as(owner, {
      method: 'GET', url: `/api/v1/projects/${projectId}/collaborators`,
    })).statusCode).toBe(200);
  });

  it('grants an uninvited stranger nothing', async () => {
    const owner = await signIn(account(OWNER, true));
    const projectId = await seedProject(owner.id);
    const stranger = await signIn(account('stranger@example.test', true, 'uid-stranger'));
    expect(await editableProject(projectId, stranger)).toBeUndefined();
  });
});
