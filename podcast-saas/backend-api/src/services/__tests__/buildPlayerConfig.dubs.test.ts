/**
 * buildPlayerConfig's language dimension (migration 067).
 *
 * The design under test: the language swap happens ON THE SERVER, so a dubbed lesson reaches the
 * player as an ordinary player config with different URLs in it. The viewer needs no second state
 * machine, no audio-track switching, and — this is the point — no opportunity to end up with
 * audio in one language and captions in another, because ONE decision here picks both.
 *
 * Four properties:
 *   1. audio and captions move together, always;
 *   2. a language is offered only when EVERY main video has a servable dub in it, so a viewer never
 *      gets a lesson that reverts to the source partway through;
 *   3. a watermarked dub is invisible to viewers, however finished it is;
 *   4. an unknown or unavailable language falls back to the source track rather than failing, so a
 *      shared /he link survives that dub being deleted.
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
  video_dubs:           { findMany: vi.fn() },
}));

vi.mock('../../db/index.js', () => ({ db: { query: mocks } }));
vi.mock('../../db/schema.js', () => ({
  projects: Symbol('projects'), video_files: Symbol('video_files'),
  timeline_sections: Symbol('timeline_sections'), image_files: Symbol('image_files'),
  audio_files: Symbol('audio_files'), scenes: Symbol('scenes'),
  branch_sequences: Symbol('branch_sequences'), branch_choice_points: Symbol('branch_choice_points'),
  branch_edges: Symbol('branch_edges'), playlists: Symbol('playlists'),
  simulations: Symbol('simulations'), sim_posters: Symbol('sim_posters'),
  video_dubs: Symbol('video_dubs'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })), asc: vi.fn(() => ({ type: 'asc' })),
  inArray: vi.fn(() => ({ type: 'inArray' })),
}));
vi.mock('../projectAccess.js', () => ({ requireProjectAccess: vi.fn(() => true) }));
vi.mock('../collabAccess.js', () => ({ collaboratorContentIds: vi.fn(async () => new Set()) }));
vi.mock('../captions/CaptionService.js', () => ({
  captionUrlForVideo: vi.fn(() => 'https://api.example.com/api/v1/videos/vid-main/captions.vtt'),
}));
vi.mock('../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getPublicUrl: (key: string) => `https://cdn.example.com/${key}`,
    getSimPublicUrl: (key: string) => `https://cdn.example.com/sim-public/${key}`,
  }),
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../simulation/RumService.js', () => ({
  resolveRumSampleRate: async () => 0,
  resolveSimRuntimeFlags: async () => ({ schedulerMode: 'off', adaptiveQuality: false, boundarySentinel: false }),
  fieldAggregates: async () => new Map(),
}));
vi.mock('../../config/publicOrigins.js', () => ({ publicApiOrigin: () => 'https://api.example.com' }));

const PROJECT = { id: 'proj-1', title: 'T', topic: null, thumbnail_url: null, avatar_config: null };

const video = (over: Record<string, unknown> = {}) => ({
  id: 'vid-main', project_id: 'proj-1', is_broll: false, filename: 'main.mp4',
  duration_sec: 100, hls_master_key: 'hls/main.m3u8', hls_360p_key: null, hls_status: 'ready',
  storage_key: 'raw/main.mp4', crop_status: null, crop_key: null,
  captions_status: 'ready', captions_vtt: 'WEBVTT\n\nsource', captions_vtt_key: null, captions_error: null,
  created_at: new Date('2026-01-01'), sequence_id: null, sequence_order: null, ...over,
});

const dub = (over: Record<string, unknown> = {}) => ({
  id: 'dub-he-1', video_file_id: 'vid-main', target_language: 'he', provider: 'elevenlabs',
  status: 'completed', watermarked: false,
  hls_master_key: 'dubs/vid-main/he/hls/dub-he-1/master.m3u8',
  captions_vtt: 'WEBVTT\n\nשלום', ...over,
});

interface Segment {
  id: string;
  hls_url: string | null;
  fallback_url: string | null;
  captions?: { status: string; vtt_url: string | null };
}
interface Config {
  segments: Segment[];
  language: string | null;
  available_languages: Array<{ code: string; name: string; endonym: string; rtl: boolean }>;
}

const config = async (language?: string | null): Promise<Config> =>
  (await buildPlayerConfig('proj-1', 'user-1', undefined, language ?? null)) as unknown as Config;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects.findFirst.mockResolvedValue(PROJECT);
  mocks.video_files.findMany.mockResolvedValue([video()]);
  mocks.timeline_sections.findMany.mockResolvedValue([]);
  mocks.image_files.findMany.mockResolvedValue([]);
  mocks.audio_files.findMany.mockResolvedValue([]);
  mocks.scenes.findMany.mockResolvedValue([]);
  mocks.branch_sequences.findMany.mockResolvedValue([]);
  mocks.simulations.findMany.mockResolvedValue([]);
  mocks.sim_posters.findMany.mockResolvedValue([]);
  mocks.video_dubs.findMany.mockResolvedValue([]);
});

describe('a project with no dubs is exactly what it was before', () => {
  it('reports no language and offers none', async () => {
    const c = await config();
    expect(c.language).toBeNull();
    expect(c.available_languages).toEqual([]);
  });

  it('keeps serving the source track and the source captions', async () => {
    const c = await config();
    expect(c.segments[0]!.hls_url).toBe('https://cdn.example.com/hls/main.m3u8');
    expect(c.segments[0]!.captions!.vtt_url).toContain('/videos/vid-main/captions.vtt');
  });
});

describe('serving a dubbed language', () => {
  beforeEach(() => {
    mocks.video_dubs.findMany.mockResolvedValue([dub()]);
  });

  it('offers the language, with its own endonym and text direction', async () => {
    const c = await config();
    expect(c.available_languages).toEqual([
      { code: 'he', name: 'Hebrew', endonym: 'עברית', rtl: true },
    ]);
  });

  it('does NOT switch until asked — offering a language is not selecting it', async () => {
    const c = await config();
    expect(c.language).toBeNull();
    expect(c.segments[0]!.hls_url).toBe('https://cdn.example.com/hls/main.m3u8');
  });

  it('swaps the audio AND the captions together when asked, never one without the other', async () => {
    const c = await config('he');
    expect(c.language).toBe('he');
    // The audio: the dubbed rendition, not the source ladder.
    expect(c.segments[0]!.hls_url).toBe('https://cdn.example.com/dubs/vid-main/he/hls/dub-he-1/master.m3u8');
    expect(c.segments[0]!.fallback_url).toBe(c.segments[0]!.hls_url);
    // The captions: THIS dub's own transcript route — never the source-language one.
    expect(c.segments[0]!.captions!.vtt_url).toBe('https://api.example.com/api/v1/videos/vid-main/captions/he.vtt');
    expect(c.segments[0]!.captions!.status).toBe('ready');
  });

  it('reports no captions rather than falling back to the source when the dub has none', async () => {
    // The failure this prevents: Hebrew audio with English captions under it.
    mocks.video_dubs.findMany.mockResolvedValue([dub({ captions_vtt: null })]);
    const c = await config('he');
    expect(c.segments[0]!.hls_url).toContain('/dubs/');
    expect(c.segments[0]!.captions!.vtt_url).toBeNull();
    expect(c.segments[0]!.captions!.status).toBe('none');
  });
});

describe('what a viewer is never offered', () => {
  it('hides a WATERMARKED dub, however finished it is', async () => {
    mocks.video_dubs.findMany.mockResolvedValue([dub({ watermarked: true })]);
    const c = await config('he');
    expect(c.available_languages).toEqual([]);
    expect(c.language).toBeNull();
    expect(c.segments[0]!.hls_url).toBe('https://cdn.example.com/hls/main.m3u8');
  });

  it('hides a dub that has not finished', async () => {
    mocks.video_dubs.findMany.mockResolvedValue([dub({ status: 'processing', hls_master_key: null })]);
    expect((await config()).available_languages).toEqual([]);
  });

  it('hides a `stale` dub, whose output no longer matches its transcript', async () => {
    mocks.video_dubs.findMany.mockResolvedValue([dub({ status: 'stale' })]);
    expect((await config()).available_languages).toEqual([]);
  });

  it('hides a completed dub with no rendition to play', async () => {
    mocks.video_dubs.findMany.mockResolvedValue([dub({ hls_master_key: null })]);
    expect((await config()).available_languages).toEqual([]);
  });

  it('hides a PARTLY dubbed language — a lesson must not revert to the source halfway', async () => {
    mocks.video_files.findMany.mockResolvedValue([
      video(),
      video({ id: 'vid-two', filename: 'part2.mp4', created_at: new Date('2026-01-02') }),
    ]);
    // Only the first video has Hebrew.
    mocks.video_dubs.findMany.mockResolvedValue([dub()]);
    expect((await config()).available_languages).toEqual([]);
  });

  it('offers the language once EVERY main video has it', async () => {
    mocks.video_files.findMany.mockResolvedValue([
      video(),
      video({ id: 'vid-two', filename: 'part2.mp4', created_at: new Date('2026-01-02') }),
    ]);
    mocks.video_dubs.findMany.mockResolvedValue([
      dub(),
      dub({ id: 'dub-he-2', video_file_id: 'vid-two', hls_master_key: 'dubs/vid-two/he/hls/dub-he-2/master.m3u8' }),
    ]);
    const c = await config('he');
    expect(c.available_languages.map((l) => l.code)).toEqual(['he']);
    expect(c.segments.every((s) => s.hls_url!.includes('/dubs/'))).toBe(true);
  });
});

describe('an unavailable language falls back rather than failing', () => {
  it('falls back to the source when the requested dub does not exist', async () => {
    // The acceptance case: a shared /he link after that dub is deleted must still play.
    const c = await config('he');
    expect(c.language).toBeNull();
    expect(c.segments[0]!.hls_url).toBe('https://cdn.example.com/hls/main.m3u8');
    expect(c.segments[0]!.captions!.vtt_url).toContain('/captions.vtt');
  });

  it('falls back for a language the product does not offer at all', async () => {
    mocks.video_dubs.findMany.mockResolvedValue([dub()]);
    const c = await config('klingon');
    expect(c.language).toBeNull();
    expect(c.segments[0]!.hls_url).toBe('https://cdn.example.com/hls/main.m3u8');
  });
});
