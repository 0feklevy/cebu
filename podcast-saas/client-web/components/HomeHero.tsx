'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Clock3,
  Copy,
  Eye,
  Film,
  Loader2,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { CreateProjectDialog } from './CreateProjectDialog';
import { PlaylistsPanel } from './PlaylistsPanel';
import { ConfirmDialog } from './ConfirmDialog';
import { api } from '../lib/api';
import { duplicationLabel, useProjectDuplication } from '../lib/useProjectDuplication';
import { canLoadPrivateWorkspace } from '../lib/authGate';
import { useAuth } from '../lib/firebase';
import type { Project } from 'shared/src/generated/client-v1';

const STATUS_META: Record<string, { label: string; className: string }> = {
  draft: {
    label: 'Draft',
    className: 'bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300',
  },
  has_videos: {
    label: 'Clips added',
    className: 'bg-blue-500/10 text-blue-700 ring-blue-500/20 dark:text-blue-300',
  },
  ready: {
    label: 'Ready',
    className: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300',
  },
  failed: {
    label: 'Needs attention',
    className: 'bg-red-500/10 text-red-700 ring-red-500/20 dark:text-red-300',
  },
};

function projectTitle(project: Project): string {
  return project.title?.trim() || project.topic?.trim() || 'Untitled project';
}

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

function statusMeta(status: string) {
  return STATUS_META[status] ?? STATUS_META.draft;
}

function ProjectTile({ project, onDelete, onDuplicated }: {
  project: Project;
  onDelete: (id: string) => void;
  onDuplicated?: (targetProjectId: string) => void;
}) {
  const meta = statusMeta(project.status);
  const title = projectTitle(project);
  const isShared = project.collab_role === 'collaborator';
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const tileRef = useRef<HTMLDivElement>(null);
  const dup = useProjectDuplication(project.id, (targetId) => {
    setConfirmCopy(false);
    onDuplicated?.(targetId);
  });
  // A FAILED copy closes the dialog too. `onReady` above is the success path only, so without this
  // the modal stays up over the "Copy failed" strip it is covering, with a Duplicate button that is
  // no longer busy and a Cancel that reads as the only way out of a run that already ended.
  useEffect(() => {
    if (dup.status === 'failed') setConfirmCopy(false);
  }, [dup.status]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteProject(project.id);
      onDelete(project.id);
    } catch {
      setDeleting(false);
      setConfirm(false);
    }
  };

  const handleDuplicate = async () => { await dup.start(); };

  return (
    <div
      ref={tileRef}
      className="group relative flex h-full min-h-[232px] w-[300px] shrink-0 sm:w-[320px] xl:w-[340px]"
    >
      <Link
        href={`/projects/${project.id}/editor`}
        className="grid h-full w-full grid-rows-[minmax(128px,1fr)_auto] rounded-lg border border-border bg-card text-card-foreground shadow-sm-soft transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card focus-ring"
        tabIndex={confirm ? -1 : 0}
      >
        <div className="relative min-h-[128px] w-full overflow-hidden rounded-t-lg bg-muted">
          <div className="absolute inset-0 flex items-center justify-center bg-primary/8 text-primary">
            <Film size={32} strokeWidth={1.8} aria-hidden />
          </div>
          {project.thumbnail_url && (
            <img
              src={project.thumbnail_url}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              draggable={false}
              onError={(event) => { event.currentTarget.style.display = 'none'; }}
            />
          )}
          <span className={`absolute right-3 top-3 rounded-full px-2.5 py-1.5 text-[11px] font-semibold shadow-sm ring-1 ${meta.className}`}>
            {meta.label}
          </span>
          {isShared && (
            <span
              className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full bg-violet-600/90 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm"
              title="Shared with you — you can edit this project"
            >
              <Users size={11} strokeWidth={2.2} aria-hidden />
              Shared
            </span>
          )}
        </div>

        <div className="flex min-h-0 flex-col p-3">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{title}</h3>
          <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Clock3 size={14} strokeWidth={1.8} aria-hidden />
              {timeAgo(project.created_at)}
            </span>
            <div className="flex items-center gap-2.5">
              {project.share_token && (project.view_count ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground" title={`${(project.view_count ?? 0).toLocaleString()} views`}>
                  <Eye size={16} strokeWidth={1.9} aria-hidden />
                  {(project.view_count ?? 0).toLocaleString()}
                </span>
              )}
              <span className="inline-flex items-center gap-1 font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                Open <ArrowRight size={14} strokeWidth={2} aria-hidden />
              </span>
            </div>
          </div>
        </div>
      </Link>

      {/* Trash button — appears on hover, sits outside the Link so it doesn't trigger navigation.
          Hidden for shared projects: deleting is owner-only (collab-042). */}
      {!isShared && <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirm(true); }}
        title="Delete project"
        aria-label="Delete project"
        className="absolute left-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-md bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-600"
        style={{ pointerEvents: confirm ? 'none' : 'auto' }}
      >
        <Trash2 size={16} strokeWidth={2} aria-hidden />
      </button>}

      {/* Duplicate — beside Delete, same hover-revealed treatment. Owner-only for the same reason
          Delete is: the backend refuses a duplication from a collaborator (a copy is a new project
          the requester would own). While a copy runs the button stays visible and reports progress,
          because the run outlives the hover and the user needs to be able to find it again. */}
      {!isShared && <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!dup.busy) setConfirmCopy(true); }}
        disabled={dup.busy}
        title={duplicationLabel(dup)}
        aria-label={duplicationLabel(dup)}
        className={`absolute left-[52px] top-3 z-10 flex h-9 w-9 items-center justify-center rounded-md bg-black/60 text-white transition-opacity hover:bg-primary disabled:cursor-progress ${
          dup.busy || dup.status === 'failed' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
        style={{ pointerEvents: confirm || confirmCopy ? 'none' : 'auto' }}
      >
        {dup.busy
          ? <Loader2 size={16} strokeWidth={2} aria-hidden className="animate-spin" />
          : <Copy size={16} strokeWidth={2} aria-hidden />}
      </button>}

      {/* Progress / outcome strip. The copy can take minutes, so the tile says so rather than
          leaving a spinner with no explanation; a failure is stated in place instead of an
          alert(), which this surface has never used. */}
      {(dup.busy || dup.status === 'failed') && (
        <div
          role="status"
          className={`absolute inset-x-3 bottom-3 z-10 flex items-start gap-2 rounded-md px-2 py-1 text-[11px] font-semibold text-white shadow-sm ${
            dup.status === 'failed' ? 'bg-red-600/90' : 'bg-black/70'
          }`}
        >
          <span className="min-w-0 flex-1">
            {dup.status === 'failed' ? (dup.error ?? 'Copy failed') : duplicationLabel(dup)}
          </span>
          {/* The way out. A failed run leaves this strip covering the tile with nothing that
              dismisses it — the hook has exported `reset()` since it was written and neither
              surface called it, so the only escape from a failure was a page reload. */}
          {dup.status === 'failed' && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); dup.reset(); }}
              title="Dismiss"
              aria-label="Dismiss copy error"
              className="shrink-0 rounded px-1 leading-none opacity-80 transition-opacity hover:opacity-100 focus-ring"
            >
              <X size={12} strokeWidth={2.5} aria-hidden />
            </button>
          )}
        </div>
      )}

      {/* Confirmation modal — portaled to <body> so it is never clipped by the
          tile's hover-transform or the horizontal scroll container. */}
      {confirm && (
        <ConfirmDialog
          title="Delete project?"
          description={`"${title}" and its videos will be permanently removed. This cannot be undone.`}
          confirmLabel="Delete"
          busy={deleting}
          onConfirm={handleDelete}
          onCancel={() => { if (!deleting) setConfirm(false); }}
        />
      )}

      {confirmCopy && (
        <ConfirmDialog
          title="Duplicate project?"
          description={`"${title}" will be copied into a new private project — video, timeline, branching and simulations included. Large videos can take a few minutes.`}
          confirmLabel="Duplicate"
          danger={false}
          busy={dup.busy}
          onConfirm={handleDuplicate}
          onCancel={() => { if (!dup.busy) setConfirmCopy(false); }}
        />
      )}
    </div>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="flex h-full gap-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="grid h-full min-h-[232px] w-[300px] shrink-0 animate-pulse grid-rows-[minmax(128px,1fr)_auto] rounded-lg border border-border bg-card/70 p-3 sm:w-[320px] xl:w-[340px]">
          <div className="mb-3 min-h-[128px] w-full rounded-md bg-muted" />
          <div className="mb-3 h-4 w-3/4 rounded bg-muted" />
          <div className="h-4 w-1/2 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

const PROJECTS_CACHE_KEY = 'hero_projects_v1';

/**
 * THE CACHE BELONGS TO AN ACCOUNT, NOT TO A BROWSER.
 *
 * This used to be a bare `Project[]` under one global key, written on every successful list and
 * never cleared — `signOutUser` only calls Firebase's `signOut`. On a shared machine the next
 * account to sign in was seeded with the previous one's list before its own fetch returned, and
 * the header counts and the "Continue latest" link render OUTSIDE the loading gate: a brand-new
 * user's first view of the product said "1 projects / 1 ready" and linked to
 * `/projects/{someone else's uuid}/editor`.
 *
 * The envelope carries the uid it was written under and a read for any other uid returns nothing.
 * A pre-envelope array cannot be attributed to anybody, so it is dropped rather than trusted.
 */
interface ProjectsCacheEnvelope { uid: string; items: Project[] }

function readCachedProjects(uid: string | null | undefined): Project[] {
  if (!uid) return [];
  try {
    const raw = localStorage.getItem(PROJECTS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ProjectsCacheEnvelope | Project[];
    if (Array.isArray(parsed)) return [];
    return parsed.uid === uid && Array.isArray(parsed.items) ? parsed.items : [];
  } catch { return []; }
}

function writeCachedProjects(uid: string | null | undefined, items: Project[]) {
  if (!uid) return;
  try { localStorage.setItem(PROJECTS_CACHE_KEY, JSON.stringify({ uid, items })); } catch { /* quota */ }
}

export function HomeHero() {
  const { loading: authLoading, user } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  // Start empty so the server and the first client render match (the page now
  // SSRs). The localStorage cache is seeded in a mount effect below.
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  // Seed from the client-side cache after hydration (avoids an SSR mismatch). Keyed on the uid, so
  // a sign-out/sign-in as somebody else re-seeds from THEIR cache (empty, for a new account)
  // instead of leaving the previous account's list on screen until the fetch returns.
  useEffect(() => {
    setProjects(readCachedProjects(user?.uid));
  }, [user?.uid]);

  useEffect(() => {
    if (authLoading) return;
    // Anonymous visitor: GET /api/v1/projects requires auth (401 otherwise) —
    // never call it without a signed-in user; render the empty state instead.
    if (!canLoadPrivateWorkspace(authLoading, user)) {
      setProjects([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Don't show skeleton if we already have cached data — just quietly refresh
    if (projects.length === 0) setLoading(true);
    api.listProjects()
      .then((items) => {
        if (!cancelled) {
          setProjects(items);
          writeCachedProjects(user?.uid, items);
        }
      })
      .catch(() => {
        if (!cancelled && projects.length === 0) setProjects([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [projects],
  );

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sortedProjects;
    return sortedProjects.filter((project) => projectTitle(project).toLowerCase().includes(q));
  }, [query, sortedProjects]);

  const counts = useMemo(() => ({
    total: projects.length,
    ready: projects.filter((project) => project.status === 'ready').length,
    active: projects.filter((project) => project.status !== 'ready' && project.status !== 'failed').length,
  }), [projects]);

  const latestProject = sortedProjects[0];

  return (
    <>
      <section className="flex w-[100dvw] max-w-[100dvw] overflow-x-hidden bg-background p-3 text-foreground sm:p-4 lg:h-full lg:min-h-0 lg:w-full lg:max-w-none lg:overflow-hidden lg:p-5">
        <div className="flex w-full min-w-0 max-w-full flex-col gap-4 overflow-visible lg:h-full lg:min-h-0 lg:overflow-hidden">
          <header className="surface-panel w-full shrink-0 rounded-lg px-4 py-3 sm:px-5">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                    Interactive Video Studio
                  </h1>
                  <div className="flex flex-wrap gap-2">
                    <span className="w-fit rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                      {counts.total} projects
                    </span>
                    <span className="w-fit rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                      {counts.active} active
                    </span>
                    <span className="w-fit rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                      {counts.ready} ready
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label className="relative block sm:w-[280px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} strokeWidth={1.8} aria-hidden />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-10 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/45 focus:ring-2 focus:ring-ring/20"
                    placeholder="Search projects"
                  />
                </label>
                <button
                  onClick={() => setCreateOpen(true)}
                  className="gradient-action inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold shadow-sm transition-all hover:brightness-110 active:translate-y-px focus-ring"
                >
                  <Plus size={16} strokeWidth={2} aria-hidden />
                  New project
                </button>
              </div>
            </div>
          </header>

          <div className="flex min-w-0 flex-col gap-4 overflow-visible lg:grid lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(340px,1.08fr)_minmax(0,.92fr)] lg:overflow-hidden">
            <section className="flex min-h-[340px] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card p-4 shadow-sm-soft sm:min-h-[370px] sm:p-5 lg:min-h-0">
              <div className="mb-4 flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">Recent projects</h2>
                    <p className="text-sm text-muted-foreground">One row for fast pickup and editing.</p>
                  </div>
                  {latestProject && (
                    <Link
                      href={`/projects/${latestProject.id}/editor`}
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-ring"
                    >
                      Continue latest
                      <ArrowRight size={14} strokeWidth={2} aria-hidden />
                    </Link>
                  )}
              </div>

              <div className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-2 fine-scrollbar">
                <div className="flex h-full min-w-max gap-4">
                  {loading ? (
                    <WorkspaceSkeleton />
                  ) : filteredProjects.length > 0 ? (
                    <>
                      {filteredProjects.slice(0, 12).map((project) => (
                        <ProjectTile
                          key={project.id}
                          project={project}
                          onDelete={(id) => {
                            setProjects(prev => {
                              const next = prev.filter(p => p.id !== id);
                              writeCachedProjects(user?.uid, next);
                              return next;
                            });
                          }}
                          // The copy exists as a real project only at this point, so it is fetched
                          // and prepended rather than optimistically synthesised — and written
                          // through to the localStorage cache, or a remount would show a list the
                          // copy is missing from.
                          onDuplicated={(targetId) => {
                            void api.getProject(targetId).then((copy) => {
                              setProjects(prev => {
                                if (prev.some(p => p.id === copy.id)) return prev;
                                const next = [copy, ...prev];
                                writeCachedProjects(user?.uid, next);
                                return next;
                              });
                            }).catch(() => { /* the next list refresh picks it up */ });
                          }}
                        />
                      ))}
                    </>
                  ) : (
                    <div className="flex h-full min-h-[228px] w-[320px] shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/25 px-5 py-6 text-center sm:w-[360px] xl:w-[392px]">
                      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Film size={22} strokeWidth={1.8} aria-hidden />
                      </div>
                      <h3 className="text-sm font-semibold text-foreground">
                        {query.trim() ? 'No matching projects' : 'Start with a blank studio'}
                      </h3>
                      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                        {query.trim()
                          ? 'Try a different title or clear the search to see every workspace.'
                          : 'Create a project, upload clips, and the editor will become your timeline, b-roll, simulation, and share room.'}
                      </p>
                      {!query.trim() && (
                        <button
                          onClick={() => setCreateOpen(true)}
                          className="gradient-action mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold shadow-sm transition-all hover:brightness-110 focus-ring"
                        >
                          <Plus size={16} strokeWidth={2} aria-hidden />
                          Create first project
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <PlaylistsPanel />
          </div>
        </div>
      </section>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
