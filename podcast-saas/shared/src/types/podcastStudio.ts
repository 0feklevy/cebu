/**
 * Audio Studio — the user-editable mix timeline (Premiere-style, order-preserving).
 *
 * The document is a list of clips in SCRIPT ORDER. In lane mode each clip stores
 * its timing RELATIVE to the previous clip on the same speaker lane
 * (`gapBeforeMs`), plus trims/gain/mute.
 * Absolute positions are derived by `layoutMix` — which is used
 * by BOTH the browser player/waveform and the server export, so what you hear in
 * the editor is exactly what exports (WYSIWYG by construction), and dragging one
 * block ripples everything after it for free.
 */

import { z } from 'zod';

export const MixClipSchema = z.object({
  /** podcast_clips.id — which persisted take this block plays. */
  clipId: z.string().uuid(),
  turnId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** >0 = a split part of the same take (shares clipId, different trims). */
  partIndex: z.number().int().min(0).max(50).default(0),
  role: z.enum(['speech', 'murmur']).default('speech'),
  lane: z.enum(['teacher', 'learner']).optional(),
  /** ms from the END of the previous clip. Legacy negative values are clamped by layoutMix. */
  gapBeforeMs: z.number().int().min(-600_000).max(600_000).default(0),
  trimStartMs: z.number().int().min(0).max(3_600_000).default(0),
  trimEndMs: z.number().int().min(0).max(3_600_000).default(0),
  gainDb: z.number().min(-24).max(12).default(0),
  muted: z.boolean().default(false),
});
export type MixClip = z.infer<typeof MixClipSchema>;

export const MixTimelineSchema = z.object({
  version: z.literal(1),
  layout: z.enum(['linear', 'lanes']).optional(),
  clips: z.array(MixClipSchema).max(1000),
});
export type MixTimeline = z.infer<typeof MixTimelineSchema>;

/** A clip's resolved position on the absolute timeline. */
export interface MixPlacement {
  clipId: string;
  turnId: string;
  partIndex: number;
  role: 'speech' | 'murmur';
  /** Absolute start on the mix timeline (ms). */
  startMs: number;
  /** Play the source from inMs to outMs (source-local, post-trim). */
  inMs: number;
  outMs: number;
  gainDb: number;
  muted: boolean;
}

export interface MixLayout {
  placements: MixPlacement[];
  totalMs: number;
}

/** Never trim a clip below this many audible ms. */
export const MIN_CLIP_MS = 150;

/**
 * THE layout function — single source of truth for clip positions.
 * `durMs` resolves a clipId to its source duration (from podcast_clips.duration_ms
 * on the server; from the loaded metadata on the client).
 */
export function layoutMix(t: MixTimeline, durMs: (clipId: string) => number, laneOf?: (turnId: string) => string): MixLayout {
  const laneMode = t.layout === 'lanes';
  let cursor = 0;
  const laneCursor = new Map<string, number>();
  let total = 0;
  const placements: MixPlacement[] = [];
  for (const c of t.clips) {
    const lane = c.lane ?? laneOf?.(c.turnId) ?? 'main';
    const baseCursor = laneMode ? (laneCursor.get(lane) ?? 0) : cursor;
    const src = Math.max(0, Math.round(durMs(c.clipId) || 0));
    const inMs = Math.min(Math.max(0, c.trimStartMs), Math.max(0, src - MIN_CLIP_MS));
    const outMs = Math.max(inMs + Math.min(MIN_CLIP_MS, src || MIN_CLIP_MS), src - Math.max(0, c.trimEndMs));
    const effMs = Math.max(0, outMs - inMs);
    const startMs = Math.max(0, baseCursor + Math.max(0, c.gapBeforeMs));
    placements.push({
      clipId: c.clipId, turnId: c.turnId, partIndex: c.partIndex, role: c.role,
      startMs, inMs, outMs, gainDb: c.gainDb, muted: c.muted,
    });
    if (laneMode) laneCursor.set(lane, startMs + effMs);
    else cursor = startMs + effMs;
    if (!c.muted) total = Math.max(total, startMs + effMs);
  }
  return { placements, totalMs: total };
}

// ── API payload shapes (hand-mirrored in generated/client-v1.ts) ─────────────

export interface PodcastStudioClip {
  id: string;
  turn_id: string;
  take_hash: string;
  text_hash: string;
  script_version: number | null;
  duration_ms: number;
  peaks: number[] | null;
  url: string;
  source: 'batch' | 'regen';
  created_at: string;
}

export interface PodcastMixInfo {
  id: string;
  episode_id: string;
  script_version: number | null;
  script_hash: string | null;
  status: 'empty' | 'generating' | 'ready' | 'failed';
  progress: { stage?: string; done?: number; total?: number } | null;
  timeline: MixTimeline | null;
  rev: number;
  error: string | null;
  updated_at: string;
}

export interface PodcastMixSnapshotInfo {
  id: string;
  name: string;
  kind: 'manual' | 'export' | 'pre_rebuild';
  script_version: number | null;
  render_id: string | null;
  created_at: string;
}

export interface PodcastStudioResponse {
  mix: PodcastMixInfo | null;
  clips: PodcastStudioClip[];
  snapshots: PodcastMixSnapshotInfo[];
  /** Newest script version with a body + its hash — drives the "script changed" banner. */
  latest_script_version: number | null;
  latest_script_hash: string | null;
}
