'use client';

// One avatar circle: the face image (always visible) ringed by an audio-reactive
// radial bar visualizer drawn on a canvas. Shared by the live viewer overlay
// (real audio) and the settings preview (synthetic "fake audio"). The animation
// source is provided per-frame via `getFrame`, so this component stays dumb and
// its effect never rebuilds on parent re-renders (config/source live in refs).

import { useEffect, useRef } from 'react';
import type { AvatarCirclesConfig } from './types';
import { computeBars, syntheticSpectrum } from '../../lib/avatarCirclesViz';

export interface CircleFrame { spectrum: Uint8Array | null; level: number; running: boolean }

interface Props {
  config: AvatarCirclesConfig;
  face: { imageUrl?: string; label?: string };
  size: number;   // face diameter (px)
  frame: number;  // canvas/container size (px) — must be > size to fit bars
  getFrame: () => CircleFrame;
}

export function AvatarCircleViz({ config, face, size, frame, getFrame }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cfgRef = useRef(config); cfgRef.current = config;
  const getFrameRef = useRef(getFrame); getFrameRef.current = getFrame;
  const barsRef = useRef<number[] | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(frame * dpr);
    canvas.height = Math.round(frame * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const idleBuf = new Uint8Array(512);
    let raf = 0;
    let phase = 0;

    // Cache the gradient stroke style — it only depends on frame + the color config,
    // never on the per-frame audio data, so recreating it every rAF tick is wasteful
    // (a GPU-backed CanvasGradient alloc at 60fps per circle). Rebuild only when one of
    // its inputs changes. (perf-004)
    let cachedStroke: string | CanvasGradient | null = null;
    let strokeKey = '';
    const resolveStroke = (cfg: AvatarCirclesConfig): string | CanvasGradient => {
      const key = cfg.colorMode === 'gradient'
        ? `g:${cfg.barColor ?? '#a855f7'}:${cfg.gradientEnd ?? '#6366f1'}:${frame}`
        : `s:${cfg.barColor ?? '#a855f7'}`;
      if (cachedStroke !== null && key === strokeKey) return cachedStroke;
      strokeKey = key;
      if (cfg.colorMode === 'gradient') {
        const g = ctx.createLinearGradient(0, 0, 0, frame);
        g.addColorStop(0, cfg.barColor ?? '#a855f7');
        g.addColorStop(1, cfg.gradientEnd ?? '#6366f1');
        cachedStroke = g;
      } else {
        cachedStroke = cfg.barColor ?? '#a855f7';
      }
      return cachedStroke;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { spectrum, level, running } = getFrameRef.current();
      const cfg = cfgRef.current;

      let data: Uint8Array | number[];
      let lvl = level;
      if (!running) {
        lvl = 0; data = idleBuf; // decay toward min height
      } else if (spectrum) {
        data = spectrum;
      } else {
        phase += 0.045;
        data = syntheticSpectrum(phase, 512, idleBuf); // gentle idle motion
      }

      barsRef.current = computeBars(data, cfg, barsRef.current, lvl);
      render(ctx, frame, size, cfg, barsRef.current, resolveStroke(cfg));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frame, size]);

  return (
    <>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: frame, height: frame }} />
      {config.showCenterCircle !== false && (
        <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: size, height: size, borderRadius: '50%', overflow: 'hidden', background: '#0f172a', border: '3px solid rgba(255,255,255,0.92)', boxShadow: '0 6px 18px rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {face.imageUrl
            ? <img src={face.imageUrl} alt={face.label ?? ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />
            : <span style={{ color: '#64748b', fontSize: Math.max(9, size * 0.12), fontWeight: 600 }}>{face.label || '—'}</span>}
        </div>
      )}
      {face.label && (
        <div style={{ position: 'absolute', bottom: 0, width: '100%', textAlign: 'center', color: '#fff', fontSize: 11, fontWeight: 600, textShadow: '0 1px 3px rgba(0,0,0,0.7)' }}>{face.label}</div>
      )}
    </>
  );
}

function render(ctx: CanvasRenderingContext2D, frame: number, size: number, cfg: AvatarCirclesConfig, bars: number[], strokeStyle: string | CanvasGradient) {
  ctx.clearRect(0, 0, frame, frame);
  const cx = frame / 2, cy = frame / 2;
  const innerR = size / 2 + 3;
  const maxReach = frame / 2 - innerR - 2;
  const maxH = Math.max(cfg.minHeight ?? 5, cfg.maxHeight ?? 180);
  const n = bars.length;
  const rot = ((cfg.rotationOffset ?? 180) * Math.PI) / 180;
  const barWidth = Math.max(1, Math.min(18, (cfg.barWidth ?? 12) * (size / 256)));

  // Stroke style is resolved/cached by the caller (identical for every bar; only
  // rebuilt when frame or the color config changes — see resolveStroke, perf-004).
  ctx.strokeStyle = strokeStyle;
  ctx.lineCap = cfg.roundedBars === false ? 'butt' : 'round';
  ctx.lineWidth = barWidth;

  for (let i = 0; i < n; i++) {
    const len = Math.max(1, (bars[i] / maxH) * maxReach);
    const a = rot + (i / n) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx + innerR * ca, cy + innerR * sa);
    ctx.lineTo(cx + (innerR + len) * ca, cy + (innerR + len) * sa);
    ctx.stroke();
  }
}
