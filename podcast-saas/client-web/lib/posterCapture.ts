/**
 * From one raw picture of a simulation to the poster renditions the server stores (night run
 * 2026-09-03 §6). The sim hands over its canvas as a PNG data URL; this letterboxes it into the
 * two sizes of the project's aspect profile — the exact sizes `POSTER_SIZES` names, so the
 * identity the player looks up is the identity that gets stored.
 *
 * The fit maths is pure and tested; the drawing needs a real canvas and runs in the browser.
 */
import { POSTER_SIZES, type PosterSizeName } from 'shared/src/sim/posterIdentity';
import type { SimAspectProfile } from 'shared/src/sim/simIdentity';

export interface FittedBox { x: number; y: number; w: number; h: number }

/** Object-contain: the largest scaled copy of `src` that fits `dst`, centred. */
export function fitContain(srcW: number, srcH: number, dstW: number, dstH: number): FittedBox {
  if (!(srcW > 0) || !(srcH > 0)) return { x: 0, y: 0, w: dstW, h: dstH };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  return { x: Math.round((dstW - w) / 2), y: Math.round((dstH - h) / 2), w, h };
}

export interface PosterTarget { size: PosterSizeName; width: number; height: number }

/** The renditions a poster of this aspect must carry, from the shared size table. */
export function posterTargets(aspect: SimAspectProfile): PosterTarget[] {
  return POSTER_SIZES[aspect].map((s) => ({ size: s.name, width: s.width, height: s.height }));
}

export interface RenderedRendition { size: PosterSizeName; width: number; height: number; dataUrl: string }

/**
 * The letterbox-bar fill when the capture's aspect does not match the target's. A dark neutral
 * rather than PNG alpha: a transparent bar would show whatever sits behind the tile (a theme
 * background today, an overlay poster surface tomorrow) and read differently everywhere the same
 * stored file is drawn. When the aspects match, `fitContain` covers the whole canvas and this
 * paint is invisible. Exported so callers pass it EXPLICITLY — a default parameter nobody passed
 * was indistinguishable from dead code.
 */
export const POSTER_LETTERBOX_BG = '#0b0d12';

/**
 * Draw the raw picture into every target size. `background` fills the letterbox bars — the sim's
 * own page colour when known, so a bar reads as margin rather than as a black frame.
 */
export async function renderPosterRenditions(
  raw: { dataUrl: string; width: number; height: number },
  aspect: SimAspectProfile,
  background = POSTER_LETTERBOX_BG,
): Promise<RenderedRendition[]> {
  const img = await loadImage(raw.dataUrl);
  const srcW = img.naturalWidth || raw.width;
  const srcH = img.naturalHeight || raw.height;
  return posterTargets(aspect).map((t) => {
    const canvas = document.createElement('canvas');
    canvas.width = t.width;
    canvas.height = t.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('poster: no 2d context');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, t.width, t.height);
    const box = fitContain(srcW, srcH, t.width, t.height);
    ctx.drawImage(img, box.x, box.y, box.w, box.h);
    return { size: t.size, width: t.width, height: t.height, dataUrl: canvas.toDataURL('image/png') };
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('poster: the picture could not be decoded'));
    img.src = src;
  });
}
