'use client';

import { PlaylistThumb, itemDuration, itemReady, fmtDuration, type PlaylistPlayItem } from './shared';

interface Props {
  title: string | null;
  description: string | null;
  items: PlaylistPlayItem[];
  allowShuffle: boolean;
  watched: Set<number>;
  ended: boolean;             // true → end screen ("Replay all")
  onPlayAll: () => void;
  onShuffle: () => void;
  onPick: (itemIdx: number) => void;
}

export function PlaylistLobby({
  title, description, items, allowShuffle, watched, ended, onPlayAll, onShuffle, onPick,
}: Props) {
  const totalSec = items.reduce((s, it) => s + itemDuration(it), 0);
  const readyCount = items.filter(itemReady).length;

  return (
    <div className="h-full w-full overflow-y-auto fine-scrollbar" style={{ background: '#0b0b0d' }}>
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-5 py-8 sm:px-8 sm:py-12">
        {/* Header */}
        <div className="flex flex-col gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40">
            {ended ? 'Playlist finished' : 'Playlist'}
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            {title ?? 'Untitled playlist'}
          </h1>
          {description && <p className="max-w-2xl text-sm leading-relaxed text-white/55">{description}</p>}
          <p className="text-xs text-white/40">
            {items.length} video{items.length !== 1 ? 's' : ''} · {fmtDuration(totalSec)}
            {readyCount < items.length && ` · ${items.length - readyCount} processing`}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              onClick={onPlayAll}
              disabled={readyCount === 0}
              className="flex h-11 items-center gap-2 rounded-xl px-6 text-sm font-bold text-white shadow-lg transition-all hover:brightness-110 disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
              {ended ? 'Replay all' : 'Play all'}
            </button>
            {allowShuffle && (
              <button
                onClick={onShuffle}
                disabled={readyCount === 0}
                className="flex h-11 items-center gap-2 rounded-xl border px-5 text-sm font-semibold text-white/90 transition-colors hover:bg-white/5 disabled:opacity-40"
                style={{ borderColor: 'rgba(255,255,255,0.15)' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                </svg>
                Shuffle
              </button>
            )}
          </div>
        </div>

        {/* Grid of videos */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item, idx) => {
            const ready = itemReady(item);
            return (
              <button
                key={item.project_id}
                onClick={() => ready && onPick(idx)}
                disabled={!ready}
                className="group flex flex-col gap-2 rounded-xl p-2 text-left transition-colors hover:bg-white/[0.04]"
                style={{ cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.55 }}
              >
                <div className="relative">
                  <PlaylistThumb index={idx} title={item.title} durationSec={itemDuration(item)} />
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
                    </span>
                  </span>
                  {watched.has(idx) && (
                    <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-emerald-500/90 px-2 py-0.5 text-[10px] font-bold text-white">
                      ✓ Watched
                    </span>
                  )}
                </div>
                <div className="px-0.5">
                  <p className="text-sm font-semibold leading-snug text-white line-clamp-2">
                    {item.title ?? 'Untitled video'}
                  </p>
                  {!ready && <p className="mt-1 text-[11px] text-amber-400/80">Processing…</p>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
