'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Clock3, Eye, ListVideo, Play, Plus } from 'lucide-react';
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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(dateStr));
}

const PLAYLISTS_CACHE_KEY = 'playlists_panel_v1';

function readCachedPlaylists(): PlaylistSummary[] {
  try {
    const raw = localStorage.getItem(PLAYLISTS_CACHE_KEY);
    return raw ? (JSON.parse(raw) as PlaylistSummary[]) : [];
  } catch { return []; }
}

export function PlaylistsPanel() {
  const { loading: authLoading } = useAuth();
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>(() => {
    if (typeof window === 'undefined') return [];
    return readCachedPlaylists();
  });
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    if (playlists.length === 0) setLoading(true);
    api.listPlaylists()
      .then((items) => {
        setPlaylists(items);
        try { localStorage.setItem(PLAYLISTS_CACHE_KEY, JSON.stringify(items)); } catch { /* quota */ }
      })
      .catch(() => { if (playlists.length === 0) setPlaylists([]); })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <div className="flex h-full min-w-max gap-3">
          {loading ? (
            [1, 2, 3].map((i) => (
              <div key={i} className="min-h-[170px] w-[240px] shrink-0 animate-pulse overflow-hidden rounded-lg border border-border bg-card/70 sm:w-[300px]">
                <div className="aspect-video bg-muted" />
                <div className="p-3.5">
                  <div className="mb-2 h-3 w-3/4 rounded bg-muted" />
                  <div className="h-3 w-1/2 rounded bg-muted" />
                </div>
              </div>
            ))
          ) : playlists.length === 0 ? (
            <button
              onClick={handleNew}
              className="flex min-h-[170px] w-[240px] shrink-0 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-5 py-6 text-center transition-colors hover:border-primary/40 hover:bg-primary/5 focus-ring sm:w-[300px]"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Plus size={18} strokeWidth={2} aria-hidden />
              </span>
              <span className="text-sm font-semibold text-foreground">Create playlist</span>
              <span className="max-w-[210px] text-sm leading-6 text-muted-foreground">
                Group videos into an autoplay series
              </span>
            </button>
          ) : (
            playlists.map((pl, idx) => {
              const grad = CARD_GRADIENTS[idx % CARD_GRADIENTS.length];
              const imageUrl = pl.banner_url ?? pl.thumbnail_url ?? null;
              return (
                <button
                  key={pl.id}
                  onClick={() => setEditingId(pl.id)}
                  className="group flex h-full min-h-[170px] w-[240px] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-left text-card-foreground shadow-sm-soft transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card focus-ring sm:w-[300px]"
                >
                  <div className="relative aspect-video w-full shrink-0 overflow-hidden bg-muted">
                    <div className="absolute inset-0 flex items-center justify-center text-white" style={{ background: grad }}>
                      <ListVideo size={24} strokeWidth={1.8} aria-hidden />
                    </div>
                    {imageUrl && (
                      <img
                        src={imageUrl}
                        alt=""
                        className="absolute inset-0 h-full w-full object-cover"
                        draggable={false}
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                    )}
                    {pl.share_token && (
                      <span className="absolute right-2 top-2 rounded-full bg-emerald-500/90 px-2 py-1 text-[10px] font-semibold text-white shadow-sm">
                        Live
                      </span>
                    )}
                  </div>

                  <div className="flex flex-1 flex-col p-3.5">
                    <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
                      {pl.title?.trim() || 'Untitled playlist'}
                    </h3>
                    <div className="mt-auto flex items-center justify-between gap-3 pt-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock3 size={13} strokeWidth={1.8} aria-hidden />
                        {timeAgo(pl.updated_at ?? pl.created_at)}
                      </span>
                      <div className="flex items-center gap-2.5">
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground" title={`${pl.item_count} videos`}>
                          <Play size={14} fill="currentColor" strokeWidth={0} aria-hidden />
                          {pl.item_count}
                        </span>
                        {pl.share_token && (pl.view_count ?? 0) > 0 && (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground" title={`${(pl.view_count ?? 0).toLocaleString()} views`}>
                            <Eye size={16} strokeWidth={1.9} aria-hidden />
                            {(pl.view_count ?? 0).toLocaleString()}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1 font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                          Edit <ArrowRight size={13} strokeWidth={2} aria-hidden />
                        </span>
                      </div>
                    </div>
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
