/**
 * buildPlayerConfig's OFFSETS — the player's half of D-01.
 *
 * The player build is one of four surfaces that has to answer "what second is this section at?",
 * and it used to answer it twice, differently, within this one file: the b-roll lane read the
 * stored `global_offset_sec` while the clip and image lanes re-derived a position from a running
 * sum of `video_files.duration_sec` written out inline. Both now go through
 * `resolveSectionPlacement`, which is the same function the export planner and the sections
 * controller call.
 *
 * WHAT A BROKEN IMPLEMENTATION WOULD ALSO SATISFY, and therefore what is NOT asserted here:
 * "the b-roll came out at second 60". Today's code produces that too. The assertions below are all
 * DIFFERENTIAL — the same project rendered before and after a main video changes length — because
 * the defect is not where a clip sits on any one render, it is that the clip stops moving with the
 * content it was placed over. Only a resolver that reads the anchor can produce two different
 * answers from the same stored row, and that is the shape of every test in the first block.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPlayerConfig } from '../buildPlayerConfig.js';

const mocks = vi.hoisted(() => ({
  projects:             { findFirst: vi.fn() },
  video_files:          { findMany: vi.fn() },
  timeline_sections:    { findMany: vi.fn() },
  image_files:          { findMany: vi.fn() },
  audio_files:          { findMany: vi.fn() },
  scenes:               { findMany: vi.fn() },
  branch_sequences:     { findMany: vi.fn() },
  branch_choice_points: { findMany: vi.fn() },
  branch_edges:         { findMany: vi.fn() },
  playlists:            { findMany: vi.fn() },
  simulations:          { findMany: vi.fn() },
  sim_posters:          { findMany: vi.fn() },
}));

vi.mock('../../db/index.js', () => ({ db: { query: mocks } }));
vi.mock('../../db/schema.js', () => ({
  projects: Symbol('projects'), video_files: Symbol('video_files'),
  timeline_sections: Symbol('timeline_sections'), image_files: Symbol('image_files'),
  audio_files: Symbol('audio_files'), scenes: Symbol('scenes'),
  branch_sequences: Symbol('branch_sequences'), branch_choice_points: Symbol('branch_choice_points'),
  branch_edges: Symbol('branch_edges'), playlists: Symbol('playlists'),
  simulations: Symbol('simulations'), sim_posters: Symbol('sim_posters'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })), asc: vi.fn(() => ({ type: 'asc' })),
  inArray: vi.fn(() => ({ type: 'inArray' })),
}));
vi.mock('../projectAccess.js', () => ({ requireProjectAccess: vi.fn(() => true) }));
vi.mock('../collabAccess.js', () => ({ collaboratorContentIds: vi.fn(async () => new Set()) }));
vi.mock('../captions/CaptionService.js', () => ({ captionUrlForVideo: vi.fn(() => null) }));
vi.mock('../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getPublicUrl: (key: string) => `https://cdn.example.com/${key}`,
    getSimPublicUrl: (key: string) => `https://cdn.example.com/sim-public/${key}`,
  }),
}));
const logged = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: logged.warn, error: logged.error, debug: logged.debug },
}));
vi.mock('../simulation/RumService.js', () => ({
  resolveRumSampleRate: async () => 0,
  resolveSimRuntimeFlags: async () => ({ schedulerMode: 'off', adaptiveQuality: false, boundarySentinel: false }),
  fieldAggregates: async () => new Map(),
}));

const PROJECT = { id: 'proj-1', title: 'T', topic: null, thumbnail_url: null, avatar_config: null };

const video = (over: Record<string, unknown> = {}) => ({
  id: 'vid-a', project_id: 'proj-1', is_broll: false, filename: 'a.mp4',
  duration_sec: 30, hls_master_key: 'hls/a.m3u8', hls_360p_key: null, hls_status: 'ready',
  storage_key: 'raw/a.mp4', crop_status: null, crop_key: null,
  captions_status: null, captions_error: null,
  created_at: new Date('2026-01-01'), sequence_id: null, sequence_order: null, ...over,
});

/** A = [0,30), B = [30,70). The b-roll SOURCE is not a segment and must not widen the timeline. */
const VID_A = video({ id: 'A', filename: 'a.mp4', duration_sec: 30, created_at: new Date('2026-01-01') });
const VID_B = video({ id: 'B', filename: 'b.mp4', duration_sec: 40, created_at: new Date('2026-01-02') });
const SOURCE = video({
  id: 'src', is_broll: true, filename: 'gen.mp4', duration_sec: 6,
  hls_master_key: 'hls/src.m3u8', created_at: new Date('2026-01-03'),
});
/** The same project after A is re-transcoded five seconds shorter: A = [0,25), B = [25,65). */
const VID_A_SHORTER = video({ ...VID_A, duration_sec: 25 });

const section = (over: Record<string, unknown> = {}) => ({
  id: 'sec-1', project_id: 'proj-1', video_file_id: 'A', track: 'main', type: 'video',
  start_sec: 0, end_sec: 10, label: null, notes: null, sort_order: null,
  simulation_url: null, simulation_id: null, sim_script: null, sim_prompt: null, sim_meta: null,
  simple_ui: false, auto_script: true,
  global_offset_sec: null, clip_source_video_id: null, clip_source_image_id: null,
  clip_source_audio_id: null, clip_in_sec: 0, broll_volume: 1,
  anchor_video_file_id: null, anchor_offset_sec: null, placement_mode: 'legacy_absolute',
  created_at: new Date('2026-01-01'), ...over,
});

type Overlay = { id: string; global_offset_sec: number };
type Config = {
  broll_clips: Overlay[];
  clip_overlays: Overlay[];
  image_overlays: Overlay[];
  audio_cutaways: Overlay[];
};

const config = async (): Promise<Config> =>
  (await buildPlayerConfig('proj-1', 'user-1')) as unknown as Config;

/** Every overlay the viewer will place, whatever lane it came out of, by id. */
const offsets = async (): Promise<Record<string, number>> => {
  const c = await config();
  const out: Record<string, number> = {};
  for (const o of [...c.broll_clips, ...c.clip_overlays, ...c.image_overlays, ...c.audio_cutaways]) {
    out[o.id] = o.global_offset_sec;
  }
  return out;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects.findFirst.mockResolvedValue(PROJECT);
  mocks.video_files.findMany.mockResolvedValue([VID_A, VID_B, SOURCE]);
  mocks.timeline_sections.findMany.mockResolvedValue([]);
  mocks.image_files.findMany.mockResolvedValue([]);
  mocks.audio_files.findMany.mockResolvedValue([]);
  mocks.scenes.findMany.mockResolvedValue([]);
  mocks.branch_sequences.findMany.mockResolvedValue([]);
  mocks.simulations.findMany.mockResolvedValue([]);
  mocks.sim_posters.findMany.mockResolvedValue([]);
});

// ── The differential test ─────────────────────────────────────────────────────

describe('a re-transcode of video A', () => {
  /** All three express "ten seconds into B" — second 40 on today's timeline. */
  const LEGACY_BROLL = section({
    id: 'legacy', track: 'broll', type: 'broll', video_file_id: 'src',
    start_sec: 0, end_sec: 6, global_offset_sec: 40,
  });
  const ANCHORED_BROLL = section({
    id: 'anchored', track: 'broll', type: 'broll', video_file_id: 'src',
    start_sec: 0, end_sec: 6, global_offset_sec: 40,
    placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: 10,
  });
  const CLIP = section({
    id: 'clip', track: 'main', type: 'clip', video_file_id: 'B',
    clip_source_video_id: 'src', start_sec: 10, end_sec: 16, clip_in_sec: 0,
  });

  beforeEach(() => {
    mocks.timeline_sections.findMany.mockResolvedValue([LEGACY_BROLL, ANCHORED_BROLL, CLIP]);
  });

  it('leaves all three on the same second while nothing has changed', async () => {
    expect(await offsets()).toEqual({ legacy: 40, anchored: 40, clip: 40 });
  });

  it('moves the ANCHORED b-roll and the clip with the content, and leaves the legacy one behind', async () => {
    // This is the whole of D-01 in one render. The three rows are byte-identical to the ones above;
    // only `video_files.duration_sec` changed. A player build that read `global_offset_sec` for the
    // b-roll lane — which is what it did before — cannot produce two different numbers for `legacy`
    // and `anchored`, because it has exactly one field to read.
    mocks.video_files.findMany.mockResolvedValue([VID_A_SHORTER, VID_B, SOURCE]);
    const after = await offsets();

    expect(after.anchored).toBe(35);        // B now starts at 25; ten seconds in is 35
    expect(after.clip).toBe(35);            // the clip lane has always followed its host
    expect(after.anchored).toBe(after.clip);
    expect(after.legacy).toBe(40);          // pinned to the wall clock — five seconds late
    expect(after.anchored).not.toBe(after.legacy);
  });
});

// ── One layout for every lane ─────────────────────────────────────────────────

describe('every lane is placed off the SAME segment layout', () => {
  it('does not let a b-roll SOURCE video widen the main timeline', async () => {
    // `src` is `is_broll` and sits between A and B by `created_at`. If it were counted as a
    // segment, every clip and image overlay on B would shift six seconds later — and the b-roll
    // lane, which does not use the layout at all, would not move, so the two lanes would disagree
    // about the same moment. Both are placed off `buildMainSegmentTimeline`, which does the filter.
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({ id: 'clip-on-b', track: 'main', type: 'clip', video_file_id: 'B',
        clip_source_video_id: 'src', start_sec: 0, end_sec: 5, clip_in_sec: 0 }),
      section({ id: 'broll-at-30', track: 'broll', type: 'broll', video_file_id: 'src',
        start_sec: 0, end_sec: 5, global_offset_sec: 30 }),
    ]);
    const o = await offsets();
    expect(o['clip-on-b']).toBe(30);        // NOT 36
    expect(o['broll-at-30']).toBe(30);
  });

  it('places an image overlay and an audio cutaway through the same resolver', async () => {
    mocks.image_files.findMany.mockResolvedValue([
      { id: 'img-1', original_url: 'https://cdn/img.png', crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 },
    ]);
    mocks.audio_files.findMany.mockResolvedValue([{ id: 'aud-1', url: 'https://cdn/a.mp3' }]);
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({ id: 'img', track: 'main', type: 'clip', video_file_id: 'B',
        clip_source_image_id: 'img-1', start_sec: 4, end_sec: 9 }),
      section({ id: 'cut', track: 'audio', type: 'audio', video_file_id: 'A',
        clip_source_audio_id: 'aud-1', start_sec: 0, end_sec: 5, global_offset_sec: 34,
        placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: 4 }),
    ]);

    expect(await offsets()).toMatchObject({ img: 34, cut: 34 });

    // …and they stay together when A shrinks, which the stored 34 could not have done.
    mocks.video_files.findMany.mockResolvedValue([VID_A_SHORTER, VID_B, SOURCE]);
    expect(await offsets()).toMatchObject({ img: 29, cut: 29 });
  });
});

// ── Degradation is never silent ───────────────────────────────────────────────

describe('a placement that could not be resolved', () => {
  it('still plays, at its stored second, and says why', async () => {
    // The `ON DELETE SET NULL` residue: the anchored row's host video was deleted. Dropping the row
    // would blank an overlay out of the viewer for a reason no one could see; falling back keeps
    // today's behaviour and makes the fault findable.
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({ id: 'orphan', track: 'broll', type: 'broll', video_file_id: 'src',
        start_sec: 0, end_sec: 5, global_offset_sec: 40,
        placement_mode: 'segment', anchor_video_file_id: null, anchor_offset_sec: null }),
    ]);
    const o = await offsets();
    expect(o.orphan).toBe(40);
    expect(logged.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sectionId: 'orphan', degradation: 'anchor_missing' }),
      expect.stringContaining('placement degraded'),
    );
  });

  it('names a main-track section whose host is not in the timeline, instead of silently using zero', async () => {
    // `videoGlobalOffsets.get(id) ?? 0`, which is what this file used to do — the row landed at its
    // local second with no log line at all.
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({ id: 'homeless', track: 'main', type: 'clip', video_file_id: 'src',
        clip_source_video_id: 'src', start_sec: 3, end_sec: 8, clip_in_sec: 0 }),
    ]);
    const o = await offsets();
    expect(o.homeless).toBe(3);
    expect(logged.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sectionId: 'homeless', degradation: 'host_not_a_segment' }),
      expect.stringContaining('placement degraded'),
    );
  });
});
