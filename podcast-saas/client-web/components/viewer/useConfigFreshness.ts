'use client';

import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { PlayerConfig } from './types';
import { readPlayerConfigResponse } from './lockedResponse';
import { nextFreshnessDelayMs } from './configRevision';

/**
 * D-13 — the viewer's ONE deliberate path from a creator's correction to a mid-watch screen.
 *
 * Before this, the viewer fetched its config once. Both viewer pages clear their readiness poll
 * in the same block that delivers the first playable config, so after that moment a new revision
 * arrived only by accident — when the auth context happened to re-render. A creator who fixed a
 * mis-placed b-roll clip while someone was watching had no path to that viewer's screen.
 *
 * The shape is the ruling's: a CONDITIONAL GET on the config route the viewer already calls, not
 * a second "revision" endpoint. A separate endpoint is a second thing that can lie about the
 * first thing; `If-None-Match` is the same probe with the answer already attached.
 *
 * WHAT IT IS NOT. Not a takedown mechanism, and not live TV. Production HLS comes from a public
 * bucket (`security-001`), so this poll cannot revoke anything, and it deliberately ignores every
 * response that is not a usable config — a `locked` stub, a 404, a 5xx, a parse failure all leave
 * playback exactly as it was. The failure this guards against is a viewer's video being *taken
 * away* by a poll, which would be a worse bug than the staleness it fixes.
 */

export interface ConfigFreshnessOptions {
  /**
   * The config URL to revalidate, or null to disable. Must be the SAME url the page fetched
   * initially — the ETag is only meaningful for the payload it was minted from.
   */
  url: string | null;
  /**
   * Whether a live player session exists. The ruling gates the poll on "the tab is visible and
   * playback is live"; "live" is read here as *a player session is mounted*, not *the video is
   * currently playing*, because a viewer who paused to take a note is still mid-watch and is
   * exactly the person a correction has to reach.
   */
  enabled: boolean;
  /**
   * The ETag of the payload the session is currently showing, seeded by the page's initial fetch
   * and updated here. A REF rather than state: a new tag must not re-render the player, and must
   * not restart this effect.
   */
  etagRef: MutableRefObject<string | null>;
  /** Auth token supplier; the poll must present the same identity the initial fetch did. */
  getToken: () => Promise<string | null>;
  /** Called with a usable config whenever the server says the payload changed. */
  onRevision: (config: PlayerConfig) => void;
}

/**
 * Revalidate `url` about once a minute, with jitter, while the tab is visible.
 *
 * Self-scheduling `setTimeout` rather than `setInterval`: the delay is re-jittered on every tick,
 * so an audience that arrived together never reconverges into a synchronised burst.
 */
export function useConfigFreshness({
  url, enabled, etagRef, getToken, onRevision,
}: ConfigFreshnessOptions): void {
  // Held in refs so that a caller passing fresh inline closures — which both viewer pages do —
  // cannot tear the poll down and restart its clock on every render. This is the same trap that
  // made the readiness poll's give-up bound unreachable, documented at its own `getIdTokenRef`.
  const onRevisionRef = useRef(onRevision);
  onRevisionRef.current = onRevision;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    if (!enabled || !url) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** One request in flight at a time — a slow response must not stack up behind the timer. */
    let busy = false;

    const visible = () =>
      typeof document === 'undefined' || document.visibilityState === 'visible';

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, nextFreshnessDelayMs());
    };

    const revalidate = async () => {
      // A hidden tab costs the host nothing: nobody is watching, so nothing can be stale to them.
      // The visibility listener below re-checks the moment they come back.
      if (busy || !visible()) return;
      // ONLY EVER A CONDITIONAL REQUEST. Without a tag there is nothing to revalidate against, and
      // an unconditional GET here would be counted as a fresh view by the share and permalink
      // routes — the exact inflation D-13 forbids. The page seeds the tag from its initial fetch.
      const ifNoneMatch = etagRef.current;
      if (!ifNoneMatch) return;

      busy = true;
      try {
        const token = await getTokenRef.current().catch(() => null);
        const headers: Record<string, string> = { 'If-None-Match': ifNoneMatch };
        if (token) headers.Authorization = `Bearer ${token}`;

        // `no-store` keeps the browser's own HTTP cache out of this: we supply the validator, and
        // a browser-generated revalidation would be indistinguishable from ours at the server
        // while belonging to no session.
        const res = await fetch(url, { headers, cache: 'no-store' });
        if (stopped) return;

        // `304` — the steady state, and the whole reason this is a conditional GET: the payload
        // on screen is still current, so do NOTHING. No setState, no re-render, and above all no
        // new `segments` array, which is the identity the caption reset keys on. A failure status
        // lands here too and means something different, but calls for the same nothing: the
        // viewer is watching a video that works, and the next tick can carry the correction.
        // Returning before the body is even read is deliberate — a 304 legitimately has none.
        if (res.status === 304 || !res.ok) return;

        const tag = res.headers.get('etag');
        const parsed = readPlayerConfigResponse(await res.json().catch(() => null));
        if (stopped || parsed.kind !== 'config') return;

        // Adopt the tag only alongside a config we actually accepted, so a response we ignored
        // cannot silently become the baseline the next revalidation compares against.
        if (tag) etagRef.current = tag;
        onRevisionRef.current(parsed.config);
      } catch {
        // A failed revalidation is a no-op, never an error surface: the viewer is watching a
        // video that works, and the correction can land on the next tick.
      } finally {
        busy = false;
      }
    };

    const tick = () => { void revalidate().finally(schedule); };

    const onVisibility = () => {
      if (!visible()) return;
      // Coming back to the tab is the one moment a viewer is most likely to be looking at
      // something stale, so revalidate now and restart the clock from here.
      void revalidate().finally(schedule);
    };

    document.addEventListener('visibilitychange', onVisibility);
    schedule();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // `etagRef` is a stable ref object; the two callbacks are held in refs above. The poll's
    // lifetime therefore depends only on WHAT it polls and WHETHER it should.
  }, [url, enabled, etagRef]);
}
