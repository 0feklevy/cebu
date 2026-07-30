/**
 * buildPlayerConfig — ui_hide emission on segments[].simulations[] (Minimal-UI picker).
 *
 * ui_hide comes from sim_meta.uiControls.hide and is OMITTED (undefined) when the section
 * has no selection, an empty hide list, or malformed jsonb — so the no-selection player
 * payload stays byte-identical to before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPlayerConfig } from '../buildPlayerConfig.js';

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

const VIDEO = {
  id: 'vid-1', project_id: 'proj-1', is_broll: false, filename: 'v.mp4',
  duration_sec: 100, hls_master_key: 'hls/master.m3u8', hls_360p_key: null, hls_status: 'ready',
  crop_status: null, crop_key: null, captions_status: null, captions_error: null,
  created_at: new Date('2026-01-01'), sequence_id: null, sequence_order: null,
};

const simSection = (id: string, simMeta: unknown) => ({
  id, project_id: 'proj-1', video_file_id: 'vid-1', track: 'main', type: 'simulation',
  start_sec: 0, end_sec: 10, label: id, simulation_url: 'https://x/sim.html', simulation_id: 'sim-1',
  sim_script: 'main', simple_ui: true, auto_script: true, sim_meta: simMeta,
  clip_source_video_id: null, clip_source_image_id: null, clip_source_audio_id: null,
  clip_in_sec: 0, global_offset_sec: null, broll_volume: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects.findFirst.mockResolvedValue(PROJECT);
  mocks.video_files.findMany.mockResolvedValue([VIDEO]);
  mocks.image_files.findMany.mockResolvedValue([]);
  mocks.audio_files.findMany.mockResolvedValue([]);
  mocks.scenes.findMany.mockResolvedValue([]);
  mocks.branch_sequences.findMany.mockResolvedValue([]);
});

describe('buildPlayerConfig — ui_hide', () => {
  it('emits ui_hide from sim_meta.uiControls.hide and omits it when absent/empty/malformed', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      simSection('sec-hide', { planVersion: '7', uiControls: { controls: [], show: ['#keep'], hide: ['#b', '#a'] } }),
      simSection('sec-empty-hide', { planVersion: '7', uiControls: { controls: [], show: [], hide: [] } }),
      simSection('sec-no-meta', null),
      simSection('sec-garbage', { planVersion: '7', uiControls: { hide: 'not-an-array' } }),
    ]);

    const config = await buildPlayerConfig('proj-1');
    expect(config).not.toBeNull();
    const sims = config!.segments[0].simulations;
    expect(sims).toHaveLength(4);
    const byId = new Map(sims.map((s: { id: string }) => [s.id, s]));

    expect(byId.get('sec-hide')?.ui_hide).toEqual(['#b', '#a']);   // passed through as stored
    expect(byId.get('sec-empty-hide')?.ui_hide).toBeUndefined();
    expect(byId.get('sec-no-meta')?.ui_hide).toBeUndefined();
    expect(byId.get('sec-garbage')?.ui_hide).toBeUndefined();

    // Omitted (not null) — the serialized payload for no-selection sections is unchanged.
    expect(JSON.stringify(byId.get('sec-no-meta'))).not.toContain('ui_hide');
  });

  it('keeps the rest of the simulations[] entry shape intact', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      simSection('sec-1', { uiControls: { controls: [], show: [], hide: ['#x'] } }),
    ]);
    const config = await buildPlayerConfig('proj-1');
    const sim = config!.segments[0].simulations[0];
    expect(sim).toMatchObject({
      id: 'sec-1', start_sec: 0, end_sec: 10,
      simulation_url: 'https://x/sim.html', simulation_id: 'sim-1',
      sim_script: 'main', simple_ui: true, auto_script: true,
      ui_hide: ['#x'], label: 'sec-1', type: 'simulation',
    });
  });
});
