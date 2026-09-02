/**
 * Orientation — the ONE derived truth every portrait decision keys off.
 *
 * A project is portrait when its primary video is taller than it is wide. Nothing else decides
 * it: not the device, not a setting, not `projects.format` (a write-only legacy column). The
 * editor's preview aspect, the HLS ladder, the export grid, the crop skip, the poster identity
 * and the lesson page all call one of the functions below, so they cannot disagree.
 *
 * Unknown geometry (rows that predate migration 082, a probe that failed) is LANDSCAPE — exactly
 * what every existing project was treated as before orientation existed, so nothing already
 * published changes shape until it has been probed.
 */

export type Orientation = 'landscape' | 'portrait';

export interface Geometry {
  width?: number | null;
  height?: number | null;
}

/** Portrait iff height > width. Square, unknown, zero or non-finite is landscape. */
export function orientationOf(g: Geometry | null | undefined): Orientation {
  if (!g) return 'landscape';
  const w = Number(g.width);
  const h = Number(g.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 'landscape';
  return h > w ? 'portrait' : 'landscape';
}

/**
 * The DISPLAYED size of a coded frame, which is what orientation is about.
 *
 * Phone footage is very often a landscape-coded stream (1920×1080) carrying a 90° rotation tag,
 * which every decoder honours — so the viewer sees 1080×1920. Anamorphic sources (1440×1080 with
 * a 4:3 sample aspect) display wider than they are coded. Both corrections apply here, in this
 * order: SAR widens the coded frame, then the rotation swaps the axes.
 */
export function displayedGeometry(
  width: number,
  height: number,
  opts: { rotationDeg?: number | null; sarNum?: number | null; sarDen?: number | null } = {},
): { width: number; height: number } {
  let w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  const num = Number(opts.sarNum);
  const den = Number(opts.sarDen);
  if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0 && num !== den) {
    w = Math.round((w * num) / den);
  }
  const r = (((Math.round(Number(opts.rotationDeg) || 0) % 360) + 360) % 360);
  return r === 90 || r === 270 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * The project's orientation: its PRIMARY video decides. Callers pass videos in timeline order
 * (created_at ascending — the order the player, the export plan and the editor all read), and the
 * primary is the first non-b-roll one; with no main video the first video counts; with none at
 * all the project is landscape.
 */
export function projectOrientation(
  videos: ReadonlyArray<Geometry & { is_broll?: boolean | null; created_at?: string | Date | null }>,
): Orientation {
  // Callers do not all read in the same order — the editor lists newest-first, the player and
  // the export plan oldest-first — so when rows carry created_at the choice is made in timeline
  // order here, once, and every surface names the same primary video.
  const ordered = videos.every((v) => v.created_at != null)
    ? [...videos].sort((a, b) => toMs(a.created_at) - toMs(b.created_at))
    : videos;
  const primary = ordered.find((v) => !v.is_broll) ?? ordered[0];
  return orientationOf(primary ?? null);
}

function toMs(v: string | Date | null | undefined): number {
  const n = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** width / height of the canonical frame for an orientation. */
export function aspectRatioOf(o: Orientation): number {
  return o === 'portrait' ? 9 / 16 : 16 / 9;
}

/** The canonical full-size frame for an orientation — the export grid and the top HLS tier. */
export function canonicalFrame(o: Orientation): { width: number; height: number } {
  return o === 'portrait' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}
