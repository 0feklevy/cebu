'use client';

import { useCallback, useEffect, useState } from 'react';
import { ListVideo, Play, Plus } from 'lucide-react';
import { api } from '../lib/api';
import type { PlaylistSummary } from 'shared/src/generated/client-v1';
import { PlaylistEditorDialog } from './PlaylistEditorDialog';

export function PlaylistsPanel() {
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

  useEffect(() => { load(); }, [load]);

  const handleNew = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const pl = await api.createPlaylist({ title: 'Untitled playlist' });
      setEditingId(pl.id);
      load();
    } catch { /* ignore */ } finally {
      setCreating(false);
    }
  }, [creating, load]);

  return (
    <section className="flex w-full max-w-[calc(100vw-32px)] flex-col rounded-lg border border-border bg-card p-4 shadow-sm-soft sm:max-w-none sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ListVideo size={18} strokeWidth={1.9} aria-hidden />
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">Playlists</h2>
            <p className="text-sm text-muted-foreground">Combine videos into one YouTube-style flow.</p>
          </div>
        </div>
        <button
          onClick={handleNew}
          disabled={creating}
          className="inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-semibold text-white shadow-sm transition-all hover:brightness-110 disabled:opacity-50 focus-ring"
          style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
        >
          <Plus size={15} strokeWidth={2} aria-hidden />
          New playlist
        </button>
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg border border-border bg-card/70" />
          ))}
        </div>
      ) : playlists.length === 0 ? (
        <button
          onClick={handleNew}
          className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/25 px-5 py-8 text-center transition-colors hover:bg-muted/40 focus-ring"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ListVideo size={20} strokeWidth={1.8} aria-hidden />
          </span>
          <span className="text-sm font-semibold text-foreground">Create your first playlist</span>
          <span className="max-w-md text-xs text-muted-foreground">
            Group several videos so viewers can watch them back-to-back with autoplay and an up-next list.
          </span>
        </button>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {playlists.map((pl) => (
            <button
              key={pl.id}
              onClick={() => setEditingId(pl.id)}
              className="group flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left shadow-sm-soft transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card focus-ring"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Play size={17} strokeWidth={2} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">
                  {pl.title?.trim() || 'Untitled playlist'}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{pl.item_count} video{pl.item_count !== 1 ? 's' : ''}</span>
                  {pl.share_token && <span className="text-emerald-500">· Shared</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <PlaylistEditorDialog
        playlistId={editingId}
        open={editingId !== null}
        onClose={() => setEditingId(null)}
        onChanged={load}
      />
    </section>
  );
}
