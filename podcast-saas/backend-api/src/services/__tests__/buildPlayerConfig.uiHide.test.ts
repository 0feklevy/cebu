/**
 * buildPlayerConfig — ui_hide emission on segments[].simulations[] (Minimal-UI picker).
 *
 * ui_hide comes from sim_meta.uiControls.hide and is OMITTED (undefined) when the section
 * has no selection, an empty hide list, or malformed jsonb — so the no-selection player
 * payload stays byte-identical to before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPlayerConfig } from '../buildPlayerConfig.js';
import {
  DEFAULT_PRESENTATION_CONFIG, computeConfigHash, derivePackageRevision,
} from 'shared/src/sim/simIdentity';
import { posterIdentityString, posterStoragePath, type PosterKey } from 'shared/src/sim/posterIdentity';

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

// ── Poster fixtures ───────────────────────────────────────────────────────────────────────────
// The key is rebuilt here from the SHARED primitives rather than pasted as a literal, because the
// property under test is that the emitted poster belongs to the section's OWN identity — and a
// literal would still "pass" if the builder silently keyed on something else that happened to
// produce it. The negative cases below are what actually pin the axes: each one differs from the
// live section in exactly ONE of them.
const SIM_PREFIX = 'simulations/proj-1/sim-1';

const posterKey = (over: Partial<PosterKey> = {}): PosterKey => ({
  // `simSection` stores a URL with no ?v=, so the derived revision hashes the URL itself.
  packageRevision: derivePackageRevision('sim-1', 'https://x/sim.html'),
  // No ?section= on that URL and sim_script is the meaningless literal 'main', so the variant key
  // falls through to the section id — exactly what the player dispatches on.
  variantKey: 'sec-1',
  configHash: computeConfigHash({
    ...DEFAULT_PRESENTATION_CONFIG,
    simpleUi: true, hideSelectors: [], autoScript: true, quality: 'high', aspect: 'wide',
  }),
  aspectProfile: 'wide',
  qualityProfile: 'high',
  ...over,
});

const posterRow = (key: PosterKey, opts: { transparent?: boolean } = {}) => {
  const transparent = opts.transparent ?? false;
  // A transparent capture is PNG-only by construction (formatsFor) — an opaque one carries both.
  const formats = transparent ? (['png'] as const) : (['webp', 'png'] as const);
  return {
    id: `poster-${posterIdentityString(key).slice(0, 8)}`,
    simulation_id: 'sim-1',
    package_revision: key.packageRevision,
    variant_key: key.variantKey,
    config_hash: key.configHash,
    aspect_profile: key.aspectProfile,
    quality_profile: key.qualityProfile,
    identity: posterIdentityString(key),
    variants: formats.flatMap((format) =>
      (['standard', 'compact'] as const).map((size) => ({
        size,
        format,
        path: posterStoragePath(SIM_PREFIX, key, size, format),
        checksum: `sha-${size}-${format}`,
        contentType: `image/${format}`,
        width: size === 'standard' ? 1280 : 640,
        height: size === 'standard' ? 720 : 360,
        bytes: 1024,
      })),
    ),
    transparent,
    captured_at: new Date('2026-07-01'),
    created_at: new Date('2026-07-01'),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects.findFirst.mockResolvedValue(PROJECT);
  mocks.video_files.findMany.mockResolvedValue([VIDEO]);
  mocks.image_files.findMany.mockResolvedValue([]);
  mocks.audio_files.findMany.mockResolvedValue([]);
  mocks.scenes.findMany.mockResolvedValue([]);
  mocks.branch_sequences.findMany.mockResolvedValue([]);
  // The package identity/classification lookup (v3 activation-scoped protocol). Empty by default:
  // a project whose simulations have never been canaried is the normal case, and the player must
  // treat an absent verdict as UNPROVEN rather than as an error.
  mocks.simulations.findMany.mockResolvedValue([]);
  // No posters captured is likewise the normal case — every section then emits poster_url: null.
  mocks.sim_posters.findMany.mockResolvedValue([]);
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

  it('derives package_revision from the section URL bridge hash and leaves package_class null when never canaried', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      simSection('sec-1', { uiControls: { controls: [], show: [], hide: [] } }),
    ]);
    const config = await buildPlayerConfig('proj-1');
    const sim = config!.segments[0].simulations[0] as { package_revision: string | null; package_class: string | null };

    // Defined and opaque — the player compares it, never parses it.
    expect(typeof sim.package_revision).toBe('string');
    expect(sim.package_revision).toMatch(/^[0-9a-f]{16}$/);
    // No canary verdict on file. Null means UNPROVEN, which the player treats exactly as legacy:
    // reporting a class here would grant the modern path to a package nothing has ever exercised.
    expect(sim.package_class).toBeNull();
  });

  it('reports the stored canary verdict when the simulation has one', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      simSection('sec-1', { uiControls: { controls: [], show: [], hide: [] } }),
    ]);
    mocks.simulations.findMany.mockResolvedValue([
      { id: 'sim-1', project_id: 'proj-1', package_class: 'managed-presentable' },
    ]);
    const config = await buildPlayerConfig('proj-1');
    const sim = config!.segments[0].simulations[0] as { package_class: string | null };
    expect(sim.package_class).toBe('managed-presentable');
  });

  it('gives every section of one package the SAME revision even when their URLs carry different ?v=', async () => {
    // The regression this pins: regenerating one section rewrites the SHARED bridge but stamps the
    // new hash onto only that section's URL. Deriving the revision from the URL therefore split one
    // package into two identities — and because both sections share a single pooled document and a
    // single runtime client, the second entry re-opened the transport against a document that had
    // already adopted a port, wedging the modern path for the rest of the session and making every
    // poster lookup miss. The package's own bridge_hash is the only value that cannot split.
    const a = simSection('sec-a', null);
    const b = simSection('sec-b', null);
    (a as { simulation_url: string }).simulation_url = 'https://x/sim.html?section=sec-a&v=aaaaaaaaaaaa';
    (b as { simulation_url: string }).simulation_url = 'https://x/sim.html?section=sec-b&v=bbbbbbbbbbbb';
    mocks.timeline_sections.findMany.mockResolvedValue([a, b]);
    mocks.simulations.findMany.mockResolvedValue([
      { id: 'sim-1', project_id: 'proj-1', package_class: null, bridge_hash: 'cafebabe1234' },
    ]);

    const config = await buildPlayerConfig('proj-1');
    const [x, y] = config!.segments[0].simulations as { package_revision: string }[];
    expect(x.package_revision).toBe(y.package_revision);

    // And it still MOVES when the package is genuinely re-bridged — otherwise posters and canary
    // verdicts from the previous bytes would survive a republish.
    mocks.simulations.findMany.mockResolvedValue([
      { id: 'sim-1', project_id: 'proj-1', package_class: null, bridge_hash: 'deadbeef5678' },
    ]);
    const after = await buildPlayerConfig('proj-1');
    const [z] = after!.segments[0].simulations as { package_revision: string }[];
    expect(z.package_revision).not.toBe(x.package_revision);
  });

  it('gives two sections of the SAME package the same revision, and a re-bridged package a different one', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      simSection('sec-1', null),
      simSection('sec-2', null),
    ]);
    const first = await buildPlayerConfig('proj-1');
    const [a, b] = first!.segments[0].simulations as { package_revision: string }[];
    expect(a.package_revision).toBe(b.package_revision);

    // Same simulation row, bridge regenerated: the URL's ?v= changes, so the revision must too —
    // that is what makes an acknowledgement from the previous bytes fail the identity check.
    const rebridged = simSection('sec-1', null);
    (rebridged as { simulation_url: string }).simulation_url = 'https://x/sim.html?v=deadbeefcafe';
    mocks.timeline_sections.findMany.mockResolvedValue([rebridged]);
    const second = await buildPlayerConfig('proj-1');
    const c = second!.segments[0].simulations[0] as { package_revision: string };
    expect(c.package_revision).not.toBe(a.package_revision);
  });
});

// ─── posters ──────────────────────────────────────────────────────────────────────────────────
//
// A poster stands in for the live simulation during the window where showing the real frame would
// be wrong or pointless. That substitution is only honest while the still picture is the one the
// live frame WOULD have shown — so a poster is served for its own presentation identity or not at
// all. "Some other poster of the same package" is the failure mode, not the fallback.

type PlayerSim = { id: string; poster_url: string | null; poster_transparent: boolean };
const simsOf = (config: Awaited<ReturnType<typeof buildPlayerConfig>>) =>
  config!.segments[0].simulations as unknown as PlayerSim[];

describe('buildPlayerConfig — posters', () => {
  it('emits the poster stored for the section’s own identity, preferring webp', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([simSection('sec-1', null)]);
    const key = posterKey();
    mocks.sim_posters.findMany.mockResolvedValue([posterRow(key)]);

    const sim = simsOf(await buildPlayerConfig('proj-1'))[0];
    // `standard` rendition (a full-width player), webp ahead of png — and served through the sim
    // proxy, because Supabase downgrades a public bucket's text/html and the poster must come from
    // the same origin family as the package it stands in for.
    expect(sim.poster_url).toBe(
      `https://cdn.example.com/sim-public/${posterStoragePath(SIM_PREFIX, key, 'standard', 'webp')}`,
    );
    expect(sim.poster_transparent).toBe(false);
  });

  it('reports a transparent capture as transparent and serves its PNG', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([simSection('sec-1', null)]);
    const key = posterKey();
    mocks.sim_posters.findMany.mockResolvedValue([posterRow(key, { transparent: true })]);

    const sim = simsOf(await buildPlayerConfig('proj-1'))[0];
    // A section that composites over video needs real alpha, so its cover must not be re-encoded
    // into a format that drops it.
    expect(sim.poster_url).toBe(
      `https://cdn.example.com/sim-public/${posterStoragePath(SIM_PREFIX, key, 'standard', 'png')}`,
    );
    expect(sim.poster_transparent).toBe(true);
  });

  it('emits null when the only posters on file belong to a DIFFERENT identity', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([simSection('sec-1', null)]);
    mocks.sim_posters.findMany.mockResolvedValue([
      // Another sub-simulation of the same package.
      posterRow(posterKey({ variantKey: 'sec-other' })),
      // The same sub-simulation, captured for a different presentation configuration.
      posterRow(posterKey({
        configHash: computeConfigHash({
          ...DEFAULT_PRESENTATION_CONFIG,
          simpleUi: false, hideSelectors: [], autoScript: true, quality: 'high', aspect: 'wide',
        }),
      })),
      // The same configuration, captured at a different aspect and a different quality.
      posterRow(posterKey({ aspectProfile: 'portrait' })),
      posterRow(posterKey({ qualityProfile: 'low' })),
      // The same everything, from a superseded package revision.
      posterRow(posterKey({ packageRevision: derivePackageRevision('sim-1', 'older-bridge') })),
    ]);

    const sim = simsOf(await buildPlayerConfig('proj-1'))[0];
    expect(sim.poster_url).toBeNull();
    expect(sim.poster_transparent).toBe(false);
  });

  it('follows the section’s Minimal-UI selection into the config hash', async () => {
    // The hidden controls change what the frame looks like, so they change which picture stands in
    // for it. A poster captured without them is a picture of a different screen.
    mocks.timeline_sections.findMany.mockResolvedValue([
      simSection('sec-1', { uiControls: { controls: [], show: [], hide: ['#b', '#a'] } }),
    ]);
    const withHides = posterKey({
      configHash: computeConfigHash({
        ...DEFAULT_PRESENTATION_CONFIG,
        // Order is not significant — canonicalizeConfig treats the selector list as a set, which is
        // why the section may store them in any order and still resolve its poster.
        simpleUi: true, hideSelectors: ['#a', '#b'], autoScript: true, quality: 'high', aspect: 'wide',
      }),
    });
    mocks.sim_posters.findMany.mockResolvedValue([posterRow(posterKey()), posterRow(withHides)]);

    const sim = simsOf(await buildPlayerConfig('proj-1'))[0];
    expect(sim.poster_url).toBe(
      `https://cdn.example.com/sim-public/${posterStoragePath(SIM_PREFIX, withHides, 'standard', 'webp')}`,
    );
  });

  it('emits null for every section when no posters exist at all', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([simSection('sec-1', null), simSection('sec-2', null)]);
    const sims = simsOf(await buildPlayerConfig('proj-1'));
    expect(sims).toHaveLength(2);
    for (const sim of sims) {
      expect(sim.poster_url).toBeNull();
      expect(sim.poster_transparent).toBe(false);
    }
  });

  it('does not query posters for a project with no simulation sections', async () => {
    // buildPlayerConfig is the hottest read path in the product (every player-config, share,
    // playlist item and course render). A project with nothing to look up must not pay a round trip.
    mocks.timeline_sections.findMany.mockResolvedValue([
      { ...simSection('sec-plain', null), type: 'clip', simulation_url: null, simulation_id: null },
    ]);
    await buildPlayerConfig('proj-1');
    expect(mocks.sim_posters.findMany).not.toHaveBeenCalled();
  });
});
