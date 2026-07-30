// Pure, dependency-free normalization for the avatar-circles feature — shared by the
// read path (buildPlayerConfig, self-heal on every load) and the one-off backfill script,
// so both apply BYTE-IDENTICAL repairs. No DB, no IO here → fully unit-testable.
//
// Two problems this fixes (see the circles-speaker-attribution investigation):
//   1. Speaker attribution has GAPS. The viewer highlights a circle only while
//      activeSpeakerAt(speaker_timeline, t) returns that circle's speaker; between script
//      turns the raw scene spans leave holes, so a manual circle-section placed in a
//      between-turn pause resolves to null → BOTH circles wave equally ("the software
//      doesn't know who says what"). normalizeSpeakerTimeline gap-fills so every instant
//      inside the scripted region belongs to the speaker who just spoke.
//   2. A degenerate `faces` mapping (both circles → same speaker/side, or count/faces
//      mismatch) makes `speaking === face.speaker` match the wrong circle or none.
//      normalizeFaces guarantees exactly `count` faces with DISTINCT sides + speakers.

export type CircleSpeaker = 'host_a' | 'host_b';
export type CircleSide = 'left' | 'right';

export interface SceneRow { speaker: string; start_ms: number; end_ms: number; script_version: number }
export interface SpeakerSpan { speaker: string; start_sec: number; end_sec: number }

export interface CircleFace { speaker: CircleSpeaker; side: CircleSide; imageUrl?: string; label?: string }
export interface CircleSection { id: string; start_sec: number; end_sec: number }

export interface AvatarCirclesLike {
  enabled?: boolean;
  count?: 1 | 2;
  faces?: CircleFace[];
  manualSections?: CircleSection[];
  [key: string]: unknown; // pass every other viz field (barStyle, colors, …) through untouched
}

export const MIN_CIRCLE_SECTION_SEC = 0.5;

const isSide = (v: unknown): v is CircleSide => v === 'left' || v === 'right';
const isSpeaker = (v: unknown): v is CircleSpeaker => v === 'host_a' || v === 'host_b';

/**
 * Turn the raw `scenes` rows into the continuous speaker timeline the viewer consumes:
 * latest script_version only, invalid rows dropped, sorted, overlaps CLIPPED and inter-turn
 * gaps FILLED (each span runs up to the next span's start). Consecutive same-speaker spans
 * merge. Empty in ⇒ empty out (script-less uploads keep the "animate all circles" fallback).
 */
export function normalizeSpeakerTimeline(scenes: readonly SceneRow[] | undefined | null): SpeakerSpan[] {
  if (!scenes || scenes.length === 0) return [];
  const latest = Math.max(...scenes.map((s) => s.script_version ?? 0));
  const spans = scenes
    .filter((s) => (s.script_version ?? 0) === latest && typeof s.speaker === 'string' && s.speaker.trim() !== '' && s.end_ms > s.start_ms)
    .map((s) => ({ speaker: s.speaker, start_sec: s.start_ms / 1000, end_sec: s.end_ms / 1000 }))
    .sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec);
  if (spans.length === 0) return [];

  const out: SpeakerSpan[] = [];
  for (let i = 0; i < spans.length; i++) {
    const cur: SpeakerSpan = { ...spans[i] };
    const next = spans[i + 1];
    // Extend to the next turn's start (fills a gap) OR clip an overlap; the last span keeps
    // its own end (no attribution past where the script reaches).
    if (next) cur.end_sec = Math.max(cur.start_sec, next.start_sec);
    const last = out[out.length - 1];
    if (last && last.speaker === cur.speaker && cur.start_sec <= last.end_sec + 1e-6) {
      last.end_sec = Math.max(last.end_sec, cur.end_sec);
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** True when a stored faces[] cannot cleanly map each speaker to its own circle. Kept in
 *  lockstep with normalizeFaces so classify (backfill) and the read/save path never disagree. */
export function facesAreDegenerate(faces: CircleFace[] | undefined, count: 1 | 2): boolean {
  if (!Array.isArray(faces)) return false; // absent is fine — defaults apply, not a "repair"
  if (faces.length !== count) return true;
  if (faces.some((f) => !f || !isSide(f.side) || !isSpeaker(f.speaker))) return true;
  const sides = new Set(faces.map((f) => f.side));
  if (sides.size !== faces.length) return true;
  if (count === 1 && faces[0].side !== 'left') return true; // read-path pins the single circle to 'left'
  if (count === 2 && new Set(faces.map((f) => f.speaker)).size !== 2) return true;
  return false;
}

/**
 * Canonical faces: exactly `count` entries, host_a→left / host_b→right by default, each
 * circle a DISTINCT speaker (so "his wave / her wave" always lands on different circles).
 * Preserves imageUrl/label from whatever side entry existed. Mirrors the client facesFor.
 */
export function normalizeFaces(faces: CircleFace[] | undefined, count: 1 | 2): CircleFace[] {
  const list = Array.isArray(faces) ? faces : [];
  const bySide = (side: CircleSide) => list.find((f) => f && f.side === side);
  const carry = (f: CircleFace | undefined): Partial<CircleFace> => (f ? { ...(f.imageUrl ? { imageUrl: f.imageUrl } : {}), ...(f.label ? { label: f.label } : {}) } : {});

  // One circle: prefer the stored left entry, else ANY stored face (so a legacy right-only
  // config keeps its image/label instead of being dropped) — always pinned to the left slot.
  if (count === 1) {
    const src = bySide('left') ?? list.find((f) => f && isSpeaker(f.speaker));
    return [{ ...carry(src), side: 'left', speaker: isSpeaker(src?.speaker) ? src!.speaker : 'host_a' }];
  }

  const leftSrc = bySide('left');
  const left: CircleFace = { ...carry(leftSrc), side: 'left', speaker: isSpeaker(leftSrc?.speaker) ? leftSrc!.speaker : 'host_a' };
  const rightSrc = bySide('right');
  const right: CircleFace = { ...carry(rightSrc), side: 'right', speaker: isSpeaker(rightSrc?.speaker) ? rightSrc!.speaker : 'host_b' };
  // Distinct speakers, preserving the explicit LEFT choice — flip only the right circle.
  if (right.speaker === left.speaker) right.speaker = left.speaker === 'host_a' ? 'host_b' : 'host_a';
  return [left, right];
}

/** Clamp/sort/de-overlap manual sections — same rules as the client's normalizeCircleSections. */
export function normalizeCircleSections(ranges: CircleSection[] | undefined, totalSec: number = Infinity): CircleSection[] {
  if (!Array.isArray(ranges)) return [];
  const cleaned = ranges
    .filter((r) => r && Number.isFinite(r.start_sec) && Number.isFinite(r.end_sec))
    .map((r, i) => ({
      id: r.id || `cs-${i}-${Math.round((r.start_sec ?? 0) * 1000)}`,
      start_sec: Math.max(0, Math.min(r.start_sec, totalSec)),
      end_sec: Math.max(0, Math.min(r.end_sec, totalSec)),
    }))
    .map((r) => (r.end_sec < r.start_sec ? { ...r, start_sec: r.end_sec, end_sec: r.start_sec } : r))
    .filter((r) => r.end_sec - r.start_sec >= MIN_CIRCLE_SECTION_SEC)
    .sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec);

  const merged: CircleSection[] = [];
  for (const r of cleaned) {
    const last = merged[merged.length - 1];
    if (last && r.start_sec <= last.end_sec + 0.001) last.end_sec = Math.max(last.end_sec, r.end_sec);
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * Self-heal a stored avatarCircles config on read: canonical faces + clean manualSections,
 * everything else passed through. `count` coerced to 1|2. Returns the SAME object when
 * nothing changed is NOT guaranteed — callers that care (the backfill) use the classify
 * helpers below to decide whether to persist.
 */
export function normalizeAvatarCircles<T extends AvatarCirclesLike>(cfg: T, totalSec: number = Infinity): T {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const count: 1 | 2 = cfg.count === 1 ? 1 : 2;
  return {
    ...cfg,
    count,
    faces: normalizeFaces(cfg.faces, count),
    ...(cfg.manualSections !== undefined ? { manualSections: normalizeCircleSections(cfg.manualSections, totalSec) } : {}),
  };
}

/** What (if anything) a persist-time repair would change — drives the backfill's classification. */
export function classifyAvatarCircles(cfg: AvatarCirclesLike | null | undefined): {
  facesRepaired: boolean;
  sectionsRepaired: boolean;
  usesManualLayer: boolean;
} {
  if (!cfg || typeof cfg !== 'object') return { facesRepaired: false, sectionsRepaired: false, usesManualLayer: false };
  const count: 1 | 2 = cfg.count === 1 ? 1 : 2;
  const facesRepaired = facesAreDegenerate(cfg.faces, count);
  const sectionsRepaired = Array.isArray(cfg.manualSections)
    ? JSON.stringify(normalizeCircleSections(cfg.manualSections)) !== JSON.stringify(cfg.manualSections)
    : false;
  const v = cfg.visibility;
  const usesManualLayer = v === 'manual' || v === 'broll+manual' || v === 'always';
  return { facesRepaired, sectionsRepaired, usesManualLayer };
}
