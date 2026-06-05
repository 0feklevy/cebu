'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Clock3,
  Eye,
  Film,
  Plus,
  Search,
} from 'lucide-react';
import { CreateProjectDialog } from './CreateProjectDialog';
import { PlaylistsPanel } from './PlaylistsPanel';
import { api } from '../lib/api';
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

function ProjectTile({ project }: { project: Project }) {
  const meta = statusMeta(project.status);
  const title = projectTitle(project);

  return (
    <Link
      href={`/projects/${project.id}/editor`}
      className="group flex h-full min-h-[132px] w-[240px] shrink-0 flex-col justify-between rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm-soft transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card focus-ring sm:w-[300px]"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Film size={18} strokeWidth={1.9} aria-hidden />
          </div>
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{title}</h3>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ring-1 ${meta.className}`}>
          {meta.label}
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Clock3 size={13} strokeWidth={1.8} aria-hidden />
          {timeAgo(project.created_at)}
        </span>
        <div className="flex items-center gap-2">
          {project.share_token && (project.view_count ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
              <Eye size={11} strokeWidth={1.8} aria-hidden />
              {(project.view_count ?? 0).toLocaleString()}
            </span>
          )}
          <span className="inline-flex items-center gap-1 font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
            Open <ArrowRight size={13} strokeWidth={2} aria-hidden />
          </span>
        </div>
      </div>
    </Link>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="flex h-full gap-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-full min-h-[132px] w-[240px] shrink-0 animate-pulse rounded-lg border border-border bg-card/70 p-4 sm:w-[300px]">
          <div className="mb-4 h-9 w-9 rounded-lg bg-muted" />
          <div className="mb-2 h-3 w-3/4 rounded bg-muted" />
          <div className="h-3 w-1/2 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

export function HomeHero() {
  const { loading: authLoading, user, isAnonymous } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    setLoading(true);
    api.listProjects()
      .then((items) => {
        if (!cancelled) setProjects(items);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authLoading]);

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
  const accountLabel = authLoading
    ? 'Loading account'
    : user && !isAnonymous
      ? user.email
      : 'Guest workspace';

  return (
    <>
      <section className="flex w-[100dvw] max-w-[100dvw] overflow-x-hidden bg-background p-3 text-foreground sm:p-4 lg:h-full lg:min-h-0 lg:w-full lg:max-w-none lg:overflow-hidden lg:p-5">
        <div className="flex w-full min-w-0 max-w-full flex-col gap-4 overflow-visible lg:h-full lg:min-h-0 lg:overflow-hidden">
          <header className="surface-panel w-full shrink-0 rounded-lg px-4 py-3 sm:px-5">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <p className="mb-1 truncate text-xs font-medium text-muted-foreground">{accountLabel}</p>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                    Podcast Studio
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

          <div className="flex min-w-0 flex-col gap-4 overflow-visible lg:grid lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:overflow-hidden">
            <section className="flex min-h-[250px] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card p-4 shadow-sm-soft sm:min-h-[270px] sm:p-5 lg:min-h-0">
              <div className="mb-4 flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">Recent projects</h2>
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
                <div className="flex h-full min-w-max gap-3">
                  {loading ? (
                    <WorkspaceSkeleton />
                  ) : filteredProjects.length > 0 ? (
                    <>
                      {filteredProjects.slice(0, 12).map((project) => (
                        <ProjectTile key={project.id} project={project} />
                      ))}
                    </>
                  ) : (
                    <div className="flex h-full min-h-[132px] w-[260px] shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/25 px-5 py-6 text-center sm:w-[320px]">
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
