'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Settings2, Trash2, GraduationCap, HelpCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/firebase';
import { ConfirmDialog } from '../ConfirmDialog';
import { PodcastChrome, PodcastButton, timeAgo } from './PodcastChrome';
import { PodcastShowSettings } from './PodcastShowSettings';
import type { PodcastShow, PodcastEpisode } from 'shared/src/generated/client-v1';

const EP_STATUS: Record<string, { label: string; color: string }> = {
  draft:        { label: 'Draft',       color: '#94a3b8' },
  scripting:    { label: 'Writing…',    color: '#f59e0b' },
  script_ready: { label: 'Script ready', color: '#3b82f6' },
  approved:     { label: 'Approved',    color: '#8b5cf6' },
  rendering:    { label: 'Rendering…',  color: '#f59e0b' },
  ready:        { label: 'Ready',       color: '#10b981' },
  failed:       { label: 'Failed',      color: '#ef4444' },
};

export function PodcastShowPage({ showId }: { showId: string }) {
  const { loading: authLoading } = useAuth();
  const [show, setShow] = useState<PodcastShow | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PodcastEpisode | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    Promise.all([api.getPodcastShow(showId), api.listPodcastEpisodes(showId)])
      .then(([s, eps]) => {
        if (cancelled) return;
        setShow(s);
        setEpisodes(eps);
      })
      .catch(() => { if (!cancelled) setNotFound(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authLoading, showId]);

  const createEpisode = useCallback(async () => {
    setCreating(true);
    try {
      const ep = await api.createPodcastEpisode(showId, {});
      window.location.href = `/podcasts/${showId}/episodes/${ep.id}`;
    } catch (err) {
      console.error('Create episode failed', err);
      setCreating(false);
      window.alert('Could not create the episode — please try again.');
    }
  }, [showId]);

  const deleteEpisode = useCallback(async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.deletePodcastEpisode(showId, confirmDelete.id);
      setEpisodes((prev) => prev.filter((e) => e.id !== confirmDelete.id));
      setConfirmDelete(null);
    } catch (err) {
      console.error('Delete episode failed', err);
      window.alert('Could not delete the episode — please try again.');
    } finally {
      setDeleting(false);
    }
  }, [confirmDelete, showId]);

  if (notFound) {
    return (
      <PodcastChrome crumbs={[{ label: 'Not found' }]}>
        <p className="text-sm text-muted-foreground">This show doesn&apos;t exist or you don&apos;t have access to it.</p>
      </PodcastChrome>
    );
  }

  return (
    <PodcastChrome
      crumbs={[{ label: show?.title?.trim() || 'Show' }]}
      actions={
        show && (
          <>
            <PodcastButton variant="outline" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={16} strokeWidth={2} aria-hidden />
              Show settings
            </PodcastButton>
            <PodcastButton onClick={createEpisode} disabled={creating}>
              <Plus size={16} strokeWidth={2} aria-hidden />
              {creating ? 'Creating…' : 'New episode'}
            </PodcastButton>
          </>
        )
      }
    >
      {loading || authLoading || !show ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 rounded-xl bg-muted/40 animate-pulse" />)}
        </div>
      ) : (
        <>
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-foreground">{show.title?.trim() || 'Untitled show'}</h1>
            {show.description && <p className="mt-1 text-sm text-muted-foreground">{show.description}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-muted-foreground" style={{ borderColor: 'hsl(var(--border))' }}>
                <GraduationCap size={13} strokeWidth={1.9} aria-hidden className="text-primary" />
                Teacher: <strong className="text-foreground">{show.teacher_name}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-muted-foreground" style={{ borderColor: 'hsl(var(--border))' }}>
                <HelpCircle size={13} strokeWidth={1.9} aria-hidden className="text-primary" />
                Learner: <strong className="text-foreground">{show.learner_name}</strong>
              </span>
              <span className="rounded-full border px-2.5 py-1 text-muted-foreground" style={{ borderColor: 'hsl(var(--border))' }}>
                {show.niche_pack === 'science' ? 'Science pack' : 'General pack'} · {show.language.toUpperCase()}
              </span>
            </div>
          </div>

          {episodes.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border py-14 text-center">
              <p className="mb-1 text-sm font-semibold text-foreground">No episodes yet</p>
              <p className="mb-5 text-sm text-muted-foreground">Start a new episode, drop in your idea, and let the writers&apos; room build the script.</p>
              <PodcastButton onClick={createEpisode} disabled={creating}>
                <Plus size={16} strokeWidth={2} aria-hidden />
                {creating ? 'Creating…' : 'New episode'}
              </PodcastButton>
            </div>
          ) : (
            <div className="space-y-2">
              {episodes.map((ep) => {
                const st = EP_STATUS[ep.status] ?? EP_STATUS.draft;
                return (
                  <div key={ep.id} className="group relative rounded-xl border border-border bg-card card-interactive">
                    <a href={`/podcasts/${showId}/episodes/${ep.id}`} className="block rounded-xl p-4 pr-12 focus-ring" style={{ textDecoration: 'none' }}>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-semibold text-muted-foreground">#{ep.episode_number ?? '—'}</span>
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{ep.title?.trim() || 'Untitled episode'}</span>
                        <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${st.color}18`, color: st.color }}>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />
                          {st.label}
                        </span>
                      </div>
                      <p className="mt-1 pl-7 text-xs text-muted-foreground">{ep.target_minutes} min · {timeAgo(ep.updated_at)}</p>
                    </a>
                    <button
                      onClick={() => setConfirmDelete(ep)}
                      title="Delete episode"
                      className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-ring"
                    >
                      <Trash2 size={15} strokeWidth={1.9} aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {settingsOpen && show && (
        <PodcastShowSettings
          show={show}
          onClose={() => setSettingsOpen(false)}
          onSaved={(updated) => { setShow(updated); setSettingsOpen(false); }}
          onShowUpdate={(updated) => setShow(updated)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete episode?"
          description={`"${confirmDelete.title?.trim() || 'Untitled episode'}" will be permanently removed. This cannot be undone.`}
          confirmLabel="Delete"
          busy={deleting}
          onConfirm={deleteEpisode}
          onCancel={() => { if (!deleting) setConfirmDelete(null); }}
        />
      )}
    </PodcastChrome>
  );
}
