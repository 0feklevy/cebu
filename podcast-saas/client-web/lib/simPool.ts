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

import { variantKeyFor, variantParamOf } from 'shared/src/sim/simIdentity';
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
export const sectionKeyOf = variantParamOf;

/**
 * The script id a DYNAMIC (v2) bridge must receive to run this section's own body — and, on the
 * activation-scoped path, the `variantKey` axis of the presentation identity.
 *
 * Delegated to `shared/src/sim/simIdentity` because the BACKEND keys posters on the same value
 * (buildPlayerConfig). A second implementation here would let the two drift, and a drifted variant
 * key means a poster captured for one sub-simulation being shown in place of another — precisely
 * the "one generic screenshot for different variants" failure posterIdentity.ts forbids.
 */
export const dynamicScriptFor: (sec: Pick<SimulationOverlay, 'id' | 'simulation_url' | 'sim_script'>) => string =
  variantKeyFor;

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
 * The section shape every collector below needs: a URL to mount and the absolute window it plays
 * in. Deliberately structural rather than `SimulationOverlay`, because the EDITOR's rows are
 * `TimelineSection`s laid out against the global timeline, not player-config overlays — and a
 * second copy of "which packages does this timeline use, and when" is exactly how the editor's
 * residency and the viewer's would drift apart. (audit §9.2)
 */
export interface SimSectionWindow {
  simulation_url: string | null;
  absStartSec: number;
  absEndSec: number;
  bootHide: string[] | null;
}

/**
 * Sort sim sections into absolute-time occurrences. The one place the occurrence shape is built,
 * so both surfaces feed `planWindowResidency` the same thing.
 */
export function simOccurrencesOf(sections: readonly SimSectionWindow[]): SimOccurrence[] {
  const out: SimOccurrence[] = [];
  for (const sec of sections) {
    if (!sec.simulation_url) continue;
    out.push({
      packageKey: packageKeyOf(sec.simulation_url),
      src: sec.simulation_url,
      bootHide: sec.bootHide,
      absStartSec: sec.absStartSec,
      absEndSec: sec.absEndSec,
    });
  }
  return out.sort((a, b) => a.absStartSec - b.absStartSec);
}

/**
 * Flatten the active path into absolute-time sim occurrences, sorted by start.
 * `segments` must be the ACTIVE sequence's segments in play order with their timeline
 * offsets (the player already maintains these for seeking).
 */
export function flattenSimOccurrences(
  segments: { offset: number; simulations?: SimulationOverlay[] | undefined }[],
): SimOccurrence[] {
  return simOccurrencesOf(
    segments.flatMap((seg) => (seg.simulations ?? []).map((sec) => ({
      simulation_url: sec.simulation_url,
      bootHide: bootHideFor(sec),
      absStartSec: seg.offset + sec.start_sec,
      absEndSec: seg.offset + sec.end_sec,
    }))),
  );
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

/**
 * Every unique PACKAGE in a section list, first-appearance order, capped — the collector both
 * surfaces share. The viewer walks a `PlayerConfig`; the editor walks its own timeline rows. Only
 * the WALK differs, so only the walk is per-surface (audit §9.2).
 */
export function collectSimPackages(
  sections: Iterable<{ simulation_url: string | null; bootHide: string[] | null }>,
  cap: number = SIM_POOL_CAP,
): SimPoolFrameSpec[] {
  const out: SimPoolFrameSpec[] = [];
  const seen = new Set<string>();
  for (const sec of sections) {
    if (!sec.simulation_url) continue;
    const key = packageKeyOf(sec.simulation_url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, src: sec.simulation_url, bootHide: sec.bootHide });
  }
  return out.slice(0, cap);
}

/** Every unique PACKAGE on the active path, first-appearance order, capped. */
export function collectSimPool(config: PlayerConfig, cap: number = SIM_POOL_CAP): SimPoolFrameSpec[] {
  const branching = config.branching ?? null;
  // Active path only: the entry sequence. Other branches pool when actually entered.
  const segments = branching
    ? (branching.sequences.find((s) => s.id === branching.entry_sequence_id) ?? branching.sequences[0])?.segments ?? []
    : config.segments ?? [];
  return collectSimPackages(
    segments.flatMap((seg) => (seg.simulations ?? []).map((sec) => ({
      simulation_url: sec.simulation_url,
      bootHide: bootHideFor(sec),
    }))),
    cap,
  );
}

// ─── Editor residency (audit §9.3 Stages 2-4) ───────────────────────────────────────────────
//
// The editor is NOT the viewer, and three of its differences are load-bearing (audit §9.4):
//
//   1. It legitimately hosts TWO simulation surfaces — the timeline and the section editor's
//      preview. Residency has to budget for both, so the timeline's own budget is ONE document:
//      `EDITOR_SIM_RESIDENT_CAP`. The viewer's `SIM_POOL_CAP = 4` is deliberately not ported.
//   2. Editor users seek constantly, so the viewer's 45 s linear-playback lead would mispredict
//      most of the time. `EDITOR_WARM_LEAD_SEC` warms the NEXT section, not a window, and the
//      caller makes the warm cheap to cancel.
//   3. Authoring invalidates: a regeneration, the picker and the live toggles SHOULD replace the
//      resident document. `simDocumentSwitch` is where "same document" is decided, and it answers
//      `navigate` for every one of those.

/** One timeline document. The preview panel is the second WebGL context this budget accounts for. */
export const EDITOR_SIM_RESIDENT_CAP = 1;

/**
 * How far ahead of the playhead the editor may boot the next package, in seconds.
 *
 * Comfortably longer than the paint budget the viewer allows a package to warm in (8 s) and far
 * shorter than the viewer's 45 s linear lead: a lead the user can outrun by seeking is a lead that
 * mostly warms documents nobody visits, and every one of those costs a WebGL context.
 */
export const EDITOR_WARM_LEAD_SEC = 10;

/** What the ONE resident timeline document is being kept for. */
export type EditorResidencyRole =
  /** The playhead is inside this package's section — it is (or is becoming) the presented one. */
  | 'active'
  /** Booting ahead of its section. Never composited: the slot gates compositing on `active`. */
  | 'warm'
  /** Nothing is due: whatever is resident may be released by the destroy grace. */
  | 'release';

export interface EditorResidencyPlan {
  key: string | null;
  /** The URL to mount. Null on 'release' — releasing names no new document. */
  src: string | null;
  bootHide: string[] | null;
  role: EditorResidencyRole;
}

/**
 * Which package the editor's single timeline slot should hold.
 *
 * `next` must already be lead-bounded — `planWindowResidency(occurrences, now, EDITOR_WARM_LEAD_SEC)`
 * computes it, and reusing that planner is what keeps "the next DISTINCT upcoming package" defined
 * once for both surfaces. What is editor-specific is only the CAP applied to its answer: the viewer
 * keeps `active` AND `next` resident, the editor keeps exactly one of them, because a second
 * timeline document plus the preview is three WebGL contexts on a machine that is also decoding
 * video and rendering a timeline.
 */
export function planEditorResidency(input: {
  active: SimPoolFrameSpec | null;
  next: SimPoolFrameSpec | null;
  resident: string | null;
}): EditorResidencyPlan {
  if (input.active) return { ...input.active, role: 'active' };
  if (input.next) return { ...input.next, role: 'warm' };
  return { key: input.resident, src: null, bootHide: null, role: 'release' };
}

/** Does the mounted document serve `next`, or must the frame navigate to it? */
export type SimDocumentSwitch = 'reuse' | 'navigate';

/**
 * THE DOCUMENT-IDENTITY RULE for a surface that mounts one section at a time.
 *
 * Until §9.3 Stage 2 the editor compared FULL URLs, so two sections of one package never matched
 * and every sim→sim boundary re-fetched, re-parsed and re-booted a WebGL document that was already
 * on screen. Identity is the PACKAGE:
 *
 *   • different package (or nothing mounted) → navigate. A regeneration mints a new revision path
 *     and a new `?v=`, and a rollback moves the pointer, so authoring invalidation lands here by
 *     construction — which is the behaviour P1.1 established and §9.4 item 4 says to keep.
 *   • same package, same URL → reuse, unchanged.
 *   • same package, different section, DYNAMIC document → reuse. The v2 bridge dispatches
 *     `startScript(variantKeyFor(section))` in place; the boundary becomes a postMessage.
 *   • same package, different section, NOT proven dynamic → navigate. A legacy bridge resolves
 *     every name through the LOADED document's `?section=` default, so postMessage cannot move it
 *     off the section it booted with; dispatching would silently run the wrong sub-simulation.
 *     `dynamic` is null until SIM_READY classifies the document, and null must take this branch:
 *     the safe answer for an unclassified document is the one that always worked.
 */
export function simDocumentSwitch(input: {
  /** The URL the frame currently has mounted (the runtime's documentKey), or null. */
  mounted: string | null;
  /** The mounted document's v2 dynamic-dispatch capability; null until SIM_READY says. */
  mountedDynamic: boolean | null;
  next: string;
}): SimDocumentSwitch {
  if (!input.mounted) return 'navigate';
  if (packageKeyOf(input.mounted) !== packageKeyOf(input.next)) return 'navigate';
  if (input.mounted === input.next) return 'reuse';
  return input.mountedDynamic === true ? 'reuse' : 'navigate';
}

/**
 * The script id to dispatch on a document whose capability is known.
 *
 * A dynamic bridge is addressed by the section's variant key (its `?section=` identity, shared with
 * the backend's poster keying). A legacy one only understands its stored entry-point name, which on
 * every generated row is the literal 'main' — meaningless as an identity, which is exactly why it
 * cannot survive a same-document switch and why `simDocumentSwitch` navigates instead.
 */
export function simScriptFor(
  section: Pick<SimulationOverlay, 'id' | 'simulation_url' | 'sim_script'>,
  dynamic: boolean | null,
): string {
  return dynamic === true ? dynamicScriptFor(section) : (section.sim_script ?? 'main');
}
