/**
 * buildPlayerConfig — orientation (migration 082, night run 2026-09-03 §3).
 *
 * One derived word, `orientation`, and the two things that key off it inside the player config:
 * a portrait project emits NO crop_url even when a crop row says 'ready', and its poster lookup
 * asks for the 'portrait' identity — the same identity the export plan captures under — so a
 * poster stored for the wide profile is (correctly) not returned for a portrait section.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPlayerConfig } from '../buildPlayerConfig.js';
import {
  DEFAULT_PRESENTATION_CONFIG, computeConfigHash, derivePackageRevision,
} from 'shared/sim/simIdentity';
import { posterIdentityString, posterStoragePath, type PosterKey } from 'shared/sim/posterIdentity';

const mocks = vi.hoisted(() => ({
  projects:           { findFirst: vi.fn() },
  video_files:        { findMany: vi.fn() },
  timeline_sections:  { findMany: vi.fn() },
  image_files:        { findMany: vi.fn() },
  audio_files:        { findMany: vi.fn() },
  scenes:             { findMany: vi.fn() },
  branch_sequences:   { findMany: vi.fn() },
  branch_choice_points: { findMany: vi.fn() },
  branch_edges:       { findMany: vi.fn() },
  playlists:          { findMany: vi.fn() },
  simulations:        { findMany: vi.fn() },
  sim_posters:        { findMany: vi.fn() },
  video_dubs:         { findMany: vi.fn() },
}));

vi.mock('../../db/index.js', () => ({ db: { query: mocks } }));
vi.mock('../../db/schema.js', () => ({
  projects:             Symbol('projects'),
  video_files:          Symbol('video_files'),
  timeline_sections:    Symbol('timeline_sections'),
  image_files:          Symbol('image_files'),
  audio_files:          Symbol('audio_files'),
  scenes:               Symbol('scenes'),
  branch_sequences:     Symbol('branch_sequences'),
  branch_choice_points: Symbol('branch_choice_points'),
  branch_edges:         Symbol('branch_edges'),
  playlists:            Symbol('playlists'),
  simulations:          Symbol('simulations'),
  sim_posters:          Symbol('sim_posters'),
  video_dubs:           Symbol('video_dubs'),
}));
vi.mock('drizzle-orm', () => ({
  eq:      vi.fn(() => ({ type: 'eq' })),
  asc:     vi.fn(() => ({ type: 'asc' })),
  inArray: vi.fn(() => ({ type: 'inArray' })),
}));
vi.mock('../projectAccess.js', () => ({ requireProjectAccess: vi.fn(() => true) }));
vi.mock('../collabAccess.js', () => ({ collaboratorContentIds: vi.fn(async () => new Set()) }));
vi.mock('../captions/CaptionService.js', () => ({ captionUrlForVideo: vi.fn(() => null) }));
vi.mock('../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getPublicUrl:    (key: string) => `https://cdn.example.com/${key}`,
    getSimPublicUrl: (key: string) => `https://cdn.example.com/sim-public/${key}`,
  }),
}));

const PROJECT = { id: 'proj-1', title: 'T', topic: null, thumbnail_url: null, avatar_config: null };

const video = (over: Record<string, unknown> = {}) => ({
  id: 'vid-1', project_id: 'proj-1', is_broll: false, filename: 'v.mp4',
  duration_sec: 100, hls_master_key: 'hls/master.m3u8', hls_360p_key: null, hls_status: 'ready',
  crop_status: 'ready', crop_key: 'crop/vid-1.json', captions_status: null, captions_error: null,
  created_at: new Date('2026-01-01'), sequence_id: null, sequence_order: null,
  width: null, height: null,
  ...over,
});

const simSection = (id: string) => ({
  id, project_id: 'proj-1', video_file_id: 'vid-1', track: 'main', type: 'simulation',
  start_sec: 0, end_sec: 10, label: id, simulation_url: 'https://x/sim.html', simulation_id: 'sim-1',
  sim_script: 'main', simple_ui: true, auto_script: true, sim_meta: null,
  clip_source_video_id: null, clip_source_image_id: null, clip_source_audio_id: null,
  clip_in_sec: 0, global_offset_sec: null, broll_volume: 1,
});

const SIM_PREFIX = 'simulations/proj-1/sim-1';
const posterKey = (aspect: 'wide' | 'portrait'): PosterKey => ({
  packageRevision: derivePackageRevision('sim-1', 'https://x/sim.html'),
  variantKey: 'sec-1',
  configHash: computeConfigHash({
    ...DEFAULT_PRESENTATION_CONFIG,
    simpleUi: true, hideSelectors: [], autoScript: true, quality: 'high', aspect,
  }),
  aspectProfile: aspect,
  qualityProfile: 'high',
});
const posterRow = (key: PosterKey) => ({
  id: `poster-${key.aspectProfile}`,
  simulation_id: 'sim-1',
  package_revision: key.packageRevision,
  variant_key: key.variantKey,
  config_hash: key.configHash,
  aspect_profile: key.aspectProfile,
  quality_profile: key.qualityProfile,
  identity: posterIdentityString(key),
  variants: [{
    size: 'standard', format: 'png', path: posterStoragePath(SIM_PREFIX, key, 'standard', 'png'),
    checksum: 'sha', contentType: 'image/png',
    width: key.aspectProfile === 'portrait' ? 720 : 1280, height: key.aspectProfile === 'portrait' ? 1280 : 720, bytes: 1,
  }],
  transparent: false,
  captured_at: new Date('2026-07-01'),
  created_at: new Date('2026-07-01'),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects.findFirst.mockResolvedValue(PROJECT);
  mocks.image_files.findMany.mockResolvedValue([]);
  mocks.audio_files.findMany.mockResolvedValue([]);
  mocks.scenes.findMany.mockResolvedValue([]);
  mocks.branch_sequences.findMany.mockResolvedValue([]);
  mocks.simulations.findMany.mockResolvedValue([]);
  mocks.sim_posters.findMany.mockResolvedValue([]);
  mocks.video_dubs.findMany.mockResolvedValue([]);
  mocks.timeline_sections.findMany.mockResolvedValue([simSection('sec-1')]);
});

describe('buildPlayerConfig — orientation', () => {
  it('a pre-082 row (no geometry) is landscape, and its ready crop is served as before', async () => {
    mocks.video_files.findMany.mockResolvedValue([video()]);
    const config = await buildPlayerConfig('proj-1');
    expect(config!.orientation).toBe('landscape');
    expect(config!.segments[0].crop_url).toBe('https://cdn.example.com/crop/vid-1.json');
  });

  it('a 1080×1920 primary video makes the project portrait and withholds the crop even when the row says ready', async () => {
    mocks.video_files.findMany.mockResolvedValue([video({ width: 1080, height: 1920 })]);
    const config = await buildPlayerConfig('proj-1');
    expect(config!.orientation).toBe('portrait');
    expect(config!.segments[0].crop_url).toBeNull();
  });

  it('b-roll geometry never decides: a portrait b-roll under a landscape main video is landscape', async () => {
    mocks.video_files.findMany.mockResolvedValue([
      video({ width: 1920, height: 1080 }),
      video({ id: 'broll', is_broll: true, width: 1080, height: 1920, created_at: new Date('2025-12-01') }),
    ]);
    const config = await buildPlayerConfig('proj-1');
    expect(config!.orientation).toBe('landscape');
  });

  it('a portrait project looks up the PORTRAIT poster identity, never the wide one', async () => {
    mocks.video_files.findMany.mockResolvedValue([video({ width: 1080, height: 1920 })]);
    // Only a WIDE poster exists: a portrait project must not wear it.
    mocks.sim_posters.findMany.mockResolvedValue([posterRow(posterKey('wide'))]);
    let config = await buildPlayerConfig('proj-1');
    expect(config!.segments[0].simulations[0].poster_url).toBeNull();

    // Now the portrait one exists too: that is the one emitted.
    mocks.sim_posters.findMany.mockResolvedValue([posterRow(posterKey('wide')), posterRow(posterKey('portrait'))]);
    config = await buildPlayerConfig('proj-1');
    expect(config!.segments[0].simulations[0].poster_url).toBe(
      `https://cdn.example.com/sim-public/${posterStoragePath(SIM_PREFIX, posterKey('portrait'), 'standard', 'png')}`,
    );
  });

  it('a landscape project keeps looking up the WIDE identity (byte-identical to before 082)', async () => {
    mocks.video_files.findMany.mockResolvedValue([video({ width: 1920, height: 1080 })]);
    mocks.sim_posters.findMany.mockResolvedValue([posterRow(posterKey('portrait')), posterRow(posterKey('wide'))]);
    const config = await buildPlayerConfig('proj-1');
    expect(config!.segments[0].simulations[0].poster_url).toBe(
      `https://cdn.example.com/sim-public/${posterStoragePath(SIM_PREFIX, posterKey('wide'), 'standard', 'png')}`,
    );
  });
});
