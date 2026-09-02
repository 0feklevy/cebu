/**
 * The timeline filmstrip's thumbnail cell — a pure rule, apart from the panel that draws it, so
 * it can be tested without loading the editor (night run 2026-09-03 §3).
 */
export const FILMSTRIP_FRAME_H = 45;
/** The widest cell: a 16:9 frame at FILMSTRIP_FRAME_H. */
export const FILMSTRIP_FRAME_W = 80;
/** The narrowest: a 9:16 frame at FILMSTRIP_FRAME_H. */
export const FILMSTRIP_FRAME_W_MIN = 26;

/** The thumbnail cell width for a frame of this shape — 80 for 16:9, 26 for 9:16, between for between. */
export function filmstripCellWidth(videoWidth: number, videoHeight: number): number {
  if (!(videoWidth > 0) || !(videoHeight > 0)) return FILMSTRIP_FRAME_W;
  return Math.max(
    FILMSTRIP_FRAME_W_MIN,
    Math.min(FILMSTRIP_FRAME_W, Math.round(FILMSTRIP_FRAME_H * (videoWidth / videoHeight))),
  );
}
