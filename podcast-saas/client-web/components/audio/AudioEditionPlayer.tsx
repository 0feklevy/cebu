'use client';

/**
 * The listening surface, rebuilt for the car (night run 2026-09-03 §4).
 *
 * ── ONE DESIGN COMMITMENT GOVERNS THIS FILE ───────────────────────────────────────────────────
 * A plain `<audio>` element, NOT WebAudio. Mobile Safari and Chrome keep a playing `<audio>`
 * element alive when the screen locks and kill WebAudio contexts. Every capability below is built
 * on top of that element rather than replacing it. (The microphone's own context may die on lock;
 * hands-free then pauses until the phone wakes, and the episode plays on.)
 *
 * ── THE SCREEN IS GLANCED AT, NOT READ ────────────────────────────────────────────────────────
 * Full viewport, dark, six things: the artwork, the title, the bar, three transport buttons, ASK
 * and STOP. Everything else — chapters, saving for the drive, the typed question, the transcript
 * of what was heard — lives in a sheet the listener opens when stopped. Targets are ≥ 56 px, text
 * is one line, the only moving part is the ring around ASK.
 *
 * ── MEDIA SESSION IS THE INTERFACE, NOT AN ENHANCEMENT ────────────────────────────────────────
 * The controls the listener actually reaches are the lock screen and the steering wheel, so the
 * title, artwork, position and chapter skip are published to `navigator.mediaSession`.
 *
 * ── THE VOICE LOOP ────────────────────────────────────────────────────────────────────────────
 * With hands-free on, speaking pauses the episode, the question is answered aloud, and after three
 * seconds of silence the episode resumes where it paused. ASK is the same thing by hand: tap to
 * ask, tap to stop an answer, hold to turn hands-free on or off. The rules are in
 * `lib/voiceLoop.ts`; the device work is in `useVoiceLoop.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  askQuestion,
  askVoiceQuestion,
  chapterIndexAt,
  formatClock,
  type AskQuestionResponse,
  type AudioChapter,
  type AudioEditionView,
} from '@/lib/audioEditionApi';
import { formatBytes, releaseOffline, saveForOffline, type OfflineState } from '@/lib/offlineAudio';
import { voiceStatusLabel } from '@/lib/voiceLoop';
import { useVoiceLoop } from './useVoiceLoop';

interface Props {
  view: AudioEditionView;
  /** Cover art for the player and the lock screen, when the project has one. */
  artworkUrl?: string | null;
  /** The mini-site's slug — the address questions are asked at. Absent ⇒ no ASK, no hand. */
  slug?: string;
}

/** How far back a chapter must have been playing before "previous" restarts it. */
const RESTART_THRESHOLD_MS = 3000;
/** Hold ASK this long to toggle hands-free listening. */
const HOLD_MS = 550;
const HANDS_FREE_KEY = 'flowvid.audio.handsFree';

function readHandsFree(): boolean {
  try { return typeof window !== 'undefined' && window.localStorage.getItem(HANDS_FREE_KEY) === '1'; } catch { return false; }
}
function writeHandsFree(on: boolean): void {
  try { window.localStorage.setItem(HANDS_FREE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

export function AudioEditionPlayer({ view, artworkUrl, slug }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const voiceRef = useRef<HTMLAudioElement | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(view.duration_ms ?? 0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [offline, setOffline] = useState<OfflineState>({ status: 'idle' });
  const [sheet, setSheet] = useState<'closed' | 'chapters' | 'ask'>('closed');
  const [handsFree, setHandsFree] = useState(false);

  // ── Raise your hand, typed (A2.4) — inside the sheet ────────────────────────────────────────
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<AskQuestionResponse | null>(null);
  // The moment the hand went UP — not the moment typing finished.
  const handRaisedAtMs = useRef(0);

  useEffect(() => { setHandsFree(readHandsFree()); }, []);

  // The Blob behind a saved recording is pinned until its object URL is revoked.
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
    el.currentTime = Math.max(0, Math.min(ms, (durationMs || el.duration * 1000) - 1)) / 1000;
    setPositionMs(el.currentTime * 1000);
  }, [durationMs]);

  const goToChapter = useCallback((delta: -1 | 1) => {
    if (chapters.length === 0) { seekTo(positionMs + delta * 30_000); return; }
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

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setFailed('Tap play again to start.'));
    else el.pause();
  }, []);

  // ── Media Session ───────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({
      title: chapters[currentChapter]?.title || view.title || 'Audio',
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
      for (const a of ['previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'play', 'pause', 'seekto'] as const) {
        try { ms.setActionHandler(a, null); } catch { /* unknown action */ }
      }
    };
  }, [chapters, currentChapter, view.title, artworkUrl, goToChapter, seekTo, positionMs]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (!durationMs || !navigator.mediaSession.setPositionState) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: durationMs / 1000,
        position: Math.min(positionMs, durationMs) / 1000,
        playbackRate: audioRef.current?.playbackRate ?? 1,
      });
    } catch { /* Safari rounding */ }
  }, [positionMs, durationMs]);

  // ── The voice loop ──────────────────────────────────────────────────────────────────────────
  const positionRef = useRef(0);
  positionRef.current = positionMs;
  const submitVoice = useCallback(
    (wav: Blob) => askVoiceQuestion(slug ?? '', { wav, positionMs: positionRef.current, language: view.language ?? null }),
    [slug, view.language],
  );
  const voice = useVoiceLoop({
    handsFree: Boolean(slug) && handsFree,
    episode: audioRef,
    voice: voiceRef,
    submit: submitVoice,
  });

  const setHandsFreeAndRemember = useCallback((on: boolean) => {
    setHandsFree(on);
    writeHandsFree(on);
  }, []);

  // ASK: tap = ask / stop the answer / continue; hold = hands-free on/off.
  const holdTimer = useRef<number | null>(null);
  const held = useRef(false);
  const onAskDown = useCallback(() => {
    held.current = false;
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      holdTimer.current = null;
      setHandsFreeAndRemember(!handsFree);
      try { navigator.vibrate?.(30); } catch { /* no haptics */ }
    }, HOLD_MS);
  }, [handsFree, setHandsFreeAndRemember]);
  const onAskUp = useCallback(() => {
    if (holdTimer.current !== null) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (!held.current) voice.askTap();
  }, [voice]);
  const onAskCancel = useCallback(() => {
    if (holdTimer.current !== null) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
  }, []);

  // ── Typed question (kept for anyone not driving) ────────────────────────────────────────────
  const raiseHand = useCallback(() => {
    handRaisedAtMs.current = positionMs;
    setAskResult(null);
    setSheet('ask');
  }, [positionMs]);

  const submitQuestion = useCallback(async () => {
    const q = question.trim();
    if (!q || asking || !slug) return;
    setAsking(true);
    try {
      const res = await askQuestion(slug, { question: q, positionMs: handRaisedAtMs.current, language: view.language ?? null });
      setAskResult(res);
      if (res.status !== 'refused') setQuestion('');
    } finally {
      setAsking(false);
    }
  }, [question, asking, slug, view.language]);

  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const remaining = Math.max(0, durationMs - positionMs);
  const voiceKind = voice.state.kind;
  const ringClass =
    voiceKind === 'listening' ? 'ring-8 ring-emerald-400/70 animate-pulse'
    : voiceKind === 'thinking' ? 'ring-8 ring-amber-300/60 animate-pulse'
    : voiceKind === 'speaking' ? 'ring-8 ring-sky-400/70'
    : voiceKind === 'resuming' ? 'ring-8 ring-white/30'
    : handsFree && voiceKind === 'idle' ? 'ring-4 ring-emerald-400/40'
    : 'ring-2 ring-white/20';

  return (
    <div
      className="fixed inset-0 flex flex-col bg-neutral-950 text-white select-none"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
      data-voice-state={voiceKind}
    >
      <audio
        ref={audioRef}
        src={offline.status === 'saved' ? offline.objectUrl : view.audio_url}
        preload="metadata"
        onTimeUpdate={(e) => setPositionMs(e.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDurationMs(d * 1000);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => setFailed('This recording could not be loaded. It may have been rebuilt — try reloading the page.')}
        className="hidden"
      >
        {view.captions_url && (
          <track kind="captions" src={view.captions_url} srcLang={view.language ?? 'en'} default />
        )}
      </audio>
      {/* The earcon and the spoken answer. A second plain element, for the same lock-screen reason. */}
      <audio ref={voiceRef} preload="none" className="hidden" aria-hidden="true" />

      {/* ── The glance: artwork · title · bar · transport · ASK/STOP ── */}
      <div className="flex flex-1 flex-col items-center justify-between gap-4 px-6 py-6 [@media(orientation:landscape)_and_(max-height:560px)]:flex-row [@media(orientation:landscape)_and_(max-height:560px)]:items-center [@media(orientation:landscape)_and_(max-height:560px)]:justify-center [@media(orientation:landscape)_and_(max-height:560px)]:gap-10">
        <div className="flex w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 [@media(orientation:landscape)_and_(max-height:560px)]:flex-none [@media(orientation:landscape)_and_(max-height:560px)]:w-[38vw] [@media(orientation:landscape)_and_(max-height:560px)]:max-w-md">
          <div className="relative aspect-square w-[min(60vw,42vh)] overflow-hidden rounded-3xl bg-neutral-800 shadow-2xl [@media(orientation:landscape)_and_(max-height:560px)]:w-[min(38vw,60vh)]">
            {artworkUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={artworkUrl} alt="" className="h-full w-full object-cover" draggable={false} />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-6xl">🎧</div>
            )}
          </div>
          <h1 className="w-full truncate text-center text-2xl font-semibold leading-tight">{view.title ?? 'Audio'}</h1>
          <p className="h-6 truncate text-center text-base text-white/60" aria-live="polite">
            {voice.note ?? chapters[currentChapter]?.title ?? ''}
          </p>
        </div>

        <div className="flex w-full max-w-sm flex-col items-center gap-5 [@media(orientation:landscape)_and_(max-height:560px)]:w-[44vw] [@media(orientation:landscape)_and_(max-height:560px)]:max-w-md">
          {/* Progress bar — a real range input so a thumb drag and a steering-wheel seek agree. */}
          <div className="w-full">
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.round(durationMs))}
              value={Math.round(Math.min(positionMs, durationMs || positionMs))}
              onChange={(e) => seekTo(Number(e.currentTarget.value))}
              aria-label="Position"
              className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-white"
              style={{ background: `linear-gradient(to right, #fff ${progress * 100}%, rgba(255,255,255,0.2) ${progress * 100}%)` }}
            />
            <div className="mt-1 flex justify-between text-xs tabular-nums text-white/60">
              <span>{formatClock(positionMs)}</span>
              <span>-{formatClock(remaining)}</span>
            </div>
          </div>

          {/* Transport */}
          <div className="flex items-center justify-center gap-6">
            <button type="button" onClick={() => goToChapter(-1)} aria-label="Previous chapter"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-3xl active:bg-white/20">
              ⏮
            </button>
            <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}
              className="flex h-24 w-24 items-center justify-center rounded-full bg-white text-5xl text-black shadow-xl active:scale-95">
              {playing ? '⏸' : '▶'}
            </button>
            <button type="button" onClick={() => goToChapter(1)} aria-label="Next chapter"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-3xl active:bg-white/20">
              ⏭
            </button>
          </div>

          {/* ASK · STOP */}
          {slug && (
            <div className="flex w-full items-center justify-center gap-8">
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  aria-label="Ask by voice"
                  aria-pressed={handsFree}
                  onPointerDown={onAskDown}
                  onPointerUp={onAskUp}
                  onPointerLeave={onAskCancel}
                  onPointerCancel={onAskCancel}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); voice.askTap(); } }}
                  className={`flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 text-3xl text-black shadow-xl transition active:scale-95 ${ringClass}`}
                >
                  🎤
                </button>
                <span className="text-sm text-white/70">{voice.error ?? voiceStatusLabel(voice.state)}</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  aria-label="Stop"
                  onClick={() => { voice.stop(); audioRef.current?.pause(); }}
                  className="flex h-20 w-20 items-center justify-center rounded-full bg-white/10 text-3xl active:bg-white/20"
                >
                  ■
                </button>
                <span className="text-sm text-white/70">Stop</span>
              </div>
            </div>
          )}

          {failed && <p role="alert" className="text-center text-sm text-red-300">{failed}</p>}

          {/* The sheet's handle: three small words, off the main path. */}
          <div className="flex items-center gap-5 text-sm text-white/60">
            {chapters.length > 0 && (
              <button type="button" onClick={() => setSheet(sheet === 'chapters' ? 'closed' : 'chapters')} className="min-h-[44px] px-2">
                Chapters
              </button>
            )}
            {slug && (
              <button type="button" onClick={raiseHand} className="min-h-[44px] px-2">
                ✋ Raise your hand
              </button>
            )}
            <button type="button" onClick={() => void save()} disabled={offline.status !== 'idle'} className="min-h-[44px] px-2 disabled:opacity-60">
              {offline.status === 'idle' && 'Save for the drive'}
              {offline.status === 'saving' && (offline.progress > 0 ? `Saving… ${Math.round(offline.progress * 100)}%` : 'Saving…')}
              {offline.status === 'saved' && `Saved · ${formatBytes(offline.bytes)}`}
              {offline.status === 'failed' && 'Save failed'}
            </button>
          </div>
        </div>
      </div>

      {/* ── The sheet: chapters, or the typed question ── */}
      {sheet !== 'closed' && (
        <div className="absolute inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-3xl bg-neutral-900 p-4 shadow-2xl" role="dialog" aria-label={sheet === 'chapters' ? 'Chapters' : 'Ask a question'}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-white/70">{sheet === 'chapters' ? 'Chapters' : `Asking about ${formatClock(handRaisedAtMs.current)}`}</span>
            <button type="button" onClick={() => { setSheet('closed'); setAskResult(null); }} className="min-h-[44px] px-3 text-sm text-white/70">
              Close
            </button>
          </div>

          {sheet === 'chapters' && (
            <ol className="divide-y divide-white/10">
              {chapters.map((c: AudioChapter, i: number) => (
                <li key={`${c.startMs}-${c.title}`}>
                  <button
                    type="button"
                    onClick={() => { seekTo(c.startMs); setSheet('closed'); }}
                    aria-current={i === currentChapter ? 'true' : undefined}
                    className={`flex w-full items-baseline gap-3 px-2 py-3 text-left min-h-[48px] ${i === currentChapter ? 'font-medium text-white' : 'text-white/80'}`}
                  >
                    <span className="tabular-nums text-xs text-white/50">{formatClock(c.startMs)}</span>
                    <span className="flex-1">{c.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          {sheet === 'ask' && slug && (
            <div>
              {voice.heard && <p className="mb-2 text-xs text-white/50">Last heard: “{voice.heard}”</p>}
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={3}
                autoFocus
                placeholder="What would you like to ask?"
                className="w-full rounded-xl border border-white/15 bg-black/40 p-3 text-base text-white"
              />
              {askResult && (
                <div role="status" aria-live="polite" className="mt-2 text-sm">
                  {askResult.status === 'answered' && askResult.answer ? (
                    <p className="rounded-xl bg-white/10 p-3 whitespace-pre-wrap">{askResult.answer}</p>
                  ) : askResult.status === 'saved' ? (
                    <p className="text-white/70">
                      Saved — the creator will see your question at {formatClock(handRaisedAtMs.current)}.
                      {askResult.message ? ` (${askResult.message})` : ''}
                    </p>
                  ) : (
                    <p className="text-red-300">{askResult.message ?? 'Could not send your question.'}</p>
                  )}
                </div>
              )}
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={submitQuestion}
                  disabled={asking || !question.trim()}
                  className="min-h-[44px] rounded-xl bg-white px-5 text-base font-medium text-black disabled:opacity-50"
                >
                  {asking ? 'Asking…' : 'Ask'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {playing && chapters[currentChapter] ? `Now playing: ${chapters[currentChapter].title}` : ''}
      </p>
    </div>
  );
}
