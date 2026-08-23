/**
 * DELETING THE THING MUST DELETE ITS BYTES.
 *
 * A code-level audit mapped ~30 storage writers against 11 deleters and found five delete paths
 * that removed rows and left every byte behind — after which the FK cascade destroyed the only
 * rows that named the keys, making the bytes permanently unreachable:
 *
 *   podcast show delete      cleaned nothing (renders, chunks, clips, previews, sources)
 *   podcast episode delete   cleaned nothing
 *   podcast source delete    cleaned nothing (uploaded PDFs/documents)
 *   image delete             cleaned nothing — while the REPLACE path on the same controller
 *                            GC'd correctly sixty lines above
 *   playlist delete          cleaned nothing (banners, including every superseded one)
 *
 * Each case here drives the real route over a mocked db/storage and asserts the exact keys and
 * prefixes. The podcast cases also pin the two-prefix-shape rule: sources live under
 * `podcasts/{showId}/…` while renders/chunks/clips/previews live under `podcasts/{episodeId}/…`
 * — a sweep of either shape alone silently misses the other, which is precisely the mistake a
 * future simplification would make.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { callArgs } from '../../../__tests__/helpers/mockCalls.js';

const mocks = vi.hoisted(() => ({
  deleteWithFallback: vi.fn(async () => {}),
  deleteWithPrefixFallback: vi.fn(async () => {}),
  episodesFindMany: vi.fn(async () => [] as Array<{ id: string }>),
  sourceDeleteReturning: vi.fn(async () => [] as Array<{ storage_key: string | null }>),
  imageDeleteReturning: vi.fn(async () => [] as Array<{ storage_key: string | null }>),
}));

vi.mock('../../../services/storage/deleteWithFallback.js', () => ({
  deleteWithFallback: mocks.deleteWithFallback,
  deleteWithPrefixFallback: mocks.deleteWithPrefixFallback,
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _r: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
}));

beforeEach(() => {
  mocks.deleteWithFallback.mockClear();
  mocks.deleteWithPrefixFallback.mockClear();
});

describe('podcast deletes remove their bytes', () => {
  vi.mock('../../../services/podcastAccess.js', () => ({
    ownedShow: async (id: string) => (id === 'show-1' ? { id: 'show-1' } : null),
    ownedEpisodeInShow: async (showId: string, epId: string) =>
      epId === 'ep-1' ? { show: { id: showId }, episode: { id: 'ep-1' } } : null,
  }));

  async function mountPodcast() {
    vi.doMock('../../../db/index.js', () => ({
      db: {
        query: { podcast_episodes: { findMany: mocks.episodesFindMany } },
        delete: () => ({
          // where(cond) must be BOTH awaitable (show/episode routes `await db.delete().where()`)
          // and carry `.returning` (the source route chains it).
          where: () => ({
            returning: mocks.sourceDeleteReturning,
            then: (resolve: (v: unknown[]) => void) => resolve([]),
          }),
        }),
      },
    }));
    const { registerPodcastRoutes } = await import('../podcast.controller.js');
    const app = Fastify();
    await registerPodcastRoutes(app);
    return app;
  }

  it('show delete sweeps the show prefix AND every episode prefix — both shapes', async () => {
    mocks.episodesFindMany.mockResolvedValueOnce([{ id: 'ep-a' }, { id: 'ep-b' }]);
    const app = await mountPodcast();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/podcasts/show-1' });
    expect(res.statusCode).toBe(204);

    const prefixes = callArgs<string>(mocks.deleteWithPrefixFallback).sort();
    // `podcast-sources/` joined the list when source documents moved off the PUBLIC `podcasts/`
    // prefix (security-016). A document that outlives the show that owned it is the same exposure
    // with a longer fuse, so the show delete has to sweep both — and this exact-set assertion is
    // what forced that to be noticed rather than discovered later in a bucket listing.
    expect(prefixes).toEqual([
      'podcast-sources/show-1',
      'podcasts/ep-a', 'podcasts/ep-b', 'podcasts/show-1',
    ]);
    await app.close();
  });

  it('episode delete sweeps BOTH prefix shapes for that episode', async () => {
    const app = await mountPodcast();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/podcasts/show-1/episodes/ep-1' });
    expect(res.statusCode).toBe(204);

    const prefixes = callArgs<string>(mocks.deleteWithPrefixFallback).sort();
    expect(prefixes).toEqual([
      'podcast-sources/show-1/episodes/ep-1',
      'podcasts/ep-1', 'podcasts/show-1/episodes/ep-1',
    ]);
    await app.close();
  });

  it('source delete removes the uploaded document; url/note sources (no key) delete nothing', async () => {
    mocks.sourceDeleteReturning.mockResolvedValueOnce([{ storage_key: 'podcasts/show-1/episodes/ep-1/sources/doc.pdf' }]);
    const app = await mountPodcast();
    let res = await app.inject({ method: 'DELETE', url: '/api/v1/podcasts/show-1/episodes/ep-1/sources/src-1' });
    expect(res.statusCode).toBe(204);
    expect(mocks.deleteWithFallback).toHaveBeenCalledWith('podcasts/show-1/episodes/ep-1/sources/doc.pdf');

    mocks.deleteWithFallback.mockClear();
    mocks.sourceDeleteReturning.mockResolvedValueOnce([{ storage_key: null }]);
    res = await app.inject({ method: 'DELETE', url: '/api/v1/podcasts/show-1/episodes/ep-1/sources/src-2' });
    expect(res.statusCode).toBe(204);
    expect(mocks.deleteWithFallback).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('image delete removes the object', () => {
  it('deletes exactly the key the row named — via .returning(), so the key survives the row', async () => {
    vi.doMock('../../../db/index.js', () => ({
      db: {
        delete: () => ({
          where: () => ({ returning: mocks.imageDeleteReturning }),
        }),
      },
    }));
    vi.doMock('../../../services/collabAccess.js', () => ({
      editableProject: async () => ({ id: 'proj-1' }),
    }));
    mocks.imageDeleteReturning.mockResolvedValueOnce([{ storage_key: 'images/proj-1/img.png' }]);

    const { registerImageRoutes } = await import('../images.controller.js');
    const app = Fastify();
    await registerImageRoutes(app);
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/projects/proj-1/images/img-1' });
    expect(res.statusCode).toBe(204);
    expect(mocks.deleteWithFallback).toHaveBeenCalledWith('images/proj-1/img.png');
    await app.close();
  });
});
