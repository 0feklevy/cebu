'use client';

/**
 * Drag / trim / split math for the Audio Studio. Order-preserving: blocks keep
 * script order, so a "move" is really a change to `gapBeforeMs`. Sticky mode lets
 * that change ripple downstream; local mode compensates the next gap so following
 * clips keep their absolute position. Every clip, including short reactions, is
 * part of the chain. Snapping is magnetic to neighbor edges, the playhead, and t=0.
 */

import { layoutMix, MIN_CLIP_MS, type MixTimeline, type MixPlacement } from 'shared';

export type Interaction =
  | { kind: 'move'; index: number; grabDx: number; base: MixTimeline }
  | { kind: 'trim'; index: number; edge: 'in' | 'out'; base: MixTimeline }
  | { kind: 'scrub' };

export interface SnapCtx {
  placements: MixPlacement[];
  timeline: MixTimeline;
  laneOf: (turnId: string) => string;
  index: number;         // block being edited
  pxPerSec: number;
  playheadMs: number;
}

/** Snap a candidate start (ms) to nearby anchors within an 8px threshold. */
export function snapStart(desiredMs: number, ctx: SnapCtx): number {
  const thresholdMs = (8 / ctx.pxPerSec) * 1000;
  const lane = clipLane(ctx.timeline, ctx.index, ctx.laneOf);
  const anchors: { at: number; weight: number }[] = [{ at: 0, weight: 1 }, { at: ctx.playheadMs, weight: 1 }];
  ctx.placements.forEach((p, i) => {
    if (i === ctx.index) return;
    if (clipLane(ctx.timeline, i, ctx.laneOf) !== lane) return;
    anchors.push({ at: p.startMs, weight: 1 });
    anchors.push({ at: p.startMs + (p.outMs - p.inMs), weight: 1.5 }); // clip END = zero-gap latch (stickier)
  });
  let best = desiredMs;
  let bestDist = thresholdMs;
  for (const a of anchors) {
    const d = Math.abs(desiredMs - a.at) / a.weight;
    if (d < bestDist) { bestDist = d; best = a.at; }
  }
  return Math.round(best);
}

const durOfFrom = (clips: Map<string, number>) => (id: string) => clips.get(id) ?? 0;
const intMs = (n: number) => Math.round(n);
const clampInt = (n: number, min: number, max: number) => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return intMs(Math.max(lo, Math.min(n, hi)));
};
const spanMs = (p: MixPlacement) => p.outMs - p.inMs;
const endMs = (p: MixPlacement) => p.startMs + spanMs(p);
const clipLane = (tl: MixTimeline, index: number, laneOf: (turnId: string) => string) => {
  const c = tl.clips[index];
  return c?.lane ?? (c ? laneOf(c.turnId) : 'main');
};
const neighborIndex = (tl: MixTimeline, index: number, laneOf: (turnId: string) => string, dir: -1 | 1): number => {
  const lane = clipLane(tl, index, laneOf);
  for (let i = index + dir; i >= 0 && i < tl.clips.length; i += dir) {
    if (clipLane(tl, i, laneOf) === lane) return i;
  }
  return -1;
};

function rippleOtherLanes(
  clips: MixTimeline['clips'],
  tl: MixTimeline,
  placements: MixPlacement[],
  selectedIndex: number,
  laneOf: (turnId: string) => string,
  thresholdMs: number,
  deltaMs: number,
): void {
  const delta = intMs(deltaMs);
  if (delta === 0) return;
  const selectedLane = clipLane(tl, selectedIndex, laneOf);
  const firstByLane = new Map<string, number>();

  placements.forEach((p, i) => {
    if (i === selectedIndex || p.startMs < thresholdMs) return;
    const lane = clipLane(tl, i, laneOf);
    if (lane === selectedLane) return;
    const current = firstByLane.get(lane);
    if (current == null || p.startMs < placements[current].startMs) firstByLane.set(lane, i);
  });

  firstByLane.forEach((i) => {
    clips[i] = { ...clips[i], gapBeforeMs: Math.max(0, intMs(clips[i].gapBeforeMs + delta)) };
  });
}

/** Move block `index` so its start lands at `newStartMs` — rewrites its gapBeforeMs. */
export function moveBlock(tl: MixTimeline, index: number, newStartMs: number, dur: Map<string, number>, sticky: boolean, laneOf: (turnId: string) => string): MixTimeline {
  const { placements } = layoutMix(tl, durOfFrom(dur), laneOf);
  const p = placements[index];
  if (!p) return tl;
  // Overwrite edit: the moved clip wins. If it enters the previous/next clip,
  // trim that neighbor at the moved clip's edge instead of blocking the drag.
  const prevIndex = neighborIndex(tl, index, laneOf, -1);
  const nextIndex = neighborIndex(tl, index, laneOf, 1);
  const prev = prevIndex >= 0 ? placements[prevIndex] : undefined;
  const next = nextIndex >= 0 ? placements[nextIndex] : undefined;
  const prevEnd = prev ? endMs(prev) : 0;
  const nextEnd = next ? endMs(next) : Infinity;
  const minStart = prev ? prev.startMs + MIN_CLIP_MS : 0;
  const maxStart = !sticky && next ? nextEnd - MIN_CLIP_MS - spanMs(p) : Infinity;
  const startMs = clampInt(newStartMs, minStart, maxStart);
  const clips = [...tl.clips];
  let anchorEnd = prevEnd;
  if (prev && startMs < prevEnd) {
    const overlap = prevEnd - startMs;
    clips[prevIndex] = { ...clips[prevIndex], trimEndMs: clips[prevIndex].trimEndMs + overlap };
    anchorEnd = startMs;
  }
  clips[index] = { ...clips[index], gapBeforeMs: Math.max(0, intMs(startMs - anchorEnd)) };
  if (!sticky && next) {
    const selectedEnd = startMs + spanMs(p);
    if (selectedEnd > next.startMs) {
      const overlap = Math.min(selectedEnd - next.startMs, Math.max(0, spanMs(next) - MIN_CLIP_MS));
      clips[nextIndex] = { ...clips[nextIndex], trimStartMs: clips[nextIndex].trimStartMs + overlap, gapBeforeMs: 0 };
    } else {
      const nextGap = next.startMs - selectedEnd;
      clips[nextIndex] = { ...clips[nextIndex], gapBeforeMs: Math.max(0, intMs(nextGap)) };
    }
  }
  if (sticky) rippleOtherLanes(clips, tl, placements, index, laneOf, p.startMs, startMs - p.startMs);
  return { ...tl, clips };
}

/** Trim one edge. Sticky mode ripples through layoutMix; local mode keeps the
 * next clip fixed and clamps extension before overlap. */
export function trimBlock(tl: MixTimeline, index: number, edge: 'in' | 'out', deltaMs: number, dur: Map<string, number>, sticky: boolean, laneOf: (turnId: string) => string): MixTimeline {
  const c = tl.clips[index];
  if (!c) return tl;
  const { placements } = layoutMix(tl, durOfFrom(dur), laneOf);
  const p = placements[index];
  if (!p) return tl;
  const prevIndex = neighborIndex(tl, index, laneOf, -1);
  const nextIndex = neighborIndex(tl, index, laneOf, 1);
  const prev = prevIndex >= 0 ? placements[prevIndex] : undefined;
  const next = nextIndex >= 0 ? placements[nextIndex] : undefined;
  const src = dur.get(c.clipId) ?? 0;
  const clips = [...tl.clips];
  if (edge === 'in') {
    if (sticky) {
      const nextTrim = clampInt(c.trimStartMs + deltaMs, 0, src - c.trimEndMs - MIN_CLIP_MS);
      clips[index] = { ...c, trimStartMs: nextTrim };
      const newEnd = p.startMs + (src - nextTrim - c.trimEndMs);
      rippleOtherLanes(clips, tl, placements, index, laneOf, endMs(p), newEnd - endMs(p));
    } else {
      const rightEdge = endMs(p);
      let nextTrim = clampInt(c.trimStartMs + deltaMs, 0, src - c.trimEndMs - MIN_CLIP_MS);
      let desiredStart = rightEdge - (src - nextTrim - c.trimEndMs);
      if (prev) {
        const minStart = prev.startMs + MIN_CLIP_MS;
        if (desiredStart < minStart) {
          desiredStart = minStart;
          nextTrim = clampInt(src - c.trimEndMs - (rightEdge - desiredStart), 0, src - c.trimEndMs - MIN_CLIP_MS);
        }
      } else {
        desiredStart = Math.max(0, desiredStart);
      }
      const prevEnd = prev ? endMs(prev) : 0;
      let anchorEnd = prevEnd;
      if (prev && desiredStart < prevEnd) {
        const overlap = prevEnd - desiredStart;
        clips[prevIndex] = { ...clips[prevIndex], trimEndMs: clips[prevIndex].trimEndMs + overlap };
        anchorEnd = desiredStart;
      }
      clips[index] = { ...c, trimStartMs: nextTrim, gapBeforeMs: Math.max(0, intMs(desiredStart - anchorEnd)) };
    }
  } else {
    const maxTrimEnd = src - c.trimStartMs - MIN_CLIP_MS;
    const availableMs = next ? Math.max(MIN_CLIP_MS, endMs(next) - MIN_CLIP_MS - p.startMs) : src - c.trimStartMs;
    const minTrimEnd = sticky ? 0 : Math.max(0, src - c.trimStartMs - availableMs);
    const nextTrim = clampInt(c.trimEndMs - deltaMs, minTrimEnd, maxTrimEnd);
    clips[index] = { ...c, trimEndMs: nextTrim };
    if (sticky) {
      const newEnd = p.startMs + (src - c.trimStartMs - nextTrim);
      rippleOtherLanes(clips, tl, placements, index, laneOf, endMs(p), newEnd - endMs(p));
    }
    if (!sticky && next) {
      const newEnd = p.startMs + (src - c.trimStartMs - nextTrim);
      if (newEnd > next.startMs) {
        const overlap = Math.min(newEnd - next.startMs, Math.max(0, spanMs(next) - MIN_CLIP_MS));
        clips[nextIndex] = { ...clips[nextIndex], trimStartMs: clips[nextIndex].trimStartMs + overlap, gapBeforeMs: 0 };
      } else {
        clips[nextIndex] = { ...clips[nextIndex], gapBeforeMs: Math.max(0, intMs(next.startMs - newEnd)) };
      }
    }
  }
  return { ...tl, clips };
}

/** Split block `index` at `atSourceMs` (source-local) into two parts sharing the take. */
export function splitBlock(tl: MixTimeline, index: number, atSourceMs: number, dur: Map<string, number>): MixTimeline {
  const c = tl.clips[index];
  const src = dur.get(c.clipId) ?? 0;
  const inMs = c.trimStartMs;
  const outMs = src - c.trimEndMs;
  const cutMs = clampInt(atSourceMs, inMs, outMs);
  if (cutMs <= inMs + MIN_CLIP_MS || cutMs >= outMs - MIN_CLIP_MS) return tl; // too close to an edge
  const left = { ...c, trimEndMs: intMs(src - cutMs) };
  const right = { ...c, partIndex: c.partIndex + 1, trimStartMs: cutMs, gapBeforeMs: 0 };
  const clips = [...tl.clips.slice(0, index), left, right, ...tl.clips.slice(index + 1)];
  return { ...tl, clips };
}

export function setClipField(tl: MixTimeline, index: number, patch: Partial<MixTimeline['clips'][number]>): MixTimeline {
  const clips = tl.clips.map((c, i) => (i === index ? { ...c, ...patch } : c));
  return { ...tl, clips };
}
