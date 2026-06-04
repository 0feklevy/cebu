'use client';

import type { PlayerConfig } from '../types';

export interface PlaylistPlayItem {
  project_id: string;
  title: string | null;
  description: string | null;
  config: PlayerConfig;
}

export interface PlaylistPlayConfig {
  id: string;
  title: string | null;
  description: string | null;
  autoplay: boolean;
  show_sidebar: boolean;
  allow_shuffle: boolean;
  items: PlaylistPlayItem[];
}

/** Total playable duration of an item (sum of its main segments). */
export function itemDuration(item: PlaylistPlayItem): number {
  return (item.config?.segments ?? []).reduce((s, seg) => s + (seg.duration_sec ?? 0), 0);
}

export function fmtDuration(totalSec: number): string {
  if (!totalSec || totalSec < 1) return '—';
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** An item is playable once at least one segment is ready (HLS or fallback). */
export function itemReady(item: PlaylistPlayItem): boolean {
  return (item.config?.segments ?? []).some((s) => s.hls_status === 'ready' || s.fallback_url);
}

const GRADIENTS = [
  'linear-gradient(135deg,#6366f1,#a855f7)',
  'linear-gradient(135deg,#0ea5e9,#22d3ee)',
  'linear-gradient(135deg,#f59e0b,#ef4444)',
  'linear-gradient(135deg,#10b981,#14b8a6)',
  'linear-gradient(135deg,#ec4899,#8b5cf6)',
  'linear-gradient(135deg,#3b82f6,#06b6d4)',
];

/** Deterministic placeholder thumbnail (gradient + index + title initials). */
export function PlaylistThumb({
  index,
  title,
  durationSec,
  size = 'md',
  active = false,
}: {
  index: number;
  title: string | null;
  durationSec: number;
  size?: 'sm' | 'md';
  active?: boolean;
}) {
  const grad = GRADIENTS[index % GRADIENTS.length];
  const initials = (title ?? 'Untitled')
    .split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
  const dims = size === 'sm' ? { width: 110, height: 62 } : { width: '100%', aspectRatio: '16 / 9' };

  return (
    <div
      style={{
        ...dims,
        position: 'relative',
        borderRadius: 8,
        background: grad,
        overflow: 'hidden',
        flexShrink: 0,
        boxShadow: active ? '0 0 0 2px rgba(255,255,255,0.85)' : 'none',
      }}
    >
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.18)' }} />
      <span style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size === 'sm' ? 18 : 28, fontWeight: 800, color: 'rgba(255,255,255,0.92)', letterSpacing: 1,
      }}>
        {initials || '▶'}
      </span>
      <span style={{
        position: 'absolute', top: 4, left: 5, fontSize: 10, fontWeight: 700,
        color: '#fff', background: 'rgba(0,0,0,0.5)', borderRadius: 4, padding: '1px 5px',
      }}>
        {index + 1}
      </span>
      <span style={{
        position: 'absolute', bottom: 4, right: 5, fontSize: 10, fontWeight: 700,
        color: '#fff', background: 'rgba(0,0,0,0.65)', borderRadius: 4, padding: '1px 5px', fontFamily: 'monospace',
      }}>
        {fmtDuration(durationSec)}
      </span>
    </div>
  );
}
