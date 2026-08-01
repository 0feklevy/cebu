import { describe, it, expect } from 'vitest';
import {
  collectSimPool, bootHideFor, dynamicScriptFor, packageKeyOf, sectionKeyOf,
  flattenSimOccurrences, planWindowResidency, SIM_POOL_CAP,
} from '../lib/simPool';
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

describe('window-tier residency planner (audited defects: distant initial mount, segment+1 blindness, no-evict gaps)', () => {
  // Absolute-time fixture: three packages across four short segments.
  //   seg0 [0..30):    (no sims)
  //   seg1 [30..60):   A @ 40-50
  //   seg2 [60..80):   (no sims)          ← short gap segment
  //   seg3 [80..120):  B @ 82-90, A @ 100-110, C @ 112-118
  const A = `${BOIDS}?section=a1&v=1`;
  const A2 = `${BOIDS}?section=a2&v=2`;
  const B = `${MURM}?section=b1&v=1`;
  const C = 'https://api.x/sim-public/simulations/p/third/index.html?section=c1&v=1';
  const segments = [
    { offset: 0, simulations: [] as SimulationOverlay[] },
    { offset: 30, simulations: [sim({ id: 'a1', simulation_url: A, start_sec: 10, end_sec: 20 })] },
    { offset: 60, simulations: [] as SimulationOverlay[] },
    {
      offset: 80,
      simulations: [
        sim({ id: 'b1', simulation_url: B, start_sec: 2, end_sec: 10 }),
        sim({ id: 'a2', simulation_url: A2, start_sec: 20, end_sec: 30 }),
        sim({ id: 'c1', simulation_url: C, start_sec: 32, end_sec: 38 }),
      ],
    },
  ];
  const occ = flattenSimOccurrences(segments);

  it('flattens across ALL segments into sorted absolute times', () => {
    expect(occ.map((o) => o.absStartSec)).toEqual([40, 82, 100, 112]);
    expect(occ[0].packageKey).toBe(packageKeyOf(A));
  });

  it('at t=0 with the first sim 40s away and lead 45s → prefetch it, keep nothing else', () => {
    const plan = planWindowResidency(occ, 0, 45);
    expect(plan.active).toBeNull();
    expect(plan.next?.packageKey).toBe(packageKeyOf(A));
    expect([...plan.keep]).toEqual([packageKeyOf(A)]);
  });

  it('REGRESSION (distant initial mount): first sim far beyond the lead → keep is EMPTY', () => {
    const far = flattenSimOccurrences([
      { offset: 0, simulations: [] },
      { offset: 300, simulations: [sim({ id: 'a1', simulation_url: A, start_sec: 0, end_sec: 10 })] },
    ]);
    const plan = planWindowResidency(far, 0, 45);
    expect(plan.active).toBeNull();
    expect(plan.next).toBeNull();
    expect(plan.keep.size).toBe(0);       // nothing mounts minutes ahead of use
  });

  it('REGRESSION (segment+1 blindness): sim two segments ahead but within the lead is found', () => {
    // t=55: inside seg1, after A ended. B starts at 82 → 27s away, in seg3 (two segments ahead).
    const plan = planWindowResidency(occ, 55, 45);
    expect(plan.next?.packageKey).toBe(packageKeyOf(B));
  });

  it('REGRESSION (no-evict gaps): between sims with nothing upcoming inside the lead → keep empty', () => {
    // Fixture where a long gap follows the only sim.
    const gap = flattenSimOccurrences([
      { offset: 0, simulations: [sim({ id: 'a1', simulation_url: A, start_sec: 0, end_sec: 10 })] },
      { offset: 400, simulations: [sim({ id: 'b1', simulation_url: B, start_sec: 0, end_sec: 10 })] },
    ]);
    const plan = planWindowResidency(gap, 60, 45);
    expect(plan.keep.size).toBe(0);       // the passed A frame is evicted during the gap
  });

  it('next means the next DISTINCT package — a same-package upcoming row is skipped', () => {
    // t=105: inside A@100-110 (active=A). The next row is C@112 (distinct) — but craft a case
    // where the immediate next row is A again:
    const seq = flattenSimOccurrences([
      {
        offset: 0,
        simulations: [
          sim({ id: 'a1', simulation_url: A, start_sec: 0, end_sec: 10 }),
          sim({ id: 'a2', simulation_url: A2, start_sec: 15, end_sec: 25 }),
          sim({ id: 'b1', simulation_url: B, start_sec: 30, end_sec: 40 }),
        ],
      },
    ]);
    const plan = planWindowResidency(seq, 5, 45);
    expect(plan.active?.packageKey).toBe(packageKeyOf(A));
    expect(plan.next?.packageKey).toBe(packageKeyOf(B));   // NOT A2's package (already live)
    expect(plan.keep).toEqual(new Set([packageKeyOf(A), packageKeyOf(B)]));
  });

  it('active + next stay within a two-package keep set at boundaries', () => {
    // t=85: inside B@82-90; A@100 is 15s away (distinct from B).
    const plan = planWindowResidency(occ, 85, 45);
    expect(plan.active?.packageKey).toBe(packageKeyOf(B));
    expect(plan.next?.packageKey).toBe(packageKeyOf(A));
    expect(plan.keep.size).toBe(2);
  });
});
