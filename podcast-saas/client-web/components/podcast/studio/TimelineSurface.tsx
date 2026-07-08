'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MixTimeline, MixPlacement, PodcastStudioClip } from 'shared';
import type { PodcastTurn } from 'shared/src/types/podcast';
import { moveBlock, trimBlock, snapStart, type Interaction } from './interactions';

const TEACHER = '#8b5cf6';
const LEARNER = '#2563eb';
const MIX = '#0f766e';
const LABEL_W = 112;
const RULER_H = 24;
const TRACK_H = 72;
const MIX_H = 52;
const TRIM_ZONE_PX = 8;
const MIN_ZOOM = 4;    // px per second
const MAX_ZOOM = 400;

interface Props {
  timeline: MixTimeline;
  placements: MixPlacement[];
  totalMs: number;
  clipsById: Map<string, PodcastStudioClip>;
  turnsById: Map<string, PodcastTurn>;
  staleTurnIds: Set<string>;
  mixPeaks: number[];
  durMap: Map<string, number>;
  playheadMs: number;
  playing: boolean;
  selectedIndex: number | null;
  razor: boolean;
  sticky: boolean;
  laneOf: (turnId: string) => string;
  onSelect: (i: number | null) => void;
  onSeek: (ms: number) => void;
  onApply: (tl: MixTimeline, snapshot?: boolean) => void;
  onSplitAt: (index: number, sourceMs: number) => void;
  onOpenPopover: (index: number) => void;
}

/** SVG waveform from float[0..1] peaks, optionally windowed to [in,out] of the source. */
function Wave({ peaks, color, width, height, inFrac = 0, outFrac = 1, gainDb = 0 }: { peaks: number[]; color: string; width: number; height: number; inFrac?: number; outFrac?: number; gainDb?: number }) {
  if (width < 2) return null;
  const gain = Math.pow(10, gainDb / 20);
  const n = Math.max(1, Math.min(Math.floor(width / 2), 400));
  const from = Math.floor(inFrac * peaks.length);
  const to = Math.max(from + 1, Math.floor(outFrac * peaks.length));
  const slice = peaks.slice(from, to);
  const bars = [];
  for (let i = 0; i < n; i++) {
    const p = slice.length ? slice[Math.floor((i / n) * slice.length)] ?? 0 : 0;
    const h = Math.max(1, Math.min(height - 2, p * gain * (height - 4)));
    const x = (i / n) * width;
    bars.push(<line key={i} x1={x} y1={(height - h) / 2} x2={x} y2={(height + h) / 2} stroke={color} strokeWidth={1} strokeLinecap="round" opacity={0.85} />);
  }
  return <svg width={width} height={height} className="pointer-events-none absolute inset-0">{bars}</svg>;
}

export function TimelineSurface(props: Props) {
  const { timeline, placements, totalMs, clipsById, turnsById, staleTurnIds, mixPeaks, durMap, playheadMs, playing, selectedIndex, razor, sticky, laneOf } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(60);
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  const interRef = useRef<Interaction | null>(null);
  const [, force] = useState(0);
  const movedRef = useRef(false);
  const [splitPreview, setSplitPreview] = useState<{ index: number; x: number } | null>(null);

  const totalSec = Math.max(1, totalMs / 1000);
  const contentW = Math.max(LABEL_W + zoom * totalSec + 280, 900);

  const followPlayhead = useCallback((forceCenter = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const playheadX = LABEL_W + (playheadMs / 1000) * zoomRef.current;
    const leftSafe = el.scrollLeft + el.clientWidth * 0.22;
    const rightSafe = el.scrollLeft + el.clientWidth * 0.72;
    if (!forceCenter && playheadX >= leftSafe && playheadX <= rightSafe) return;
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    const target = playheadX - el.clientWidth * 0.42;
    el.scrollLeft = Math.max(0, Math.min(maxScroll, target));
  }, [playheadMs]);

  // Fit to view on first layout.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && el.clientWidth > 0) setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (el.clientWidth - 40) / totalSec)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pxToMs = useCallback((clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, ((clientX - rect.left + el.scrollLeft - LABEL_W) / zoomRef.current) * 1000);
  }, []);

  // Ctrl/⌘+wheel = zoom preserving the second under the cursor; plain wheel = pan.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sec = (e.clientX - rect.left + el.scrollLeft - LABEL_W) / zoomRef.current;
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current * (e.deltaY < 0 ? 1.15 : 0.87)));
      setZoom(nextZoom);
      requestAnimationFrame(() => { el.scrollLeft = LABEL_W + sec * nextZoom - (e.clientX - rect.left); });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const raf = requestAnimationFrame(() => {
      if (!interRef.current) followPlayhead(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [playing, playheadMs, zoom, followPlayhead]);

  // Global drag handlers.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const it = interRef.current;
      if (!it) return;
      movedRef.current = true;
      const ms = pxToMs(e.clientX);
      if (it.kind === 'scrub') { props.onSeek(ms); return; }
      if (it.kind === 'move') {
        const desired = ms - it.grabDx;
        const snapped = snapStart(desired, { placements, timeline: it.base, laneOf, index: it.index, pxPerSec: zoomRef.current, playheadMs });
        props.onApply(moveBlock(it.base, it.index, snapped, durMap, sticky, laneOf), false);
      } else if (it.kind === 'trim') {
        const p = placements[it.index];
        const deltaMs = it.edge === 'in' ? ms - p.startMs : ms - (p.startMs + (p.outMs - p.inMs));
        props.onApply(trimBlock(it.base, it.index, it.edge, deltaMs, durMap, sticky, laneOf), false);
      }
    };
    const onUp = () => {
      const it = interRef.current;
      if (it && (it.kind === 'move' || it.kind === 'trim') && movedRef.current) {
        // Commit a single undo checkpoint for the whole gesture.
        props.onApply(timeline, true);
      }
      interRef.current = null;
      force((n) => n + 1);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [timeline, placements, durMap, playheadMs, pxToMs, props, sticky, laneOf]);

  const startBlockDrag = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    const p = placements[index];
    const widthPx = ((p.outMs - p.inMs) / 1000) * zoom;
    const rel = e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left;
    movedRef.current = false;
    if (razor) {
      const srcMs = p.inMs + (rel / widthPx) * (p.outMs - p.inMs);
      props.onSplitAt(index, srcMs);
      setSplitPreview(null);
      return;
    }
    props.onSelect(index);
    if (rel <= TRIM_ZONE_PX) interRef.current = { kind: 'trim', index, edge: 'in', base: timeline };
    else if (rel >= widthPx - TRIM_ZONE_PX) interRef.current = { kind: 'trim', index, edge: 'out', base: timeline };
    else interRef.current = { kind: 'move', index, grabDx: (rel / zoom) * 1000, base: timeline };
    force((n) => n + 1);
  };

  const laneTop = (speaker: string) => {
    const base = RULER_H + MIX_H;
    return speaker === 'learner' ? base : base + TRACK_H;
  };

  const ticks = [];
  const stepSec = zoom > 120 ? 1 : zoom > 40 ? 5 : zoom > 12 ? 15 : 30;
  for (let s = 0; s <= totalSec + stepSec; s += stepSec) {
    ticks.push(
      <div key={s} className="absolute top-0 flex h-full flex-col" style={{ left: s * zoom }}>
        <div className="w-px bg-border" style={{ height: RULER_H }} />
        <span className="absolute left-1 top-0.5 text-[9px] tabular-nums text-muted-foreground">{fmt(s)}</span>
      </div>,
    );
  }

  return (
    <div ref={scrollRef} className="fine-scrollbar relative overflow-x-auto overflow-y-hidden rounded-xl border border-border bg-card shadow-sm" style={{ height: RULER_H + MIX_H + TRACK_H * 2 }}>
      <div className="relative" style={{ width: contentW, height: RULER_H + MIX_H + TRACK_H * 2 }}
        onMouseDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.lane) { movedRef.current = false; interRef.current = { kind: 'scrub' }; props.onSeek(pxToMs(e.clientX)); props.onSelect(null); force((n) => n + 1); } }}>
        {/* Ruler */}
        <div className="absolute left-0 top-0 z-10 flex items-center border-r border-border bg-card px-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" style={{ width: LABEL_W, height: RULER_H }}>
          Time
        </div>
        <div className="absolute top-0" style={{ left: LABEL_W, right: 0, height: RULER_H }}>{ticks}</div>

        {/* Lane backgrounds + labels */}
        <TrackLabel top={RULER_H} height={MIX_H} label="Mix" sublabel="Master" color={MIX} />
        <TrackLabel top={RULER_H + MIX_H} height={TRACK_H} label="Learner" sublabel="Voice B" color={LEARNER} />
        <TrackLabel top={RULER_H + MIX_H + TRACK_H} height={TRACK_H} label="Teacher" sublabel="Voice A" color={TEACHER} />
        <div data-lane="mix" className="absolute" style={{ left: LABEL_W, right: 0, top: RULER_H, height: MIX_H, background: 'hsl(var(--muted)/0.32)' }} />
        <div data-lane="learner" className="absolute" style={{ left: LABEL_W, right: 0, top: RULER_H + MIX_H, height: TRACK_H, borderTop: '1px solid hsl(var(--border))', background: 'linear-gradient(90deg, rgba(37,99,235,0.08), transparent 38%)' }} />
        <div data-lane="teacher" className="absolute" style={{ left: LABEL_W, right: 0, top: RULER_H + MIX_H + TRACK_H, height: TRACK_H, borderTop: '1px solid hsl(var(--border))', background: 'linear-gradient(90deg, rgba(139,92,246,0.08), transparent 38%)' }} />

        {/* Mix waveform */}
        <div className="pointer-events-none absolute" style={{ top: RULER_H + 4, left: LABEL_W, width: totalSec * zoom, height: MIX_H - 8 }}>
          <Wave peaks={mixPeaks} color={MIX} width={Math.max(2, totalSec * zoom)} height={MIX_H - 6} />
        </div>

        {/* Clip blocks */}
        {placements.map((p, i) => {
          const clip = clipsById.get(p.clipId);
          const turn = turnsById.get(p.turnId);
          const color = turn?.speaker === 'teacher' ? TEACHER : LEARNER;
          const src = durMap.get(p.clipId) || 1;
          const left = LABEL_W + (p.startMs / 1000) * zoom;
          const width = Math.max(3, ((p.outMs - p.inMs) / 1000) * zoom);
          const top = laneTop(turn?.speaker ?? 'learner') + 4;
          const height = TRACK_H - 8;
          const stale = staleTurnIds.has(p.turnId);
          const selected = selectedIndex === i;
          return (
            <div
              key={`${p.clipId}:${p.partIndex}:${i}`}
              onMouseDown={(e) => startBlockDrag(e, i)}
              onMouseEnter={() => { if (!interRef.current && !razor) props.onOpenPopover(i); }}
              onMouseMove={(e) => {
                if (!razor) return;
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setSplitPreview({ index: i, x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)) });
              }}
              onMouseLeave={() => setSplitPreview((prev) => (prev?.index === i ? null : prev))}
              title={turn ? stripTags(turn.text) : ''}
              className={`group absolute overflow-hidden rounded-md ${razor ? 'cursor-col-resize' : 'cursor-grab'}`}
              style={{
                left, width, top, height,
                zIndex: selected ? 12 : 4,
                background: `${color}${p.muted ? '18' : '24'}`,
                border: `1px solid ${selected ? color : `${color}7a`}`,
                boxShadow: selected ? `0 0 0 2px ${color}33, 0 8px 18px rgba(15, 23, 42, 0.12)` : '0 3px 10px rgba(15, 23, 42, 0.06)',
                opacity: p.muted ? 0.45 : 1,
              }}
            >
              <Wave peaks={clip?.peaks ?? []} color={color} width={width} height={height} inFrac={p.inMs / src} outFrac={p.outMs / src} gainDb={p.gainDb} />
              <span className="pointer-events-none absolute left-2 top-1 max-w-full truncate pr-2 text-[10px] font-semibold" style={{ color }}>
                {turn ? stripTags(turn.text).slice(0, 60) : ''}
              </span>
              {stale && <span className="pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" title="Script changed — re-voice" />}
              {razor && splitPreview?.index === i && (
                <span
                  className="pointer-events-none absolute top-0 z-20 h-full w-px bg-rose-500 shadow-[0_0_0_1px_rgba(255,255,255,0.8),0_0_10px_rgba(244,63,94,0.65)]"
                  style={{ left: splitPreview.x }}
                >
                  <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 rounded-[1px] bg-rose-500" />
                  <span className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 rounded-[1px] bg-rose-500" />
                </span>
              )}
              {/* trim handles */}
              {!razor && selected && (
                <>
                  <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" style={{ background: `${color}55` }} />
                  <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" style={{ background: `${color}55` }} />
                </>
              )}
            </div>
          );
        })}

        {/* Playhead */}
        <div className="pointer-events-none absolute top-0 z-20 w-px" style={{ left: LABEL_W + (playheadMs / 1000) * zoom, height: RULER_H + MIX_H + TRACK_H * 2, background: '#ef4444', boxShadow: '0 0 4px #ef4444' }} />
      </div>
    </div>
  );
}

function TrackLabel({ top, height, label, sublabel, color }: { top: number; height: number; label: string; sublabel: string; color: string }) {
  return (
    <div className="absolute left-0 z-10 flex items-center gap-2 border-r border-t border-border bg-card px-3" style={{ top, width: LABEL_W, height }}>
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-foreground">{label}</span>
        <span className="block text-[10px] text-muted-foreground">{sublabel}</span>
      </span>
    </div>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function stripTags(t: string): string { return t.replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim(); }
