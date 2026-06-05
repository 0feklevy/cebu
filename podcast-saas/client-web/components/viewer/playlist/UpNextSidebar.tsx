'use client';

import { Play } from 'lucide-react';
import { PlaylistThumb, itemDuration, itemReady, fmtDuration, type PlaylistPlayItem } from './shared';

interface Props {
  title: string | null;
  description: string | null;
  items: PlaylistPlayItem[];
  order: number[];
  currentPos: number;
  watched: Set<number>;
  onJump: (displayPos: number) => void;
}

export function UpNextSidebar({ title, description, items, order, currentPos, watched, onJump }: Props) {
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-white/[0.07]" style={{ background: '#0c0c10' }}>
      {/* Header */}
      <div className="shrink-0 px-4 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[13px] font-semibold text-white/90">{title ?? 'Playlist'}</p>
          <span className="shrink-0 rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-bold text-white/45 tabular-nums">
            {currentPos + 1}/{order.length}
          </span>
        </div>
        {description && (
          <p className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-white/40">{description}</p>
        )}
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto fine-scrollbar py-1.5">
        {order.map((itemIdx, displayPos) => {
          const item = items[itemIdx];
          if (!item) return null;
          const active = displayPos === currentPos;
          const ready = itemReady(item);
          const dur = itemDuration(item);

          return (
            <button
              key={item.project_id + displayPos}
              onClick={() => ready && !active && onJump(displayPos)}
              disabled={!ready || active}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors"
              style={{
                background: active ? 'linear-gradient(90deg,rgba(99,102,241,0.18),rgba(99,102,241,0.06))' : 'transparent',
                borderLeft: active ? '2px solid rgba(129,140,248,0.7)' : '2px solid transparent',
                opacity: ready ? 1 : 0.45,
                cursor: active || !ready ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => { if (!active && ready) (e.currentTarget.style.background = 'rgba(255,255,255,0.05)'); }}
              onMouseLeave={(e) => { (e.currentTarget.style.background = active ? 'linear-gradient(90deg,rgba(99,102,241,0.18),rgba(99,102,241,0.06))' : 'transparent'); }}
            >
              <div className="relative shrink-0">
                <PlaylistThumb index={displayPos} title={item.title} thumbnailUrl={item.thumbnail_url} durationSec={dur} size="sm" active={active} />
                {active && (
                  <span className="absolute inset-0 flex items-center justify-center rounded-md bg-black/30">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500/90">
                      <Play size={10} fill="white" strokeWidth={0} />
                    </span>
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="line-clamp-2 text-[12px] font-medium leading-[1.35] text-white/80" style={{ color: active ? 'rgba(199,210,254,0.95)' : undefined }}>
                  {item.title ?? 'Untitled video'}
                </p>
                <p className="mt-1 text-[10px] font-medium" style={{ color: active ? 'rgba(129,140,248,0.8)' : 'rgba(255,255,255,0.35)' }}>
                  {active ? 'Now playing' : watched.has(itemIdx) ? '✓ Watched' : !ready ? 'Processing…' : fmtDuration(dur)}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
