'use client';

/**
 * The listening surface — P3-B / A2.2, built for the phone in a pocket.
 *
 * ── ONE DESIGN COMMITMENT GOVERNS THIS FILE ───────────────────────────────────────────────────
 * A plain `<audio>` element, NOT WebAudio. Mobile Safari and Chrome keep a playing `<audio>`
 * element alive when the screen locks and kill WebAudio contexts. Every capability below is built
 * on top of that element rather than replacing it, because the moment the audio graph becomes
 * something the browser can garbage-collect on lock, this feature stops being the thing it is for.
 *
 * That rules out effects that would be easy and tempting — a visualiser, a gapless crossfade, a
 * speed control implemented in the graph. `playbackRate` on the element is fine; a WebAudio node
 * is not, at any quality.
 *
 * ── MEDIA SESSION IS THE INTERFACE, NOT AN ENHANCEMENT ────────────────────────────────────────
 * The listener is driving. The controls they actually reach are the lock screen and the steering
 * wheel, so title, artwork, position and chapter skip are published to `navigator.mediaSession`
 * and the on-screen controls are the secondary copy. An interaction that requires looking at the
 * screen is ruled out by the design, not styled smaller.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  chapterIndexAt,
  formatClock,
  type AudioChapter,
  type AudioEditionView,
} from '@/lib/audioEditionApi';
import {
  formatBytes,
  releaseOffline,
  saveForOffline,
  type OfflineState,
} from '@/lib/offlineAudio';

interface Props {
  view: AudioEditionView;
  /** Cover art for the lock screen, when the project has one. */
  artworkUrl?: string | null;
}

/** How far back a chapter must have been playing before "previous" restarts it. */
const RESTART_THRESHOLD_MS = 3000;
// The convention every podcast app follows: pressing back near the START of a chapter goes to the
// previous one; pressing it in the MIDDLE restarts the current one. Without the threshold, a
// listener who wants the last thirty seconds again has to press back twice and guess.

export function AudioEditionPlayer({ view, artworkUrl }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(view.duration_ms ?? 0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [offline, setOffline] = useState<OfflineState>({ status: 'idle' });

  // The Blob behind a saved recording is pinned until its object URL is revoked — a 29 MB episode
  // held forever by a tab the listener left open.
  useEffect(() => () => {
    if (offline.status === 'saved') releaseOffline(offline.objectUrl);
  }, [offline]);

  const save = useCallback(async () => {
    setOffline({ status: 'saving', progress: 0 });
    try {
      const { objectUrl, bytes } = await saveForOffline(view.audio_url, {
        onProgress: (progress) => setOffline({ status: 'saving', progress }),
      });
      setOffline({ status: 'saved', objectUrl, bytes });
    } catch (e) {
      setOffline({ status: 'failed', reason: (e as Error).message });
    }
  }, [view.audio_url]);

  const chapters = view.chapters;
  const currentChapter = useMemo(() => chapterIndexAt(chapters, positionMs), [chapters, positionMs]);

  const seekTo = useCallback((ms: number) => {
    const el = audioRef.current;
    if (!el) return;
    // Clamped, because a seek past the end pauses on some browsers and loops on others, and a
    // negative one throws. Both are reachable from a chapter list that disagrees with the file.
    el.currentTime = Math.max(0, Math.min(ms, (durationMs || el.duration * 1000) - 1)) / 1000;
    setPositionMs(el.currentTime * 1000);
  }, [durationMs]);

  const goToChapter = useCallback((delta: -1 | 1) => {
    if (chapters.length === 0) {
      // No chapters is a legitimate shape — a project with no labelled sections. Skip still has
      // to DO something, or the steering-wheel button reads as broken; thirty seconds is the
      // convention when there is nothing structural to jump to.
      seekTo(positionMs + delta * 30_000);
      return;
    }
    const i = Math.max(0, currentChapter);
    if (delta === -1) {
      const intoChapter = positionMs - chapters[i].startMs;
      const target = intoChapter > RESTART_THRESHOLD_MS || i === 0 ? i : i - 1;
      seekTo(chapters[target].startMs);
      return;
    }
    if (i + 1 < chapters.length) seekTo(chapters[i + 1].startMs);
    else seekTo(durationMs || positionMs);
  }, [chapters, currentChapter, positionMs, durationMs, seekTo]);

  // ── Media Session ───────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({
      title: chapters[currentChapter]?.title || view.title || 'Audio',
      // The EPISODE goes in `artist`, so the lock screen shows "chapter / episode" — the pair a
      // listener needs to place themselves. Putting the episode in `title` loses the chapter,
      // which is the half that changes.
      artist: view.title ?? '',
      artwork: artworkUrl ? [{ src: artworkUrl, sizes: '512x512' }] : [],
    });
    ms.setActionHandler('previoustrack', () => goToChapter(-1));
    ms.setActionHandler('nexttrack', () => goToChapter(1));
    ms.setActionHandler('seekbackward', () => seekTo(positionMs - 15_000));
    ms.setActionHandler('seekforward', () => seekTo(positionMs + 30_000));
    ms.setActionHandler('play', () => void audioRef.current?.play());
    ms.setActionHandler('pause', () => audioRef.current?.pause());
    ms.setActionHandler('seekto', (d) => { if (typeof d.seekTime === 'number') seekTo(d.seekTime * 1000); });
    return () => {
      // Handlers are GLOBAL to the document. Leaving them attached after this component unmounts
      // means the lock screen still drives an element that no longer exists — the buttons stay
      // lit and do nothing, which is worse than their being absent.
      for (const a of ['previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'play', 'pause', 'seekto'] as const) {
        try { ms.setActionHandler(a, null); } catch { /* an action this browser does not know */ }
      }
    };
  }, [chapters, currentChapter, view.title, artworkUrl, goToChapter, seekTo, positionMs]);

  // Position state drives the lock screen's own scrubber. Without it the OS shows a stuck 0:00
  // for the whole episode.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (!durationMs || !navigator.mediaSession.setPositionState) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: durationMs / 1000,
        position: Math.min(positionMs, durationMs) / 1000,
        playbackRate: audioRef.current?.playbackRate ?? 1,
      });
    } catch {
      // Safari throws when position exceeds duration by a rounding error. Not worth breaking
      // playback over — the scrubber simply does not update this tick.
    }
  }, [positionMs, durationMs]);

  return (
    <div className="w-full max-w-2xl mx-auto">
      <audio
        ref={audioRef}
        // The saved copy WINS once it exists. Swapping the src mid-session resets the element's
        // position, so this is deliberately only ever set once per save — and the listener has
        // just pressed a button, which is the one moment an interruption is expected.
        src={offline.status === 'saved' ? offline.objectUrl : view.audio_url}
        preload="metadata"
        onTimeUpdate={(e) => setPositionMs(e.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(e) => {
          // The FILE's duration wins over the stored one. They should agree; when they do not,
          // the element is the thing the listener is actually hearing.
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDurationMs(d * 1000);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => setFailed('This recording could not be loaded. It may have been rebuilt — try reloading the page.')}
        className="w-full"
        controls
      >
        {view.captions_url && (
          <track kind="captions" src={view.captions_url} srcLang={view.language ?? 'en'} default />
        )}
      </audio>

      {failed && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {/* A signed URL expires. The honest recovery is "reload", and saying so is the
              difference between a listener retrying and a listener assuming it is broken. */}
          {failed}
        </p>
      )}

      {/* Save for the drive — P3-B/A2.3, deliberately WITHOUT a service worker. The root layout
          unregisters every worker on every page load (added after a stale one served cached
          localhost URLs), so a worker registered here would die on the next navigation, silently.
          An explicit download the listener asks for needs no exemption from that protection. */}
      <div className="mt-4 flex items-center gap-3">
        {offline.status === 'idle' && (
          <button
            type="button"
            onClick={() => void save()}
            className="min-h-[44px] rounded-lg border border-border px-4 py-2 text-sm"
          >
            Save for the drive
          </button>
        )}
        {offline.status === 'saving' && (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {/* Percent ONLY when the server told us the total. A fabricated denominator produces a
                bar that races to 90% and stops. */}
            {offline.progress > 0 ? `Saving… ${Math.round(offline.progress * 100)}%` : 'Saving…'}
          </p>
        )}
        {offline.status === 'saved' && (
          <p className="text-sm text-muted-foreground">
            Saved for this session · {formatBytes(offline.bytes)}
          </p>
        )}
        {offline.status === 'failed' && (
          <p role="alert" className="text-sm text-destructive">{offline.reason}</p>
        )}
      </div>

      {chapters.length > 0 && (
        <ol className="mt-6 divide-y divide-border rounded-lg border border-border">
          {chapters.map((c: AudioChapter, i: number) => (
            <li key={`${c.startMs}-${c.title}`}>
              <button
                type="button"
                onClick={() => seekTo(c.startMs)}
                aria-current={i === currentChapter ? 'true' : undefined}
                // Deliberately large. The screen is assumed dark or glanced at; a 44px target is
                // the floor, not the goal.
                className={`flex w-full items-baseline gap-3 px-4 py-3 text-left min-h-[44px] ${
                  i === currentChapter ? 'bg-muted font-medium' : ''
                }`}
              >
                <span className="tabular-nums text-xs text-muted-foreground">{formatClock(c.startMs)}</span>
                <span className="flex-1">{c.title}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      <p className="sr-only" aria-live="polite">
        {/* Announced to a screen reader on chapter change, which is also the listener whose
            screen is off by choice rather than by circumstance. */}
        {playing && chapters[currentChapter] ? `Now playing: ${chapters[currentChapter].title}` : ''}
      </p>
    </div>
  );
}
