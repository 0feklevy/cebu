/**
 * buildPlayerConfig's overlay DISPATCH — one row, one lane, one order.
 *
 * Three defects live here and all three are the same defect wearing different hats: the file
 * re-derived "what is this row?" separately at every emit site instead of asking once.
 *
 *   1. DOUBLE EMISSION. `track==='broll' && !clip_source_audio_id` and
 *      `type==='clip' && clip_source_video_id` are not disjoint predicates. A row that is
 *      `track='broll' AND type='clip' AND clip_source_video_id IS NOT NULL` satisfies BOTH and was
 *      emitted twice, at two different offsets, into the single array the viewer `.find()`s over
 *      (`[...broll_clips, ...clip_overlays]`). The user sees one clip play twice.
 *
 *   2. NON-DETERMINISTIC ORDER. The section query ordered by `start_sec` alone. On the b-roll track
 *      `start_sec` is a source in-point — almost always 0 — so every b-roll row ties, and a tie lets
 *      Postgres return them in any order. The viewer's `.find()` takes the FIRST match, so which of
 *      two overlapping clips plays was decided by the query planner. That is why the symptom was
 *      intermittent, and why this file asserts on a SHUFFLED input.
 *
 *   3. SILENT OMISSION. A "Use Existing" b-roll sourced from one of the user's own uploaded videos
 *      is accepted by the API, previewed by the editor and rendered by the export — and dropped by
 *      the player, because the b-roll source map was built from `is_broll` videos only. No log, no
 *      warning, no counter. The census confirmed the whole chain end to end.
 *
 * None of these tests touch how an offset is COMPUTED. The b-roll lane's stored offset and the clip
 * lane's derived one disagree, and reconciling them is a blocked product decision (D-01); the
 * assertions below pin each row to ONE lane and one order, never to a re-anchored position.
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
  id: 'vid-main', project_id: 'proj-1', is_broll: false, filename: 'main.mp4',
  duration_sec: 100, hls_master_key: 'hls/main.m3u8', hls_360p_key: null, hls_status: 'ready',
  storage_key: 'raw/main.mp4', crop_status: null, crop_key: null,
  captions_status: null, captions_error: null,
  created_at: new Date('2026-01-01'), sequence_id: null, sequence_order: null, ...over,
});

/** The AI-generated b-roll source: `is_broll = true`. */
const BROLL_VIDEO = video({
  id: 'vid-broll', is_broll: true, filename: 'gen.mp4', hls_master_key: 'hls/broll.m3u8',
  created_at: new Date('2026-01-02'),
});
/** A NORMAL uploaded library video — the "Use Existing" source the player used to drop. */
const LIBRARY_VIDEO = video({
  id: 'vid-lib', is_broll: false, filename: 'library.mp4', hls_master_key: 'hls/library.m3u8',
  created_at: new Date('2026-01-03'),
});

const section = (over: Record<string, unknown> = {}) => ({
  id: 'sec-1', project_id: 'proj-1', video_file_id: 'vid-main', track: 'main', type: 'video',
  start_sec: 0, end_sec: 10, label: null, notes: null, sort_order: null,
  simulation_url: null, simulation_id: null, sim_script: null, sim_prompt: null, sim_meta: null,
  simple_ui: false, auto_script: true,
  global_offset_sec: null, clip_source_video_id: null, clip_source_image_id: null,
  clip_source_audio_id: null, clip_in_sec: 0, broll_volume: 1,
  created_at: new Date('2026-01-01'), ...over,
});

type Overlay = { id: string; global_offset_sec: number; start_sec: number; end_sec: number };
type Config = {
  broll_clips: Overlay[];
  clip_overlays: Overlay[];
  image_overlays: Array<{ id: string; global_offset_sec: number }>;
  audio_cutaways: Overlay[];
};

async function config(): Promise<Config> {
  return (await buildPlayerConfig('proj-1', 'user-1')) as unknown as Config;
}

/** Every id the viewer will `.find()` over, in the order it concatenates them. */
const overlayIds = (c: Config): string[] =>
  [...c.broll_clips, ...c.clip_overlays].map((o) => o.id);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects.findFirst.mockResolvedValue(PROJECT);
  mocks.video_files.findMany.mockResolvedValue([video(), BROLL_VIDEO, LIBRARY_VIDEO]);
  mocks.timeline_sections.findMany.mockResolvedValue([]);
  mocks.image_files.findMany.mockResolvedValue([]);
  mocks.audio_files.findMany.mockResolvedValue([]);
  mocks.scenes.findMany.mockResolvedValue([]);
  mocks.branch_sequences.findMany.mockResolvedValue([]);
  mocks.simulations.findMany.mockResolvedValue([]);
  mocks.sim_posters.findMany.mockResolvedValue([]);
});

// ── 1. Mutually exclusive lanes ───────────────────────────────────────────────

describe('the malformed hybrid row', () => {
  /** track='broll' AND type='clip' AND clip_source_video_id — satisfies both old filters. */
  const HYBRID = section({
    id: 'sec-hybrid', track: 'broll', type: 'clip',
    video_file_id: 'vid-broll', clip_source_video_id: 'vid-lib',
    global_offset_sec: 60, start_sec: 0, end_sec: 8, clip_in_sec: 2,
  });

  beforeEach(() => { mocks.timeline_sections.findMany.mockResolvedValue([HYBRID]); });

  it('is emitted EXACTLY ONCE across every overlay array', async () => {
    const c = await config();
    const all = [...c.broll_clips, ...c.clip_overlays, ...c.image_overlays, ...c.audio_cutaways];
    expect(all.filter((o) => o.id === 'sec-hybrid')).toHaveLength(1);
  });

  it('plays in the b-roll lane, because on a broll row `track` beats `type`', async () => {
    // `type` is rewritten to 'video' by any Save from the section editor, so a row whose LANE
    // depended on `type` would change lanes behind the user's back. `track` is what every other
    // consumer already keys on, and it is the reading the viewer and the editor show today.
    const c = await config();
    expect(c.broll_clips.map((o) => o.id)).toEqual(['sec-hybrid']);
    expect(c.clip_overlays).toEqual([]);
  });

  it('keeps the STORED offset of the b-roll lane — no re-anchoring', async () => {
    // D-01 is blocked. This pins that making the lanes disjoint did not quietly change
    // where a clip sits: the surviving copy is the one the viewer already played.
    const c = await config();
    expect(c.broll_clips[0]!.global_offset_sec).toBe(60);
    expect(c.broll_clips[0]!.start_sec).toBe(0);
    expect(c.broll_clips[0]!.end_sec).toBe(8);
  });
});

describe('lane exclusivity holds for every combination of the discriminating columns', () => {
  it('never emits one row into two arrays', async () => {
    const rows = [] as ReturnType<typeof section>[];
    let n = 0;
    for (const track of ['main', 'broll', 'audio']) {
      for (const type of ['video', 'broll', 'clip', 'simulation']) {
        for (const video_id of [null, 'vid-lib']) {
          for (const image_id of [null, 'img-1']) {
            for (const audio_id of [null, 'aud-1']) {
              rows.push(section({
                id: `sec-${n++}`, track, type,
                video_file_id: 'vid-broll',
                clip_source_video_id: video_id,
                clip_source_image_id: image_id,
                clip_source_audio_id: audio_id,
                global_offset_sec: 5, start_sec: 0, end_sec: 4,
              }));
            }
          }
        }
      }
    }
    mocks.timeline_sections.findMany.mockResolvedValue(rows);
    mocks.image_files.findMany.mockResolvedValue([
      { id: 'img-1', project_id: 'proj-1', original_url: 'https://x/i.png', crop_x: null, crop_y: null, crop_w: null, crop_h: null },
    ]);
    mocks.audio_files.findMany.mockResolvedValue([
      { id: 'aud-1', project_id: 'proj-1', url: 'https://x/a.mp3' },
    ]);

    const c = await config();
    const emitted = [...c.broll_clips, ...c.clip_overlays, ...c.image_overlays, ...c.audio_cutaways]
      .map((o) => o.id);
    const duplicated = emitted.filter((id, i) => emitted.indexOf(id) !== i);
    expect([...new Set(duplicated)]).toEqual([]);
  });
});

// ── 2. Deterministic total ordering ───────────────────────────────────────────

describe('overlay order is a function of the rows, not of the row order the database returned', () => {
  /** Four b-roll rows that ALL tie on start_sec — exactly the population that made this random. */
  const tied = [
    section({ id: 'aaa', track: 'broll', type: 'broll', video_file_id: 'vid-broll', global_offset_sec: 30, start_sec: 0, end_sec: 5 }),
    section({ id: 'bbb', track: 'broll', type: 'broll', video_file_id: 'vid-broll', global_offset_sec: 10, start_sec: 0, end_sec: 5 }),
    section({ id: 'ccc', track: 'broll', type: 'broll', video_file_id: 'vid-broll', global_offset_sec: 20, start_sec: 0, end_sec: 5 }),
    section({ id: 'ddd', track: 'broll', type: 'broll', video_file_id: 'vid-broll', global_offset_sec: 20, start_sec: 0, end_sec: 5 }),
  ];

  it('is identical for every permutation of the same rows', async () => {
    const seen = new Set<string>();
    for (const order of permutations(tied)) {
      mocks.timeline_sections.findMany.mockResolvedValue(order);
      seen.add(overlayIds(await config()).join(','));
    }
    expect([...seen]).toHaveLength(1);
  });

  it('orders tied b-roll rows by their position on the timeline', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([...tied].reverse());
    const c = await config();
    expect(c.broll_clips.map((o) => o.global_offset_sec)).toEqual([10, 20, 20, 30]);
    // …and the two rows that tie on offset too are separated by id, so `.find()` is stable.
    expect(c.broll_clips.map((o) => o.id)).toEqual(['bbb', 'ccc', 'ddd', 'aaa']);
  });
});

// ── 3. The is_broll viewer-parity omission ────────────────────────────────────

describe('a "Use Existing" b-roll sourced from a normal uploaded video', () => {
  const USE_EXISTING = section({
    id: 'sec-use-existing', track: 'broll', type: 'broll',
    video_file_id: 'vid-lib',                 // is_broll = false — a plain library upload
    global_offset_sec: 42, start_sec: 1, end_sec: 9,
  });

  beforeEach(() => { mocks.timeline_sections.findMany.mockResolvedValue([USE_EXISTING]); });

  it('reaches the player instead of being silently dropped', async () => {
    // The editor previews it, the export renders it, the API accepts it. Only the player omitted
    // it — and omitted it without a single log line.
    const c = await config();
    expect(c.broll_clips.map((o) => o.id)).toEqual(['sec-use-existing']);
  });

  it('resolves the source video it was actually given', async () => {
    const c = await config();
    expect((c.broll_clips[0] as unknown as { hls_url: string }).hls_url)
      .toBe('https://cdn.example.com/hls/library.m3u8');
  });

  it('still drops — but now REPORTS — a b-roll whose source cannot be resolved at all', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({ id: 'sec-orphan', track: 'broll', type: 'broll', video_file_id: 'vid-gone', global_offset_sec: 3 }),
    ]);
    const c = await config();
    expect(c.broll_clips).toEqual([]);
    expect(logged.warn).toHaveBeenCalled();
  });
});

// ── The lanes that already worked keep working ────────────────────────────────

describe('the well-formed shapes are unchanged', () => {
  it('a main-track "Existing Visual" still derives its offset from the host video', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({
        id: 'sec-clip', track: 'main', type: 'clip', video_file_id: 'vid-main',
        clip_source_video_id: 'vid-lib', start_sec: 12, end_sec: 20, clip_in_sec: 3,
      }),
    ]);
    const c = await config();
    expect(c.clip_overlays).toHaveLength(1);
    expect(c.clip_overlays[0]).toMatchObject({
      id: 'sec-clip', global_offset_sec: 12, start_sec: 3, end_sec: 11,
    });
    expect(c.broll_clips).toEqual([]);
  });

  it('an audio cutaway stays audio, and stays out of the visual lanes', async () => {
    mocks.audio_files.findMany.mockResolvedValue([{ id: 'aud-1', project_id: 'proj-1', url: 'https://x/a.mp3' }]);
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({
        id: 'sec-audio', track: 'broll', type: 'broll', video_file_id: 'vid-broll',
        clip_source_audio_id: 'aud-1', global_offset_sec: 15, start_sec: 0, end_sec: 6,
      }),
    ]);
    const c = await config();
    expect(c.audio_cutaways.map((o) => o.id)).toEqual(['sec-audio']);
    expect(c.broll_clips).toEqual([]);
    expect(c.clip_overlays).toEqual([]);
  });

  it('an image overlay still derives its offset from the host video', async () => {
    mocks.image_files.findMany.mockResolvedValue([
      { id: 'img-1', project_id: 'proj-1', original_url: 'https://x/i.png', crop_x: null, crop_y: null, crop_w: null, crop_h: null },
    ]);
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({
        id: 'sec-img', track: 'main', type: 'clip', video_file_id: 'vid-main',
        clip_source_image_id: 'img-1', start_sec: 7, end_sec: 11,
      }),
    ]);
    const c = await config();
    expect(c.image_overlays).toHaveLength(1);
    expect(c.image_overlays[0]).toMatchObject({ id: 'sec-img', global_offset_sec: 7 });
  });
});

/** Every ordering of the input, so "the DB may return these in any order" is actually exercised. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}
