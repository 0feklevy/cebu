'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../../lib/firebase';
import type { PlayerConfig } from '../types';
import type { LockedContent } from 'shared/src/generated/client-v1';
import { HLSPlayerShell } from '../HLSPlayerShell';
import { PaywallOverlay } from '../../PaywallOverlay';
import { PlaylistLobby } from './PlaylistLobby';
import { PlaylistWatchLayout } from './PlaylistWatchLayout';
import { UpNextCard } from './UpNextCard';
import type { PlaylistPlayConfig } from './shared';
import { AskAvatarButton } from '../../avatar/AskAvatarButton';
import { AvatarPopup } from '../../avatar/AvatarPopup';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
const COUNTDOWN_SEC = 6;

interface Props {
  shareToken?: string;   // public playlist
  playlistId?: string;   // owner preview (auth)
}

function shuffledIndices(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function PlaylistViewer({ shareToken, playlistId }: Props) {
  const [data, setData]   = useState<PlaylistPlayConfig | null>(null);
  const [locked, setLocked] = useState<LockedContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [order, setOrder]           = useState<number[]>([]);   // display order → item index
  const [currentPos, setCurrentPos] = useState(-1);             // -1 = lobby
  const [ended, setEnded]           = useState(false);
  const [watched, setWatched]       = useState<Set<number>>(new Set());
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Up-next card state
  const [pendingNextPos, setPendingNextPos] = useState<number | null>(null);
  const [countdown, setCountdown]           = useState<number | null>(null);
  const [playerControlsVisible, setPlayerControlsVisible] = useState(true);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Ask-the-Avatar popup state (scoped to a specific video/project).
  const [avatar, setAvatar] = useState<{ projectId: string; title: string | null } | null>(null);
  const openAvatar = useCallback((projectId: string, title: string | null) => setAvatar({ projectId, title }), []);

  const rootRef = useRef<HTMLDivElement>(null);

  // Wait for Firebase auth to resolve before fetching — the owner-preview route
  // requires the owner's token; a fresh tab has no currentUser yet (→ 401 / lock).
  const { loading: authLoading, getIdToken } = useAuth();

  // ── load play-config ──────────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    const load = async () => {
      try {
        const token = await getIdToken().catch(() => null);
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        let res: Response;
        if (shareToken) {
          res = await fetch(`${API_URL}/api/v1/playlist-share/${shareToken}`, { headers });
        } else {
          res = await fetch(`${API_URL}/api/v1/playlists/${playlistId}/play-config`, { headers });
        }
        if (res.status === 404) { if (!cancelled) setError('This playlist is no longer active or does not exist.'); return; }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = (await res.json()) as PlaylistPlayConfig & Partial<LockedContent>;
        if (cancelled) return;
        if (json.locked) { setLocked(json as LockedContent); return; }
        if (!json.items?.length) { setError('This playlist has no videos yet.'); return; }
        setData(json);
        setOrder(json.items.map((_, i) => i));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [shareToken, playlistId, authLoading, getIdToken]);

  // ── fullscreen tracking ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else rootRef.current?.requestFullscreen?.();
  }, []);

  const clearCountdown = useCallback(() => {
    if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
    setCountdown(null);
    setPendingNextPos(null);
  }, []);

  // ── navigation ────────────────────────────────────────────────────────────
  const startAt = useCallback((displayPos: number, newOrder?: number[]) => {
    clearCountdown();
    setEnded(false);
    if (newOrder) setOrder(newOrder);
    setCurrentPos(displayPos);
  }, [clearCountdown]);

  const playAll  = useCallback(() => { if (data) startAt(0, data.items.map((_, i) => i)); }, [data, startAt]);
  const shuffle  = useCallback(() => { if (data) startAt(0, shuffledIndices(data.items.length)); }, [data, startAt]);
  const pick     = useCallback((itemIdx: number) => {
    // Pick from lobby: jump to that item within the current order (or identity).
    const base = order.length ? order : (data?.items.map((_, i) => i) ?? []);
    const pos = base.indexOf(itemIdx);
    startAt(pos >= 0 ? pos : 0, base);
  }, [order, data, startAt]);
  const jumpTo   = useCallback((displayPos: number) => startAt(displayPos), [startAt]);

  const goToLobby = useCallback(() => { clearCountdown(); setCurrentPos(-1); }, [clearCountdown]);

  // ── project completion → advance / up-next / end ──────────────────────────
  const handleProjectComplete = useCallback(() => {
    if (!data) return;
    const itemIdx = order[currentPos];
    if (itemIdx != null) setWatched((prev) => new Set(prev).add(itemIdx));

    const nextPos = currentPos + 1;
    if (nextPos < order.length) {
      setPendingNextPos(nextPos);
      if (data.autoplay) {
        setCountdown(COUNTDOWN_SEC);
        countdownTimer.current = setInterval(() => {
          setCountdown((c) => {
            if (c == null) return null;
            if (c <= 1) {
              if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
              setPendingNextPos(null);
              setCurrentPos(nextPos);
              return null;
            }
            return c - 1;
          });
        }, 1000);
      } else {
        setCountdown(null); // manual: card stays until user acts
      }
    } else {
      // End of playlist → end screen
      setEnded(true);
      setCurrentPos(-1);
    }
  }, [data, order, currentPos]);

  const playNextNow = useCallback(() => {
    if (pendingNextPos == null) return;
    const pos = pendingNextPos;
    clearCountdown();
    setCurrentPos(pos);
  }, [pendingNextPos, clearCountdown]);

  if (locked) {
    return (
      <PaywallOverlay
        contentType="playlist"
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
  if (!data) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
      </div>
    );
  }

  const inLobby = currentPos < 0;
  const currentItem = !inLobby ? data.items[order[currentPos]] : null;
  const showSidebar = data.show_sidebar && !isFullscreen;

  const playlistChrome = (
    <>
      <button
        onClick={goToLobby}
        className="viewer-top-btn"
        title="Back to playlist"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12h13M9 6l-6 6 6 6M21 6v12" /></svg>
        <span className="hidden min-[360px]:inline">Playlist</span>
      </button>
      <button
        onClick={toggleFullscreen}
        className="viewer-top-btn viewer-top-btn--icon"
        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      >
        {isFullscreen ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 9H5V5M15 9h4V5M9 15H5v4M15 15h4v4" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
        )}
      </button>
    </>
  );

  // The player + overlays for the current item.
  const playerArea = currentItem ? (
    <>
      <HLSPlayerShell
        key={currentItem.project_id}
        config={currentItem.config as PlayerConfig}
        autoStart
        hideHomeLink
        onProjectComplete={handleProjectComplete}
        topRightControls={playlistChrome}
        bottomRightOverlay={<AskAvatarButton onClick={() => openAvatar(currentItem.project_id, currentItem.title)} label="Ask!" />}
        onControlsVisibleChange={setPlayerControlsVisible}
      />

      {pendingNextPos != null && data.items[order[pendingNextPos]] && (
        <UpNextCard
          nextItem={data.items[order[pendingNextPos]]}
          nextDisplayPos={pendingNextPos}
          countdown={countdown}
          onPlayNext={playNextNow}
          onCancel={clearCountdown}
          onShowAll={goToLobby}
        />
      )}
    </>
  ) : null;

  return (
    <div ref={rootRef} className="h-full w-full bg-black">
      <AvatarPopup
        open={!!avatar}
        onClose={() => setAvatar(null)}
        projectId={avatar?.projectId}
        videoTitle={avatar?.title}
      />
      {inLobby ? (
        <PlaylistLobby
          title={data.title}
          description={data.description}
          bannerUrl={data.banner_url}
          items={data.items}
          allowShuffle={data.allow_shuffle}
          watched={watched}
          ended={ended}
          onPlayAll={playAll}
          onShuffle={shuffle}
          onPick={pick}
        />
      ) : (
        <PlaylistWatchLayout
          playerArea={playerArea}
          playlistTitle={data.title}
          playlistDescription={data.description}
          bannerUrl={data.banner_url}
          items={data.items}
          order={order}
          currentPos={currentPos}
          watched={watched}
          showSidebar={showSidebar}
          controlsVisible={playerControlsVisible}
          onJump={jumpTo}
        />
      )}
    </div>
  );
}
