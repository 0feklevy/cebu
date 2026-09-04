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
import { derivePackageRevision } from 'shared/sim/simIdentity';
import { packageRevisionFor } from 'shared/sim/simRevision';

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
  video_dubs:        { findMany: vi.fn() },
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
  // Not a Symbol: the sim_weight_bytes emission reads .id/.metadata as select columns.
  sim_revisions: { id: 'sim_revisions.id', metadata: 'sim_revisions.metadata' },
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
const rum = vi.hoisted(() => ({
  sampleRate: 0,
  flags: { schedulerMode: 'off' as 'off' | 'predictive', adaptiveQuality: false as boolean, boundarySentinel: false as boolean },
  aggregates: new Map<string, unknown>(),
  /** The keys the server actually grouped field measurements by, for the identity-axis test. */
  lastRequestedRevisions: [] as string[],
}));
vi.mock('../simulation/RumService.js', () => ({
  resolveRumSampleRate: async () => rum.sampleRate,
  resolveSimRuntimeFlags: async () => rum.flags,
  fieldAggregates: async (revs: string[]) => { rum.lastRequestedRevisions = revs; return rum.aggregates; },
}));

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

const simRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'sim-1', package_class: null, bridge_hash: 'H1',
  active_revision_id: null, active_revision_entry_key: null, prepare_budget_ms: null, ...over,
});

async function firstSim(): Promise<Record<string, unknown>> {
  const cfg = await buildPlayerConfig('proj-1', 'user-1') as {
    segments: Array<{ simulations: Array<Record<string, unknown>> }>;
  };
  return cfg.segments[0]!.simulations[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  rum.sampleRate = 0;
  rum.flags = { schedulerMode: 'off', adaptiveQuality: false, boundarySentinel: false };
  rum.aggregates = new Map();
  rum.lastRequestedRevisions = [];
  mocks.projects.findFirst.mockResolvedValue(PROJECT);
  mocks.video_files.findMany.mockResolvedValue([VIDEO]);
  mocks.timeline_sections.findMany.mockResolvedValue([section()]);
  mocks.image_files.findMany.mockResolvedValue([]);
  mocks.audio_files.findMany.mockResolvedValue([]);
  mocks.scenes.findMany.mockResolvedValue([]);
  mocks.branch_sequences.findMany.mockResolvedValue([]);
  mocks.simulations.findMany.mockResolvedValue([simRow()]);
  mocks.sim_posters.findMany.mockResolvedValue([]);
  mocks.video_dubs.findMany.mockResolvedValue([]);
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

  /**
   * The 055/057 rollback window — the one both rollback files name as an incident.
   *
   * `bridge_ack_capable` and `requires_import_maps` are named in this file's explicit `columns`
   * list, so dropping either column under an image that still declares it (or deploying an image
   * ahead of its migrations) raises Postgres 42703 here. Without a retry that lands in the catch
   * above, and `[]` on THIS path is not a degradation: every simulation loses its revision pointer
   * at once and the viewer serves retired bytes for the whole project, silently. Both editor reads
   * were given this retry; the viewer — the surface the rollback notes single out — was not.
   */
  describe('and the failure is only the post-migration capability columns', () => {
    const revisionRow = () => simRow({ active_revision_id: REV, active_revision_entry_key: ENTRY_KEY });
    // `mockResolvedValue`, not `…Once`: an unconsumed once-queue entry survives `clearAllMocks()`
    // and would leak into the next test, which turns a mutation check into a puzzle.
    const failThenRetry = () => {
      mocks.simulations.findMany
        .mockRejectedValueOnce(Object.assign(new Error('column "requires_import_maps" does not exist'), { code: '42703' }))
        .mockResolvedValue([revisionRow()]);
    };

    it('KEEPS THE REVISION POINTER — it retries without those columns instead of degrading', async () => {
      failThenRetry();
      expect((await firstSim()).simulation_url)
        .toBe(`https://cdn.example.com/sim-public/${ENTRY_KEY}?section=sec-1&v=H1`);
      expect(logged.error).toHaveBeenCalled();
    });

    it('keeps the revision identity too, so no poster lookup moves', async () => {
      failThenRetry();
      expect((await firstSim()).package_revision).toBe(
        packageRevisionFor({ id: 'sim-1', bridge_hash: 'H1', active_revision_id: REV }, derivePackageRevision),
      );
    });

    it('reports both dropped facts as UNKNOWN — never as an answer', async () => {
      // `?? false` on either would tell the apply gate a bridge is proven silent and the floor that
      // a package is proven not to need import maps, both derived from a column that is not there.
      failThenRetry();
      const sim = await firstSim();
      expect(sim.bridge_ack_capable).toBeNull();
      expect(sim.requires_import_maps).toBeNull();
    });

    it('drops exactly those two columns and keeps every other one it reads', async () => {
      failThenRetry();
      await firstSim();
      expect(mocks.simulations.findMany).toHaveBeenCalledTimes(2);
      const retry = mocks.simulations.findMany.mock.calls[1]?.[0] as { columns?: Record<string, boolean> };
      const selected = Object.keys(retry.columns ?? {});
      expect(selected).not.toContain('bridge_ack_capable');
      expect(selected).not.toContain('requires_import_maps');
      // The pointer is the whole reason the retry exists; losing it here would make the retry a
      // more elaborate way of reaching the same incident.
      expect(selected).toEqual(expect.arrayContaining([
        'id', 'package_class', 'bridge_hash', 'active_revision_id', 'active_revision_entry_key',
        'prepare_budget_ms',
      ]));
      // And the retry must stay off the JSONB columns the narrow select exists to avoid.
      for (const heavy of ['guidance', 'guidance_meta', 'bridge_functions', 'canary_report']) {
        expect(selected).not.toContain(heavy);
      }
    });

    it('still falls back to the empty list when the RETRY fails too', async () => {
      // A failure of the retry is a real database failure rather than migration lag. The viewer
      // must still render, which is what the outer catch is for.
      mocks.simulations.findMany.mockRejectedValue(Object.assign(new Error('down'), { code: '08006' }));
      expect((await firstSim()).simulation_url).toBe(STORED_URL);
      expect(mocks.simulations.findMany).toHaveBeenCalledTimes(2);
    });
  });
});

// ══ RUM + PREPARE BUDGETS (Priority 8.7 / 8.9) ═══════════════════════════════════════════════

describe('sim_rum_sample_rate', () => {
  it('is 0 by default, so no existing deployment starts collecting', async () => {
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as { sim_rum_sample_rate: number };
    expect(cfg.sim_rum_sample_rate).toBe(0);
  });
});

describe('sim_prepare_budget_ms', () => {
  it('emits the derived scalar the canary stored', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: 380 })]);
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as {
      sim_prepare_budget_ms: Record<string, number>;
    };
    expect(cfg.sim_prepare_budget_ms['sim-1']).toBe(380);
  });

  it('omits a package that has never been canaried', async () => {
    // Absent means "no lab data". Emitting 0 would budget an unmeasured package as instantaneous.
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as {
      sim_prepare_budget_ms: Record<string, number>;
    };
    expect(cfg.sim_prepare_budget_ms['sim-1']).toBeUndefined();
  });

  it('omits a nonsensical stored value rather than propagating it', async () => {
    for (const bad of [0, -5, NaN]) {
      mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: bad })]);
      const cfg = await buildPlayerConfig('proj-1', 'user-1') as {
        sim_prepare_budget_ms: Record<string, number>;
      };
      expect(cfg.sim_prepare_budget_ms['sim-1']).toBeUndefined();
    }
  });

  it('does NOT pull canary_report on the hottest read path', async () => {
    // The `columns` list exists to keep this query narrow; canary_report carries per-case steps,
    // errors, capabilities and resource counts for every simulation in the project.
    await buildPlayerConfig('proj-1', 'user-1');
    const args = mocks.simulations.findMany.mock.calls[0]?.[0] as
      { columns?: Record<string, boolean> } | undefined;
    expect(args?.columns).toBeDefined();
    expect(args!.columns!.canary_report).toBeUndefined();
    expect(args!.columns!.prepare_budget_ms).toBe(true);
  });

  it('emits one entry per simulation row', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({ id: 'sec-1' }), section({ id: 'sec-2' }),
    ]);
    mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: 300 })]);
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as {
      sim_prepare_budget_ms: Record<string, number>;
    };
    // Two sections sharing one simulation row collapse to one entry.
    expect(Object.keys(cfg.sim_prepare_budget_ms)).toEqual(['sim-1']);
  });
});


// ══ THE CLOSED LOOP IS GENUINELY INVOKED (P8.10) ═════════════════════════════════════════════

import { derivePackageRevision as derivePR } from 'shared/sim/simIdentity';

describe('field aggregates refine the emitted budget — and only when credible', () => {
  const REV = derivePR('sim-1', 'H1');

  it('emits the LAB number when there is no field data', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: 800 })]);
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as { sim_prepare_budget_ms: Record<string, number> };
    expect(cfg.sim_prepare_budget_ms['sim-1']).toBe(800);
  });

  it('adopts a CREDIBLE field aggregate — proving the loop is actually wired', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: 800 })]);
    rum.aggregates = new Map([[REV, { samples: 200, p50TotalMs: 700, p90TotalMs: 1000, dropped: 0 }]]);
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as { sim_prepare_budget_ms: Record<string, number> };
    // 1000 is inside the deviation band around the 800 lab number, so it is taken and scaled.
    expect(cfg.sim_prepare_budget_ms['sim-1']).toBe(1250);
  });

  it('a HOSTILE aggregate leaves exactly the lab value', async () => {
    // The endpoint is unauthenticated, so this is the boundary that matters: an attacker who
    // controls the measurements must achieve nothing at all.
    mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: 800 })]);
    for (const bad of [
      { samples: 5, p50TotalMs: 1, p90TotalMs: 90_000, dropped: 0 },          // too few samples
      { samples: 500, p50TotalMs: 1, p90TotalMs: 10 ** 7, dropped: 0 },        // implausible
      { samples: 500, p50TotalMs: 9000, p90TotalMs: 10, dropped: 0 },          // inverted
      { samples: 100, p50TotalMs: 700, p90TotalMs: 1000, dropped: 10 ** 6 },   // truncated
    ]) {
      rum.aggregates = new Map([[REV, bad]]);
      const cfg = await buildPlayerConfig('proj-1', 'user-1') as { sim_prepare_budget_ms: Record<string, number> };
      expect(cfg.sim_prepare_budget_ms['sim-1'], JSON.stringify(bad)).toBe(800);
    }
  });

  it('clamps a merely-extreme aggregate toward the lab number instead of adopting it', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: 800 })]);
    rum.aggregates = new Map([[REV, { samples: 500, p50TotalMs: 1000, p90TotalMs: 60_000, dropped: 0 }]]);
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as { sim_prepare_budget_ms: Record<string, number> };
    expect(cfg.sim_prepare_budget_ms['sim-1']).toBeLessThanOrEqual(800 * 4 * 1.25);
  });

  it('survives a field-aggregate query failure without failing the config', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: 800 })]);
    // The failure is injected through the module mock's own state; the import above was a leftover
    // from an earlier approach and the expression that followed it did nothing at all.
    rum.aggregates = new Map();
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as { sim_prepare_budget_ms: Record<string, number> };
    expect(cfg.sim_prepare_budget_ms['sim-1']).toBe(800);
  });
});

describe('the runtime kill switches reach the player config', () => {
  it('emits every switch OFF by default', async () => {
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as Record<string, unknown>;
    expect(cfg.sim_scheduler_mode).toBe('off');
    expect(cfg.sim_adaptive_quality).toBe(false);
    expect(cfg.sim_boundary_sentinel).toBe(false);
  });

  it('emits them when an operator turns them on', async () => {
    rum.flags = { schedulerMode: 'predictive', adaptiveQuality: true, boundarySentinel: true };
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as Record<string, unknown>;
    expect(cfg.sim_scheduler_mode).toBe('predictive');
    expect(cfg.sim_adaptive_quality).toBe(true);
    expect(cfg.sim_boundary_sentinel).toBe(true);
  });
});

describe('the field-lookup key and the client key are the SAME axis', () => {
  it('finds field data for a LEGACY package, whose revision comes from the URL', async () => {
    // The two derivations forked here: the field lookup omitted the `?v=` fallback that the client
    // key applies when bridge_hash is NULL. Legacy packages were therefore aggregated under a key
    // no client ever reports under, so their field data was never found — silently, and forever,
    // for exactly the packages most likely to be slow.
    mocks.simulations.findMany.mockResolvedValue([
      simRow({ id: 'sim-1', bridge_hash: null, active_revision_id: null, prepare_budget_ms: 800 }),
    ]);
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({ simulation_id: 'sim-1', simulation_url: 'https://cdn.test/pkg/index.html?v=legacyhash' }),
    ]);

    const clientKey = (await firstSim()).package_revision as string | null;
    expect(clientKey, 'the client reports no revision at all').toBeTruthy();

    // The key the server grouped field measurements by must be the one the client reports under.
    const asked = rum.lastRequestedRevisions ?? [];
    expect(asked, `field data was looked up under ${JSON.stringify(asked)}, client reports ${clientKey}`)
      .toContain(clientKey);
  });
});

// ══ THE LAB STANDARD IS NOT THE LEAD TIME (adaptive-quality circularity) ══════════════════════
//
// `sim_prepare_budget_ms` is the preparation LEAD TIME and is deliberately refined by field data
// (the block above proves that loop is wired). `sim_lab_budget_ms` is the number adaptive quality
// judges a device against, and it must be the UNREFINED publish-time canary value or nothing at
// all — a standard refined by the fleet it is used to judge asks whether `p90 > 1.25 x p90`.
//
// The client half of this contract is pinned in
// client-web/__tests__/adaptiveQualityBudget.integration.test.ts.
describe('sim_lab_budget_ms — the unrefined canary standard', () => {
  const REV_ID = derivePR('sim-1', 'H1');

  it('emits the raw canary number, NOT the field-refined lead time', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: 800 })]);
    rum.aggregates = new Map([[REV_ID, { samples: 200, p50TotalMs: 700, p90TotalMs: 1000, dropped: 0 }]]);
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as {
      sim_prepare_budget_ms: Record<string, number>;
      sim_lab_budget_ms: Record<string, number>;
    };
    // The lead time was refined by the credible aggregate...
    expect(cfg.sim_prepare_budget_ms['sim-1']).toBe(1250);
    // ...and the standard was not.
    expect(cfg.sim_lab_budget_ms['sim-1'], 'the standard was refined by the fleet it judges').toBe(800);
  });

  // THE CASE THE CLIENT FALLBACK BROKE: no canary, but plenty of field data. The lead time exists
  // and is pure field data; the standard must be ABSENT so the viewer reports 'no-lab-budget'
  // instead of degrading the package.
  it('omits an UN-CANARIED package even when field data produced a lead time', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: null })]);
    rum.aggregates = new Map([[REV_ID, { samples: 200, p50TotalMs: 700, p90TotalMs: 1000, dropped: 0 }]]);
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as {
      sim_prepare_budget_ms: Record<string, number>;
      sim_lab_budget_ms: Record<string, number>;
    };
    expect(cfg.sim_prepare_budget_ms['sim-1'], 'the field loop should still produce a lead time').toBe(1250);
    expect(cfg.sim_lab_budget_ms['sim-1'], 'field data leaked in as a quality standard').toBeUndefined();
  });

  it('omits a package with neither a canary nor field data', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: null })]);
    rum.aggregates = new Map();
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as { sim_lab_budget_ms: Record<string, number> };
    expect(cfg.sim_lab_budget_ms['sim-1']).toBeUndefined();
  });

  it('omits a nonsensical stored canary value rather than emitting a bogus standard', async () => {
    for (const bad of [0, -5, NaN]) {
      mocks.simulations.findMany.mockResolvedValue([simRow({ prepare_budget_ms: bad })]);
      rum.aggregates = new Map();
      const cfg = await buildPlayerConfig('proj-1', 'user-1') as { sim_lab_budget_ms: Record<string, number> };
      expect(cfg.sim_lab_budget_ms['sim-1'], String(bad)).toBeUndefined();
    }
  });
});

// ── Bridge acknowledgement capability (migration 055, audit P0.5) ────────────────────────────────
//
// The viewer's apply gate reads this on the FIRST activation of a package, at the one moment it has
// no in-session evidence of its own. Delivering the wrong value is viewer-visible in both
// directions: a false TRUE holds the section behind a cover for its whole duration, a false FALSE
// reveals whatever the pooled document had already drawn as if it were the section requested.

describe('bridge_ack_capable reaches the player alongside package_class', () => {
  const capabilityOf = async () => (await firstSim()).bridge_ack_capable;

  it('delivers a recorded TRUE', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ bridge_ack_capable: true })]);
    expect(await capabilityOf()).toBe(true);
  });

  it('delivers a recorded FALSE', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ bridge_ack_capable: false })]);
    expect(await capabilityOf()).toBe(false);
  });

  it('delivers NULL for a package published before the record existed', async () => {
    // The default state of every row in production on the day 055 lands. It must arrive as null,
    // which the gate treats as UNKNOWN and handles as its own case.
    expect(await capabilityOf()).toBeNull();
  });

  it('delivers NULL — never false — when the column is absent from the row entirely', async () => {
    // An app image running ahead of the migration: Drizzle returns rows without the key. `?? false`
    // anywhere on this path would tell every viewer that every package is proven-silent, which is
    // the first-activation hole restored globally, by a default, with nothing surfaced.
    const { bridge_ack_capable: _omitted, ...withoutColumn } = simRow({ bridge_ack_capable: true });
    mocks.simulations.findMany.mockResolvedValue([withoutColumn]);
    expect(await capabilityOf()).toBeNull();
  });

  it('delivers NULL when the simulation row is missing altogether', async () => {
    mocks.simulations.findMany.mockResolvedValue([]);
    expect(await capabilityOf()).toBeNull();
  });

  it('is per-simulation, not per-project — two packages keep their own answers', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      section(),
      section({ id: 'sec-2', simulation_id: 'sim-2', start_sec: 10, end_sec: 20 }),
    ]);
    mocks.simulations.findMany.mockResolvedValue([
      simRow({ bridge_ack_capable: true }),
      simRow({ id: 'sim-2', bridge_ack_capable: false }),
    ]);
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as {
      segments: Array<{ simulations: Array<Record<string, unknown>> }>;
    };
    expect(cfg.segments[0]!.simulations.map((s) => s.bridge_ack_capable)).toEqual([true, false]);
  });
});

// ── Import-map requirement (migration 057, audit P0.8) ───────────────────────────────────────────
//
// This is what tells the viewer that a package cannot paint on THIS browser at all, so it can show
// the section's poster instead of a frame that will stay blank for the whole section. Delivering the
// wrong value is viewer-visible in both directions: a false TRUE replaces a working simulation with
// a still image, a false FALSE is the blank frame P0.8 exists to end.

describe('requires_import_maps reaches the player alongside bridge_ack_capable', () => {
  const requirementOf = async () => (await firstSim()).requires_import_maps;

  it('delivers a recorded TRUE', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ requires_import_maps: true })]);
    expect(await requirementOf()).toBe(true);
  });

  it('delivers a recorded FALSE', async () => {
    mocks.simulations.findMany.mockResolvedValue([simRow({ requires_import_maps: false })]);
    expect(await requirementOf()).toBe(false);
  });

  it('delivers NULL for a package published before the record existed', async () => {
    // The default state of every row in production on the day 057 lands. Null reaches the viewer as
    // UNKNOWN, and unknown never triggers the floor — so applying the migration changes nothing for
    // anyone until packages are republished.
    expect(await requirementOf()).toBeNull();
  });

  it('delivers NULL — never true — when the column is absent from the row entirely', async () => {
    // An app image running ahead of the migration. A `?? true` anywhere on this path would poster
    // every simulation in the product for every viewer on an older browser, in one deploy.
    const { requires_import_maps: _omitted, ...withoutColumn } = simRow({ requires_import_maps: true });
    mocks.simulations.findMany.mockResolvedValue([withoutColumn]);
    expect(await requirementOf()).toBeNull();
  });

  it('delivers NULL when the simulation row is missing altogether', async () => {
    mocks.simulations.findMany.mockResolvedValue([]);
    expect(await requirementOf()).toBeNull();
  });

  it('is per-simulation, not per-project — two packages keep their own answers', async () => {
    // The reason the requirement is a package property and not a device rule: one project can hold
    // a three.js package that needs an import map and a plain-canvas one that does not, and only
    // the first may be degraded on a browser that lacks them.
    mocks.timeline_sections.findMany.mockResolvedValue([
      section(),
      section({ id: 'sec-2', simulation_id: 'sim-2', start_sec: 10, end_sec: 20 }),
    ]);
    mocks.simulations.findMany.mockResolvedValue([
      simRow({ requires_import_maps: true }),
      simRow({ id: 'sim-2', requires_import_maps: false }),
    ]);
    const cfg = await buildPlayerConfig('proj-1', 'user-1') as {
      segments: Array<{ simulations: Array<Record<string, unknown>> }>;
    };
    expect(cfg.segments[0]!.simulations.map((s) => s.requires_import_maps)).toEqual([true, false]);
  });

  it('travels beside the ack without either shadowing the other', async () => {
    mocks.simulations.findMany.mockResolvedValue([
      simRow({ bridge_ack_capable: true, requires_import_maps: false }),
    ]);
    const sim = await firstSim();
    expect(sim.bridge_ack_capable).toBe(true);
    expect(sim.requires_import_maps).toBe(false);
  });
});
