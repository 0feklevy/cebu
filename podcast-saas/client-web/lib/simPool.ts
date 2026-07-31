// Resident sim pool collection — pure, unit-testable.
//
// IDENTITY IS THE PACKAGE, NOT THE SECTION URL. A generated simulation package hosts MANY
// timeline sections through one combined bridge (`…/index.html?section=<id>&v=<hash>` —
// same document, different default section). Real projects therefore have few PACKAGES
// (1–3) but many section URLs; pooling by URL would boot the same heavy WebGL scene many
// times over. One resident document per package + the bridge's dynamic dispatch
// (startScript(sectionId), v2) serves every section with a single scene/context.
//
// Only the ACTIVE PATH is collected for branching projects (entry sequence): other
// branches' sims are pooled on demand when their sequence loads — never speculatively.

import type { PlayerConfig, SimulationOverlay } from '../components/viewer/types';

export interface SimPoolFrameSpec {
  /** Package identity: the entry URL stripped of query/hash. The pool key everywhere. */
  key: string;
  /** Full section URL the frame loads (carries the ?section default + cache-buster). */
  src: string;
  /** Minimal-UI selectors for the #simboot first-paint hint (first-using section's). */
  bootHide: string[] | null;
}

export const SIM_POOL_CAP = 4;

/** Package identity of a sim section URL: origin+path, no query/hash. */
export function packageKeyOf(url: string): string {
  try {
    const u = new URL(url, 'http://x');   // base tolerates relative URLs
    return u.origin === 'http://x' ? u.pathname : u.origin + u.pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/** Minimal-UI selectors a sim section should BOOT with (only when simple_ui + mechanical hides). */
export function bootHideFor(sec: Pick<SimulationOverlay, 'simple_ui' | 'ui_hide'> | null | undefined): string[] | null {
  return sec?.simple_ui && sec.ui_hide?.length ? sec.ui_hide : null;
}

/** Every unique PACKAGE on the active path, first-appearance order, capped. */
export function collectSimPool(config: PlayerConfig, cap: number = SIM_POOL_CAP): SimPoolFrameSpec[] {
  const out: SimPoolFrameSpec[] = [];
  const seen = new Set<string>();
  const visit = (sections: SimulationOverlay[] | undefined) => {
    for (const sec of sections ?? []) {
      if (!sec.simulation_url) continue;
      const key = packageKeyOf(sec.simulation_url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, src: sec.simulation_url, bootHide: bootHideFor(sec) });
    }
  };
  const branching = config.branching ?? null;
  if (branching) {
    // Active path only: the entry sequence. Other branches pool when actually entered.
    const entry = branching.sequences.find((s) => s.id === branching.entry_sequence_id) ?? branching.sequences[0];
    for (const seg of entry?.segments ?? []) visit(seg.simulations);
  } else {
    for (const seg of config.segments ?? []) visit(seg.simulations);
  }
  return out.slice(0, cap);
}
