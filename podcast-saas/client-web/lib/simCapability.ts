// Whether it's worth WARMING a sim iframe unpaused (letting it run frames while hidden so
// it paints before the boundary). The warm is always *safe* — if a device throttles hidden
// iframes it simply never acks SIM_PAINTED and the player falls back to a bounded hold — but
// on low-end / data-saving devices the extra GPU work isn't worth it, so we skip it and park
// the sim cold at SIM_READY instead. Unknown = conservative (skip). SSR-safe.

interface NavigatorLike extends Navigator {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

export function canWarmUnpaused(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorLike;
  if (nav.connection?.saveData) return false;                 // respect Data Saver
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4) return false;
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return false; // touch/mobile
  } catch { /* matchMedia unavailable — fall through */ }
  return true;
}
