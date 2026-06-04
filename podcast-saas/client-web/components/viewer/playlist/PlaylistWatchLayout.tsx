'use client';

import type { ReactNode } from 'react';
import { UpNextSidebar } from './UpNextSidebar';
import { fmtDuration, itemDuration, type PlaylistPlayItem } from './shared';

interface Props {
  playerArea: ReactNode;       // the HLSPlayerShell (+ overlays) for the current item
  playlistTitle: string | null;
  items: PlaylistPlayItem[];
  order: number[];
  currentPos: number;
  watched: Set<number>;
  showSidebar: boolean;
  onJump: (displayPos: number) => void;
}

export function PlaylistWatchLayout({
  playerArea, playlistTitle, items, order, currentPos, watched, showSidebar, onJump,
}: Props) {
  const current = items[order[currentPos]];

  return (
    <div className="flex h-full w-full" style={{ background: '#0b0b0d' }}>
      {/* Left column: video + title/description */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Video area */}
        <div className="relative w-full bg-black" style={{ flex: '1 1 auto', minHeight: 0 }}>
          {playerArea}
        </div>

        {/* Title + description panel (YouTube watch-page style) */}
        <div className="shrink-0 overflow-y-auto fine-scrollbar px-5 py-4" style={{ maxHeight: '34%', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <h1 className="text-lg font-semibold text-white">{current?.title ?? 'Untitled video'}</h1>
          <p className="mt-1 text-xs text-white/45">
            Video {currentPos + 1} of {order.length}
            {current ? ` · ${fmtDuration(itemDuration(current))}` : ''}
          </p>
          {current?.description && (
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-white/65">
              {current.description}
            </p>
          )}
        </div>
      </div>

      {/* Right: Up next sidebar (hidden on narrow screens) */}
      {showSidebar && (
        <div className="hidden lg:flex">
          <UpNextSidebar
            title={playlistTitle}
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
