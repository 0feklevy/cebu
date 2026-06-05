'use client';

import { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { Music, Plus, Trash2, Volume2, X } from 'lucide-react';
import type { VideoFile, TimelineSection, Simulation, ImageFile, AudioFile } from 'shared/src/generated/client-v1';
import { SectionEditor } from './SectionEditor';
import { api } from '../lib/api';

// ─── constants ────────────────────────────────────────────────────────────────

const BROLL_TRACK_H  = 44;
const VIDEO_TRACK_H  = 52;
const AUDIO_TRACK_H  = 22;
const RULER_H        = 24;
const LABEL_W        = 110;
const FRAME_W        = 80;
const FRAME_H        = 45;
const FRAMES_COUNT   = 20;
const WAVEFORM_PEAKS = 200;
const SCROLLBAR_H    = 12;
const RULER_LABEL_TOP = 3;
const VISUAL_MAX_SEC = 15;
const MIN_DRAG_PX    = 4;
const MIN_BROLL_SEC  = 4;   // minimum marked duration for B-roll creation
const TRIM_ZONE_PX   = 10;
const MIN_ZOOM       = 2;
const MAX_ZOOM       = 400;

// ─── section colors ───────────────────────────────────────────────────────────

const TYPE_STYLE: Record<string, { fill: string; border: string; text: string; handle: string }> = {
  video:      { fill: 'rgba(59,130,246,0.18)',  border: '#3b82f6', text: '#1d4ed8', handle: '#2563eb' },
  simulation: { fill: 'rgba(245,158,11,0.18)',  border: '#f59e0b', text: '#92400e', handle: '#d97706' },
  broll:      { fill: 'rgba(6,182,212,0.22)',   border: '#06b6d4', text: '#0e7490', handle: '#0891b2' },
  intro:      { fill: 'rgba(16,185,129,0.18)',  border: '#10b981', text: '#065f46', handle: '#059669' },
  outro:      { fill: 'rgba(139,92,246,0.18)',  border: '#8b5cf6', text: '#4c1d95', handle: '#7c3aed' },
  cut:        { fill: 'rgba(239,68,68,0.18)',   border: '#ef4444', text: '#991b1b', handle: '#dc2626' },
  clip:       { fill: 'rgba(34,197,94,0.18)',   border: '#22c55e', text: '#14532d', handle: '#16a34a' },
  audio:      { fill: 'rgba(16,185,129,0.18)',  border: '#10b981', text: '#047857', handle: '#059669' },
  custom:     { fill: 'rgba(107,114,128,0.18)', border: '#6b7280', text: '#374151', handle: '#4b5563' },
};
const fallbackStyle = TYPE_STYLE.custom;

// ─── types ────────────────────────────────────────────────────────────────────

type ToolMode = 'video' | 'simulation' | 'broll';

type Interaction =
  // V1 track
  | { kind: 'creating'; videoId: string; clipOffset: number; startSec: number; curSec: number; duration: number }
  | { kind: 'moving';   section: TimelineSection; clipOffset: number; offsetSec: number; duration: number; previewStart: number; previewEnd: number }
  | { kind: 'trimming'; section: TimelineSection; clipOffset: number; edge: 'start' | 'end'; duration: number; previewStart: number; previewEnd: number }
  // V2 broll track
  | { kind: 'broll-creating'; startSec: number; curSec: number }
  | { kind: 'broll-moving';   section: TimelineSection; dragOffsetSec: number; previewOffset: number }
  | { kind: 'broll-trimming'; section: TimelineSection; edge: 'start' | 'end'; sourceDuration: number; previewStart: number; previewEnd: number };

// ─── clip model ───────────────────────────────────────────────────────────────

interface ClipWithOffset {
  video: VideoFile;
  offset: number;
}

function buildClips(videos: VideoFile[]): ClipWithOffset[] {
  const sorted = [...videos].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  let off = 0;
  return sorted.map(v => {
    const clip = { video: v, offset: off };
    off += v.duration_sec ?? 0;
    return clip;
  });
}

function findClipAtGlobalSec(clips: ClipWithOffset[], globalSec: number): ClipWithOffset | null {
  for (const c of clips) {
    const end = c.offset + (c.video.duration_sec ?? 0);
    if (globalSec >= c.offset && globalSec < end) return c;
  }
  return clips.length > 0 ? clips[clips.length - 1] : null;
}

function isAudioSection(s: TimelineSection): boolean {
  return s.track === 'audio' || !!s.clip_source_audio_id;
}

function isVisualBrollSection(s: TimelineSection): boolean {
  return s.track === 'broll' && !isAudioSection(s);
}

function isMainSection(s: TimelineSection): boolean {
  return s.track === 'main';
}

// ─── overlap helpers ──────────────────────────────────────────────────────────

function sortedSections(sections: TimelineSection[], videoId: string) {
  return sections
    .filter(s => isMainSection(s) && s.video_file_id === videoId)
    .sort((a, b) => a.start_sec - b.start_sec);
}

function findGap(sections: TimelineSection[], videoId: string, atSec: number, duration: number): [number, number] | null {
  const sorted = sortedSections(sections, videoId);
  if (sorted.some(s => atSec >= s.start_sec && atSec <= s.end_sec)) return null;
  let gapStart = 0;
  for (const s of sorted) {
    if (s.start_sec > atSec) return [gapStart, s.start_sec];
    gapStart = s.end_sec;
  }
  return [gapStart, duration];
}

function clampMove(sections: TimelineSection[], moved: TimelineSection, newStart: number, duration: number): [number, number] {
  const dur = moved.end_sec - moved.start_sec;
  let s = Math.max(0, Math.min(duration - dur, newStart));
  const e = s + dur;
  const others = sortedSections(sections, moved.video_file_id).filter(x => x.id !== moved.id);
  for (const o of others) {
    if (s < o.end_sec && e > o.start_sec) {
      const pushRight = o.end_sec;
      const pushLeft  = o.start_sec - dur;
      s = Math.abs(newStart - pushRight) < Math.abs(newStart - pushLeft) ? pushRight : pushLeft;
      s = Math.max(0, Math.min(duration - dur, s));
    }
  }
  return [s, s + dur];
}

function clampTrim(sections: TimelineSection[], trimmed: TimelineSection, edge: 'start' | 'end', value: number, duration: number): number {
  const others = sortedSections(sections, trimmed.video_file_id).filter(x => x.id !== trimmed.id);
  if (edge === 'start') {
    let min = 0;
    for (const o of others) if (o.end_sec <= trimmed.start_sec + 0.001) min = Math.max(min, o.end_sec);
    return Math.max(min, Math.min(trimmed.end_sec - 0.5, value));
  } else {
    let max = duration;
    for (const o of others) if (o.start_sec >= trimmed.end_sec - 0.001) max = Math.min(max, o.start_sec);
    return Math.min(max, Math.max(trimmed.start_sec + 0.5, value));
  }
}

// ─── frame extraction ────────────────────────────────────────────────────────

function useVideoFrames(url: string | null, duration: number) {
  const [frames, setFrames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!url || duration <= 0) { setFrames([]); setLoading(false); return; }
    setLoading(true);
    let aborted = false;
    const vid = document.createElement('video');
    vid.crossOrigin = 'anonymous';
    vid.preload = 'metadata';
    vid.muted = true;
    vid.playsInline = true;
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_W; canvas.height = FRAME_H;
    const ctx = canvas.getContext('2d')!;
    const captured: string[] = [];
    let i = 0;
    const captureNext = () => {
      if (aborted) return;
      if (i >= FRAMES_COUNT) { setFrames([...captured]); setLoading(false); return; }
      vid.currentTime = Math.min(((i + 0.5) / FRAMES_COUNT) * duration, duration - 0.01);
    };
    vid.addEventListener('loadedmetadata', captureNext);
    vid.addEventListener('seeked', () => {
      if (aborted) return;
      try { ctx.drawImage(vid, 0, 0, FRAME_W, FRAME_H); captured.push(canvas.toDataURL('image/jpeg', 0.6)); }
      catch { captured.push(''); }
      i++; captureNext();
    });
    vid.addEventListener('error', () => { aborted = true; setLoading(false); });
    vid.src = url;
    return () => { aborted = true; vid.src = ''; setLoading(false); };
  }, [url, duration]);
  return { frames, loading };
}

// ─── waveform ────────────────────────────────────────────────────────────────

function parseWaveformPeaks(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as number[];
    return Array.isArray(arr) && arr.length > 0 ? arr : null;
  } catch { return null; }
}

function Waveform({ peaks }: { peaks: number[] | null }) {
  const midY = AUDIO_TRACK_H / 2;
  if (!peaks || peaks.length === 0) {
    // Placeholder: deterministic sine-wave bar pattern at low opacity
    return (
      <div className="absolute inset-0 overflow-hidden">
        <svg className="w-full h-full" viewBox={`0 0 200 ${AUDIO_TRACK_H}`} preserveAspectRatio="none">
          {Array.from({ length: 50 }, (_, i) => {
            const h = Math.max(1, (Math.abs(Math.sin(i * 0.55)) * 0.6 + 0.15) * (midY - 1));
            return (
              <rect key={i} x={i * 4} y={midY - h} width={2.5} height={h * 2}
                fill="#10b981" fillOpacity="0.25" rx="0.5" />
            );
          })}
        </svg>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 overflow-hidden">
      <svg className="w-full h-full" viewBox={`0 0 ${WAVEFORM_PEAKS} ${AUDIO_TRACK_H}`} preserveAspectRatio="none">
        <line x1={0} y1={midY} x2={WAVEFORM_PEAKS} y2={midY} stroke="#d1fae5" strokeWidth="0.5" />
        {peaks.map((p, i) => {
          const h = Math.max(0.5, p * (midY - 3));
          return (
            <line key={i} x1={i + 0.5} y1={midY - h} x2={i + 0.5} y2={midY + h}
              stroke="#10b981" strokeWidth="0.9" strokeOpacity={0.7} />
          );
        })}
      </svg>
    </div>
  );
}

function ClipFilmstrip({ videoUrl, duration }: { videoUrl: string | null; duration: number }) {
  const { frames, loading } = useVideoFrames(videoUrl, duration);
  if (frames.length === 0) {
    // Placeholder bars while frames are loading or URL unavailable
    return (
      <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ opacity: 0.45 }}>
        <div style={{
          width: '100%', height: '100%',
          backgroundImage: 'repeating-linear-gradient(90deg, rgba(59,130,246,0.22) 0px, rgba(59,130,246,0.22) 1px, rgba(59,130,246,0.08) 1px, rgba(59,130,246,0.08) 22px)',
        }} />
        {loading && (
          <div style={{ position: 'absolute', top: '50%', left: 6, transform: 'translateY(-50%)', fontSize: 8, color: 'rgba(59,130,246,0.5)', fontWeight: 700, letterSpacing: 2, userSelect: 'none' }}>
            ···
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex pointer-events-none" style={{ opacity: 0.55 }}>
      {frames.map((src: string, idx: number) => (
        <div key={idx} className="flex-1 overflow-hidden" style={{ borderRight: '1px solid rgba(0,0,0,0.08)' }}>
          {src
            ? <img src={src} className="w-full h-full object-cover" alt="" draggable={false} />
            : <div className="w-full h-full bg-gray-200" />}
        </div>
      ))}
    </div>
  );
}

function getAudioDurationFromUrl(url: string): Promise<number | null> {
  return new Promise(resolve => {
    const audio = new Audio();
    let timer: number | null = null;

    const cleanup = () => {
      if (timer !== null) window.clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.src = '';
    };

    timer = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, 4000);

    audio.preload = 'metadata';
    audio.crossOrigin = 'anonymous';
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
      cleanup();
      resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      resolve(null);
    };
    audio.src = url;
  });
}

function formatDuration(s: number): string {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

function AudioGainPopover({
  projectId,
  section,
  onUpdate,
  onDelete,
  onClose,
}: {
  projectId: string;
  section: TimelineSection;
  onUpdate: (section: TimelineSection) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [volume, setVolume] = useState(section.broll_volume ?? 1);
  const [busy, setBusy] = useState(false);
  const pct = Math.round(volume * 100);

  useEffect(() => {
    setVolume(section.broll_volume ?? 1);
  }, [section.id, section.broll_volume]);

  const commitVolume = useCallback(async (nextVolume = volume) => {
    setBusy(true);
    try {
      const updated = await api.updateSection(projectId, section.id, { broll_volume: nextVolume });
      onUpdate(updated);
    } catch { /* ignore */ }
    finally {
      setBusy(false);
    }
  }, [onUpdate, projectId, section.id, volume]);

  const deleteAudioSection = useCallback(async () => {
    setBusy(true);
    try {
      await api.deleteSection(projectId, section.id);
      onDelete(section.id);
    } catch {
      onDelete(section.id);
    } finally {
      setBusy(false);
    }
  }, [onDelete, projectId, section.id]);

  return (
    <>
      <div
        className="fixed inset-0"
        style={{ zIndex: 700, background: 'transparent' }}
        onClick={onClose}
      />
      <div
        className="fixed overflow-hidden rounded-lg border bg-white shadow-xl"
        style={{
          right: 24,
          bottom: 156,
          width: 320,
          zIndex: 701,
          borderColor: '#d1fae5',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: '#ecfdf5', backgroundColor: '#f0fdf4' }}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: '#d1fae5', color: '#047857' }}>
              <Volume2 size={16} strokeWidth={2} aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-emerald-900">{section.label || 'Audio'}</p>
              <p className="text-[10px] font-medium uppercase tracking-widest text-emerald-600">Audio gain</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-emerald-700 transition-colors hover:bg-emerald-100 focus-ring"
            title="Close"
          >
            <X size={15} strokeWidth={2} aria-hidden />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={e => setVolume(parseFloat(e.target.value))}
              onPointerUp={() => commitVolume()}
              onKeyUp={e => {
                if (e.key === 'Enter' || e.key === ' ') void commitVolume();
              }}
              className="min-w-0 flex-1"
              style={{ accentColor: '#10b981' }}
              aria-label="Audio volume"
            />
            <span className="w-12 text-right font-mono text-xs font-bold text-emerald-700">{pct}%</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-muted-foreground">{formatDuration(section.end_sec - section.start_sec)}</p>
            <button
              type="button"
              onClick={deleteAudioSection}
              disabled={busy}
              className="flex h-8 items-center gap-1.5 rounded-md border border-red-100 px-2.5 text-[11px] font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 focus-ring"
            >
              <Trash2 size={13} strokeWidth={1.9} aria-hidden />
              Delete
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── props ────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  videos: VideoFile[];
  sections: TimelineSection[];
  simulations: Simulation[];
  images?: ImageFile[];
  audioFiles?: AudioFile[];
  playheadSec: number;
  activeVideoId: string | null;
  videoUrls: Record<string, string>;
  onSeek: (globalSec: number) => void;
  onSectionsChange: (sections: TimelineSection[]) => void;
  onBrollMarkComplete?: (mark: { start: number; end: number }) => void;
  onAudioCutawayInserted?: (section: TimelineSection) => void;
  onSimulationUpdate?: (sim: Simulation) => void;
  toolMode: ToolMode;
  showAllLayers?: boolean;
  showBrollTrack?: boolean;
  showAudioTrack?: boolean;
  onAddVideo?: () => void;
}

// ─── main component ───────────────────────────────────────────────────────────

export function TimelinePanel({
  projectId, videos, sections, simulations, images = [], audioFiles = [], playheadSec, activeVideoId, videoUrls,
  onSeek, onSectionsChange, onBrollMarkComplete, onAudioCutawayInserted, onSimulationUpdate,
  toolMode, showAllLayers = false, showBrollTrack, showAudioTrack, onAddVideo,
}: Props) {
  const scrollRef    = useRef<HTMLDivElement>(null);
  const interRef     = useRef<Interaction | null>(null);
  const didMoveRef   = useRef(false);
  const zoomRef      = useRef(10);
  const scrollAdjRef = useRef<{ sec: number; mouseX: number } | null>(null);

  const [zoom, setZoom]                   = useState(10);
  const [interaction, setInteraction]     = useState<Interaction | null>(null);
  const [selectedSection, setSelectedSection] = useState<TimelineSection | null>(null);
  const [addMenuOpen, setAddMenuOpen]     = useState(false);
  const [addBusy, setAddBusy]             = useState<'simulation' | 'clip' | null>(null);
  const [a2DragOver, setA2DragOver]       = useState(false);

  const mainSections  = sections.filter(isMainSection);
  const brollSections = sections.filter(isVisualBrollSection);
  const audioSections = sections.filter(isAudioSection);
  const hasBroll = showBrollTrack ?? (toolMode === 'broll' || showAllLayers);
  const hasAudio = showAudioTrack ?? (audioFiles.length > 0 || audioSections.length > 0 || hasBroll);

  const clipsWithOffset = buildClips(videos);
  const videoTimelineDuration = clipsWithOffset.reduce((s, c) => s + (c.video.duration_sec ?? 0), 0);
  const sectionTimelineEnd = mainSections.reduce((max, s) => {
    const clip = clipsWithOffset.find(c => c.video.id === s.video_file_id);
    return clip ? Math.max(max, clip.offset + s.end_sec) : max;
  }, videoTimelineDuration);
  const overlayTimelineEnd = sections.reduce((max, s) => {
    if (!isVisualBrollSection(s) && !isAudioSection(s)) return max;
    return Math.max(max, (s.global_offset_sec ?? 0) + (s.end_sec - s.start_sec));
  }, 0);
  const totalDuration = Math.max(sectionTimelineEnd, overlayTimelineEnd, 50);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  const setInter = useCallback((v: Interaction | null) => { interRef.current = v; setInteraction(v); }, []);

  // ── Fit-to-view on mount ─────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (w > 0 && totalDuration > 0) {
      const fit = Math.max(MIN_ZOOM, w / totalDuration);
      zoomRef.current = fit;
      setZoom(fit);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Adjust scroll after zoom ─────────────────────────────────────────────
  useLayoutEffect(() => {
    const adj = scrollAdjRef.current;
    if (adj && scrollRef.current) {
      scrollRef.current.scrollLeft = adj.sec * zoom - adj.mouseX;
      scrollAdjRef.current = null;
    }
  }, [zoom]);

  // ── Wheel zoom / pan ─────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        const cur = zoomRef.current;
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cur * factor));
        if (next === cur) return;
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const secAtMouse = (mouseX + el.scrollLeft) / cur;
        scrollAdjRef.current = { sec: secAtMouse, mouseX };
        zoomRef.current = next;
        setZoom(next);
      } else if (e.deltaX === 0 && e.deltaY !== 0) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── px → global seconds ──────────────────────────────────────────────────
  const pixelsToGlobalSec = useCallback((clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left + el.scrollLeft;
    return Math.max(0, Math.min(totalDuration, px / zoom));
  }, [totalDuration, zoom]);

  // ── V1 track mouse down ──────────────────────────────────────────────────
  const handleTrackMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (toolMode === 'broll') return; // handled by V2 track
    const globalSec = pixelsToGlobalSec(e.clientX);
    const clip = findClipAtGlobalSec(clipsWithOffset, globalSec);
    if (!clip) return;
    const localSec = Math.max(0, globalSec - clip.offset);
    const dur = clip.video.duration_sec ?? totalDuration;
    const gap = findGap(mainSections, clip.video.id, localSec, dur);
    if (!gap) return;
    setInter({
      kind: 'creating',
      videoId: clip.video.id,
      clipOffset: clip.offset,
      startSec: localSec,
      curSec: localSec,
      duration: dur,
    });
    setSelectedSection(null);
    e.preventDefault();
  }, [mainSections, clipsWithOffset, totalDuration, pixelsToGlobalSec, setInter, toolMode]);

  // ── V2 broll track mouse down ────────────────────────────────────────────
  const handleBrollTrackMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || toolMode !== 'broll') return;
    const globalSec = pixelsToGlobalSec(e.clientX);
    setInter({ kind: 'broll-creating', startSec: globalSec, curSec: globalSec });
    setSelectedSection(null);
    e.preventDefault();
  }, [toolMode, pixelsToGlobalSec, setInter]);

  // ── V1 section mouse down ────────────────────────────────────────────────
  const handleSectionMouseDown = useCallback((
    e: React.MouseEvent,
    s: TimelineSection,
    clipOffset: number,
    mode: 'move' | 'trim-start' | 'trim-end',
  ) => {
    if (e.button !== 0) return;
    const globalSec = pixelsToGlobalSec(e.clientX);
    const localSec  = globalSec - clipOffset;
    const baseDur = videos.find(v => v.id === s.video_file_id)?.duration_sec ?? totalDuration;
    const dur = Math.max(baseDur, s.end_sec);
    didMoveRef.current = false;
    if (mode === 'move') {
      const offsetSec = localSec - s.start_sec;
      setInter({ kind: 'moving', section: s, clipOffset, offsetSec, duration: dur, previewStart: s.start_sec, previewEnd: s.end_sec });
    } else {
      setInter({ kind: 'trimming', section: s, clipOffset, edge: mode === 'trim-start' ? 'start' : 'end', duration: dur, previewStart: s.start_sec, previewEnd: s.end_sec });
    }
    e.preventDefault();
  }, [videos, totalDuration, pixelsToGlobalSec, setInter]);

  // ── V2 broll section mouse down ──────────────────────────────────────────
  const handleBrollSectionMouseDown = useCallback((
    e: React.MouseEvent,
    s: TimelineSection,
    mode: 'move' | 'trim-start' | 'trim-end',
  ) => {
    if (e.button !== 0) return;
    const globalSec = pixelsToGlobalSec(e.clientX);
    const offset = s.global_offset_sec ?? 0;
    const sourceDuration = videos.find(v => v.id === s.video_file_id)?.duration_sec ?? (s.end_sec - s.start_sec);
    didMoveRef.current = false;
    if (mode === 'move') {
      setInter({ kind: 'broll-moving', section: s, dragOffsetSec: globalSec - offset, previewOffset: offset });
    } else {
      setInter({ kind: 'broll-trimming', section: s, edge: mode === 'trim-start' ? 'start' : 'end', sourceDuration, previewStart: s.start_sec, previewEnd: s.end_sec });
    }
    e.preventDefault();
  }, [pixelsToGlobalSec, setInter, videos]);

  // ── Global mouse move / up ───────────────────────────────────────────────

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const inter = interRef.current;
      if (!inter) return;
      const globalSec = pixelsToGlobalSec(e.clientX);

      if (inter.kind === 'creating') {
        const localSec = Math.max(0, Math.min(inter.duration, globalSec - inter.clipOffset));
        const cur = toolMode === 'video'
          ? Math.min(localSec, inter.startSec + VISUAL_MAX_SEC)
          : localSec;
        setInter({ ...inter, curSec: cur });

      } else if (inter.kind === 'moving') {
        const localSec = Math.max(0, Math.min(inter.duration, globalSec - inter.clipOffset));
        const newStart = localSec - inter.offsetSec;
        const [ps, pe] = clampMove(mainSections, inter.section, newStart, inter.duration);
        if (Math.abs(ps - inter.section.start_sec) > 0.05) didMoveRef.current = true;
        setInter({ ...inter, previewStart: ps, previewEnd: pe });

      } else if (inter.kind === 'trimming') {
        const localSec = Math.max(0, Math.min(inter.duration, globalSec - inter.clipOffset));
        const clamped = clampTrim(mainSections, inter.section, inter.edge, localSec, inter.duration);
        if (inter.edge === 'start' && Math.abs(clamped - inter.section.start_sec) > 0.05) didMoveRef.current = true;
        if (inter.edge === 'end'   && Math.abs(clamped - inter.section.end_sec)   > 0.05) didMoveRef.current = true;
        setInter({
          ...inter,
          previewStart: inter.edge === 'start' ? clamped : inter.section.start_sec,
          previewEnd:   inter.edge === 'end'   ? clamped : inter.section.end_sec,
        });

      } else if (inter.kind === 'broll-creating') {
        setInter({ ...inter, curSec: Math.max(0, Math.min(totalDuration, globalSec)) });

      } else if (inter.kind === 'broll-moving') {
        const newOffset = Math.max(0, Math.min(totalDuration - (inter.section.end_sec - inter.section.start_sec), globalSec - inter.dragOffsetSec));
        if (Math.abs(newOffset - (inter.section.global_offset_sec ?? 0)) > 0.05) didMoveRef.current = true;
        setInter({ ...inter, previewOffset: newOffset });

      } else if (inter.kind === 'broll-trimming') {
        const localSec = globalSec - (inter.section.global_offset_sec ?? 0);
        if (inter.edge === 'start') {
          const clamped = Math.max(0, Math.min(inter.previewEnd - 1, localSec + (inter.section.global_offset_sec ?? 0) - (inter.section.global_offset_sec ?? 0)));
          // trim start: clamp between 0 and end_sec - 1
          const val = Math.max(0, Math.min(inter.section.end_sec - 1, globalSec - (inter.section.global_offset_sec ?? 0) + inter.section.start_sec));
          const newStart = Math.max(0, Math.min(inter.section.end_sec - 1, val));
          if (Math.abs(newStart - inter.section.start_sec) > 0.05) didMoveRef.current = true;
          setInter({ ...inter, previewStart: newStart });
          void clamped; // suppress unused warning
        } else {
          const clipDur = inter.sourceDuration;
          const val = Math.min(clipDur, Math.max(inter.section.start_sec + 1, globalSec - (inter.section.global_offset_sec ?? 0) + inter.section.start_sec));
          // simpler: end_sec moves based on delta from mouse
          const delta = globalSec - ((inter.section.global_offset_sec ?? 0) + (inter.section.end_sec - inter.section.start_sec));
          const newEnd = Math.min(clipDur, Math.max(inter.section.start_sec + 1, inter.section.end_sec + delta));
          if (Math.abs(newEnd - inter.section.end_sec) > 0.05) didMoveRef.current = true;
          setInter({ ...inter, previewEnd: newEnd });
          void val;
        }
      }
    };

    const onUp = async () => {
      const inter = interRef.current;
      if (!inter) return;
      setInter(null);

      if (inter.kind === 'creating') {
        const s  = Math.min(inter.startSec, inter.curSec);
        const en = toolMode === 'video'
          ? Math.min(Math.max(inter.startSec, inter.curSec), s + VISUAL_MAX_SEC)
          : Math.max(inter.startSec, inter.curSec);
        const minSec = MIN_DRAG_PX / zoomRef.current;
        if (en - s < minSec) return;
        const gap = findGap(mainSections, inter.videoId, inter.startSec, inter.duration);
        if (!gap) return;
        const finalS = Math.max(s, gap[0]);
        const finalE = Math.min(en, gap[1]);
        if (finalE - finalS < minSec) return;
        try {
          const section = await api.createSection(projectId, {
            video_file_id: inter.videoId, start_sec: finalS, end_sec: finalE, type: toolMode,
          });
          onSectionsChange([...sections, section]);
          setSelectedSection(section);
        } catch { /* ignore */ }

      } else if (inter.kind === 'moving') {
        const { previewStart, previewEnd, section } = inter;
        if (Math.abs(previewStart - section.start_sec) < 0.01) return;
        try {
          const updated = await api.updateSection(projectId, section.id, { start_sec: previewStart, end_sec: previewEnd });
          onSectionsChange(sections.map(s => s.id === updated.id ? updated : s));
        } catch { /* ignore */ }

      } else if (inter.kind === 'trimming') {
        const { previewStart, previewEnd, section } = inter;
        if (Math.abs(previewStart - section.start_sec) < 0.01 && Math.abs(previewEnd - section.end_sec) < 0.01) return;
        try {
          const updated = await api.updateSection(projectId, section.id, { start_sec: previewStart, end_sec: previewEnd });
          onSectionsChange(sections.map(s => s.id === updated.id ? updated : s));
        } catch { /* ignore */ }

      } else if (inter.kind === 'broll-creating') {
        const s  = Math.min(inter.startSec, inter.curSec);
        const en = Math.max(inter.startSec, inter.curSec);
        if (en - s < MIN_BROLL_SEC) return; // enforce 4 s minimum
        onBrollMarkComplete?.({ start: s, end: en });

      } else if (inter.kind === 'broll-moving') {
        const { previewOffset, section } = inter;
        if (Math.abs(previewOffset - (section.global_offset_sec ?? 0)) < 0.01) return;
        try {
          const updated = await api.updateSection(projectId, section.id, { global_offset_sec: previewOffset });
          onSectionsChange(sections.map(s => s.id === updated.id ? updated : s));
        } catch { /* ignore */ }

      } else if (inter.kind === 'broll-trimming') {
        const { previewStart, previewEnd, section } = inter;
        if (Math.abs(previewStart - section.start_sec) < 0.01 && Math.abs(previewEnd - section.end_sec) < 0.01) return;
        try {
          const updated = await api.updateSection(projectId, section.id, { start_sec: previewStart, end_sec: previewEnd });
          onSectionsChange(sections.map(s => s.id === updated.id ? updated : s));
        } catch { /* ignore */ }
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [sections, mainSections, toolMode, pixelsToGlobalSec, projectId, onSectionsChange, setInter, onBrollMarkComplete, totalDuration]);

  const handleSectionClick = useCallback((e: React.MouseEvent, s: TimelineSection) => {
    e.stopPropagation();
    if (didMoveRef.current) return;
    setSelectedSection(s);
  }, []);

  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    onSeek(pixelsToGlobalSec(e.clientX));
  }, [pixelsToGlobalSec, onSeek]);

  const handleAppendSection = useCallback(async (type: 'simulation' | 'clip') => {
    const anchor = clipsWithOffset[clipsWithOffset.length - 1];
    if (!anchor || addBusy) return;
    setAddBusy(type);
    setAddMenuOpen(false);
    try {
      const anchorDuration = anchor.video.duration_sec ?? 0;
      const start = Math.max(anchorDuration, sectionTimelineEnd - anchor.offset);
      const section = await api.createSection(projectId, {
        video_file_id: anchor.video.id,
        start_sec: start,
        end_sec: start + VISUAL_MAX_SEC,
        type,
        label: type === 'simulation' ? 'Simulation' : 'Existing clip',
      });
      onSectionsChange([...sections, section]);
      setSelectedSection(section);
      onSeek(anchor.offset + start);
    } catch { /* ignore */ }
    finally {
      setAddBusy(null);
    }
  }, [addBusy, clipsWithOffset, onSectionsChange, onSeek, projectId, sectionTimelineEnd, sections]);

  const handleUploadNewClip = useCallback(() => {
    setAddMenuOpen(false);
    onAddVideo?.();
  }, [onAddVideo]);

  const handleA2Drop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setA2DragOver(false);
    const raw = e.dataTransfer.getData('application/audio-cutaway');
    if (!raw) return;
    let audioData: { id: string; filename: string; url: string; duration_sec: number | null };
    try {
      audioData = JSON.parse(raw) as { id: string; filename: string; url: string; duration_sec: number | null };
    } catch {
      return;
    }
    const firstVideo = clipsWithOffset[0]?.video;
    if (!firstVideo) return;
    // Calculate global offset from drop X position
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const relX  = e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0);
    const dropSec = Math.max(0, relX / zoom);
    const measuredDuration = audioData.duration_sec ?? await getAudioDurationFromUrl(audioData.url);
    const dur = Math.max(0.5, measuredDuration ?? Math.max(10, totalDuration - dropSec));
    try {
      const section = await api.insertAudioCutaway(projectId, {
        audio_file_id:     audioData.id,
        global_offset_sec: dropSec,
        duration_sec:      dur,
        video_file_id:     firstVideo.id,
      });
      onAudioCutawayInserted?.(section);
    } catch { /* ignore */ }
  }, [clipsWithOffset, zoom, projectId, onAudioCutawayInserted, totalDuration]);

  // ── Ruler ticks ──────────────────────────────────────────────────────────

  const tickSec  = totalDuration <= 30 ? 1  : totalDuration <= 120 ? 5  : totalDuration <= 600 ? 15  : 60;
  const majorSec = totalDuration <= 30 ? 5  : totalDuration <= 120 ? 10 : totalDuration <= 600 ? 30  : 120;
  const fmt = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  const fmtDur = formatDuration;

  // ── Section display helper (V1) ──────────────────────────────────────────

  const sectionPos = (s: TimelineSection, clip: ClipWithOffset): { left: string; width: string } | null => {
    const disp = interaction?.kind === 'moving' && interaction.section.id === s.id
      ? { start: interaction.previewStart, end: interaction.previewEnd }
      : interaction?.kind === 'trimming' && interaction.section.id === s.id
        ? {
            start: interaction.edge === 'start' ? interaction.previewStart : s.start_sec,
            end:   interaction.edge === 'end'   ? interaction.previewEnd   : s.end_sec,
          }
        : { start: s.start_sec, end: s.end_sec };
    const leftPx  = (clip.offset + disp.start) * zoom;
    const widthPx = (disp.end - disp.start) * zoom;
    if (widthPx <= 0) return null;
    return { left: `${leftPx}px`, width: `${widthPx}px` };
  };

  // ── Broll section display helper (V2) ───────────────────────────────────

  const brollSectionPos = (s: TimelineSection): { left: string; width: string } | null => {
    let offset = s.global_offset_sec ?? 0;
    let start  = s.start_sec;
    let end    = s.end_sec;

    if (interaction?.kind === 'broll-moving' && interaction.section.id === s.id) {
      offset = interaction.previewOffset;
    } else if (interaction?.kind === 'broll-trimming' && interaction.section.id === s.id) {
      start = interaction.previewStart;
      end   = interaction.previewEnd;
    }

    const leftPx  = offset * zoom;
    const widthPx = (end - start) * zoom;
    if (widthPx <= 0) return null;
    return { left: `${leftPx}px`, width: `${widthPx}px` };
  };

  const contentWidth = zoom * totalDuration;

  // ── section render helper ────────────────────────────────────────────────

  const renderSectionEl = (
    s: TimelineSection,
    pos: { left: string; width: string },
    clipOffset: number,
    isBroll: boolean,
  ) => {
    const style = TYPE_STYLE[s.type] ?? fallbackStyle;
    const isSelected = selectedSection?.id === s.id;
    const getSectionMode = (e: React.MouseEvent, el: HTMLElement): 'move' | 'trim-start' | 'trim-end' => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (x <= TRIM_ZONE_PX) return 'trim-start';
      if (x >= r.width - TRIM_ZONE_PX) return 'trim-end';
      return 'move';
    };
    return (
      <div
        key={s.id}
        className="absolute flex items-center overflow-hidden"
        style={{
          top: 5, bottom: 5,
          left: pos.left,
          width: pos.width,
          backgroundColor: style.fill,
          border: `1.5px solid ${style.border}`,
          borderRadius: 4,
          boxShadow: isSelected ? `0 0 0 2px ${style.border}` : '0 1px 3px rgba(0,0,0,0.1)',
          cursor: 'grab',
          zIndex: 10,
          userSelect: 'none',
          minWidth: 4,
        }}
        onMouseDown={e => {
          e.stopPropagation();
          const mode = getSectionMode(e, e.currentTarget);
          if (isBroll) handleBrollSectionMouseDown(e, s, mode);
          else handleSectionMouseDown(e, s, clipOffset, mode);
        }}
        onClick={e => { e.stopPropagation(); handleSectionClick(e, s); }}
      >
        <div
          className="absolute top-0 bottom-0 flex items-center justify-center"
          style={{ left: 0, width: TRIM_ZONE_PX, cursor: 'ew-resize', zIndex: 2 }}
          onMouseDown={e => {
            e.stopPropagation();
            if (isBroll) handleBrollSectionMouseDown(e, s, 'trim-start');
            else handleSectionMouseDown(e, s, clipOffset, 'trim-start');
          }}
        >
          <div style={{ width: 2, height: '60%', borderRadius: 1, backgroundColor: style.handle, opacity: 0.7 }} />
        </div>
        {s.label && (
          <span style={{ fontSize: 9, color: style.text, fontWeight: 600, paddingLeft: 14, paddingRight: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.label}
          </span>
        )}
        <div
          className="absolute top-0 bottom-0 flex items-center justify-center"
          style={{ right: 0, width: TRIM_ZONE_PX, cursor: 'ew-resize', zIndex: 2 }}
          onMouseDown={e => {
            e.stopPropagation();
            if (isBroll) handleBrollSectionMouseDown(e, s, 'trim-end');
            else handleSectionMouseDown(e, s, clipOffset, 'trim-end');
          }}
        >
          <div style={{ width: 2, height: '60%', borderRadius: 1, backgroundColor: style.handle, opacity: 0.7 }} />
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full overflow-visible bg-white" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* ── Fixed label column ───────────────────────────────────────────── */}
      <div className="shrink-0 flex flex-col" style={{ width: LABEL_W, borderRight: '1px solid hsl(var(--border))' }}>
        <div style={{ height: RULER_H, backgroundColor: '#ffffff', borderBottom: '1.5px solid #e2e8f0', flexShrink: 0 }} />

        {videos.length > 0 && (
          <>
            {/* V2 label (broll track) */}
            {hasBroll && (
              <div
                className="shrink-0 flex flex-col justify-center px-3 select-none"
                style={{ height: BROLL_TRACK_H, borderBottom: '1px solid #e5e7eb', backgroundColor: '#ecfeff' }}
              >
                <span style={{ fontSize: 9, fontWeight: 700, color: '#0891b2', letterSpacing: '0.08em', textTransform: 'uppercase' }}>V2</span>
                <span style={{ fontSize: 8, color: '#06b6d4', marginTop: 2 }}>B-Roll</span>
              </div>
            )}

            {/* A2 label (audio channel) */}
            {hasAudio && (
              <div
                className="shrink-0 flex items-center px-3 select-none"
                style={{ height: AUDIO_TRACK_H, borderBottom: '1px solid #e5e7eb', backgroundColor: '#f0fdf4' }}
              >
                <span style={{ fontSize: 9, fontWeight: 700, color: '#059669', letterSpacing: '0.08em', textTransform: 'uppercase' }}>A2</span>
              </div>
            )}

            {/* V1 label */}
            <div
              className="shrink-0 flex flex-col justify-center px-3 select-none"
              style={{ height: VIDEO_TRACK_H, borderBottom: '1px solid #e5e7eb', backgroundColor: '#fafafa' }}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <span style={{ fontSize: 9, fontWeight: 700, color: '#9ca3af', letterSpacing: '0.08em', textTransform: 'uppercase' }}>V1</span>
                {videos.length > 1 && (
                  <span style={{ fontSize: 8, color: '#6366f1', fontWeight: 600 }}>{videos.length} clips</span>
                )}
              </div>
              <p style={{ fontSize: 9, color: '#9ca3af', fontFamily: 'monospace' }}>{fmtDur(totalDuration)}</p>
            </div>

            {/* A1 label */}
            <div
              className="shrink-0 flex items-center px-3"
              style={{ height: AUDIO_TRACK_H, backgroundColor: '#f0fdf4' }}
            >
              <span style={{ fontSize: 9, fontWeight: 700, color: '#6ee7b7', letterSpacing: '0.08em', textTransform: 'uppercase' }}>A1</span>
            </div>

            <div
              className="shrink-0"
              style={{ height: SCROLLBAR_H, backgroundColor: '#ffffff', borderTop: '1px solid #f1f5f9' }}
            />
          </>
        )}
      </div>

      {/* ── Scrollable track area ────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        className="flex-1 fine-scrollbar"
        style={{
          overflowX: 'auto',
          overflowY: 'hidden',
          paddingBottom: SCROLLBAR_H,
          boxSizing: 'border-box',
          scrollbarGutter: 'stable',
        }}
      >
        <div style={{ width: `${contentWidth}px`, minWidth: '100%', position: 'relative' }}>

          {/* ── Ruler ─────────────────────────────────────────────────────── */}
          <div
            className="select-none"
            style={{ height: RULER_H, position: 'relative', backgroundColor: '#ffffff', borderBottom: '1.5px solid #e2e8f0' }}
          >
            {Array.from({ length: Math.ceil(totalDuration / tickSec) + 1 }, (_, i) => {
              const sec = i * tickSec;
              const isMajor = sec % majorSec === 0;
              return (
                <div key={i} className="absolute top-0 bottom-0" style={{ left: `${sec * zoom}px` }}>
                  <div style={{ position: 'absolute', bottom: 0, width: 1, height: isMajor ? 10 : 5, backgroundColor: isMajor ? '#9ca3af' : '#d1d5db' }} />
                  {isMajor && (
                    <span style={{ position: 'absolute', top: RULER_LABEL_TOP, left: 3, fontSize: 10, lineHeight: '12px', color: '#6b7280', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                      {fmt(sec)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Tracks ────────────────────────────────────────────────────── */}
          {videos.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2" style={{ height: VIDEO_TRACK_H + AUDIO_TRACK_H, color: '#9ca3af' }}>
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <rect x="2" y="6" width="28" height="20" rx="3" stroke="#d1d5db" strokeWidth="1.5" />
                <path d="M12 12l8 4-8 4V12z" fill="#d1d5db" />
              </svg>
              <span className="text-xs font-medium">Upload a video to get started</span>
            </div>
          ) : (
            <>
              {/* ── V2 BROLL TRACK ─────────────────────────────────────── */}
              {hasBroll && (
                <div
                  style={{
                    height: BROLL_TRACK_H,
                    position: 'relative',
                    backgroundColor: toolMode === 'broll' ? '#ecfeff' : '#f7feff',
                    borderBottom: '1px solid #cffafe',
                    cursor: toolMode === 'broll' ? 'crosshair' : 'default',
                  }}
                  onMouseDown={handleBrollTrackMouseDown}
                  onClick={handleTrackClick}
                >
                  {/* Broll clip backgrounds */}
                  {brollSections.map(s => {
                    const pos = brollSectionPos(s);
                    if (!pos) return null;
                    const vidUrl = videoUrls[s.video_file_id] ?? null;
                    const dur = s.end_sec - s.start_sec;
                    return (
                      <div key={`bg-${s.id}`} className="absolute top-0 bottom-0 pointer-events-none"
                        style={{ left: pos.left, width: pos.width, backgroundColor: 'rgba(6,182,212,0.08)' }}>
                        <ClipFilmstrip videoUrl={vidUrl} duration={dur} />
                      </div>
                    );
                  })}

                  {/* Broll section elements */}
                  {brollSections.map(s => {
                    const pos = brollSectionPos(s);
                    if (!pos) return null;
                    return renderSectionEl(s, pos, 0, true);
                  })}

                  {/* Broll creation preview */}
                  {interaction?.kind === 'broll-creating' && (() => {
                    const cs = Math.min(interaction.startSec, interaction.curSec);
                    const ce = Math.max(interaction.startSec, interaction.curSec);
                    const dur = ce - cs;
                    const isEnough = dur >= MIN_BROLL_SEC;
                    return (
                      <>
                        <div
                          className="absolute pointer-events-none"
                          style={{
                            top: 5, bottom: 5,
                            left: `${cs * zoom}px`,
                            width: `${(ce - cs) * zoom}px`,
                            backgroundColor: isEnough ? 'rgba(6,182,212,0.25)' : 'rgba(239,68,68,0.15)',
                            border: `1.5px dashed ${isEnough ? '#06b6d4' : '#ef4444'}`,
                            borderRadius: 4,
                            zIndex: 11,
                          }}
                        />
                        {/* Duration label */}
                        <div
                          className="absolute pointer-events-none"
                          style={{
                            top: 6, left: `${cs * zoom + 4}px`,
                            fontSize: 9, fontWeight: 700,
                            color: isEnough ? '#0891b2' : '#ef4444',
                            background: 'rgba(255,255,255,0.8)',
                            padding: '1px 4px', borderRadius: 3, zIndex: 12,
                          }}
                        >
                          {dur.toFixed(1)}s{!isEnough && ' (min 4s)'}
                        </div>
                      </>
                    );
                  })()}

                  {/* Playhead */}
                  <div
                    className="absolute top-0 bottom-0 pointer-events-none"
                    style={{ left: `${playheadSec * zoom}px`, width: 2, backgroundColor: '#ef4444', opacity: 0.6, zIndex: 20 }}
                  />
                </div>
              )}

              {/* ── A2 AUDIO CHANNEL ───────────────────────────────────── */}
              {hasAudio && (
                <div
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setA2DragOver(true); }}
                  onDragLeave={() => setA2DragOver(false)}
                  onDrop={handleA2Drop}
                  onClick={handleTrackClick}
                  style={{
                    height: AUDIO_TRACK_H,
                    position: 'relative',
                    backgroundColor: a2DragOver ? '#ccfbf1' : '#f0feff',
                    borderBottom: `1px solid ${a2DragOver ? '#6ee7b7' : '#cffafe'}`,
                    outline: a2DragOver ? '2px dashed #10b981' : 'none',
                    outlineOffset: -2,
                    display: 'flex',
                    alignItems: 'center',
                    transition: 'background-color 0.15s, outline 0.15s',
                  }}
                >
                  {audioSections.map(s => {
                    const pos = brollSectionPos(s);
                    if (!pos) return null;
                    const vol = s.broll_volume ?? 1.0;
                    const pct = Math.round(vol * 100);
                    const isSelected = selectedSection?.id === s.id;
                    return (
                      <div
                        key={`a2-${s.id}`}
                        className="absolute top-0 bottom-0 flex items-center px-1.5 gap-1.5 overflow-hidden"
                        style={{
                          left: pos.left, width: pos.width,
                          backgroundColor: 'rgba(16,185,129,0.18)',
                          borderRadius: 3,
                          border: `1px solid ${isSelected ? '#047857' : '#10b981'}`,
                          boxShadow: isSelected ? '0 0 0 2px rgba(16,185,129,0.22)' : undefined,
                          cursor: 'pointer',
                          zIndex: 11,
                        }}
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => {
                          e.stopPropagation();
                          setSelectedSection(s);
                        }}
                      >
                        <Music size={9} strokeWidth={2} style={{ color: '#059669', flexShrink: 0 }} />
                        {/* Volume bar background */}
                        <div style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: 'rgba(16,185,129,0.15)', position: 'relative', minWidth: 0 }}>
                          <div style={{ height: '100%', borderRadius: 3, backgroundColor: vol > 0 ? '#10b981' : '#e5e7eb', width: `${pct}%`, transition: 'width 0.2s' }} />
                        </div>
                        {/* Volume pct label */}
                        <span style={{ fontSize: 8, fontWeight: 700, color: '#059669', flexShrink: 0, fontFamily: 'monospace' }}>{pct}%</span>
                      </div>
                    );
                  })}
                  {/* Playhead */}
                  <div
                    className="absolute top-0 bottom-0 pointer-events-none"
                    style={{ left: `${playheadSec * zoom}px`, width: 2, backgroundColor: '#ef4444', opacity: 0.5, zIndex: 20 }}
                  />
                </div>
              )}

              {/* ── V1 VIDEO TRACK ─────────────────────────────────────── */}
              <div
                style={{ height: VIDEO_TRACK_H, position: 'relative', backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb', cursor: 'crosshair' }}
                onMouseDown={handleTrackMouseDown}
                onClick={handleTrackClick}
              >
                <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'repeating-linear-gradient(90deg, rgba(0,0,0,0.04) 0px, rgba(0,0,0,0.04) 1px, transparent 1px, transparent 60px)' }} />

                {clipsWithOffset.map(c => {
                  const wPx = (c.video.duration_sec ?? 0) * zoom;
                  const lPx = c.offset * zoom;
                  return (
                    <div
                      key={c.video.id}
                      className="absolute top-0 bottom-0"
                      style={{ left: `${lPx}px`, width: `${wPx}px`, backgroundColor: activeVideoId === c.video.id ? '#e0f2fe' : '#f0f7ff' }}
                    >
                      <ClipFilmstrip videoUrl={videoUrls[c.video.id] ?? null} duration={c.video.duration_sec ?? 0} />
                    </div>
                  );
                })}

                {clipsWithOffset.slice(1).map((c, i) => (
                  <div
                    key={c.video.id}
                    className="absolute top-0 bottom-0 pointer-events-none"
                    style={{ left: `${c.offset * zoom}px`, width: 2, backgroundColor: '#6366f1', zIndex: 15 }}
                  >
                    <div style={{
                      position: 'absolute', top: 4, left: 3,
                      fontSize: 8, fontWeight: 700, color: '#6366f1',
                      backgroundColor: '#eef2ff', border: '1px solid #c7d2fe',
                      borderRadius: 3, padding: '0 3px', lineHeight: '14px',
                      whiteSpace: 'nowrap',
                    }}>
                      {i + 2}
                    </div>
                  </div>
                ))}

                {mainSections.map(s => {
                  const clip = clipsWithOffset.find(c => c.video.id === s.video_file_id);
                  if (!clip) return null;
                  const pos = sectionPos(s, clip);
                  if (!pos) return null;
                  return renderSectionEl(s, pos, clip.offset, false);
                })}

                {interaction?.kind === 'creating' && (() => {
                  const cs = Math.min(interaction.startSec, interaction.curSec);
                  const ce = Math.max(interaction.startSec, interaction.curSec);
                  const gs = interaction.clipOffset + cs;
                  const ge = interaction.clipOffset + ce;
                  return (
                    <div
                      className="absolute pointer-events-none"
                      style={{
                        top: 5, bottom: 5,
                        left: `${gs * zoom}px`,
                        width: `${(ge - gs) * zoom}px`,
                        backgroundColor: toolMode === 'simulation' ? 'rgba(245,158,11,0.25)' : 'rgba(59,130,246,0.25)',
                        border: `1.5px dashed ${toolMode === 'simulation' ? '#f59e0b' : '#3b82f6'}`,
                        borderRadius: 4,
                        zIndex: 11,
                      }}
                    />
                  );
                })()}

                {interaction?.kind === 'creating' && toolMode === 'video'
                  && (interaction.curSec - interaction.startSec) >= VISUAL_MAX_SEC - 0.5 && (
                  <div
                    className="absolute top-0 bottom-0 pointer-events-none"
                    style={{
                      left: `${(interaction.clipOffset + interaction.startSec + VISUAL_MAX_SEC) * zoom}px`,
                      width: 1, backgroundColor: '#ef4444', opacity: 0.7, zIndex: 12,
                    }}
                  />
                )}

                <div
                  className="absolute top-0 bottom-0 pointer-events-none"
                  style={{ left: `${playheadSec * zoom}px`, width: 2, backgroundColor: '#ef4444', boxShadow: '0 0 8px rgba(239,68,68,0.6), 0 0 2px rgba(239,68,68,0.9)', zIndex: 20 }}
                />
              </div>

              {/* ── A1 AUDIO TRACK ─────────────────────────────────────── */}
              <div style={{ height: AUDIO_TRACK_H, position: 'relative', backgroundColor: '#f0fdf4' }}>
                {clipsWithOffset.map(c => {
                  const wPx = (c.video.duration_sec ?? 0) * zoom;
                  const lPx = c.offset * zoom;
                  const peaks = parseWaveformPeaks(c.video.waveform_peaks);
                  return (
                    <div key={c.video.id} className="absolute top-0 bottom-0" style={{ left: `${lPx}px`, width: `${wPx}px` }}>
                      <Waveform peaks={peaks} />
                    </div>
                  );
                })}
                {clipsWithOffset.slice(1).map(c => (
                  <div
                    key={c.video.id}
                    className="absolute top-0 bottom-0 pointer-events-none"
                    style={{ left: `${c.offset * zoom}px`, width: 2, backgroundColor: '#6366f1', opacity: 0.4, zIndex: 5 }}
                  />
                ))}
                <div
                  className="absolute top-0 bottom-0 pointer-events-none"
                  style={{ left: `${playheadSec * zoom}px`, width: 2, backgroundColor: '#ef4444', opacity: 0.5, zIndex: 10 }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Append menu ──────────────────────────────────────────────────── */}
      {onAddVideo && (
        <div
          className="shrink-0 flex items-center justify-center relative"
          style={{ width: 43, borderLeft: '1px solid #e5e7eb', backgroundColor: '#fafafa' }}
        >
          <button
            onClick={() => setAddMenuOpen(v => !v)}
            title="Add to end"
            className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-gray-100 focus-ring"
            style={{ border: '1.5px dashed #d1d5db', color: '#9ca3af' }}
          >
            <Plus size={16} strokeWidth={2} aria-hidden />
          </button>

          {addMenuOpen && (
            <div
              className="absolute right-9 bottom-2 z-30 w-48 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl"
              onMouseDown={e => e.stopPropagation()}
              style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
            >
              <div style={{ padding: '9px 10px 6px', fontSize: 10, fontWeight: 800, color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Video
              </div>
              <button
                onClick={handleUploadNewClip}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-gray-700 hover:bg-gray-50 focus-ring"
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
                  <path d="M6.5 9V4M4 6.5l2.5-2.5L9 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <rect x="1.5" y="9.5" width="10" height="2" rx="1" stroke="currentColor" strokeWidth="1.2" />
                </svg>
                Upload new clip
              </button>
              <button
                onClick={() => handleAppendSection('clip')}
                disabled={!!addBusy || videos.length === 0}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
                  <rect x="1.5" y="3" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M5 5l3 1.5L5 8V5z" fill="currentColor" />
                </svg>
                Existing clip
              </button>
              <div style={{ height: 1, backgroundColor: '#f1f5f9' }} />
              <div style={{ padding: '8px 10px 5px', fontSize: 10, fontWeight: 800, color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Simulation
              </div>
              <button
                onClick={() => handleAppendSection('simulation')}
                disabled={!!addBusy || videos.length === 0}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
                  <circle cx="6.5" cy="6.5" r="4.6" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M6.5 4.2v2.4l1.8 1.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
                Show full simulation
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Section editor modal ─────────────────────────────────────────── */}
      {selectedSection && isAudioSection(selectedSection) ? (
        <AudioGainPopover
          section={selectedSection}
          projectId={projectId}
          onUpdate={updated => {
            onSectionsChange(sections.map(s => s.id === updated.id ? updated : s));
            setSelectedSection(updated);
          }}
          onDelete={id => {
            onSectionsChange(sections.filter(s => s.id !== id));
            setSelectedSection(null);
          }}
          onClose={() => setSelectedSection(null)}
        />
      ) : selectedSection ? (
        <SectionEditor
          section={selectedSection}
          projectId={projectId}
          simulations={simulations}
          videos={videos}
          videoUrls={videoUrls}
          images={images}
          onUpdate={updated => {
            onSectionsChange(sections.map(s => s.id === updated.id ? updated : s));
            setSelectedSection(updated);
          }}
          onDelete={id => {
            onSectionsChange(sections.filter(s => s.id !== id));
            setSelectedSection(null);
          }}
          onSimulationUpdate={onSimulationUpdate}
          onClose={() => setSelectedSection(null)}
        />
      ) : null}
    </div>
  );
}
