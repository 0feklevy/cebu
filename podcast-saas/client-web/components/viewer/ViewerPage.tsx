'use client';

import { useEffect, useRef, useState } from 'react';
import type { PlayerConfig } from './types';
import type { LockedContent } from 'shared/src/generated/client-v1';
import { HLSPlayerShell } from './HLSPlayerShell';
import { PaywallOverlay } from '../PaywallOverlay';
import { useAuth } from '../../lib/firebase';
import { AskAvatarButton } from '../avatar/AskAvatarButton';
import { AvatarPopup } from '../avatar/AvatarPopup';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
const POLL_INTERVAL_MS = 5000;

interface Props {
  projectId: string;
}

export function ViewerPage({ projectId }: Props) {
  const [config, setConfig] = useState<PlayerConfig | null>(null);
  const [locked, setLocked] = useState<LockedContent | null>(null);
  const [error, setError]   = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [captionMenuOpen, setCaptionMenuOpen] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Wait for Firebase auth to resolve before fetching — otherwise a fresh tab
  // fetches with no token and the owner is treated as anonymous (paid content
  // shows the paywall to its own creator).
  const { loading: authLoading, getIdToken } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    const check = async () => {
      try {
        const token = await getIdToken().catch(() => null);
        const r = await fetch(`${API_URL}/api/v1/projects/${projectId}/player-config`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const data = (await r.json()) as PlayerConfig & Partial<LockedContent>;

        if (data.locked) {
          setLocked(data as LockedContent);
          clearInterval(intervalRef.current!);
          return;
        }

        if (!data.segments.length) {
          setError('This project has no videos yet.');
          clearInterval(intervalRef.current!);
          return;
        }

        const hasReady = data.segments.some((s) => s.hls_status === 'ready' || s.fallback_url);
        const allFailed = data.segments.every((s) => s.hls_status === 'failed');

        if (allFailed) {
          setError('Video processing failed. Please re-upload and try again.');
          clearInterval(intervalRef.current!);
          return;
        }

        if (hasReady) {
          setConfig(data);
          setProcessing(false);
          clearInterval(intervalRef.current!);
        } else {
          setProcessing(true);
        }
      } catch (e) {
        setError((e as Error).message);
        clearInterval(intervalRef.current!);
      }
    };

    check();
    intervalRef.current = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(intervalRef.current!);
  }, [projectId, authLoading, getIdToken]);

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
      <HLSPlayerShell config={config} onCaptionMenuOpenChange={setCaptionMenuOpen} />

      {/* Ask-the-Avatar — bottom-right, above the controls; pauses the video.
          Hidden while the caption-settings menu is open so they don't overlap. */}
      {!captionMenuOpen && (
        <div className="absolute bottom-24 right-3 z-[70] sm:bottom-32 sm:right-5">
          <AskAvatarButton onClick={() => setAvatarOpen(true)} label="Ask!" />
        </div>
      )}

      <AvatarPopup
        open={avatarOpen}
        onClose={() => setAvatarOpen(false)}
        projectId={projectId}
        videoTitle={(config as PlayerConfig & { title?: string | null }).title ?? null}
      />
    </div>
  );
}
