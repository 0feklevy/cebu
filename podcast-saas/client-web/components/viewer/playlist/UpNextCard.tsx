'use client';

import { PlaylistThumb, itemDuration, type PlaylistPlayItem } from './shared';

interface Props {
  nextItem: PlaylistPlayItem;
  nextDisplayPos: number;
  countdown: number | null;   // null = no auto-advance countdown (manual)
  onPlayNext: () => void;
  onCancel: () => void;
  onShowAll: () => void;
}

export function UpNextCard({ nextItem, nextDisplayPos, countdown, onPlayNext, onCancel, onShowAll }: Props) {
  return (
    <div className="absolute bottom-6 right-6 z-40" style={{ width: 320 }}>
      <div
        className="overflow-hidden rounded-xl shadow-2xl"
        style={{ background: 'rgba(20,20,22,0.94)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.1)' }}
      >
        <div className="flex items-center justify-between px-3 pt-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/50">
            {countdown != null ? `Up next in ${countdown}s` : 'Up next'}
          </span>
          <button onClick={onCancel} className="text-white/45 hover:text-white" title="Cancel">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>

        <button onClick={onPlayNext} className="flex w-full items-start gap-3 px-3 py-2.5 text-left">
          <PlaylistThumb index={nextDisplayPos} title={nextItem.title} durationSec={itemDuration(nextItem)} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-snug text-white line-clamp-2">
              {nextItem.title ?? 'Untitled video'}
            </p>
            {nextItem.description && (
              <p className="mt-1 text-[11px] text-white/45 line-clamp-2">{nextItem.description}</p>
            )}
          </div>
        </button>

        <div className="flex items-center gap-2 px-3 pb-3">
          <button
            onClick={onPlayNext}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold text-white"
            style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
            Play now
          </button>
          <button
            onClick={onShowAll}
            className="flex h-8 items-center justify-center rounded-lg border px-3 text-xs font-semibold text-white/85"
            style={{ borderColor: 'rgba(255,255,255,0.15)' }}
          >
            Show all
          </button>
        </div>
      </div>
    </div>
  );
}
