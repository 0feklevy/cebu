/**
 * Contract plan → resolved splice plan (pure — no fs, no ffmpeg, no db).
 *
 * `buildExportPlan` emits a LAYERED timeline mirroring the viewer: base `video`
 * windows cover the concatenated main videos, and section windows (clip, image,
 * sim-capture → poster-fallback) OVERLAP them, exactly as the player stacks its
 * layers. A rendered sim window may extend past its host video's end (post-roll),
 * which is why `totalDurationSec` can exceed the base coverage.
 *
 * The splice graph needs the opposite shape: one contiguous, non-overlapping list
 * of windows from 0 to the total. This module flattens the layers:
 *
 *   - at any instant the TOPMOST layer wins, with the viewer's stacking order
 *     (plan doc §2): sim/poster (pool, layer 6) over image (layer 4) over
 *     clip/b-roll (layer 3) over the base video;
 *   - the base video KEEPS PLAYING underneath an overlay (its audio window spans
 *     its whole duration), so when an overlay ends the base resumes at the source
 *     position corresponding to ABSOLUTE time — never where it left off;
 *   - a poster-fallback with no poster is dropped so the base video shows through
 *     (the planner's stated fallback); where nothing at all covers the timeline
 *     (post-roll tail without a poster), the gap renders as black, bounded;
 *   - every boundary is snapped to the output frame grid, so each spliced window
 *     is an exact number of frames and the total lands within one frame of
 *     `plan.totalDurationSec` — the duration gate's reference — by construction.
 *
 * Audio windows translate directly (they never overlap-splice; they mix):
 * absolute placement from `globalOffsetSec`, duration from the source in/out pair,
 * stored linear gain → dB for the `volume` filter.
 */

import type {
  ExportPlan,
  ExportWindow,
} from './types.js';
import type { AudioWindow, TimelineWindow } from './ffmpegGraph.js';
import {
  OVERLAY_LAYER, firstOverlappingPair, stacksAbove, type StackRank,
} from 'shared';

/** The plan cannot be assembled as written — a planner/contract bug, not a media failure. */
export class ExportPlanShapeError extends Error {
  constructor(detail: string) {
    super(`export plan is not assemblable: ${detail}`);
    this.name = 'ExportPlanShapeError';
  }
}

export interface TranslatedPlan {
  /** Contiguous splice windows, frame-snapped, covering [0, totalSec) exactly. */
  timeline: TimelineWindow[];
  audio: AudioWindow[];
  /** Unique storage keys the assembler must materialise, in first-use order. */
  keys: string[];
  warnings: string[];
  totalSec: number;
}

/**
 * Viewer stacking order (plan doc §2): sim pool > image > clip/b-roll > base video.
 *
 * The NUMBERS now come from `shared`, because the viewer resolves the same question and used to
 * answer it differently (broll-player-002). Mapping stays here — only this file knows what an
 * `ExportWindow['kind']` is.
 */
const LAYER_PRIORITY: Record<ExportWindow['kind'], number> = {
  'sim-capture': OVERLAY_LAYER.sim,   // defensively mapped to poster-fallback below; same layer
  'poster-fallback': OVERLAY_LAYER.sim,
  image: OVERLAY_LAYER.image,
  clip: OVERLAY_LAYER.clip,
  video: OVERLAY_LAYER.base,
};

/** Stored linear gain → dB for the volume filter; null means "drop this window". */
export function gainToDb(gain: number): number | null {
  if (!Number.isFinite(gain) || gain <= 0) return null;
  const db = 20 * Math.log10(gain);
  return Math.max(-60, Math.min(12, db));
}

/**
 * A layer as the shared stacking rule sees it.
 *
 * Frames, not seconds — the comparison is unit-agnostic and this file has already snapped to the
 * frame grid, so ranking in frames is what makes two windows that snap to the same frame tie
 * exactly rather than by a float hair.
 *
 * The id is the SECTION id where there is one. That is the tiebreak the viewer uses too, and it is
 * why the two sides now agree on a genuine tie: array position, which this file used before, is not
 * something the viewer could ever have reproduced.
 */
function rankOf(l: Layer): StackRank {
  const sectionId = (l.w as { sectionId?: string }).sectionId;
  return {
    layer: l.priority,
    start: l.startF,
    end: l.endF,
    // A window with no section id is the base video, which never contends for a tie — the kind
    // string is a stable stand-in rather than a meaningful ordering.
    id: typeof sectionId === 'string' && sectionId.length > 0 ? sectionId : l.w.kind,
  };
}

interface Layer {
  w: ExportWindow;
  priority: number;
  /** Frame-snapped bounds, clamped to [0, totalFrames]. */
  startF: number;
  endF: number;
  /** Original (unsnapped) start, for source-position mapping. */
  rawStartSec: number;
  order: number;
}

const nearlyIdentityCrop = (c: { x: number; y: number; w: number; h: number }): boolean =>
  c.x <= 1e-4 && c.y <= 1e-4 && c.w >= 1 - 1e-4 && c.h >= 1 - 1e-4;

export function translateContractPlan(
  plan: ExportPlan,
  localPathOf: (storageKey: string) => string,
): TranslatedPlan {
  const fps = plan.grid.fps;
  if (!(fps > 0)) throw new ExportPlanShapeError(`grid fps ${fps}`);
  const warnings: string[] = [];
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  const pathOf = (key: string): string => {
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      keys.push(key);
    }
    return localPathOf(key);
  };
  const label = (w: ExportWindow): string => w.label ?? (w.sectionId ? `section ${w.sectionId}` : w.kind);

  if (!(plan.totalDurationSec > 0)) {
    throw new ExportPlanShapeError(`totalDurationSec ${plan.totalDurationSec}`);
  }
  const totalF = Math.round(plan.totalDurationSec * fps);
  if (totalF < 1) throw new ExportPlanShapeError('the export is shorter than one frame');

  // ── Layers: snap, clamp, validate, defensively substitute ───────────────────────────────────
  const layers: Layer[] = [];
  plan.timeline.forEach((w0, order) => {
    let w = w0;
    if (w.kind === 'sim-capture') {
      // The runner substitutes sim-capture windows before assembling (Phase 1). If one
      // reaches the assembler anyway, it degrades to its poster fallback LOUDLY here
      // rather than failing the whole export or, worse, silently skipping the window.
      warnings.push(`${label(w)}: sim-capture window reached the assembler — rendered as its poster fallback`);
      w = {
        kind: 'poster-fallback',
        sectionId: w.sectionId,
        label: w.label,
        startSec: w.startSec,
        endSec: w.endSec,
        posterKey: w.posterKey,
      };
    }
    if (w.kind === 'poster-fallback' && !w.posterKey) {
      // No poster: the base video shows through (the planner already warned). Where no
      // base exists either (post-roll tail), the gap-filler below renders black.
      return;
    }
    const startF = Math.max(0, Math.round(w.startSec * fps));
    const endF = Math.min(totalF, Math.round(w.endSec * fps));
    if (endF <= startF) return; // sub-frame after snapping/clamping — nothing to draw
    if (Math.round(w.endSec * fps) > totalF) {
      warnings.push(`${label(w)}: window extends past the export end and was clipped to it`);
    }
    if (w.kind === 'video' || w.kind === 'clip') {
      if (!w.storageKey) {
        throw new ExportPlanShapeError(
          `${label(w)} (${w.kind}) has no source master in storage — re-upload it and export again`,
        );
      }
      const winDur = w.endSec - w.startSec;
      const srcDur = w.sourceOutSec - w.sourceInSec;
      if (Math.abs(winDur - srcDur) > 1 / fps + 1e-3) {
        throw new ExportPlanShapeError(
          `${label(w)} (${w.kind}): window is ${winDur.toFixed(3)}s but its source range is ` +
          `${srcDur.toFixed(3)}s — splice windows play 1:1`,
        );
      }
    }
    layers.push({ w, priority: LAYER_PRIORITY[w.kind], startF, endF, rawStartSec: w.startSec, order });
  });

  // Overlap between overlays is resolvable (stacking order) but worth surfacing once.
  //
  // The wording used to promise "the viewer's stacking order decides which is visible" — a stacking
  // order the viewer did not have, which is precisely how the two surfaces diverged in silence.
  // Both now call `stacksAbove`, so the promise is true; the warning stays because an overlap is
  // still usually an authoring mistake.
  const overlapping = firstOverlappingPair(
    layers.filter((l) => l.priority > 0).map((l) => ({ ...rankOf(l), label: label(l.w) })),
  );
  if (overlapping) {
    const [a, b] = overlapping;
    warnings.push(
      `${a.label} and ${b.label} overlap on the timeline — the one that starts later is the one ` +
      `that shows, in the player and in this export alike`,
    );
  }

  // ── Sweep the frame axis: topmost layer per elementary interval ─────────────────────────────
  const cuts = new Set<number>([0, totalF]);
  for (const l of layers) {
    cuts.add(l.startF);
    cuts.add(l.endF);
  }
  const marks = [...cuts].sort((x, y) => x - y);

  interface Piece {
    layer: Layer | null; // null → nothing covers this stretch → black
    startF: number;
    endF: number;
  }
  const pieces: Piece[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const aF = marks[i]!;
    const bF = marks[i + 1]!;
    // Containment, not overlap: this elementary interval is either wholly inside a layer or
    // wholly outside it, so the shared `coversPoint` test is applied to the interval's start.
    let winner: Layer | null = null;
    for (const l of layers) {
      if (l.startF > aF || l.endF < bF) continue;
      if (winner === null || stacksAbove(rankOf(l), rankOf(winner))) winner = l;
    }
    const prev = pieces[pieces.length - 1];
    if (prev && prev.layer === winner && prev.endF === aF) {
      prev.endF = bF; // same layer, contiguous → one splice window (source mapping is linear)
    } else {
      pieces.push({ layer: winner, startF: aF, endF: bF });
    }
  }

  // ── Pieces → resolved splice windows ──────────────────────────────────────────────────────────
  const timeline: TimelineWindow[] = pieces.map((p) => {
    const startSec = p.startF / fps;
    const endSec = p.endF / fps;
    if (p.layer === null) {
      return { kind: 'poster-fallback' as const, startSec, endSec };
    }
    const w = p.layer.w;
    switch (w.kind) {
      case 'video':
      case 'clip': {
        // The base keeps playing under overlays: the source position tracks ABSOLUTE
        // time. (For clips the same rule holds across a split by a higher layer.)
        const sourceInSec = w.sourceInSec + (startSec - p.layer.rawStartSec);
        return {
          kind: w.kind,
          startSec,
          endSec,
          sourcePath: pathOf(w.storageKey!),
          sourceInSec: Math.max(0, sourceInSec),
        };
      }
      case 'image':
        return {
          kind: 'image' as const,
          startSec,
          endSec,
          sourcePath: pathOf(w.storageKey),
          cropFrac: nearlyIdentityCrop(w.crop) ? undefined : w.crop,
        };
      case 'poster-fallback':
        return {
          kind: 'poster-fallback' as const,
          startSec,
          endSec,
          sourcePath: pathOf(w.posterKey!), // null-poster layers were dropped above
        };
      case 'sim-capture':
        // unreachable: substituted before layering
        throw new ExportPlanShapeError('sim-capture survived substitution');
    }
  });

  if (timeline.some((t) => t.kind === 'poster-fallback' && !t.sourcePath)) {
    warnings.push('parts of the timeline have no content (no base video, no poster) — they render as black');
  }

  // ── Audio ─────────────────────────────────────────────────────────────────────────────────────
  const totalSec = totalF / fps;
  const audio: AudioWindow[] = [];
  for (const a of plan.audio) {
    const name = a.sectionId ? `audio for section ${a.sectionId}` : `${a.source} audio`;
    if (!a.storageKey) {
      warnings.push(`${name}: no stored source — omitted from the mix`);
      continue;
    }
    const gainDb = gainToDb(a.gain);
    if (a.gain !== 1 && gainDb === null) {
      warnings.push(`${name}: stored gain ${a.gain} silences it — omitted from the mix`);
      continue;
    }
    const dur = a.sourceOutSec - a.sourceInSec;
    if (!(dur > 1e-6)) {
      warnings.push(`${name}: empty source range — omitted from the mix`);
      continue;
    }
    let startSec = a.globalOffsetSec;
    let endSec = a.globalOffsetSec + dur;
    let sourceInSec = a.sourceInSec;
    if (startSec >= totalSec - 1e-6) {
      warnings.push(`${name}: starts after the export ends — omitted from the mix`);
      continue;
    }
    if (startSec < 0) {
      sourceInSec += -startSec; // the part before 0 is never heard; keep the mapping 1:1
      startSec = 0;
    }
    if (endSec > totalSec + 1e-6) {
      warnings.push(`${name}: extends past the export end and was trimmed to it`);
      endSec = totalSec;
    }
    audio.push({
      sourcePath: pathOf(a.storageKey),
      startSec,
      endSec,
      sourceInSec,
      gainDb: a.gain === 1 ? undefined : gainDb!,
    });
  }

  return { timeline, audio, keys, warnings, totalSec };
}
