/**
 * backend-001 — a non-uuid `:id` must 404, not 500.
 *
 * MECHANISM, verified against real Postgres (PGlite) rather than assumed: `projects.id` and
 * `video_files.id` are `uuid` columns, and Postgres REFUSES a comparison against a malformed
 * literal at bind time — SQLSTATE 22P02, `invalid input syntax for type uuid`. A well-formed
 * uuid that does not exist returns zero rows and no error; `'banana'` raises. The driver error
 * carries no `statusCode`, so `server.ts`'s handler defaulted it to 500 with an "Internal server
 * error" body. `db.query.*.findFirst` is stubbed to throw exactly that error below, so these
 * tests pin the ROUTE's behaviour, not Postgres's.
 *
 * The stronger assertion in each case is `findFirst` NOT having been called: the guard's whole
 * point is to answer before the database is touched, so a malformed id costs no round trip and
 * no error-log line.
 *
 * The 404 body must MATCH the route's genuine not-found body. These routes 404 rather than 403
 * so a private project's existence is not confirmed; a distinguishable "bad id" body would hand
 * back a probe oracle that the 404 was chosen to deny.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  projects:    { findFirst: vi.fn() },
  video_files: { findFirst: vi.fn() },
}));

/** What `postgres.js` actually throws: the SQLSTATE verbatim on `.code`, and no `statusCode`. */
function pgInvalidUuidError(value: string): Error & { code: string } {
  const err = new Error(
    `invalid input syntax for type uuid: "${value}"`,
  ) as Error & { code: string };
  err.code = '22P02';
  return err;
}

vi.mock('../../../db/index.js', () => ({ db: { query: mocks } }));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'),
  video_files: Symbol('video_files'),
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({ type: 'eq' })) }));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: async (req: Record<string, unknown>) => { req.dbUser = { id: 'user-1' }; },
  firebaseAuthOptionalMiddleware: async () => {},
}));
vi.mock('../../../services/buildPlayerConfig.js', () => ({ buildPlayerConfig: vi.fn() }));
vi.mock('../../../services/billing/BillingService.js', () => ({
  BillingService: { getPricing: vi.fn(), hasAccess: vi.fn() },
}));
vi.mock('../../../services/captions/CaptionService.js', () => ({
  enqueueCaptionsForProject: vi.fn(async () => {}),
  getCaptionStatusForProject: vi.fn(async () => ({ status: 'ready' })),
}));
vi.mock('../../../services/projectAccess.js', () => ({ requireProjectAccess: vi.fn(() => true) }));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: vi.fn(),
  isCollaborator: vi.fn(async () => false),
}));

const { registerPlayerRoutes } = await import('../player.controller.js');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerPlayerRoutes(app);
  // The real global handler's shape: an error with no `statusCode` becomes a 500.
  app.setErrorHandler((err, _req, reply) => {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(statusCode).send({
      error_type: 'server_error',
      message: statusCode >= 500 ? 'Internal server error' : err.message,
    });
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  mocks.projects.findFirst.mockReset();
  mocks.video_files.findFirst.mockReset();
  // Any id that reaches the database in these tests is a malformed one, so every stub throws.
  mocks.projects.findFirst.mockRejectedValue(pgInvalidUuidError('banana'));
  mocks.video_files.findFirst.mockRejectedValue(pgInvalidUuidError('banana'));
});

const MALFORMED = [
  ['a bare word', 'banana'],
  ['a numeric id', '12345'],
  ['a uuid missing a group', '11111111-1111-4111-8111'],
  ['a uuid with a non-hex digit', '1111111z-1111-4111-8111-111111111111'],
  ['a 36-hex over-long id', '11111111-1111-4111-8111-111111111111-1111'],
] as const;

/**
 * Spellings Postgres RESOLVES. They were briefly in the table above as things to reject, which
 * would have been a new bug wearing a fix's clothes: each one returns the row today, so 404ing
 * them breaks a working URL with a body that says "does not exist". These assert the guard lets
 * them THROUGH to the database.
 */
const EXOTIC_BUT_VALID = [
  ['a hyphenless 32-hex string', '11111111111141118111111111111111'],
  ['a braced uuid', '{11111111-1111-4111-8111-111111111111}'],
] as const;

describe('backend-001 — GET /api/v1/projects/:id/player-config', () => {
  for (const [label, id] of MALFORMED) {
    it(`404s on ${label} without querying the database`, async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/player-config` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ message: 'Project not found' });
      expect(mocks.projects.findFirst).not.toHaveBeenCalled();
      await app.close();
    });
  }

  it('still reaches the database for a well-formed id', async () => {
    // The guard must not swallow real traffic: a canonical uuid passes through untouched.
    mocks.projects.findFirst.mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/11111111-1111-4111-8111-111111111111/player-config',
    });
    expect(mocks.projects.findFirst).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(404); // genuinely absent, same body — indistinguishable by design
    expect(res.json()).toEqual({ message: 'Project not found' });
    await app.close();
  });

  for (const [label, id] of EXOTIC_BUT_VALID) {
    it(`lets ${label} reach the database, because Postgres resolves it`, async () => {
      mocks.projects.findFirst.mockResolvedValue(undefined);
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${encodeURIComponent(id)}/player-config` });
      // The assertion that matters is the CALL: the guard must not short-circuit a resolvable id.
      expect(mocks.projects.findFirst).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(404); // absent in this stub, not blocked by the guard
      await app.close();
    });
  }
});

describe('backend-001 — the sibling player routes', () => {
  it('GET /projects/:id/captions 404s on a malformed id', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/banana/captions' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'Project not found' });
    expect(mocks.projects.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET /videos/:videoId/captions.vtt 404s on a malformed id', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/videos/banana/captions.vtt' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'Captions not available' });
    expect(mocks.video_files.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /projects/:id/captions/retry 404s on a malformed id', async () => {
    const { editableProject } = await import('../../../services/collabAccess.js');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/projects/banana/captions/retry' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'Project not found' });
    expect(vi.mocked(editableProject)).not.toHaveBeenCalled();
    await app.close();
  });
});
