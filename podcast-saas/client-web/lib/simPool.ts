// Resident sim pool collection — pure, unit-testable.
//
// A video has at most a few sims (typically 1–3). Instead of loading a sim when its section
// arrives (a race the boundary can lose), the viewer mounts EVERY unique sim once, up front,
// in persistent hidden iframes that stay for the whole session — transitions are then pure
// opacity swaps of already-painted frames. This module decides WHAT to pool: every unique
// simulation_url across the flat timeline AND all branching sequences, in first-appearance
// order, carrying the first-using section's minimal-UI boot hint. Capped to protect WebGL
// context limits (browsers allow ~8–16 live contexts; we stay far below).

import type { PlayerConfig, SimulationOverlay } from '../components/viewer/types';

export interface SimPoolFrameSpec {
  url: string;                 // RAW simulation_url — the identity key everywhere
  bootHide: string[] | null;   // minimal-UI selectors for the #simboot first-paint hint
}

export const SIM_POOL_CAP = 4;

/** Minimal-UI selectors a sim section should BOOT with (only when simple_ui + mechanical hides). */
export function bootHideFor(sec: Pick<SimulationOverlay, 'simple_ui' | 'ui_hide'> | null | undefined): string[] | null {
  return sec?.simple_ui && sec.ui_hide?.length ? sec.ui_hide : null;
}

/** Every unique sim in the config, first-appearance order, capped. */
export function collectSimPool(config: PlayerConfig, cap: number = SIM_POOL_CAP): SimPoolFrameSpec[] {
  const out: SimPoolFrameSpec[] = [];
  const seen = new Set<string>();
  const visit = (sections: SimulationOverlay[] | undefined) => {
    for (const sec of sections ?? []) {
      if (!sec.simulation_url || seen.has(sec.simulation_url)) continue;
      seen.add(sec.simulation_url);
      out.push({ url: sec.simulation_url, bootHide: bootHideFor(sec) });
    }
  };
  // Entry sequence first (its sims are needed soonest), then the flat segments, then the
  // remaining branching sequences in declared order.
  const branching = config.branching ?? null;
  if (branching) {
    const entry = branching.sequences.find((s) => s.id === branching.entry_sequence_id) ?? branching.sequences[0];
    for (const seg of entry?.segments ?? []) visit(seg.simulations);
  }
  for (const seg of config.segments ?? []) visit(seg.simulations);
  for (const seq of branching?.sequences ?? []) {
    for (const seg of seq.segments) visit(seg.simulations);
  }
  return out.slice(0, cap);
}
