/**
 * "Save for the drive" — P3-B / A2.3, without a service worker.
 *
 * ── WHY NOT A SERVICE WORKER, WHICH IS WHAT THE DESIGN SAID ───────────────────────────────────
 * `client-web/app/layout.tsx` ships an unconditional kill-switch: on EVERY page load it
 * unregisters EVERY service worker and deletes every Cache Storage entry. It was added after a
 * stale worker kept serving cached `http://localhost:8080/...` URLs to real browsers, and
 * `production-smoke.spec.ts` now asserts zero registrations in production. There is one root
 * layout and no route can opt out.
 *
 * So a worker registered here would be destroyed the next time the listener opened any page in
 * the app — silently, and the page would appear to work until the connection dropped. Exempting
 * our own worker from that kill-switch is possible, but it is the recovery path for a bad worker,
 * and narrowing it means a bad version of OURS needs its own kill path designed rather than
 * discovered. That is a ruling the owner should make deliberately, not a side effect of shipping
 * an offline button.
 *
 * This is the half that needs no ruling: an explicit download into a Blob the listener asks for.
 * It is genuinely offline for the session, touches no worker, weakens no protection, and matches
 * what podcast apps actually do — stream on tap, save on request.
 *
 * WHAT IT DELIBERATELY IS NOT: offline-by-default. A forty-minute lesson at 96 kbps is ~29 MB and
 * playback cannot begin until it lands, so making this the default play path would trade an
 * instant start for a wait on every listen. The listener asks; they are not guessed at.
 */

export type OfflineState =
  | { status: 'idle' }
  | { status: 'saving'; progress: number }
  | { status: 'saved'; objectUrl: string; bytes: number }
  | { status: 'failed'; reason: string };

/** Bytes above which we refuse to download without the listener having been told the size. */
export const CONFIRM_ABOVE_BYTES = 60 * 1024 * 1024;
// Sixty megabytes is roughly ninety minutes of spoken word at this bitrate. Beyond that it is
// plausibly someone's whole mobile data allowance, and a button that spends it without saying so
// is a button that gets pressed once and never again.

/** A size a person can judge before agreeing to spend their data on it. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  // No decimal above 100 MB: the digit stops carrying information once the number is that large,
  // and the decision it informs ("do I have room / signal for this?") does not turn on it.
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * Is this URL still safe to hand to a download?
 *
 * The audio URL is a SIGNED, time-limited capability. A page that has been open for hours holds a
 * stale one, and the download would fail with an opaque 403 — which a listener reads as "the app
 * is broken", not "reload". Checked before the bytes start moving so the recovery advice can be
 * given instead of a spinner that ends in nothing.
 */
export function looksExpired(res: Response): boolean {
  return res.status === 401 || res.status === 403;
}

export interface SaveOptions {
  /** Progress in 0..1. Called on every chunk; the caller throttles if it needs to. */
  onProgress?: (fraction: number) => void;
  /** Aborts the download. */
  signal?: AbortSignal;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Download the episode into memory and hand back an object URL the `<audio>` element can play.
 *
 * A Blob, not Cache Storage: the kill-switch clears Cache Storage on every page load too, so
 * anything written there is gone by the next navigation. The Blob lives as long as the page does,
 * which is exactly the lifetime of the drive it was saved for.
 */
export async function saveForOffline(
  url: string,
  opts: SaveOptions = {},
): Promise<{ objectUrl: string; bytes: number }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, { signal: opts.signal });

  if (looksExpired(res)) {
    throw new Error('This link has expired. Reload the page and try again.');
  }
  if (!res.ok) {
    throw new Error(`The recording could not be downloaded (${res.status}).`);
  }

  // Content-Length is advisory — a chunked response has none. Progress is reported only when the
  // total is known; a fabricated denominator produces a bar that races to 90% and stops, which is
  // worse than no bar at all.
  const total = Number(res.headers.get('content-length') ?? 0);

  if (!res.body) {
    // No streaming body (older browsers, some test doubles). Fall back to a single read: the
    // download still works, there is simply nothing to report until it lands.
    const blob = await res.blob();
    return { objectUrl: URL.createObjectURL(blob), bytes: blob.size };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      if (total > 0) opts.onProgress?.(Math.min(1, received / total));
    }
  }

  const blob = new Blob(chunks as BlobPart[], { type: res.headers.get('content-type') ?? 'audio/mp4' });
  // Reported at 1 exactly once at the end, even when Content-Length was absent, so a caller
  // rendering a bar can finish it rather than leaving it stuck wherever the last chunk landed.
  opts.onProgress?.(1);
  return { objectUrl: URL.createObjectURL(blob), bytes: blob.size };
}

/**
 * Release a saved recording.
 *
 * An object URL pins its Blob in memory until it is revoked — a 29 MB episode held forever by a
 * tab the listener left open. Called on unmount and before replacing one save with another.
 */
export function releaseOffline(objectUrl: string | null | undefined): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
}
