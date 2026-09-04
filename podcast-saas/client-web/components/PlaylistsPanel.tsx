'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Clock3, Eye, ListVideo, Play, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { canLoadPrivateWorkspace } from '../lib/authGate';
import { useAuth } from '../lib/firebase';
import type { PlaylistSummary } from 'shared/src/generated/client-v1';
import { PlaylistEditorDialog } from './PlaylistEditorDialog';
import { gradientFor } from './library/LibraryCard';
import { tourAnchor } from '@/lib/tours/anchors';

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
  const { loading: authLoading, user } = useAuth();
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>(() => {
    if (typeof window === 'undefined') return [];
    return readCachedPlaylists();
  });
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    if (playlists.length === 0) setLoading(true);
    setLoadFailed(false);
    api.listPlaylists()
      .then((items) => {
        setPlaylists(items);
        try { localStorage.setItem(PLAYLISTS_CACHE_KEY, JSON.stringify(items)); } catch { /* quota */ }
      })
      // A failed load used to fall through to the "Create playlist" empty state — which tells a
      // user with real playlists that they have none. Say the load failed and offer a retry;
      // cached playlists (if any) stay on screen.
      .catch(() => { if (playlists.length === 0) { setPlaylists([]); setLoadFailed(true); } })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authLoading) return;
    // Anonymous visitor: GET /api/v1/playlists requires auth (401 otherwise) —
    // never call it without a signed-in user; render the empty state instead.
    if (!canLoadPrivateWorkspace(authLoading, user)) {
      setPlaylists([]);
      setLoading(false);
      return;
    }
    load();
  }, [authLoading, user, load]);

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
    <section {...tourAnchor('home-playlists')} className="flex min-h-0 w-full flex-col rounded-lg border border-border bg-card shadow-sm-soft">
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
          className="btn-gradient inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold shadow-sm focus-ring"
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
          ) : loadFailed && playlists.length === 0 ? (
            <div
              role="alert"
              className="flex min-h-[170px] w-[240px] shrink-0 flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-5 py-6 text-center sm:w-[300px]"
            >
              <div>
                <p className="text-sm font-semibold text-foreground">Couldn&apos;t load your playlists</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">They&apos;re still there — this panel just couldn&apos;t reach them.</p>
              </div>
              <button
                onClick={load}
                className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring"
              >
                Try again
              </button>
            </div>
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
            playlists.map((pl) => {
              const imageUrl = pl.banner_url ?? pl.thumbnail_url ?? null;
              return (
                <button
                  key={pl.id}
                  onClick={() => setEditingId(pl.id)}
                  className="group flex h-full min-h-[170px] w-[240px] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-left text-card-foreground shadow-sm-soft transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card focus-ring sm:w-[300px]"
                >
                  <div className="relative aspect-video w-full shrink-0 overflow-hidden bg-muted">
                    {/* Token gradient (same palette + hash as the library tiles) so the tile
                        survives both themes; the glyph rides a chip for the same reason. */}
                    <div className={`absolute inset-0 flex items-center justify-center ${gradientFor(pl.id)}`}>
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-background/30 text-foreground/80">
                        <ListVideo size={20} strokeWidth={1.8} aria-hidden />
                      </span>
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
                    {pl.collab_role === 'collaborator' && (
                      <span
                        className="absolute left-2 top-2 rounded-full bg-violet-600/90 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm"
                        title="Shared with you — you can edit this playlist"
                      >
                        Shared
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
