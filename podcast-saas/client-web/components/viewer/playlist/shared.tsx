'use client';

import type { PlayerConfig } from '../types';

export interface PlaylistPlayItem {
  project_id: string;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  config: PlayerConfig;
}

export interface PlaylistPlayConfig {
  id: string;
  title: string | null;
  description: string | null;
  autoplay: boolean;
  show_sidebar: boolean;
  allow_shuffle: boolean;
  banner_url: string | null;
  banner_prompt: string | null;
  banner_provider: string | null;
  items: PlaylistPlayItem[];
}

export function itemDuration(item: PlaylistPlayItem): number {
  return (item.config?.segments ?? []).reduce((s, seg) => s + (seg.duration_sec ?? 0), 0);
}

export function fmtDuration(totalSec: number): string {
  if (!totalSec || totalSec < 1) return '—';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function itemReady(item: PlaylistPlayItem): boolean {
  return (item.config?.segments ?? []).some((s) => s.hls_status === 'ready' || s.fallback_url);
}

const PALETTES = [
  { from: '#6366f1', to: '#8b5cf6' },
  { from: '#0ea5e9', to: '#2563eb' },
  { from: '#f59e0b', to: '#ef4444' },
  { from: '#10b981', to: '#059669' },
  { from: '#ec4899', to: '#8b5cf6' },
  { from: '#06b6d4', to: '#3b82f6' },
  { from: '#a855f7', to: '#6366f1' },
  { from: '#f97316', to: '#ef4444' },
];

export function PlaylistThumb({
  index,
  title,
  thumbnailUrl,
  durationSec,
  size = 'md',
  active = false,
}: {
  index: number;
  title: string | null;
  thumbnailUrl?: string | null;
  durationSec: number;
  size?: 'sm' | 'md';
  active?: boolean;
}) {
  const p = PALETTES[index % PALETTES.length];
  const isSmall = size === 'sm';
  const w = isSmall ? 108 : '100%';
  const h = isSmall ? 62 : undefined;
  const aspect = isSmall ? undefined : '16 / 9';

  const label = (title ?? '').trim();
  const initials = label
    ? label.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('').slice(0, 2) || label[0]?.toUpperCase() || '▶'
    : '▶';

  return (
    <div
      style={{
        position: 'relative',
        width: w,
        height: h,
        aspectRatio: aspect,
        flexShrink: 0,
        borderRadius: isSmall ? 6 : 8,
        overflow: 'hidden',
        background: thumbnailUrl ? '#000' : `linear-gradient(135deg, ${p.from}, ${p.to})`,
        boxShadow: active ? `0 0 0 2px white, 0 0 0 4px ${p.from}66` : 'none',
      }}
    >
      {thumbnailUrl ? (
        /* Real thumbnail from the video */
        <img
          src={thumbnailUrl}
          alt={title ?? ''}
          draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        /* Gradient fallback when thumbnail not yet generated */
        <>
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'40\' height=\'40\' viewBox=\'0 0 40 40\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23ffffff\' fill-opacity=\'0.03\'%3E%3Cpath d=\'M0 40L40 0H20L0 20M40 40V20L20 40\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")',
            backgroundSize: '20px 20px',
          }} />
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.15)' }} />
          <span style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: isSmall ? 16 : 26, fontWeight: 800, color: 'rgba(255,255,255,0.88)',
            letterSpacing: 1, fontFamily: 'system-ui,-apple-system,sans-serif',
            textShadow: '0 1px 4px rgba(0,0,0,0.3)',
          }}>
            {initials}
          </span>
        </>
      )}

      {/* Scrim so overlays read against both thumbnail and gradient */}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.08)' }} />

      {/* Episode number — top-left */}
      <span style={{
        position: 'absolute', top: 5, left: 5,
        fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
        color: 'rgba(255,255,255,0.9)',
        background: 'rgba(0,0,0,0.52)',
        borderRadius: 4, padding: '1px 6px',
        backdropFilter: 'blur(4px)',
      }}>
        {index + 1}
      </span>

      {/* Duration — bottom-right */}
      {durationSec > 0 && (
        <span style={{
          position: 'absolute', bottom: 5, right: 5,
          fontSize: 9, fontWeight: 700,
          color: 'rgba(255,255,255,0.95)',
          background: 'rgba(0,0,0,0.62)',
          borderRadius: 4, padding: '1px 5px',
          fontFamily: 'ui-monospace,SFMono-Regular,monospace',
          backdropFilter: 'blur(4px)',
        }}>
          {fmtDuration(durationSec)}
        </span>
      )}
    </div>
  );
}
