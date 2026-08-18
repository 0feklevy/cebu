'use client';

import { useEffect, useRef, useState } from 'react';
import type { PlayerConfig, PlayerSegment } from './types';
import type { LockedContent } from 'shared/src/generated/client-v1';
import { readPlayerConfigResponse } from './lockedResponse';
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

  useEffect(() => {
    if (authLoading) return;
    const startedAt = Date.now();
    const stop = () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };
    setStalled(false);
    const check = async () => {
      try {
        const token = await getIdToken().catch(() => null);
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

        // READINESS IS PER SEGMENT, NOT PER PROJECT — and conflating them froze real lectures.
        //
        // `some()` admitted a project as soon as ONE video was ready, and `stop()` in the same
        // block tore down the only mechanism that would ever deliver the others. So a two-video
        // lecture opened while video 2 was still transcoding — the ordinary case for anyone who
        // shares a link right after uploading — played video 1, froze on its last frame at the
        // boundary, and stayed there forever: no spinner, no error, no retry, because the player
        // attaches nothing for a null URL and waits on a `canplay` that cannot arrive.
        //
        // Playback still STARTS on the first ready segment (waiting for the whole lecture would
        // be a worse experience, and the first segment is genuinely watchable). What changed is
        // that the poll now survives until every segment has resolved, so the later URLs arrive
        // while the viewer is watching the earlier ones.
        const isResolved = (st: string | null | undefined, fb: string | null | undefined) =>
          st === 'ready' || st === 'failed' || Boolean(fb);
        const playable = data.segments.filter((s: PlayerSegment) => s.hls_status === 'ready' || s.fallback_url);
        const pending = data.segments.filter((s: PlayerSegment) => !isResolved(s.hls_status, s.fallback_url));
        const allFailed = data.segments.every((s) => s.hls_status === 'failed');

        if (allFailed) {
          setError('Video processing failed. Please re-upload and try again.');
          stop();
          return;
        }

        if (playable.length > 0) {
          // Deliver what exists now. The committed-revision pinning in useProjectPlayer means a
          // later config cannot swap a shot out from under a viewer mid-playback.
          setConfig(data);
          setProcessing(false);
          // KEEP POLLING while anything is still transcoding. Stop only when every segment has
          // reached a terminal state — ready, failed, or carrying a fallback.
          if (pending.length === 0) stop();
          else if (Date.now() - startedAt >= PROCESSING_LIMIT_MS) stop();
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
  }, [projectId, authLoading, getIdToken, recheck]);

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
