'use client';

import { useCallback, useEffect, useState } from 'react';
import { Mic, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/firebase';
import { ConfirmDialog } from '../ConfirmDialog';
import { PodcastChrome, PodcastButton, timeAgo } from './PodcastChrome';
import type { PodcastShow } from 'shared/src/generated/client-v1';

export function PodcastShowsPage() {
  const { loading: authLoading } = useAuth();
  const [shows, setShows] = useState<PodcastShow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PodcastShow | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    api
      .listPodcastShows()
      .then((rows) => { if (!cancelled) setShows(rows); })
      .catch(() => { if (!cancelled) setShows([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authLoading]);

  const createShow = useCallback(async () => {
    setCreating(true);
    try {
      const show = await api.createPodcastShow({});
      window.location.href = `/podcasts/${show.id}`;
    } catch (err) {
      console.error('Create show failed', err);
      setCreating(false);
      window.alert('Could not create the show — please try again.');
    }
  }, []);

  const deleteShow = useCallback(async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.deletePodcastShow(confirmDelete.id);
      setShows((prev) => prev.filter((s) => s.id !== confirmDelete.id));
      setConfirmDelete(null);
    } catch (err) {
      console.error('Delete show failed', err);
      window.alert('Could not delete the show — please try again.');
    } finally {
      setDeleting(false);
    }
  }, [confirmDelete]);

  return (
    <PodcastChrome
      crumbs={[]}
      actions={
        <PodcastButton onClick={createShow} disabled={creating}>
          <Plus size={16} strokeWidth={2} aria-hidden />
          {creating ? 'Creating…' : 'New show'}
        </PodcastButton>
      }
    >
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Podcast Studio</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Turn any idea into a fascinating two-host episode — a teacher who explains and a learner who
          asks the questions you were about to. Each <strong>show</strong> is a series with its own hosts,
          voices and memory.
        </p>
      </div>

      {loading || authLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : shows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Mic size={22} strokeWidth={1.9} aria-hidden />
          </div>
          <p className="mb-1 text-sm font-semibold text-foreground">No shows yet</p>
          <p className="mb-5 text-sm text-muted-foreground">Create your first show to start generating episodes.</p>
          <PodcastButton onClick={createShow} disabled={creating}>
            <Plus size={16} strokeWidth={2} aria-hidden />
            {creating ? 'Creating…' : 'Create a show'}
          </PodcastButton>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shows.map((show) => (
            <div key={show.id} className="group relative rounded-xl border border-border bg-card card-interactive transition-colors">
              <a href={`/podcasts/${show.id}`} className="block rounded-xl p-4 pr-12 focus-ring" style={{ textDecoration: 'none' }}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Mic size={15} strokeWidth={1.9} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                    {show.title?.trim() || 'Untitled show'}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {show.episode_count ?? 0} episode{(show.episode_count ?? 0) !== 1 ? 's' : ''} · {show.teacher_name} &amp; {show.learner_name} · {timeAgo(show.updated_at)}
                </p>
              </a>
              <button
                onClick={() => setConfirmDelete(show)}
                title="Delete show"
                className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-ring"
              >
                <Trash2 size={15} strokeWidth={1.9} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete show?"
          description={`"${confirmDelete.title?.trim() || 'Untitled show'}" and all its episodes will be permanently removed. This cannot be undone.`}
          confirmLabel="Delete"
          busy={deleting}
          onConfirm={deleteShow}
          onCancel={() => { if (!deleting) setConfirmDelete(null); }}
        />
      )}
    </PodcastChrome>
  );
}
