/**
 * Device-hint query params for simulation iframes (D6).
 *
 * `resolveSimUrl` appends read-only device hints to a sim entry URL so the sim
 * (or the injected rAF bridge) can self-tune on weak hardware:
 *   - `lowend=1`  when deviceMemory <= 4, hardwareConcurrency <= 4, or Save-Data is on
 *   - `dpr=<n>`   always: min(devicePixelRatio, 3), rounded to 2 decimals
 *   - `mem=<n>`   only when navigator.deviceMemory is exposed
 *
 * IMPORTANT: this is applied ONLY at iframe `src` render sites (and the matching
 * cache prefetch). The resolved URL must never be persisted into saved state or
 * compared against stored section URLs — canReuse/save flows always work on the
 * raw `section.simulation_url`.
 */

interface NavigatorWithHints extends Navigator {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

export function resolveSimUrl(url: string): string {
  // SSR-safe: no window → no device to hint about; return unchanged.
  if (typeof window === 'undefined') return url;
  try {
    const u = new URL(url, window.location.href);
    const nav = navigator as NavigatorWithHints;

    const mem = nav.deviceMemory;
    const lowMem   = typeof mem === 'number' && mem <= 4;   // undefined = NOT low
    const lowCores = typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 4;
    const saveData = nav.connection?.saveData === true;
    if (lowMem || lowCores || saveData) u.searchParams.set('lowend', '1');

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    u.searchParams.set('dpr', String(Math.round(dpr * 100) / 100));

    if (typeof mem === 'number') u.searchParams.set('mem', String(mem));

    return u.href;
  } catch {
    return url;
  }
}
