/**
 * The ONE place the two video pipelines agree on what "fit this source into this frame"
 * means. Both the linear export (services/export/ffmpegGraph.videoNormChain) and the HLS
 * ladder (services/video/HLSTranscoder.buildTierArgs) fit an arbitrary user upload into a
 * fixed box, and both must do it the same way — they were written separately, and the HLS
 * half was missing the square-pixels step for months (media-002) while the export half's
 * own header comment named the omission as a live bug.
 *
 * WHY THE SQUARING STEP IS LOAD-BEARING
 *
 * `scale=W:H:force_original_aspect_ratio=decrease` fits against the CODED (storage)
 * dimensions, and libavfilter's scale filter then REWRITES the output sample aspect ratio
 * to preserve the input's display aspect:
 *
 *     sar_out = (h_out · w_in) / (w_out · h_in) · sar_in
 *
 * So a non-unity input SAR survives the fit, `pad` leaves it alone, and the tier ships a
 * frame whose SAR the player still applies. On a 1440x1080 SAR 4:3 source (DAR 16:9 — an
 * ordinary HDV/broadcast/camcorder shape) the naive chain fits on 4:3 coded dimensions
 * into a 1280x720 box, producing 960x720 content with 160px of black on EACH side, and
 * then the surviving SAR 4:3 makes the player stretch that whole composite by 4/3.
 * Pillarboxed AND stretched, simultaneously.
 *
 * Squaring the pixels FIRST (`scale=trunc(iw*sar/2)*2:ih,setsar=1`) makes the coded
 * dimensions equal the displayed ones, so the fit is computed on the shape the viewer
 * actually sees. The 1440x1080 SAR 4:3 source becomes 1920x1080 SAR 1:1, fits the 1280x720
 * box exactly, and the pad is a no-op.
 *
 * `trunc(…/2)*2` keeps the width even (yuv420p needs even dimensions), and the trailing
 * `setsar=1` pins the result rather than trusting the arithmetic to land on exactly 1:1 —
 * it also stops `concat` from adopting a neighbour's SAR downstream in the export graph.
 *
 * Text in, text out. No fs, no child_process.
 */

/**
 * Undo an anamorphic squeeze: widen the coded frame to its DISPLAYED width and declare
 * the pixels square. A no-op (beyond a possible 1px even-width trim) on a 1:1 source.
 */
export const SQUARE_PIXELS_CHAIN = 'scale=trunc(iw*sar/2)*2:ih,setsar=1';

/**
 * Fit into `w`x`h` without distortion and centre what is left over, pinning square pixels
 * on the way out. Assumes the input already has square pixels — see SQUARE_PIXELS_CHAIN,
 * and prefer `aspectPreservingFitChain` unless you have already squared them yourself.
 *
 * Bars are still produced when the source's displayed aspect genuinely differs from the
 * box (a 4:3 webcam recording in a 16:9 tier really does need pillars) — that is correct
 * letterboxing, not the media-002 defect.
 */
export function fitPadChain(w: number, h: number): string {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`fitPadChain: box must be positive integers, got ${w}x${h}`);
  }
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  );
}

/**
 * The full geometry chain: square the pixels, then fit + pad onto the box. The output is
 * exactly `w`x`h` with SAR 1:1 and the source's DISPLAYED aspect intact.
 */
export function aspectPreservingFitChain(w: number, h: number): string {
  return `${SQUARE_PIXELS_CHAIN},${fitPadChain(w, h)}`;
}
