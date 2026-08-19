'use client';

import { useEffect, useRef, useState } from 'react';
import type { PlayerConfig } from './types';
import type { LockedContent } from 'shared/src/generated/client-v1';
import { readPlayerConfigResponse } from './lockedResponse';
import { readinessOf } from './segmentReadiness';
import { HLSPlayerShell } from './HLSPlayerShell';
import { branchNavigate } from './branchNavigate';
import { PaywallOverlay } from '../PaywallOverlay';
import { useAuth } from '../../lib/firebase';
import { AskAvatarButton } from '../avatar/AskAvatarButton';
import { AvatarPopup } from '../avatar/AvatarPopup';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');
const POLL_INTERVAL_MS = 5000;
/**
 * How long the "processing" placeholder may spin before it stops and hands control back.
 *
 * NOT a failure verdict — transcoding legitimately takes minutes and the job may still be alive.
 * It is a bound on how long a viewer is asked to watch a spinner with nothing to read and nothing
 * to click. Every other outcome of the poll already ends it; "still processing" was the one that
 * could run for the life of the tab. (ui-ux-001)
 */
const PROCESSING_LIMIT_MS = 5 * 60 * 1000;

interface Props {
  projectId: string;
}

export function ViewerPage({ projectId }: Props) {
  const [config, setConfig] = useState<PlayerConfig | null>(null);
  const [locked, setLocked] = useState<LockedContent | null>(null);
  const [error, setError]   = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  /** The bound above was reached: stop polling and show the viewer a way out. */
  const [stalled, setStalled] = useState(false);
  /** Bumped by "Check again" — restarts the poll (and its clock) from scratch. */
  const [recheck, setRecheck] = useState(0);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [captionMenuOpen, setCaptionMenuOpen] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Wait for Firebase auth to resolve before fetching — otherwise a fresh tab
  // fetches with no token and the owner is treated as anonymous (paid content
  // shows the paywall to its own creator).
  const { loading: authLoading, getIdToken } = useAuth();
  // HELD IN A REF, AND DELIBERATELY NOT AN EFFECT DEPENDENCY.
  //
  // `FirebaseAuthProvider` builds its context `value` as a fresh object literal and declares
  // `getIdToken` as a plain function in its body, so BOTH change identity on every provider
  // render. With `getIdToken` in the dependency list below, each of those renders tore this poll
  // down and rebuilt it: `startedAt` reset to now, `setStalled(false)` ran, and the effect's
  // opening `check()` fired another request. The give-up bound could therefore be pushed out
  // indefinitely and never surface, and the poll rate was bounded by nothing.
  //
  // A ref keeps the latest function without making the poll's lifetime depend on its identity.
  const getIdTokenRef = useRef(getIdToken);
  getIdTokenRef.current = getIdToken;

  useEffect(() => {
    if (authLoading) return;
    const startedAt = Date.now();
    const stop = () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };
    setStalled(false);
    const check = async () => {
      try {
        const token = await getIdTokenRef.current().catch(() => null);
        const r = await fetch(`${API_URL}/api/v1/projects/${projectId}/player-config`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        // The endpoint answers with ONE of two shapes. Reading it as an intersection made every
        // field of both look present and put `data.segments.length` one line away from a
        // TypeError on any third shape — which the catch below rendered to the viewer verbatim
        // ("Cannot read properties of undefined (reading 'length')"). types-011.
        const parsed = readPlayerConfigResponse(await r.json().catch(() => null));

        if (parsed.kind === 'locked') {
          setLocked(parsed.locked);
          clearInterval(intervalRef.current!);
          return;
        }

        if (parsed.kind === 'unusable') {
          setError('This video could not be loaded. Please try again later.');
          clearInterval(intervalRef.current!);
          return;
        }

        const data = parsed.config;

        if (!data.segments.length) {
          setError('This project has no videos yet.');
          stop();
          return;
        }

        // READINESS IS THE ENTRY SEGMENT'S, NOT THE PROJECT'S — and not "any segment's".
        //
        // Two rounds of this bug. First `some(ready)` admitted a project as soon as ONE video was
        // ready and tore down the poll, so a lecture opened while video 2 transcoded froze at the
        // boundary forever. The fix kept polling — but still gated on `playable.length > 0`, which
        // is the same mistake one step earlier: transcodes run concurrently, so video 2 can finish
        // FIRST, and then the gate opened on a segment 0 that had no URL at all. The player always
        // attaches index 0 (`currentSegIdx: 0`), so the viewer got a dead player with the spinner
        // already dismissed. The comment here claimed playback "starts on the first ready segment";
        // it never did, and the test asserted the comment rather than the behaviour.
        //
        // The rule now lives in `segmentReadiness.ts` and is exercised directly by tests.
        const readiness = readinessOf(data);

        if (readiness.allFailed) {
          setError('Video processing failed. Please re-upload and try again.');
          stop();
          return;
        }

        if (readiness.entryPlayable) {
          // Deliver what exists now. The committed-revision pinning in useProjectPlayer means a
          // later config cannot swap a shot out from under a viewer mid-playback, and
          // useProjectPlayer's own sync effect fills in URLs that arrive after this point.
          setConfig(data);
          setProcessing(false);
          // KEEP POLLING while anything is still transcoding.
          //
          // The time bound must SURFACE, not just stop — and it must surface even once a config
          // exists. `setStalled(true)` used to set state that nothing rendered, because the
          // stalled branch sat inside `if (!config)`. That put the long-transcode case straight
          // back into the silent freeze: poll dead, later segment never arriving, viewer at the
          // boundary with nothing to read and nothing to press.
          if (readiness.pendingCount === 0) stop();
          else if (Date.now() - startedAt >= PROCESSING_LIMIT_MS) { setStalled(true); stop(); }
        } else {
          setProcessing(true);
          if (Date.now() - startedAt >= PROCESSING_LIMIT_MS) { setStalled(true); stop(); }
        }
      } catch (e) {
        setError((e as Error).message);
        stop();
      }
    };

    check();
    intervalRef.current = setInterval(check, POLL_INTERVAL_MS);
    return stop;
  }, [projectId, authLoading, recheck]);

  if (locked) {
    return (
      <PaywallOverlay
        contentType="project"
        contentId={locked.content_id}
        title={locked.title}
        priceCents={locked.price_cents}
        currency={locked.currency}
      />
    );
  }

  if (error) {
    return (
      <div className="flex h-full w-full min-w-0 items-center justify-center bg-black px-4 text-center text-sm text-white/60">
        <p className="w-full max-w-[240px] break-words leading-6 whitespace-normal sm:max-w-sm">
          {error}
        </p>
      </div>
    );
  }

  if (!config) {
    // Bounded: after PROCESSING_LIMIT_MS the spinner is replaced by something to read and
    // something to press, instead of running until the tab closes. (ui-ux-001)
    if (stalled) {
      return (
        <div className="flex h-full w-full min-w-0 flex-col items-center justify-center gap-4 bg-black px-4 text-center">
          <p className="w-full max-w-[min(28rem,calc(100dvw-32px))] break-words text-sm leading-6 text-white/60">
            This video is still processing. Long uploads can take a while — check again in a few
            minutes. If it stays this way, re-upload the video from the editor.
          </p>
          <button
            onClick={() => { setStalled(false); setRecheck((n) => n + 1); }}
            className="rounded-lg border border-white/25 px-4 py-2 text-sm font-medium text-white/85 transition-colors hover:bg-white/10 focus-ring"
          >
            Check again
          </button>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center gap-3 w-full h-full bg-black">
        <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        {processing && (
          <p className="max-w-[min(28rem,calc(100dvw-32px))] px-4 text-center text-xs leading-5 text-white/40">Video is processing — this may take a few minutes…</p>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {/*
        A later segment can stall AFTER playback has started, and that is precisely the case the
        viewer cannot diagnose alone: the video plays, then stops at a boundary. Before this, the
        notice lived inside `if (!config)` and so was unreachable exactly when it mattered. It is
        an overlay rather than a replacement — interrupting a playing video to announce that a
        LATER one is slow would be its own bug.
      */}
      {stalled && (
        <div className="pointer-events-auto absolute inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-3 bg-black/80 px-4 py-2 text-center backdrop-blur-sm">
          <p className="text-xs leading-5 text-white/75">
            A later part of this video is still processing.
          </p>
          <button
            onClick={() => { setStalled(false); setRecheck((n) => n + 1); }}
            className="rounded-md border border-white/25 px-3 py-1 text-xs font-medium text-white/85 transition-colors hover:bg-white/10 focus-ring"
          >
            Check again
          </button>
        </div>
      )}
      <HLSPlayerShell
        config={config}
        onNavigate={branchNavigate}
        onCaptionMenuOpenChange={setCaptionMenuOpen}
        bottomRightOverlay={!captionMenuOpen ? <AskAvatarButton onClick={() => setAvatarOpen(true)} label="Ask!" /> : null}
      />

      <AvatarPopup
        open={avatarOpen}
        onClose={() => setAvatarOpen(false)}
        projectId={projectId}
        videoTitle={(config as PlayerConfig & { title?: string | null }).title ?? null}
      />
    </div>
  );
}
