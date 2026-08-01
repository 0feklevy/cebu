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

/** Sub-simulation key of a sim section URL: its `?section=` param (null when absent). */
export function sectionKeyOf(url: string): string | null {
  try {
    return new URL(url, 'http://x').searchParams.get('section');
  } catch {
    const m = /[?&]section=([^&#]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

/**
 * The script id a DYNAMIC (v2) bridge must receive to run this section's own body.
 *
 * The URL's `?section=` param — not the row id, and never the stored sim_script — is the
 * authoritative key: bridge bodies are keyed by the section id the URL was minted with
 * (`?section=<id>&v=<hash>` at bridge-upload time), and DUPLICATED sections keep the
 * ORIGINAL's URL/param while their own row id has no body in the bridge. The persisted
 * sim_script is the literal 'main' on every generated row (the legacy entry-point name,
 * not a section identity); a v2 bridge resolves 'main' to the LOADED URL's ?section
 * default — in a pooled document that is the first-pooled section, so sending it ran one
 * variation in every section of the package (the sub-simulation regression).
 */
export function dynamicScriptFor(sec: Pick<SimulationOverlay, 'id' | 'simulation_url' | 'sim_script'>): string {
  const urlKey = sec.simulation_url ? sectionKeyOf(sec.simulation_url) : null;
  if (urlKey) return urlKey;
  // No ?section= on the URL (single-section/legacy-shaped packages): a real named script
  // still wins; the meaningless literal 'main' falls through to the section id.
  if (sec.sim_script && sec.sim_script !== 'main') return sec.sim_script;
  return sec.id;
}

/** Minimal-UI selectors a sim section should BOOT with (only when simple_ui + mechanical hides). */
export function bootHideFor(sec: Pick<SimulationOverlay, 'simple_ui' | 'ui_hide'> | null | undefined): string[] | null {
  return sec?.simple_ui && sec.ui_hide?.length ? sec.ui_hide : null;
}

// ─── Window-tier residency planning (pure, unit-tested) ─────────────────────────────────
//
// The 'window' tier (weak/touch/Data-Saver devices) keeps only the ACTIVE package plus the
// NEXT distinct upcoming package resident. The original in-hook implementation had three
// audited defects (optimization brief §3-P1, all verified against the code):
//   1. it mounted the FIRST package at video start even when its first section was minutes
//      away (initial cap=1 taken from first-appearance order);
//   2. it scanned only the current segment and segment+1, so a sim in segment+2 that was
//      within the 45s lead was missed when segments are short;
//   3. eviction was guarded by `want.size > 0`, so during a long sim-free gap stale frames
//      (WebGL context + heap) were retained indefinitely.
// This planner replaces that logic with an absolute-time occurrence scan across the WHOLE
// remaining active path, and its result is authoritative: the caller keeps exactly the
// returned packages and evicts everything else — including when the result is empty.

export interface SimOccurrence {
  /** Pool key of the package (packageKeyOf of the section URL). */
  packageKey: string;
  /** Full section URL (the frame src if this occurrence mounts the package). */
  src: string;
  bootHide: string[] | null;
  /** Absolute media time on the active path (segment offset + section start/end). */
  absStartSec: number;
  absEndSec: number;
}

/**
 * Flatten the active path into absolute-time sim occurrences, sorted by start.
 * `segments` must be the ACTIVE sequence's segments in play order with their timeline
 * offsets (the player already maintains these for seeking).
 */
export function flattenSimOccurrences(
  segments: { offset: number; simulations?: SimulationOverlay[] | undefined }[],
): SimOccurrence[] {
  const out: SimOccurrence[] = [];
  for (const seg of segments) {
    for (const sec of seg.simulations ?? []) {
      if (!sec.simulation_url) continue;
      out.push({
        packageKey: packageKeyOf(sec.simulation_url),
        src: sec.simulation_url,
        bootHide: bootHideFor(sec),
        absStartSec: seg.offset + sec.start_sec,
        absEndSec: seg.offset + sec.end_sec,
      });
    }
  }
  return out.sort((a, b) => a.absStartSec - b.absStartSec);
}

export interface WindowResidencyPlan {
  /** Package occurrence covering `nowSec`, if any. */
  active: SimOccurrence | null;
  /** First DISTINCT upcoming package whose section starts within `leadSec`. */
  next: SimOccurrence | null;
  /** The exact set of package keys that may stay resident. Everything else is evicted. */
  keep: Set<string>;
}

/**
 * Decide window-tier residency at `nowSec`. Pure — the hook feeds it the flattened
 * occurrences and applies `keep` verbatim (mount what is missing, drop what is not listed).
 *
 * "Next" deliberately means the next DISTINCT package, not the next sim row: when the
 * upcoming row reuses the active package there is nothing to prefetch for it, and the row
 * after it may belong to a package that genuinely needs the 45s boot lead.
 */
export function planWindowResidency(
  occurrences: SimOccurrence[],
  nowSec: number,
  leadSec: number,
): WindowResidencyPlan {
  let active: SimOccurrence | null = null;
  for (const occ of occurrences) {
    if (occ.absStartSec <= nowSec && nowSec < occ.absEndSec) { active = occ; break; }
  }
  let next: SimOccurrence | null = null;
  for (const occ of occurrences) {
    if (occ.absStartSec <= nowSec) continue;
    if (occ.absStartSec - nowSec > leadSec) break;          // sorted — nothing closer follows
    if (active && occ.packageKey === active.packageKey) continue;  // same package: already live
    next = occ;
    break;
  }
  const keep = new Set<string>();
  if (active) keep.add(active.packageKey);
  if (next) keep.add(next.packageKey);
  return { active, next, keep };
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
