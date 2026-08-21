/**
 * D-13 — conditional GET on the three PROJECT config routes, driven through real Fastify.
 *
 * The service-level rules (cache keying, weak comparison, the revalidation predicate) are pinned
 * in `services/__tests__/playerConfigFreshness.test.ts`. What can only be checked HERE is the
 * wiring, and the wiring is where the two dangerous mistakes live:
 *
 *   • **AUTHORIZATION MUST RUN BEFORE ANY `304`.** A conditional GET is still a request for
 *     content. Answering it from a validator without re-running the gate hands a viewer who just
 *     lost access a stale allow, once a minute, for as long as they leave the tab open. The tests
 *     below revoke access between two requests and require a 404 — not a 304 — even though the
 *     client presents the tag it legitimately obtained a moment earlier.
 *
 *   • **A REVALIDATION MUST NOT COUNT AS A VIEW.** `share` and `permalink` bump `view_count` on
 *     every GET; at a 60s poll that turns one viewer of a one-hour lecture into ~60.
 *
 * Playlists are deliberately absent: D-13 excludes them explicitly (see the comment on the
 * playlist branch of `permalink.controller.ts`), and the last test in this file pins that
 * exclusion so it stays a decision rather than an oversight.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  projects:  { findFirst: vi.fn() },
  playlists: { findFirst: vi.fn() },
  video_files: { findFirst: vi.fn() },
  /** Every `db.update(...).set(...).where(...)` that actually ran. */
  viewBumps: [] as string[],
  currentUser: null as { id: string; email: string | null } | null,
  access: { allowed: true },
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: mocks.projects,
      playlists: mocks.playlists,
      video_files: mocks.video_files,
    },
    update: (table: { name: string }) => ({
      set: () => ({
        where: (clause: { id: string }) => {
          mocks.viewBumps.push(`${table.name}:${clause.id}`);
          return Promise.resolve();
        },
      }),
    }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  projects:  { name: 'projects', id: 'projects.id', view_count: 'projects.view_count', share_token: 'projects.share_token', slug: 'projects.slug' },
  playlists: { name: 'playlists', id: 'playlists.id', view_count: 'playlists.view_count', slug: 'playlists.slug' },
  video_files: { name: 'video_files', id: 'video_files.id' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, value: string) => ({ id: value }),
  sql: (parts: TemplateStringsArray) => parts.join(''),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: async (req: Record<string, unknown>) => { req.dbUser = mocks.currentUser; },
  firebaseAuthOptionalMiddleware: async (req: Record<string, unknown>) => { req.dbUser = mocks.currentUser; },
}));

/**
 * The builder returns a payload that DEPENDS ON THE REQUESTER, exactly as the real one does: a
 * cross-project branch edge carries the destination's share token only for a viewer who can reach
 * it. `configState.brollAt` is the editorial correction the poll exists to deliver.
 */
const configState = vi.hoisted(() => ({ brollAt: 10, calls: 0 }));
vi.mock('../../../services/buildPlayerConfig.js', () => ({
  buildPlayerConfig: vi.fn(async (projectId: string, requesterUserId: string | null) => {
    configState.calls += 1;
    return {
      project_id: projectId,
      segments: [{ id: 'seg-1', hls_url: 'https://cdn/seg-1.m3u8' }],
      broll_clips: [{ id: 'clip-1', global_offset_sec: configState.brollAt }],
      viewer_token: requesterUserId === 'collab-user' ? 'SECRET-COLLAB-TOKEN' : null,
    };
  }),
}));
vi.mock('../../../services/billing/BillingService.js', () => ({
  BillingService: {
    getPricing: vi.fn(async () => ({ accessType: 'free', title: 't', priceCents: 0, currency: 'usd' })),
    hasAccess: vi.fn(async () => true),
  },
}));
vi.mock('../../../services/projectAccess.js', () => ({
  requireProjectAccess: vi.fn(() => mocks.access.allowed),
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: vi.fn(),
  editablePlaylist: vi.fn(),
  isCollaborator: vi.fn(async () => false),
}));
vi.mock('../../../services/captions/CaptionService.js', () => ({
  enqueueCaptionsForProject: vi.fn(async () => {}),
  getCaptionStatusForProject: vi.fn(async () => ({ status: 'ready' })),
}));
vi.mock('../../../services/dubbing/languages.js', () => ({
  normalizeDubbingLanguage: (raw: string) => (raw ? raw : null),
}));
vi.mock('./playlists.controller.js', () => ({ buildPlaylistPlayConfig: vi.fn() }));
vi.mock('../playlists.controller.js', () => ({
  buildPlaylistPlayConfig: vi.fn(async () => ({ items: [{ id: 'i1' }] })),
}));
vi.mock('../../../services/permalinkService.js', () => ({
  normalizePermalinkSlug: (s: string) => s,
  permalinkBaseUrl: () => 'https://site',
  permalinkUrl: (s: string) => `https://site/${s}`,
  rejectPermalinkSlug: vi.fn(async () => null),
  rejectionMessage: (r: string) => r,
  suggestPermalinkSlug: vi.fn(async () => 'slug'),
}));

const { registerPlayerRoutes } = await import('../player.controller.js');
const { registerShareRoutes } = await import('../share.controller.js');
const { registerPermalinkRoutes } = await import('../permalink.controller.js');
const { resetConfigCache } = await import('../../../services/playerConfigFreshness.js');

const PROJECT_ROW = {
  id: PROJECT_ID,
  title: 'A lecture',
  topic: 'topic',
  visibility: 'public',
  access_type: 'free',
  share_token: 'SHARE-TOKEN',
  slug: 'a-lecture',
  price_cents: 0,
  currency: 'usd',
  thumbnail_url: null,
  seo_description: null,
  view_count: 0,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerPlayerRoutes(app);
  await registerShareRoutes(app);
  await registerPermalinkRoutes(app);
  await app.ready();
  return app;
}

/** The three PROJECT config surfaces the ruling names, by the url a viewer actually polls. */
const SURFACES = [
  ['player-config', `/api/v1/projects/${PROJECT_ID}/player-config`],
  ['share',         '/api/v1/share/SHARE-TOKEN'],
  ['permalink',     '/api/v1/public/permalink/a-lecture/config'],
] as const;

/** Only these two bump `view_count` today, so only these two can inflate it. */
const VIEW_COUNTING_SURFACES = SURFACES.filter(([name]) => name !== 'player-config');

beforeEach(() => {
  resetConfigCache();
  mocks.viewBumps.length = 0;
  mocks.currentUser = null;
  mocks.access.allowed = true;
  configState.brollAt = 10;
  configState.calls = 0;
  mocks.projects.findFirst.mockReset();
  mocks.projects.findFirst.mockResolvedValue(PROJECT_ROW);
  mocks.playlists.findFirst.mockReset();
  mocks.playlists.findFirst.mockResolvedValue(undefined);
});

describe.each(SURFACES)('D-13 conditional GET — %s', (_name, url) => {
  it('answers 200 with a strong ETag and a private, always-revalidate cache policy', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toBe('Authorization');
    expect(res.json().broll_clips[0].global_offset_sec).toBe(10);
    await app.close();
  });

  it('answers 304 with an empty body when the payload has not changed', async () => {
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url });
    const etag = first.headers.etag as string;

    const second = await app.inject({ method: 'GET', url, headers: { 'if-none-match': etag } });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    // The tag must survive the 304, or the next poll has nothing to revalidate with.
    expect(second.headers.etag).toBe(etag);
    await app.close();
  });

  it('delivers the corrected payload once the creator changes it', async () => {
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url });
    const etag = first.headers.etag as string;

    resetConfigCache();               // the 5s micro-cache expiring
    configState.brollAt = 25;         // the creator fixes a mis-placed clip

    const second = await app.inject({ method: 'GET', url, headers: { 'if-none-match': etag } });
    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).not.toBe(etag);
    expect(second.json().broll_clips[0].global_offset_sec).toBe(25);
    await app.close();
  });

  it('honours a weak (W/) tag from an intermediary', async () => {
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url });
    const res = await app.inject({
      method: 'GET', url, headers: { 'if-none-match': `W/${first.headers.etag}` },
    });
    expect(res.statusCode).toBe(304);
    await app.close();
  });
});

describe('AUTHORIZATION RUNS BEFORE ANY 304', () => {
  it('player-config: a viewer who loses read access gets 404, not a stale 304', async () => {
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/player-config` });
    const etag = first.headers.etag as string;
    expect(first.statusCode).toBe(200);

    // The project goes private between polls.
    mocks.access.allowed = false;

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_ID}/player-config`,
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(404);
    expect(second.headers.etag).toBeUndefined();
    await app.close();
  });

  it('share: a revoked token gets 404, not a stale 304', async () => {
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url: '/api/v1/share/SHARE-TOKEN' });
    const etag = first.headers.etag as string;

    mocks.projects.findFirst.mockResolvedValue(undefined);   // token revoked

    const second = await app.inject({
      method: 'GET', url: '/api/v1/share/SHARE-TOKEN', headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(404);
    await app.close();
  });

  it('permalink: a project turned private gets 404, not a stale 304', async () => {
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url: '/api/v1/public/permalink/a-lecture/config' });
    const etag = first.headers.etag as string;

    mocks.projects.findFirst.mockResolvedValue({ ...PROJECT_ROW, visibility: 'private' });

    const second = await app.inject({
      method: 'GET', url: '/api/v1/public/permalink/a-lecture/config', headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(404);
    await app.close();
  });

  it('player-config: the paywall still fires on a conditional request', async () => {
    const billing = await import('../../../services/billing/BillingService.js');
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/player-config` });
    const etag = first.headers.etag as string;

    vi.mocked(billing.BillingService.getPricing).mockResolvedValue(
      { accessType: 'paid', title: 't', priceCents: 500, currency: 'usd' } as any,
    );
    vi.mocked(billing.BillingService.hasAccess).mockResolvedValue(false);

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_ID}/player-config`,
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().locked).toBe(true);

    vi.mocked(billing.BillingService.getPricing).mockResolvedValue(
      { accessType: 'free', title: 't', priceCents: 0, currency: 'usd' } as any,
    );
    vi.mocked(billing.BillingService.hasAccess).mockResolvedValue(true);
    await app.close();
  });
});

describe('a revalidation is not a view', () => {
  it.each(VIEW_COUNTING_SURFACES)('%s counts the opening and NOT the re-polls', async (_name, url) => {
    const app = await buildApp();

    // The opening: no validator to offer, so it is a genuine new view.
    const first = await app.inject({ method: 'GET', url });
    expect(mocks.viewBumps).toHaveLength(1);
    const etag = first.headers.etag as string;

    // An hour of a one-hour lecture, at 60s per tick, is ~60 of these.
    for (let i = 0; i < 60; i += 1) {
      await app.inject({ method: 'GET', url, headers: { 'if-none-match': etag } });
    }
    expect(mocks.viewBumps).toHaveLength(1);
    await app.close();
  });

  it('does not count the 200 that DELIVERS a correction either — it is still a re-poll', async () => {
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url: '/api/v1/share/SHARE-TOKEN' });
    expect(mocks.viewBumps).toHaveLength(1);

    resetConfigCache();
    configState.brollAt = 25;

    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/share/SHARE-TOKEN',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(second.statusCode).toBe(200);
    expect(mocks.viewBumps).toHaveLength(1);
    await app.close();
  });

  it('a second real opening still counts — the guard is on the validator, not on the route', async () => {
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/v1/share/SHARE-TOKEN' });
    await app.inject({ method: 'GET', url: '/api/v1/share/SHARE-TOKEN' });
    expect(mocks.viewBumps).toHaveLength(2);
    await app.close();
  });
});

describe('SECURITY — the micro-cache never crosses audiences', () => {
  it('does not serve a signed-in viewer’s payload to an anonymous one', async () => {
    const app = await buildApp();

    mocks.currentUser = { id: 'collab-user', email: null };
    const collab = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/player-config` });
    expect(collab.json().viewer_token).toBe('SECRET-COLLAB-TOKEN');

    mocks.currentUser = null;
    const anon = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/player-config` });
    expect(anon.json().viewer_token).toBeNull();
    expect(anon.headers.etag).not.toBe(collab.headers.etag);

    // And the anonymous viewer must not be able to 304 their way into the collaborator's build.
    const stolen = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_ID}/player-config`,
      headers: { 'if-none-match': collab.headers.etag as string },
    });
    expect(stolen.statusCode).toBe(200);
    expect(stolen.json().viewer_token).toBeNull();
    await app.close();
  });

  it('collapses repeat viewers of ONE audience into one build (the affordability claim)', async () => {
    const app = await buildApp();
    configState.calls = 0;
    await app.inject({ method: 'GET', url: '/api/v1/share/SHARE-TOKEN' });
    await app.inject({ method: 'GET', url: '/api/v1/share/SHARE-TOKEN' });
    await app.inject({ method: 'GET', url: '/api/v1/share/SHARE-TOKEN' });
    expect(configState.calls).toBe(1);
    await app.close();
  });
});

describe('the response works cross-origin, which is the only way the viewer ever reads it', () => {
  it('keeps CORS’s Vary: Origin and exposes ETag to the browser', async () => {
    const cors = (await import('@fastify/cors')).default;
    const app = Fastify();
    // The real registration's shape: a non-`*` origin (so @fastify/cors sets `Vary: Origin`) and
    // the `exposedHeaders` entry without which `r.headers.get('etag')` reads null in the browser
    // and the freshness poll has no tag to send back.
    await app.register(cors, { origin: ['https://app.test'], credentials: true, exposedHeaders: ['ETag'] });
    await registerPlayerRoutes(app);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_ID}/player-config`,
      headers: { origin: 'https://app.test' },
    });

    expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(res.headers['access-control-expose-headers']).toContain('ETag');
    // Both fields, not one: `reply.header('Vary', …)` replaces, so a handler that set its own
    // Vary would have told a cache that one origin's CORS response is good for every origin.
    const vary = String(res.headers.vary);
    expect(vary).toContain('Origin');
    expect(vary).toContain('Authorization');
    await app.close();
  });

  /**
   * The test above builds its OWN cors registration, so on its own it proves nothing about the
   * server. `server.ts` cannot be imported here (module scope opens listeners and a database
   * connection), so this reads the source — the same shape, and for the same reason, as
   * `trustProxyWiring.test.ts`: the property being pinned is which value reaches the framework,
   * which is a wiring fact rather than a runtime behaviour.
   *
   * Without it, the whole poll silently degrades to unconditional GETs in the browser: the tag is
   * unreadable cross-origin, so every tick re-downloads the config and (on share/permalink) is
   * counted as another view. Nothing fails; the numbers just go wrong.
   */
  it('server.ts really registers cors with exposedHeaders: ETag', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const serverCode = readFileSync(resolve(here, '../../../server.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(serverCode, 'the browser cannot read an ETag that CORS does not expose')
      .toMatch(/exposedHeaders:\s*\[\s*'ETag'\s*\]/);
  });
});

describe('playlists are EXCLUDED from D-13, deliberately', () => {
  it('the playlist permalink branch carries no validator and still counts every GET', async () => {
    mocks.projects.findFirst.mockResolvedValue(undefined);
    mocks.playlists.findFirst.mockResolvedValue({
      id: 'pl-1', title: 'A playlist', description: null, banner_url: null,
      slug: 'a-playlist', access_type: 'free', price_cents: 0, currency: 'usd', view_count: 0,
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/permalink/a-playlist/config' });

    expect(res.statusCode).toBe(200);
    // No ETag: `PlaylistViewer` loads its config exactly once and never re-polls, so a validator
    // here would only invite the browser's own revalidation of a payload nothing re-reads — and
    // that revalidation would then be excluded from `view_count`, silently changing owner-visible
    // playlist analytics for no freshness benefit. Covering playlists means a per-item poll in the
    // playlist shell; until that lands, D-13 stays PARTIAL by the ruling's own terms.
    expect(res.headers.etag).toBeUndefined();
    expect(mocks.viewBumps).toEqual(['playlists:pl-1']);
    await app.close();
  });
});
