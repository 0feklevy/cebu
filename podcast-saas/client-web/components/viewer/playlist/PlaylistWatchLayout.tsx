'use client';

import type { ReactNode } from 'react';
import { UpNextSidebar } from './UpNextSidebar';
import { fmtDuration, itemDuration, type PlaylistPlayItem } from './shared';

interface Props {
  playerArea: ReactNode;
  playlistTitle: string | null;
  playlistDescription: string | null;
  bannerUrl: string | null;
  items: PlaylistPlayItem[];
  order: number[];
  currentPos: number;
  watched: Set<number>;
  showSidebar: boolean;
  onJump: (displayPos: number) => void;
}

export function PlaylistWatchLayout({
  playerArea, playlistTitle, playlistDescription, items, order, currentPos, watched, showSidebar, onJump,
}: Props) {
  const current = items[order[currentPos]];
  const dur = current ? itemDuration(current) : 0;

  return (
    <div
      className="h-full w-full overflow-hidden"
      style={{ display: 'grid', gridTemplateColumns: showSidebar ? 'minmax(0,1fr) 360px' : '1fr', background: '#080809' }}
    >
      {/* Player column */}
      <div className="relative min-h-0 min-w-0 bg-black">
        {playerArea}

        {/* Slim info bar — bottom of video, above controls */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[44]"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.72) 0%, transparent 100%)', height: 88 }}
        >
          <div className="absolute bottom-[72px] left-4 right-4 flex items-end justify-between gap-3 sm:left-5 sm:right-5">
            <div className="min-w-0 flex-1">
              <p className="mb-0.5 truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
                {playlistTitle ?? 'Playlist'} · {currentPos + 1} / {order.length}
              </p>
              <h2 className="line-clamp-1 text-sm font-semibold text-white/95 sm:text-base">
                {current?.title ?? 'Untitled video'}
              </h2>
            </div>
            {dur > 0 && (
              <span className="shrink-0 rounded-full bg-black/40 px-2.5 py-1 text-[11px] font-bold text-white/60 backdrop-blur-sm tabular-nums">
                {fmtDuration(dur)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Sidebar — hidden on small screens */}
      {showSidebar && (
        <div className="hidden min-h-0 lg:block">
          <UpNextSidebar
            title={playlistTitle}
            description={playlistDescription}
            items={items}
            order={order}
            currentPos={currentPos}
            watched={watched}
            onJump={onJump}
          />
        </div>
      )}
    </div>
  );
}
