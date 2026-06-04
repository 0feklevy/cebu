'use client';

import { PlaylistThumb, itemDuration, itemReady, type PlaylistPlayItem } from './shared';

interface Props {
  title: string | null;
  items: PlaylistPlayItem[];
  order: number[];            // display order → item index
  currentPos: number;         // index into `order`
  watched: Set<number>;       // item indices already watched
  onJump: (displayPos: number) => void;
}

export function UpNextSidebar({ title, items, order, currentPos, watched, onJump }: Props) {
  return (
    <aside
      className="flex h-full w-[340px] shrink-0 flex-col border-l"
      style={{ borderColor: 'rgba(255,255,255,0.08)', background: '#0f0f0f' }}
    >
      <div className="shrink-0 px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-sm font-semibold text-white truncate">{title ?? 'Playlist'}</p>
        <p className="text-xs text-white/45 mt-0.5">
          {currentPos + 1} / {order.length}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto fine-scrollbar py-1">
        {order.map((itemIdx, displayPos) => {
          const item = items[itemIdx];
          if (!item) return null;
          const active = displayPos === currentPos;
          const ready = itemReady(item);
          return (
            <button
              key={item.project_id + displayPos}
              onClick={() => ready && onJump(displayPos)}
              disabled={!ready}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors"
              style={{
                background: active ? 'rgba(255,255,255,0.09)' : 'transparent',
                cursor: ready ? 'pointer' : 'not-allowed',
                opacity: ready ? 1 : 0.5,
              }}
              onMouseEnter={(e) => { if (!active) (e.currentTarget.style.background = 'rgba(255,255,255,0.05)'); }}
              onMouseLeave={(e) => { if (!active) (e.currentTarget.style.background = 'transparent'); }}
            >
              <div className="relative">
                <PlaylistThumb index={displayPos} title={item.title} durationSec={itemDuration(item)} size="sm" active={active} />
                {active && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/55">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
                    </span>
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-[13px] font-medium leading-snug text-white line-clamp-2">
                  {item.title ?? 'Untitled video'}
                </p>
                <p className="mt-1 text-[11px] text-white/45">
                  {active ? 'Now playing' : watched.has(itemIdx) ? 'Watched' : !ready ? 'Processing…' : 'Up next'}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
