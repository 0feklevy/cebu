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

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

/**
 * Stored sim URLs are denormalized at save time with whatever API origin the
 * backend ran under (e.g. a section saved against production carries
 * https://api.flowvidco.com/sim-public/...). The keys live in the one shared
 * Supabase bucket, so any /sim-public/ URL is valid on the CURRENT origin —
 * and framing a foreign origin is blocked by CSP (frame-src). Rebase every
 * /sim-public/ URL onto this environment's API origin.
 */
function rebaseSimPublicOrigin(u: URL): URL {
  if (!u.pathname.startsWith('/sim-public/') || !API_BASE) return u;
  try {
    const base = new URL(API_BASE, window.location.href);
    if (u.origin === base.origin) return u;
    const rebased = new URL(u.pathname + u.search + u.hash, base.origin);
    return rebased;
  } catch {
    return u;
  }
}

export interface SimBootParams {
  /** Minimal-UI selectors to hide from the sim's very first paint (no flash of full UI). */
  hideSelectors?: string[];
}

export function resolveSimUrl(url: string, boot?: SimBootParams): string {
  // SSR-safe: no window → no device to hint about; return unchanged.
  if (typeof window === 'undefined') return url;
  try {
    const u = rebaseSimPublicOrigin(new URL(url, window.location.href));
    const nav = navigator as NavigatorWithHints;

    const mem = nav.deviceMemory;
    const lowMem   = typeof mem === 'number' && mem <= 4;   // undefined = NOT low
    const lowCores = typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 4;
    const saveData = nav.connection?.saveData === true;
    if (lowMem || lowCores || saveData) u.searchParams.set('lowend', '1');

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    u.searchParams.set('dpr', String(Math.round(dpr * 100) / 100));

    if (typeof mem === 'number') u.searchParams.set('mem', String(mem));

    // Minimal-UI boot hint: carried in the FRAGMENT so it never reaches the server
    // (proxy caching/ETags unaffected) and a hash-only src change never reloads a
    // live iframe. The sim-public proxy injects a tiny head bootstrap that reads
    // this and applies display:none BEFORE first paint — killing the full-UI flash.
    if (boot?.hideSelectors?.length) {
      u.hash = 'simboot=' + encodeURIComponent(JSON.stringify({ hide: boot.hideSelectors }));
    }

    return u.href;
  } catch {
    return url;
  }
}
