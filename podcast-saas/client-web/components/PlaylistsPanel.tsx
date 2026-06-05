'use client';

import { useCallback, useEffect, useState } from 'react';
import { ListVideo, Play, Plus, Clock3 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/firebase';
import type { PlaylistSummary } from 'shared/src/generated/client-v1';
import { PlaylistEditorDialog } from './PlaylistEditorDialog';

const CARD_GRADIENTS = [
  'linear-gradient(135deg,#6366f1 0%,#a855f7 100%)',
  'linear-gradient(135deg,#0ea5e9 0%,#2563eb 100%)',
  'linear-gradient(135deg,#f97316 0%,#ef4444 100%)',
  'linear-gradient(135deg,#10b981 0%,#059669 100%)',
  'linear-gradient(135deg,#ec4899 0%,#8b5cf6 100%)',
  'linear-gradient(135deg,#06b6d4 0%,#3b82f6 100%)',
];

export function PlaylistsPanel() {
  const { loading: authLoading } = useAuth();
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.listPlaylists()
      .then(setPlaylists)
      .catch(() => setPlaylists([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!authLoading) load();
  }, [authLoading, load]);

  const handleNew = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const pl = await api.createPlaylist({ title: 'Untitled playlist' });
      load();
      setEditingId(pl.id);
    } catch { /* ignore */ } finally {
      setCreating(false);
    }
  }, [creating, load]);

  return (
    <section className="flex min-h-0 w-full flex-col rounded-lg border border-border bg-card shadow-sm-soft">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ListVideo size={16} strokeWidth={1.9} aria-hidden />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-foreground">Playlists</h2>
            <p className="text-xs text-muted-foreground">Group videos into one watch flow</p>
          </div>
        </div>
        <button
          onClick={handleNew}
          disabled={creating}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white shadow-sm transition-all hover:brightness-110 disabled:opacity-50 focus-ring"
          style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
        >
          {creating ? (
            <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="31.4" strokeDashoffset="10" /></svg>
          ) : (
            <Plus size={13} strokeWidth={2.2} aria-hidden />
          )}
          New
        </button>
      </div>

      {/* Cards row */}
      <div className="min-h-0 overflow-x-auto pb-4 pl-4 pr-2 fine-scrollbar sm:pl-5">
        <div className="flex gap-3" style={{ minWidth: 'max-content' }}>
          {loading ? (
            [1, 2, 3].map((i) => (
              <div key={i} className="h-[140px] w-[220px] animate-pulse rounded-xl bg-muted" />
            ))
          ) : playlists.length === 0 ? (
            <button
              onClick={handleNew}
              className="flex h-[140px] w-[220px] shrink-0 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/20 text-center transition-colors hover:border-primary/40 hover:bg-primary/5 focus-ring"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Plus size={18} strokeWidth={2} aria-hidden />
              </span>
              <span className="text-sm font-semibold text-foreground">Create playlist</span>
              <span className="max-w-[160px] text-[11px] leading-4 text-muted-foreground">
                Group videos into an autoplay series
              </span>
            </button>
          ) : (
            playlists.map((pl, idx) => {
              const grad = CARD_GRADIENTS[idx % CARD_GRADIENTS.length];
              return (
                <button
                  key={pl.id}
                  onClick={() => setEditingId(pl.id)}
                  className="group relative flex h-[140px] w-[220px] shrink-0 flex-col overflow-hidden rounded-xl text-left transition-all hover:-translate-y-0.5 hover:shadow-lg focus-ring"
                >
                  {/* Background */}
                  {pl.banner_url ? (
                    <>
                      <img src={pl.banner_url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
                      <div className="absolute inset-0 bg-black/55" />
                    </>
                  ) : (
                    <div className="absolute inset-0" style={{ background: grad }} />
                  )}
                  {/* Grain */}
                  <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'100\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\' opacity=\'1\'/%3E%3C/svg%3E")', backgroundSize: '60px 60px' }} />

                  {/* Play icon top-right */}
                  <div className="relative flex items-start justify-between p-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 backdrop-blur-md">
                      <Play size={14} fill="white" strokeWidth={0} />
                    </span>
                    {pl.share_token && (
                      <span className="rounded-full bg-emerald-400/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-200">
                        Live
                      </span>
                    )}
                  </div>

                  {/* Bottom info */}
                  <div className="relative mt-auto p-3 pt-0">
                    <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/60 to-transparent rounded-b-xl" />
                    <div className="relative">
                      <p className="line-clamp-2 text-[13px] font-bold leading-snug text-white">
                        {pl.title?.trim() || 'Untitled playlist'}
                      </p>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-white/55">
                        <span className="flex items-center gap-1">
                          <Play size={9} fill="currentColor" strokeWidth={0} />
                          {pl.item_count} video{pl.item_count !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Hover state */}
                  <div className="absolute inset-0 flex items-center justify-center rounded-xl opacity-0 transition-opacity group-hover:opacity-100" style={{ background: 'rgba(0,0,0,0.18)' }}>
                    <span className="rounded-lg bg-black/50 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-sm">Edit</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <PlaylistEditorDialog
        playlistId={editingId}
        open={editingId !== null}
        onClose={() => setEditingId(null)}
        onChanged={load}
      />
    </section>
  );
}
