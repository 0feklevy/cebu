'use client';

import { useEffect, useRef, useState } from 'react';
import type { PlayerConfig } from './types';
import type { LockedContent } from 'shared/src/generated/client-v1';
import { readPlayerConfigResponse } from './lockedResponse';
import { readinessOf } from './segmentReadiness';
import { HLSPlayerShell } from './HLSPlayerShell';
import { branchNavigate } from './branchNavigate';
import { PaywallOverlay } from '../PaywallOverlay';
import { auth } from '../../lib/firebase';
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
  /** Random unlisted share link (/v/:token). */
  shareToken?: string;
  /** Creator-controlled public permalink ({PUBLIC_SITE_URL}/{slug}, migration 043). */
  permalinkSlug?: string;
}

export function SharedViewerPage({ shareToken, permalinkSlug }: Props) {
  const [config, setConfig]         = useState<PlayerConfig | null>(null);
  const [locked, setLocked]         = useState<LockedContent | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  /** The bound above was reached: stop polling and show the viewer a way out. */
  const [stalled, setStalled] = useState(false);
  /** Bumped by "Check again" — restarts the poll (and its clock) from scratch. */
  const [recheck, setRecheck] = useState(0);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [captionMenuOpen, setCaptionMenuOpen] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const startedAt = Date.now();
    const stop = () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };
    setStalled(false);
    const check = async () => {
      try {
        const token = await auth.currentUser?.getIdToken().catch(() => null);
        const configUrl = shareToken
          ? `${API_URL}/api/v1/share/${shareToken}`
          : `${API_URL}/api/v1/public/permalink/${permalinkSlug}/config`;
        const r = await fetch(configUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (r.status === 404) {
          setError('This link is no longer active or does not exist.');
          stop();
          return;
        }
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);

        // ONE of two shapes, never a merge of both — see lockedResponse.ts. The intersection this
        // replaces put `data.segments.length` one line from a TypeError on any third shape, and
        // the catch below rendered that TypeError to the viewer as the error text. types-011.
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

        // Readiness is the ENTRY SEGMENT'S — the same rule as ViewerPage, from the same module,
        // because these two surfaces have already diverged once. A shared link is exactly how a
        // lecture gets watched while a later video is still transcoding, so this is the surface
        // most likely to meet the bug.
        //
        // `playable.length > 0` was still wrong: transcodes run concurrently, so a later video can
        // finish first and open the gate on a segment 0 with no URL. Playback always attaches
        // index 0, so that produced a dead player with the spinner already gone.
        const readiness = readinessOf(data);

        if (readiness.allFailed) {
          setError('Video processing failed — please contact the owner.');
          stop();
          return;
        }

        if (readiness.entryPlayable) {
          setConfig(data);
          setProcessing(false);
          // Keep polling until every segment is terminal, and surface the give-up — including
          // once a config exists, which the old placement inside `if (!config)` could not do.
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
  }, [shareToken, permalinkSlug, recheck]);

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
      <div className="flex h-full w-full min-w-0 flex-col items-center justify-center gap-4 bg-black px-4">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
          <circle cx="20" cy="20" r="19" stroke="rgba(255,255,255,0.15)" strokeWidth="2" />
          <path d="M20 12v10M20 28v1" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <p className="w-full max-w-[240px] break-words text-center text-sm leading-6 text-white/50 whitespace-normal sm:max-w-sm">{error}</p>
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
            minutes. If it stays this way, let the owner of this link know.
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

  const cfg = config as PlayerConfig & { id?: string; project_id?: string; title?: string | null };

  return (
    <div className="relative h-full w-full">
      {/*
        Reachable after playback has started — see ViewerPage for why that placement matters.
        An overlay, not a replacement: a later segment being slow must not interrupt the video
        the viewer is currently watching.
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
        shareToken={shareToken ?? null}
        bottomRightOverlay={!captionMenuOpen ? <AskAvatarButton onClick={() => setAvatarOpen(true)} label="Ask!" /> : null}
      />

      <AvatarPopup
        open={avatarOpen}
        onClose={() => setAvatarOpen(false)}
        projectId={cfg.project_id ?? cfg.id}
        videoTitle={cfg.title ?? null}
      />
    </div>
  );
}
