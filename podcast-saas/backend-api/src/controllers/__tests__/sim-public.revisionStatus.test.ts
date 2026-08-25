/**
 * simulation-007 — /sim-public/* must not serve a revision whose bytes were never published.
 *
 * The route's only gate is `key.startsWith('simulations/') && !keyHasTraversal(key)`. A revision
 * prefix is inside `simulations/`, so the bytes of a `draft`, `uploading`, `validating` or `failed`
 * revision are served byte-for-byte like the active one. An aborted publication therefore leaves a
 * customer's unpublished work permanently readable — `RevisionService.gc()` has no production
 * caller, so nothing ever removes it.
 *
 * The four statuses gated here are exactly the ones the pointer NEVER named: no player, poster or
 * config has ever held a URL into them, so refusing them cannot break a live session. `active`,
 * `retired`, `rolled_back` and `canary_passed` are deliberately still served — see the test at the
 * bottom, and the report note on why revoking retired/rolled_back bytes is a separate decision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerSimPublicRoutes } from '../sim-public.controller.js';

const mocks = vi.hoisted(() => ({
  mockStorage: {
    readObject: vi.fn<(key: string) => Promise<Buffer>>(),
    getPublicUrl: vi.fn((key: string) => `https://cdn.example.com/${key}`),
  },
  /** status keyed by revision id; `undefined` = no such revision row. */
  statusByRevision: new Map<string, string>(),
}));

vi.mock('../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => mocks.mockStorage,
}));

vi.mock('../../services/simulation/SimulationService.js', () => ({
  getSimulationContentType: (path: string) =>
    (path.endsWith('.html') ? 'text/html; charset=utf-8'
      : path.endsWith('.js') ? 'application/javascript'
        : path.endsWith('.png') ? 'image/png' : 'application/octet-stream'),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Stand in for the database round trip, keeping the real shape/positional parsing in
// revisionIdentity.ts untested here (revisionIdentity.test.ts owns that) while letting this suite
// state one fact per revision: what status its row has.
vi.mock('../../services/simulation/revisionIdentity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/simulation/revisionIdentity.js')>();
  return {
    ...actual,
    isVerifiedRevisionKey: async (key: string) => {
      const coords = actual.revisionCoordsFromKey(key);
      return !!coords && mocks.statusByRevision.has(coords.revisionId);
    },
    revisionServingFacts: async (key: string) => {
      const coords = actual.revisionCoordsFromKey(key);
      const status = coords ? mocks.statusByRevision.get(coords.revisionId) ?? null : null;
      return { verified: status !== null, status };
    },
  };
});

const { mockStorage, statusByRevision } = mocks;

const SIM = '22222222-2222-4222-a222-222222222222';
const REV = '11111111-1111-4111-a111-111111111111';
const revKey = (file: string) => `simulations/proj-1/${SIM}/revisions/${REV}/package/${file}`;

async function makeApp() {
  const app = Fastify();
  await registerSimPublicRoutes(app);
  return app;
}

beforeEach(() => {
  mockStorage.readObject.mockReset();
  mockStorage.readObject.mockResolvedValue(Buffer.from('<!doctype html><html><body>secret draft</body></html>'));
  mockStorage.getPublicUrl.mockClear();
  statusByRevision.clear();
});

describe('GET /sim-public/* — unpublished revisions are not public', () => {
  it.each(['draft', 'uploading', 'validating', 'failed'])(
    'refuses the entry HTML of a %s revision', async (status) => {
      statusByRevision.set(REV, status);
      const app = await makeApp();

      const res = await app.inject({ method: 'GET', url: `/sim-public/${revKey('index.html')}` });

      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('secret draft');
      expect(mockStorage.readObject, 'the bytes were read before the status was checked')
        .not.toHaveBeenCalled();
    });

  it('refuses a binary asset of a failed revision instead of redirecting to the bucket', async () => {
    statusByRevision.set(REV, 'failed');
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${revKey('assets/sprite.png')}` });

    expect(res.statusCode).toBe(404);
    expect(mockStorage.getPublicUrl, 'a redirect hands the bucket URL to the caller anyway')
      .not.toHaveBeenCalled();
  });

  it.each(['active', 'retired', 'rolled_back'])(
    'still serves a %s revision', async (status) => {
      statusByRevision.set(REV, status);
      const app = await makeApp();

      const res = await app.inject({ method: 'GET', url: `/sim-public/${revKey('index.html')}` });

      expect(res.statusCode).toBe(200);
    });

  it('refuses a canary_passed revision — it is a staging state, not a published one', async () => {
    // This test previously asserted the OPPOSITE, on the strength of a comment claiming "the
    // pre-activation canary drives the real document over this route". Checked three ways on
    // 2026-08-25 and nothing does: RevisionService.validate() reads bytes from storage and that
    // file has no fetch/http at all, sim-canary-publish.ts consumes a --report file, and
    // sim-canary.spec.ts routes API_ORIGIN/** to an in-process server that 404s any real revision
    // key. simRevision.ts states outright that canary_passed is "NOT proof that a canary ran".
    statusByRevision.set(REV, 'canary_passed');
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${revKey('index.html')}` });

    expect(res.statusCode).toBe(404);
    expect(mockStorage.readObject).not.toHaveBeenCalled();
  });

  it('refuses a status this build has never heard of — the reason the list had to be inverted', async () => {
    // THE POINT OF THE WHOLE CHANGE. The old deny-list read
    // `status === null || !NEVER_PUBLISHED.has(status)`, so any status it did not recognise was
    // PUBLIC — its own comment said "Unknown status ⇒ yes (legacy)".
    //
    // That makes adding a non-public status impossible to do safely: during a rolling deploy, and
    // on any image not yet replaced, a new `proof_pending` would be served precisely BECAUSE it is
    // new — serving exactly the unproven bytes it was added to protect. So the allow-list ships
    // first, in its own release, and the new statuses follow in a later one. The order is the fix,
    // and this test is what holds it.
    statusByRevision.set(REV, 'proof_pending');
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${revKey('index.html')}` });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('secret draft');
  });

  it('still serves a legacy (non-revision) key, which has no status at all', async () => {
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/simulations/proj-1/${SIM}/index.html`,
    });

    expect(res.statusCode).toBe(200);
  });
});
