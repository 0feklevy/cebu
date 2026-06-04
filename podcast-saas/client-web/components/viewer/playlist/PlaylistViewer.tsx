'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '../../../lib/firebase';
import type { PlayerConfig } from '../types';
import { HLSPlayerShell } from '../HLSPlayerShell';
import { PlaylistLobby } from './PlaylistLobby';
import { PlaylistWatchLayout } from './PlaylistWatchLayout';
import { UpNextCard } from './UpNextCard';
import type { PlaylistPlayConfig } from './shared';

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
  const [error, setError] = useState<string | null>(null);

  const [order, setOrder]           = useState<number[]>([]);   // display order → item index
  const [currentPos, setCurrentPos] = useState(-1);             // -1 = lobby
  const [ended, setEnded]           = useState(false);
  const [watched, setWatched]       = useState<Set<number>>(new Set());
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Up-next card state
  const [pendingNextPos, setPendingNextPos] = useState<number | null>(null);
  const [countdown, setCountdown]           = useState<number | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);

  // ── load play-config ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        let res: Response;
        if (shareToken) {
          res = await fetch(`${API_URL}/api/v1/playlist-share/${shareToken}`);
        } else {
          const token = await auth.currentUser?.getIdToken();
          res = await fetch(`${API_URL}/api/v1/playlists/${playlistId}/play-config`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
        }
        if (res.status === 404) { if (!cancelled) setError('This playlist is no longer active or does not exist.'); return; }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = (await res.json()) as PlaylistPlayConfig;
        if (cancelled) return;
        if (!json.items?.length) { setError('This playlist has no videos yet.'); return; }
        setData(json);
        setOrder(json.items.map((_, i) => i));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [shareToken, playlistId]);

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

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black px-6 text-center text-sm text-white/55">
        {error}
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

  // The player + overlays for the current item.
  const playerArea = currentItem ? (
    <>
      <HLSPlayerShell
        key={currentItem.project_id}
        config={currentItem.config as PlayerConfig}
        autoStart
        hideHomeLink
        onProjectComplete={handleProjectComplete}
      />

      {/* Fullscreen toggle (top-right of the video area) */}
      <button
        onClick={toggleFullscreen}
        className="absolute right-3 top-3 z-40 flex h-9 w-9 items-center justify-center rounded-lg text-white/85 transition-colors hover:bg-white/10"
        style={{ background: 'rgba(0,0,0,0.4)' }}
        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      >
        {isFullscreen ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 9H5V5M15 9h4V5M9 15H5v4M15 15h4v4" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
        )}
      </button>

      {/* Back-to-playlist button (top-right, next to fullscreen) */}
      <button
        onClick={goToLobby}
        className="absolute right-14 top-3 z-40 flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-white/85 transition-colors hover:bg-white/10"
        style={{ background: 'rgba(0,0,0,0.4)' }}
        title="Back to playlist"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h13M9 6l-6 6 6 6M21 6v12" /></svg>
        Playlist
      </button>

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
      {inLobby ? (
        <PlaylistLobby
          title={data.title}
          description={data.description}
          items={data.items}
          allowShuffle={data.allow_shuffle}
          watched={watched}
          ended={ended}
          onPlayAll={playAll}
          onShuffle={shuffle}
          onPick={pick}
        />
      ) : showSidebar ? (
        <PlaylistWatchLayout
          playerArea={playerArea}
          playlistTitle={data.title}
          items={data.items}
          order={order}
          currentPos={currentPos}
          watched={watched}
          showSidebar={showSidebar}
          onJump={jumpTo}
        />
      ) : (
        <div className="relative h-full w-full bg-black">{playerArea}</div>
      )}
    </div>
  );
}
