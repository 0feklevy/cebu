'use client';

import { CheckCircle2, Clock3, Play, Shuffle } from 'lucide-react';
import { PlaylistThumb, itemDuration, itemReady, fmtDuration, type PlaylistPlayItem } from './shared';

interface Props {
  title: string | null;
  description: string | null;
  bannerUrl: string | null;
  items: PlaylistPlayItem[];
  allowShuffle: boolean;
  watched: Set<number>;
  ended: boolean;
  onPlayAll: () => void;
  onShuffle: () => void;
  onPick: (itemIdx: number) => void;
}

export function PlaylistLobby({ title, description, bannerUrl, items, allowShuffle, watched, ended, onPlayAll, onShuffle, onPick }: Props) {
  const totalSec = items.reduce((s, it) => s + itemDuration(it), 0);
  const readyCount = items.filter(itemReady).length;
  const watchedCount = items.filter((_, idx) => watched.has(idx)).length;
  const heroImageUrl = bannerUrl ?? items.find((item) => item.thumbnail_url)?.thumbnail_url ?? null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#070709] text-white">
      {/* Background */}
      <div className="absolute inset-0" style={{
        background: 'radial-gradient(ellipse 70% 60% at 15% 20%, rgba(99,102,241,0.28) 0%, transparent 60%), radial-gradient(ellipse 50% 50% at 85% 15%, rgba(168,85,247,0.22) 0%, transparent 55%), linear-gradient(160deg,#0d0d12 0%,#10101a 50%,#0a0a0e 100%)',
      }} />
      {heroImageUrl ? (
        <>
          <img
            src={heroImageUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
          <div className="absolute inset-0 bg-black/55" />
          <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(0,0,0,0.92)_0%,rgba(0,0,0,0.3)_46%,rgba(0,0,0,0.28)_66%,rgba(0,0,0,0.76)_100%)]" />
        </>
      ) : null}

      {/* Content */}
      <div className="relative z-10 h-full overflow-y-auto fine-scrollbar">
        <div className="flex min-h-full w-full flex-col gap-6 px-5 py-8 sm:px-8 sm:py-10 lg:h-full lg:flex-row lg:items-stretch lg:justify-between lg:gap-10 lg:overflow-hidden lg:px-8 lg:py-10 xl:px-12 2xl:px-16">

          {/* Left — hero info */}
          <section className="flex flex-col justify-between lg:w-[min(40vw,560px)] lg:min-w-[340px] lg:py-4 xl:w-[min(36vw,600px)]">
            <div>
              {/* Eyebrow tag */}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/8 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-white/55 backdrop-blur-md">
                <span className="h-1 w-1 rounded-full bg-white/40" />
                {ended ? 'Finished' : 'Playlist'}
              </span>

              {/* Title */}
              <h1 className="mt-4 text-[clamp(28px,5vw,56px)] font-bold leading-[1.08] tracking-tight text-white">
                {title?.trim() || 'Untitled playlist'}
              </h1>

              {description && (
                <p className="mt-3 max-w-xl text-sm leading-6 text-white/60 sm:text-base sm:leading-7">
                  {description}
                </p>
              )}

              {/* Stats row */}
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/8 px-3 py-1.5 text-xs text-white/65 backdrop-blur-md">
                  <Play size={11} fill="currentColor" strokeWidth={0} />
                  {items.length} video{items.length !== 1 ? 's' : ''}
                </span>
                {totalSec > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/8 px-3 py-1.5 text-xs text-white/65 backdrop-blur-md">
                    <Clock3 size={11} strokeWidth={2} />
                    {fmtDuration(totalSec)}
                  </span>
                )}
                {watchedCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/12 px-3 py-1.5 text-xs font-medium text-emerald-300 backdrop-blur-md">
                    <CheckCircle2 size={11} strokeWidth={2.2} />
                    {watchedCount} watched
                  </span>
                )}
              </div>
            </div>

            {/* CTA buttons */}
            <div className="mt-8 flex flex-wrap items-center gap-3 lg:mt-0">
              <button
                onClick={onPlayAll}
                disabled={readyCount === 0}
                className="group relative inline-flex h-12 items-center gap-2.5 overflow-hidden rounded-xl px-7 text-sm font-bold text-white shadow-xl shadow-indigo-950/40 transition-all hover:scale-[1.02] hover:shadow-indigo-900/50 active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg,#7c3aed,#2563eb)' }}
              >
                <div className="absolute inset-0 bg-white/0 transition-colors group-hover:bg-white/10" />
                <Play size={16} fill="currentColor" strokeWidth={0} />
                {ended ? 'Replay all' : 'Play all'}
              </button>
              {allowShuffle && (
                <button
                  onClick={onShuffle}
                  disabled={readyCount === 0}
                  className="inline-flex h-12 items-center gap-2.5 rounded-xl border border-white/15 bg-white/8 px-6 text-sm font-semibold text-white backdrop-blur-md transition-all hover:bg-white/15 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Shuffle size={15} strokeWidth={2} />
                  Shuffle
                </button>
              )}
            </div>
          </section>

          {/* Right — video list */}
          <aside className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-black/30 shadow-2xl shadow-black/35 backdrop-blur-xl lg:ml-auto lg:w-[360px] xl:w-[380px] 2xl:w-[400px]">
            <div className="flex shrink-0 items-center justify-between border-b border-white/8 px-4 py-3.5">
              <p className="text-sm font-semibold text-white/90">Videos</p>
              <span className="rounded-full bg-white/8 px-2.5 py-0.5 text-xs font-bold text-white/50">{items.length}</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto fine-scrollbar p-2">
              {items.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                  <p className="text-sm text-white/35">No videos in this playlist</p>
                </div>
              ) : items.map((item, idx) => {
                const ready = itemReady(item);
                const dur = itemDuration(item);
                const isWatched = watched.has(idx);

                return (
                  <button
                    key={item.project_id}
                    onClick={() => ready && onPick(idx)}
                    disabled={!ready}
                    className="group grid w-full grid-cols-[108px_minmax(0,1fr)] gap-3 rounded-lg p-2 text-left transition-colors hover:bg-white/[0.08] disabled:cursor-default"
                    style={{ opacity: ready ? 1 : 0.45 }}
                  >
                    <div className="relative">
                      <PlaylistThumb index={idx} title={item.title} thumbnailUrl={item.thumbnail_url} durationSec={dur} size="sm" />
                      {/* Play hover overlay */}
                      <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 disabled:group-hover:opacity-0">
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm">
                          <Play size={14} fill="white" strokeWidth={0} />
                        </span>
                      </span>
                      {isWatched && (
                        <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/90">
                          <CheckCircle2 size={10} strokeWidth={2.5} />
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 py-0.5">
                      <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-white/90 group-hover:text-white">
                        {item.title ?? 'Untitled video'}
                      </p>
                      <p className="mt-1 text-[11px] text-white/45">
                        {!ready ? 'Processing…' : isWatched ? '✓ Watched' : fmtDuration(dur)}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
