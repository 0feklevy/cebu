import { describe, it, expect } from 'vitest';
import { collectSimPool, bootHideFor, SIM_POOL_CAP } from '../lib/simPool';
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

describe('collectSimPool — every unique sim, first-appearance order, capped', () => {
  it('collects unique urls across segments, keeping first-appearance order', () => {
    const pool = collectSimPool(cfg([
      seg([sim({ id: 'a', simulation_url: 'u1' }), sim({ id: 'b', simulation_url: 'u2' })]),
      seg([sim({ id: 'c', simulation_url: 'u1' })], 'seg2'),   // duplicate url → ignored
    ]));
    expect(pool.map((p) => p.url)).toEqual(['u1', 'u2']);
  });

  it('skips sections without a simulation_url', () => {
    const pool = collectSimPool(cfg([seg([sim({ id: 'a', simulation_url: null }), sim({ id: 'b', simulation_url: 'u9' })])]));
    expect(pool.map((p) => p.url)).toEqual(['u9']);
  });

  it('carries the FIRST using section boot-hide (simple_ui + ui_hide)', () => {
    const pool = collectSimPool(cfg([
      seg([
        sim({ id: 'a', simulation_url: 'u1', simple_ui: true, ui_hide: ['#panel', '.hud'] }),
        sim({ id: 'b', simulation_url: 'u1', simple_ui: false }),   // later section — ignored
      ]),
    ]));
    expect(pool).toEqual([{ url: 'u1', bootHide: ['#panel', '.hud'] }]);
  });

  it('no boot-hide without simple_ui (or with an empty hide list)', () => {
    expect(bootHideFor(sim({ simple_ui: false, ui_hide: ['#x'] }))).toBeNull();
    expect(bootHideFor(sim({ simple_ui: true, ui_hide: [] }))).toBeNull();
    expect(bootHideFor(sim({ simple_ui: true, ui_hide: ['#x'] }))).toEqual(['#x']);
  });

  it('walks branching sequences — entry sequence first', () => {
    const branching = {
      entry_sequence_id: 'seqB',
      sequences: [
        { id: 'seqA', segments: [seg([sim({ id: 'a', simulation_url: 'uA' })], 'sA')] },
        { id: 'seqB', segments: [seg([sim({ id: 'b', simulation_url: 'uB' })], 'sB')] },
      ],
    } as unknown as NonNullable<PlayerConfig['branching']>;
    const pool = collectSimPool(cfg([], branching));
    expect(pool.map((p) => p.url)).toEqual(['uB', 'uA']);   // entry sequence's sim first
  });

  it('caps the pool size', () => {
    const many = Array.from({ length: SIM_POOL_CAP + 3 }, (_, i) =>
      sim({ id: `s${i}`, simulation_url: `u${i}` }));
    expect(collectSimPool(cfg([seg(many)]))).toHaveLength(SIM_POOL_CAP);
  });

  it('empty config → empty pool', () => {
    expect(collectSimPool(cfg([]))).toEqual([]);
  });
});
