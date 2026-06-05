'use client';

import { ListVideo, Play, X } from 'lucide-react';
import { PlaylistThumb, itemDuration, fmtDuration, type PlaylistPlayItem } from './shared';

interface Props {
  nextItem: PlaylistPlayItem;
  nextDisplayPos: number;
  countdown: number | null;
  onPlayNext: () => void;
  onCancel: () => void;
  onShowAll: () => void;
}

export function UpNextCard({ nextItem, nextDisplayPos, countdown, onPlayNext, onCancel, onShowAll }: Props) {
  const dur = itemDuration(nextItem);

  return (
    <div className="absolute bottom-[80px] left-3 right-3 z-[80] sm:bottom-[96px] sm:left-auto sm:right-5 sm:w-[340px]">
      <div
        className="overflow-hidden rounded-xl shadow-2xl shadow-black/50"
        style={{
          background: 'rgba(12,12,16,0.96)',
          backdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.12)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3.5 pt-3.5 pb-2">
          <div className="flex items-center gap-2">
            {countdown != null && (
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                style={{ background: 'linear-gradient(135deg,#7c3aed,#2563eb)' }}
              >
                {countdown}
              </span>
            )}
            <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-white/45">
              {countdown != null ? 'Up next' : 'Up next'}
            </span>
          </div>
          <button
            onClick={onCancel}
            className="rounded-md p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white"
            title={countdown != null ? 'Cancel autoplay' : 'Dismiss'}
          >
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>

        {/* Video preview */}
        <button onClick={onPlayNext} className="group flex w-full items-start gap-3 px-3.5 pb-3 text-left hover:bg-white/[0.03] transition-colors">
          <div className="relative shrink-0">
            <PlaylistThumb index={nextDisplayPos} title={nextItem.title} thumbnailUrl={nextItem.thumbnail_url} durationSec={dur} size="sm" />
            <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm">
                <Play size={14} fill="white" strokeWidth={0} />
              </span>
            </span>
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-white/90 group-hover:text-white">
              {nextItem.title ?? 'Untitled video'}
            </p>
            <p className="mt-1 text-[11px] text-white/40">{fmtDuration(dur)}</p>
          </div>
        </button>

        {/* Progress bar (countdown visual) */}
        {countdown != null && (
          <div className="mx-3.5 mb-3 h-0.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${(countdown / 6) * 100}%`,
                background: 'linear-gradient(90deg,#7c3aed,#2563eb)',
                transition: countdown < 6 ? 'width 1s linear' : 'none',
              }}
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 px-3.5 pb-3.5">
          <button
            onClick={onPlayNext}
            className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold text-white shadow-lg transition-all hover:brightness-110"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#2563eb)' }}
          >
            <Play size={12} fill="currentColor" strokeWidth={0} aria-hidden />
            Play now
          </button>
          <button
            onClick={onShowAll}
            className="flex h-9 items-center justify-center gap-1 rounded-lg border border-white/12 px-3 text-xs font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ListVideo size={13} strokeWidth={1.8} aria-hidden />
            All
          </button>
        </div>
      </div>
    </div>
  );
}
