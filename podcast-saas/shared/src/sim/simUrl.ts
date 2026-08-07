/**
 * Device-hint query params for simulation iframes (D6).
 *
 * SHARED across client-web AND admin-web. It lives here because the admin avatar gallery renders
 * stored sim URLs too, and rendering one WITHOUT the origin rebase below is not a cosmetic
 * difference: a sim URL minted under another API origin is blocked outright by the frame-src CSP,
 * so the frame renders blank. Admin cannot import from client-web, so a client-local copy could
 * never fix it (audited: admin was doing exactly that).
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

// Both Next apps inline NEXT_PUBLIC_* at build time, so reading it here resolves per-app.
//
// The reference MUST stay written literally as `process.env.NEXT_PUBLIC_API_URL`: Next performs a
// textual substitution, so reading it through a variable or a destructured alias defeats the
// inlining and leaves the API origin undefined in the browser. This package targets the DOM and
// does not carry Node types, so the shape is declared locally rather than pulling in @types/node.
declare const process: { env: Record<string, string | undefined> };

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

// DPR is SNAPSHOTTED once per page: it is a query param, so a live value would change the
// iframe src whenever devicePixelRatio changes (browser zoom, moving to another monitor) and
// silently RELOAD every resident sim at the next overlay re-render — typically a section
// boundary, and the resulting `load` event was misread as a late same-document event, leaving
// stale ready/painted flags on an unloaded document (audited). A monitor change now keeps the
// boot-time hint; render quality follows the sim's own resize handling.
let dprSnapshot: number | null = null;

/** Test-only: reset the per-page DPR snapshot. */
export function __resetDprSnapshotForTests(): void { dprSnapshot = null; }

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

    if (dprSnapshot === null) dprSnapshot = Math.min(window.devicePixelRatio || 1, 3);
    u.searchParams.set('dpr', String(Math.round(dprSnapshot * 100) / 100));

    if (typeof mem === 'number') u.searchParams.set('mem', String(mem));

    // Minimal-UI boot hint: carried in the FRAGMENT so it never reaches the server
    // (proxy caching/ETags unaffected) and a hash-only src change never reloads a
    // live iframe. The sim-public proxy injects a tiny head bootstrap that reads
    // this and applies display:none BEFORE first paint — killing the full-UI flash.
    // An AUTHOR fragment (hash-routed sims, deep links) is PRESERVED by appending —
    // the boot snippet's reader (`/[#&]simboot=/`) was already written for that form.
    //
    // The fragment is emitted whenever the caller is boot-aware — INCLUDING for an empty hide
    // list (the snippet then builds no rules and does nothing). "Hash-only changes never
    // reload" only holds while the fragment stays present: per the HTML navigation spec a src
    // change is same-document only when the NEW fragment is non-null, so REMOVING it (Simple-UI
    // toggled off, every control re-checked, or the section going null during the destroy grace)
    // is a full navigation that hard-reloads a live sim (audited).
    if (boot) {
      const simboot = 'simboot=' + encodeURIComponent(JSON.stringify({ hide: boot.hideSelectors ?? [] }));
      const author = u.hash.replace(/^#/, '');
      const withoutOld = author.replace(/(^|&)simboot=[^&]*/g, '$1').replace(/^&|&$/g, '');
      u.hash = withoutOld ? `${withoutOld}&${simboot}` : simboot;
    }

    return u.href;
  } catch {
    return url;
  }
}
