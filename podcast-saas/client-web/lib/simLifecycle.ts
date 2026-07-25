/**
 * Shared destroy-on-leave grace policy for simulation iframes (D2/D2b).
 *
 * When a sim overlay hides, the iframe is kept mounted (paused via `simPause`)
 * for a grace window so re-entering the section re-shows it instantly; after the
 * grace the owning component clears its sim URL, unmounting the iframe and truly
 * freeing the WebGL context.
 *
 * Grace: 45 s on desktop; 700 ms on touch devices (`pointer: coarse`) or when
 * `navigator.deviceMemory <= 4` (undefined deviceMemory counts as NOT low).
 * The 700 ms floor also guarantees the 200 ms overlay opacity fade always
 * completes before the iframe can unmount.
 */

export const SIM_DESTROY_GRACE_DESKTOP_MS = 45_000;
export const SIM_DESTROY_GRACE_LOW_MS = 700;

export function simDestroyGraceMs(): number {
  if (typeof window === 'undefined') return SIM_DESTROY_GRACE_DESKTOP_MS;
  try {
    const coarse =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const lowMem = typeof mem === 'number' && mem <= 4;
    return coarse || lowMem ? SIM_DESTROY_GRACE_LOW_MS : SIM_DESTROY_GRACE_DESKTOP_MS;
  } catch {
    return SIM_DESTROY_GRACE_DESKTOP_MS;
  }
}
