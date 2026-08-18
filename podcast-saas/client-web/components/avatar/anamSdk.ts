'use client';

/**
 * LAZY ENTRY POINT FOR @anam-ai/js-sdk.
 *
 * MEASUREMENT FIRST — this split is not a guess.
 *
 * Bundle cost of `import { createClient, AnamEvent } from '@anam-ai/js-sdk'`
 * (v4.15.0), esbuild --bundle --minify --format=esm --target=es2022:
 *
 *     91,660 bytes minified   /   23,105 bytes gzipped
 *
 * of which the single largest input is not Anam's code at all:
 *
 *     27,531 bytes minified   the `buffer` npm polyfill (buffer + base64-js)
 *
 * pulled in because AnamClient.js:56 does `Buffer.from(base64Payload, 'base64')`
 * to read the session token's JWT payload — one `atob` call's worth of work for
 * 30% of the SDK's shipped weight. The rest is StreamingClient (17.7 KB),
 * AnamClient (11.9 KB), ClientMetrics, ToolCallManager, SignallingClient.
 *
 * Where it landed: in the checked-in Next build the SDK is its own chunk,
 * .next/static/chunks/385-*.js (89,856 B raw / 22,506 B gzipped, and nothing else
 * of ours in it), and app-build-manifest.json lists that chunk in the INITIAL js
 * of every public viewer route:
 *
 *     /[slug]                            /v/[shareToken]
 *     /pl/[shareToken]                   /c/[courseSlug]/[lessonSlug]
 *     /projects/[id]/view                /playlists/[id]/view
 *
 * because ViewerPage / SharedViewerPage / LessonPlayer / PlaylistViewer all import
 * AvatarPopup statically, which imported AvatarConversation, which imported the SDK.
 * So every viewer of every shared video downloaded, parsed and compiled ~90 KB of
 * WebRTC client for a feature only the ones who press "Ask!" ever reach — on the
 * critical path of the video they actually came for.
 *
 * Hence: one dynamic import, cached, plus an explicit preload so the split cannot
 * cost click-to-first-frame. The chunk is warmed on hover/focus of the Ask button
 * (AskAvatarButton) and again the moment the popup opens (AvatarPopup), where it
 * downloads in parallel with /api/v1/avatar/start — an endpoint that is one vendor
 * round-trip at best and six at worst, i.e. always slower than fetching this chunk.
 * By the time AvatarConversation needs createClient the promise is already settled.
 *
 * Preloading a static chunk is free and side-effect-free: it mints nothing and opens
 * no session. As of anam-latency-007 the same warm ALSO opens the TLS connection to
 * api.anam.ai (preconnectAnamApi) — a handshake, still no HTTP request and still
 * nothing billable. Do not "preload" anything billable here.
 */

import { preconnectAnamApi } from './anamConnectPolicy';

export type AnamSdk = typeof import('@anam-ai/js-sdk');

let pending: Promise<AnamSdk> | null = null;

/** Resolve the SDK, fetching its chunk at most once. */
export function loadAnamSdk(): Promise<AnamSdk> {
  if (!pending) {
    pending = import('@anam-ai/js-sdk').catch((err: unknown) => {
      // A failed chunk fetch (offline, deploy mid-session) must not poison every
      // later attempt — drop the cache so a retry can re-fetch.
      pending = null;
      throw err;
    });
  }
  return pending;
}

/**
 * Fire-and-forget warm of everything the connect will need that costs nothing: the code
 * chunk AND the TLS handshake to the Anam API origin (anam-latency-007 — one cold
 * DNS+TCP+TLS to a third-party origin, ~50-200ms, which was previously paid INSIDE the
 * SDK's startSession on every first open). Both are pure latency removal: no session,
 * no mint, no request to any of our routes, which is why hover is a safe trigger for
 * this and not for /avatar/start.
 */
export function preloadAnamSdk(): void {
  preconnectAnamApi();
  void loadAnamSdk().catch(() => { /* preload is best-effort; loadAnamSdk() will retry */ });
}
