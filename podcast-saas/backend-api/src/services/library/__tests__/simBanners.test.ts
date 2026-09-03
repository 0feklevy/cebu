/**
 * Which poster banners a library tile (loadSimBannerUrls):
 *   - the served revision's, when it has one;
 *   - else the newest poster of a RETIRED revision — served once, then replaced — so a republish
 *     no longer blanks every banner of that simulation until a creator re-opens each section;
 *   - never a candidate revision that was not activated (the 2026-08-30 ruling), and never a
 *     poster whose revision is unknown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { packageRevisionFor } from 'shared/sim/simRevision';
import { derivePackageRevision } from 'shared/sim/simIdentity';

const mocks = vi.hoisted(() => ({
  posters: vi.fn(),
  revisions: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      sim_posters: { findMany: (...a: unknown[]) => mocks.posters(...a) },
      sim_revisions: { findMany: (...a: unknown[]) => mocks.revisions(...a) },
      projects: { findFirst: vi.fn() },
      simulations: { findMany: vi.fn() },
      video_files: { findMany: vi.fn() },
      image_files: { findMany: vi.fn() },
      audio_files: { findMany: vi.fn() },
    },
  },
}));
vi.mock('../../../db/schema.js', () => ({
  sim_posters: { simulation_id: 'sim_posters.simulation_id' },
  sim_revisions: { simulation_id: 'sim_revisions.simulation_id', status: 'sim_revisions.status' },
  simulations: {}, projects: {}, video_files: {}, image_files: {}, audio_files: {},
}));
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...parts: unknown[]) => ({ and: parts })),
  inArray: vi.fn((col: unknown, vals: unknown[]) => ({ col, vals })),
}));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getSimPublicUrl: (key: string) => `https://bucket.example/${key}`,
    getPublicUrl: (key: string) => `https://bucket.example/${key}`,
  }),
}));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { loadSimBannerUrls } from '../buildLibraryView.js';

const SIM = { id: 'sim-1', bridge_hash: 'abc', active_revision_id: 'rev-live' };
const served = packageRevisionFor(SIM, derivePackageRevision);
const retired = packageRevisionFor({ id: 'sim-1', active_revision_id: 'rev-old' }, derivePackageRevision);
const candidate = packageRevisionFor({ id: 'sim-1', active_revision_id: 'rev-draft' }, derivePackageRevision);

const variants = (tag: string) => [
  { size: 'standard', format: 'png', path: `simulations/p/sim-1/posters/${tag}/standard.png`, checksum: 'x', contentType: 'image/png', width: 1280, height: 720, bytes: 10 },
  { size: 'compact', format: 'png', path: `simulations/p/sim-1/posters/${tag}/compact.png`, checksum: 'y', contentType: 'image/png', width: 640, height: 360, bytes: 5 },
];
const poster = (tag: string, packageRevision: string, capturedAt: string) => ({
  id: tag, simulation_id: 'sim-1', package_revision: packageRevision, variant_key: 'v', config_hash: 'c',
  aspect_profile: 'wide', quality_profile: 'high', identity: `id-${tag}`, variants: variants(tag),
  transparent: false, captured_at: new Date(capturedAt), created_at: new Date(capturedAt),
});

beforeEach(() => {
  mocks.posters.mockReset();
  mocks.revisions.mockReset();
  mocks.revisions.mockResolvedValue([{ id: 'rev-old', simulation_id: 'sim-1' }]);
});

describe('loadSimBannerUrls', () => {
  it('prefers the served revision’s poster even when a retired one is newer', async () => {
    mocks.posters.mockResolvedValue([poster('old', retired, '2026-09-02T00:00:00Z'), poster('live', served, '2026-08-01T00:00:00Z')]);
    const out = await loadSimBannerUrls([SIM]);
    expect(out.get('sim-1')?.banner).toBe('https://bucket.example/simulations/p/sim-1/posters/live/compact.png');
  });

  it('falls back to the newest RETIRED revision’s poster when the served revision has none', async () => {
    mocks.posters.mockResolvedValue([poster('older', retired, '2026-07-01T00:00:00Z'), poster('old', retired, '2026-08-01T00:00:00Z')]);
    const out = await loadSimBannerUrls([SIM]);
    expect(out.get('sim-1')).toEqual({
      banner: 'https://bucket.example/simulations/p/sim-1/posters/old/compact.png',
      poster: 'https://bucket.example/simulations/p/sim-1/posters/old/standard.png',
    });
    // Only retired revisions were asked for.
    const where = mocks.revisions.mock.calls[0]![0].where as { and: Array<{ col: string; val?: unknown }> };
    expect(where.and.find((p) => p.col === 'sim_revisions.status')?.val).toBe('retired');
  });

  it('never banners a candidate revision that was not activated, nor an unknown one', async () => {
    mocks.posters.mockResolvedValue([poster('draft', candidate, '2026-09-02T00:00:00Z'), poster('mystery', 'deadbeefdeadbeef', '2026-09-02T00:00:00Z')]);
    const out = await loadSimBannerUrls([SIM]);
    expect(out.has('sim-1')).toBe(false);
  });

  it('a failed sim_revisions read degrades to "served revision only", not to a failed page', async () => {
    mocks.revisions.mockRejectedValue(new Error('db down'));
    mocks.posters.mockResolvedValue([poster('old', retired, '2026-08-01T00:00:00Z'), poster('live', served, '2026-08-01T00:00:00Z')]);
    const out = await loadSimBannerUrls([SIM]);
    expect(out.get('sim-1')?.banner).toContain('/posters/live/');
  });
});
