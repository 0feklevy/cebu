import { describe, it, expect } from 'vitest';
import { collectSimPool, bootHideFor, dynamicScriptFor, packageKeyOf, sectionKeyOf, SIM_POOL_CAP } from '../lib/simPool';
import type { PlayerConfig, PlayerSegment, SimulationOverlay } from '../components/viewer/types';

const sim = (over: Partial<SimulationOverlay>): SimulationOverlay => ({
  id: over.id ?? 's1',
  start_sec: 0,
  end_sec: 10,
  simulation_url: null,
  simulation_id: null,
  sim_script: null,
  simple_ui: null,
  auto_script: null,
  label: null,
  type: 'simulation',
  ...over,
});

const seg = (sims: SimulationOverlay[], id = 'seg1'): PlayerSegment => ({
  id, label: id, duration_sec: 60, hls_url: null, fallback_url: null, hls_status: 'ready',
  simulations: sims,
} as unknown as PlayerSegment);

const cfg = (segments: PlayerSegment[], branching?: PlayerConfig['branching']): PlayerConfig =>
  ({ segments, branching } as unknown as PlayerConfig);

const BOIDS = 'https://api.x/sim-public/simulations/p/boids-3d/index.html';
const MURM  = 'https://api.x/sim-public/simulations/p/murmuration/index.html';

describe('packageKeyOf — package identity strips section/query/hash', () => {
  it('same package, different sections → same key', () => {
    expect(packageKeyOf(`${BOIDS}?section=a&v=111`)).toBe(packageKeyOf(`${BOIDS}?section=b&v=222`));
  });
  it('different packages → different keys', () => {
    expect(packageKeyOf(`${BOIDS}?section=a`)).not.toBe(packageKeyOf(`${MURM}?section=a`));
  });
  it('bare URL equals its own key', () => {
    expect(packageKeyOf(BOIDS)).toBe(packageKeyOf(`${BOIDS}?v=9`));
  });
  it('relative URLs key on the path', () => {
    expect(packageKeyOf('/sim-public/simulations/p/x/index.html?section=s')).toBe('/sim-public/simulations/p/x/index.html');
  });
});

describe('sectionKeyOf — the sub-simulation key is the URL ?section= param', () => {
  it('extracts the section id', () => {
    expect(sectionKeyOf(`${BOIDS}?section=abc-123&v=9`)).toBe('abc-123');
  });
  it('param order does not matter', () => {
    expect(sectionKeyOf(`${BOIDS}?v=9&section=abc-123#simboot`)).toBe('abc-123');
  });
  it('null when absent', () => {
    expect(sectionKeyOf(BOIDS)).toBeNull();
    expect(sectionKeyOf(`${BOIDS}?v=9`)).toBeNull();
  });
  it('relative URLs work', () => {
    expect(sectionKeyOf('/sim-public/simulations/p/x/index.html?section=s-1')).toBe('s-1');
  });
});

describe('dynamicScriptFor — the v2 dispatch id (the "one variation everywhere" regression)', () => {
  it("REGRESSION: production rows persist sim_script='main' — the URL ?section= must win, never 'main'", () => {
    // Sending 'main' to a pooled document runs the boot URL's default (the FIRST-pooled
    // section) in every section of the package. The URL param is the body key.
    const s = sim({ id: '151d0f87', sim_script: 'main', simulation_url: `${BOIDS}?section=151d0f87-full-uuid&v=a80e` });
    expect(dynamicScriptFor(s)).toBe('151d0f87-full-uuid');
  });

  it('DUPLICATED sections keep the ORIGINAL URL — dispatch by URL param, not the copy row id', () => {
    // The bridge has a body for the original's id only; the copy's own id has no body.
    const copy = sim({ id: 'copy-6c7ed806', sim_script: 'main', simulation_url: `${MURM}?section=orig-914a16f5&v=1` });
    expect(dynamicScriptFor(copy)).toBe('orig-914a16f5');
  });

  it("no ?section= + sim_script 'main' → the section id (never the meaningless literal)", () => {
    expect(dynamicScriptFor(sim({ id: 'a7765242', sim_script: 'main', simulation_url: BOIDS }))).toBe('a7765242');
    expect(dynamicScriptFor(sim({ id: 'a7765242', sim_script: null, simulation_url: BOIDS }))).toBe('a7765242');
  });

  it('no ?section= + a REAL named script → the named script', () => {
    expect(dynamicScriptFor(sim({ id: 'x', sim_script: 'intro-cam', simulation_url: BOIDS }))).toBe('intro-cam');
  });

  it('no URL at all → the section id', () => {
    expect(dynamicScriptFor(sim({ id: 'only-id', sim_script: null, simulation_url: null }))).toBe('only-id');
  });
});

describe('collectSimPool — one entry per PACKAGE, first-appearance order, capped', () => {
  it('groups many section URLs of one package into a single pool entry', () => {
    const pool = collectSimPool(cfg([
      seg([
        sim({ id: 'a', simulation_url: `${BOIDS}?section=a&v=1` }),
        sim({ id: 'b', simulation_url: `${BOIDS}?section=b&v=2` }),
        sim({ id: 'c', simulation_url: `${MURM}?section=c&v=3` }),
        sim({ id: 'd', simulation_url: `${BOIDS}?section=d&v=4` }),
      ]),
    ]));
    expect(pool).toHaveLength(2);
    expect(pool[0].key).toBe(packageKeyOf(BOIDS));
    expect(pool[0].src).toBe(`${BOIDS}?section=a&v=1`);   // first-seen section is the boot default
    expect(pool[1].key).toBe(packageKeyOf(MURM));
  });

  it('skips sections without a simulation_url', () => {
    const pool = collectSimPool(cfg([seg([sim({ id: 'a', simulation_url: null }), sim({ id: 'b', simulation_url: MURM })])]));
    expect(pool.map((p) => p.key)).toEqual([packageKeyOf(MURM)]);
  });

  it('carries the FIRST using section boot-hide (simple_ui + ui_hide)', () => {
    const pool = collectSimPool(cfg([
      seg([
        sim({ id: 'a', simulation_url: `${BOIDS}?section=a`, simple_ui: true, ui_hide: ['#panel', '.hud'] }),
        sim({ id: 'b', simulation_url: `${BOIDS}?section=b`, simple_ui: false }),
      ]),
    ]));
    expect(pool).toHaveLength(1);
    expect(pool[0].bootHide).toEqual(['#panel', '.hud']);
  });

  it('no boot-hide without simple_ui (or with an empty hide list)', () => {
    expect(bootHideFor(sim({ simple_ui: false, ui_hide: ['#x'] }))).toBeNull();
    expect(bootHideFor(sim({ simple_ui: true, ui_hide: [] }))).toBeNull();
    expect(bootHideFor(sim({ simple_ui: true, ui_hide: ['#x'] }))).toEqual(['#x']);
  });

  it('branching: collects ONLY the entry sequence (active path) — never other branches', () => {
    const branching = {
      entry_sequence_id: 'seqB',
      sequences: [
        { id: 'seqA', segments: [seg([sim({ id: 'a', simulation_url: `${BOIDS}?section=x` })], 'sA')] },
        { id: 'seqB', segments: [seg([sim({ id: 'b', simulation_url: `${MURM}?section=y` })], 'sB')] },
      ],
    } as unknown as NonNullable<PlayerConfig['branching']>;
    const pool = collectSimPool(cfg([], branching));
    expect(pool.map((p) => p.key)).toEqual([packageKeyOf(MURM)]);   // seqA's sim NOT pooled
  });

  it('caps the pool size (by package)', () => {
    const many = Array.from({ length: SIM_POOL_CAP + 3 }, (_, i) =>
      sim({ id: `s${i}`, simulation_url: `https://api.x/sim-public/simulations/p/pkg${i}/index.html` }));
    expect(collectSimPool(cfg([seg(many)]))).toHaveLength(SIM_POOL_CAP);
  });

  it('empty config → empty pool', () => {
    expect(collectSimPool(cfg([]))).toEqual([]);
  });
});
