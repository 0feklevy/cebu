/**
 * buildPlayerConfig — resolving the immutable-revision pointer (Priority 7.6).
 *
 * Two properties, and the first one matters more than the second:
 *
 *   1. A simulation with NO revision must emit byte-identical output to before migration 050.
 *      Every existing package is in that state, every `sim_posters` row is keyed on the
 *      pre-revision identity, and the poster lookup deliberately has no fallback — so a change
 *      here would silently blank every poster in the product.
 *
 *   2. A simulation WITH an active revision takes both its identity and its served URL from that
 *      revision, and the STORED `simulation_url` is never rewritten. Putting the revision id into
 *      stored URLs would make activation an N-row un-transacted rewrite, breaking the single-
 *      pointer-update promise outright.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPlayerConfig } from '../buildPlayerConfig.js';
import { derivePackageRevision } from 'shared/src/sim/simIdentity';
import { packageRevisionFor } from 'shared/src/sim/simRevision';

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
const logged = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: logged.error, debug: vi.fn() },
}));

const PROJECT = { id: 'proj-1', title: 'T', topic: null, thumbnail_url: null, avatar_config: null };
const VIDEO = {
  id: 'vid-1', project_id: 'proj-1', is_broll: false, filename: 'v.mp4',
  duration_sec: 100, hls_master_key: 'hls/master.m3u8', hls_360p_key: null, hls_status: 'ready',
  crop_status: null, crop_key: null, captions_status: null, captions_error: null,
  created_at: new Date('2026-01-01'), sequence_id: null, sequence_order: null,
};

const STORED_URL = 'https://x/sim.html?section=sec-1&v=H1';
const REV = '11111111-1111-1111-1111-111111111111';
const ENTRY_KEY = `simulations/proj-1/sim-1/revisions/${REV}/package/index.html`;

const section = (over: Record<string, unknown> = {}) => ({
  id: 'sec-1', project_id: 'proj-1', video_file_id: 'vid-1', track: 'main', type: 'simulation',
  start_sec: 0, end_sec: 10, label: 'sec-1', simulation_url: STORED_URL, simulation_id: 'sim-1',
  sim_script: 'main', simple_ui: false, auto_script: true, sim_meta: null,
  clip_source_video_id: null, clip_source_image_id: null, clip_source_audio_id: null,
  clip_in_sec: 0, global_offset_sec: null, broll_volume: 1, ...over,
});

const simRow = (over: Record<string, unknown> = {}) => ({
  id: 'sim-1', package_class: null, bridge_hash: 'H1',
  active_revision_id: null, active_revision_entry_key: null, ...over,
});

async function firstSim(): Promise<Record<string, unknown>> {
  const cfg = await buildPlayerConfig('proj-1', 'user-1') as {
    segments: Array<{ simulations: Array<Record<string, unknown>> }>;
  };
  return cfg.segments[0]!.simulations[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects.findFirst.mockResolvedValue(PROJECT);
  mocks.video_files.findMany.mockResolvedValue([VIDEO]);
  mocks.timeline_sections.findMany.mockResolvedValue([section()]);
  mocks.image_files.findMany.mockResolvedValue([]);
  mocks.audio_files.findMany.mockResolvedValue([]);
  mocks.scenes.findMany.mockResolvedValue([]);
  mocks.branch_sequences.findMany.mockResolvedValue([]);
  mocks.simulations.findMany.mockResolvedValue([simRow()]);
  mocks.sim_posters.findMany.mockResolvedValue([]);
});

// ── Backward compatibility ───────────────────────────────────────────────────────────────────────

describe('a simulation with no revision is untouched', () => {
  it('emits the STORED url verbatim', async () => {
    expect((await firstSim()).simulation_url).toBe(STORED_URL);
  });

  it('emits the pre-revision identity, unchanged from before migration 050', async () => {
    // Every sim_posters row is keyed on this value and the lookup has NO fallback, so a change
    // here blanks every poster for every existing package.
    expect((await firstSim()).package_revision).toBe(derivePackageRevision('sim-1', 'H1'));
  });

  it('still falls back to the URL ?v= for a package whose bridge predates the column', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ bridge_hash: null })]);
    expect((await firstSim()).package_revision).toBe(derivePackageRevision('sim-1', 'H1'));
  });

  it('emits an identity even when the simulation row is missing entirely', async () => {
    // Emitting null would disable identity checking for the section rather than degrade it.
    mocks.simulations.findMany.mockResolvedValue([]);
    expect((await firstSim()).package_revision).toBeTruthy();
  });
});

// ── Pointer resolution ───────────────────────────────────────────────────────────────────────────

describe('a simulation with an active revision', () => {
  beforeEach(() => {
    mocks.simulations.findMany.mockResolvedValue([
      simRow({ active_revision_id: REV, active_revision_entry_key: ENTRY_KEY }),
    ]);
  });

  it('serves from the revision entry key', async () => {
    expect((await firstSim()).simulation_url)
      .toBe(`https://cdn.example.com/sim-public/${ENTRY_KEY}?section=sec-1&v=H1`);
  });

  it('preserves the query string exactly', async () => {
    // The pool dispatches on ?section= and the poster/variant identity axis reads it. Dropping the
    // query would collapse every section of a package onto one variant key.
    const url = String((await firstSim()).simulation_url);
    expect(url).toContain('?section=sec-1');
    expect(url).toContain('&v=H1');
  });

  it('takes identity from the revision, not from bridge_hash', async () => {
    const expected = packageRevisionFor(
      { id: 'sim-1', bridge_hash: 'H1', active_revision_id: REV }, derivePackageRevision);
    const got = (await firstSim()).package_revision;
    expect(got).toBe(expected);
    expect(got).not.toBe(derivePackageRevision('sim-1', 'H1'));
  });

  it('uses ONE resolver — the shared one', async () => {
    // A second derivation in this file is what the shared module forbids: it costs every poster and
    // leaves the canary verdict describing bytes that are no longer served.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../buildPlayerConfig.ts', import.meta.url), 'utf8'));
    expect(src).toContain('revisionIdentityFor');
    // The local fork used to compute this inline. It must not come back.
    expect(src).not.toMatch(/return derivePackageRevision\(simId \?\? url \?\? ''/);
  });

  it('keeps identity stable when only bridge_hash moves', async () => {
    const a = (await firstSim()).package_revision;
    mocks.simulations.findMany.mockResolvedValue([
      simRow({ bridge_hash: 'H2', active_revision_id: REV, active_revision_entry_key: ENTRY_KEY }),
    ]);
    // The revision's bytes are what is immutable; the legacy prefix's hash is not the identity.
    expect((await firstSim()).package_revision).toBe(a);
  });

  it('falls back to the stored url when the entry key is missing', async () => {
    // Both-or-neither is enforced by a CHECK, so this state should be unreachable — but if it were
    // reached, serving the legacy package is the safe direction.
    mocks.simulations.findMany.mockResolvedValue([
      simRow({ active_revision_id: REV, active_revision_entry_key: null }),
    ]);
    expect((await firstSim()).simulation_url).toBe(STORED_URL);
  });

  it('leaves a section with no simulation_url null', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([section({ simulation_url: null })]);
    expect((await firstSim()).simulation_url).toBeNull();
  });
});

// ── The degraded read ────────────────────────────────────────────────────────────────────────────

describe('when the simulation rows cannot be read', () => {
  it('does not 500 the viewer, but reports it as an incident', async () => {
    // An empty list makes every simulation look revision-less, so the config silently serves the
    // legacy package with a pre-revision identity — correct-looking, entirely wrong bytes. It must
    // not take the viewer down, and it must not pass unnoticed either.
    mocks.simulations.findMany.mockRejectedValue(Object.assign(new Error('boom'), { code: '42703' }));
    const sim = await firstSim();
    expect(sim.simulation_url).toBe(STORED_URL);
    expect(logged.error).toHaveBeenCalled();
  });
});
