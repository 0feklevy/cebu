'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Clapperboard,
  Film,
  Layers3,
  MonitorPlay,
  Plus,
  Search,
  Share2,
  Sparkles,
  Upload,
  Wand2,
} from 'lucide-react';
import { CreateProjectDialog } from './CreateProjectDialog';
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

const WORKFLOW = [
  { label: 'Upload', icon: Upload, tone: 'text-sky-500', note: 'Clips, lectures, demos' },
  { label: 'Structure', icon: Layers3, tone: 'text-violet-500', note: 'Mark video and sim moments' },
  { label: 'Generate', icon: Wand2, tone: 'text-amber-500', note: 'B-roll and simulations' },
  { label: 'Share', icon: Share2, tone: 'text-emerald-500', note: 'Public watch link' },
];

const TEMPLATE_STARTERS = [
  'Product walkthrough',
  'Lecture breakdown',
  'Course module',
  'Interactive demo',
];

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
      className="group flex min-h-[128px] flex-col justify-between rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm-soft transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card focus-ring"
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
        <span className="inline-flex items-center gap-1 font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
          Open <ArrowRight size={13} strokeWidth={2} aria-hidden />
        </span>
      </div>
    </Link>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-32 animate-pulse rounded-lg border border-border bg-card/70 p-4">
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
      <section className="min-h-full overflow-x-hidden bg-background px-4 py-4 text-foreground sm:px-6 lg:px-8 lg:py-6">
        <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-5">
          <header className="surface-panel w-full max-w-[calc(100vw-32px)] rounded-lg px-4 py-4 sm:max-w-none sm:px-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <p className="mb-1 truncate text-xs font-medium text-muted-foreground">{accountLabel}</p>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:gap-3">
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                    Podcast Studio
                  </h1>
                  <span className="w-fit rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground sm:mb-1">
                    Interactive video workspace
                  </span>
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

          <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-5">
              <section className="grid gap-3 sm:grid-cols-3">
                <div className="w-full max-w-[calc(100vw-32px)] rounded-lg border border-border bg-card p-4 shadow-sm-soft sm:max-w-none">
                  <p className="text-xs font-medium text-muted-foreground">Projects</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">{counts.total}</p>
                </div>
                <div className="w-full max-w-[calc(100vw-32px)] rounded-lg border border-border bg-card p-4 shadow-sm-soft sm:max-w-none">
                  <p className="text-xs font-medium text-muted-foreground">In progress</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">{counts.active}</p>
                </div>
                <div className="w-full max-w-[calc(100vw-32px)] rounded-lg border border-border bg-card p-4 shadow-sm-soft sm:max-w-none">
                  <p className="text-xs font-medium text-muted-foreground">Ready to share</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">{counts.ready}</p>
                </div>
              </section>

              <section className="w-full max-w-[calc(100vw-32px)] rounded-lg border border-border bg-card p-4 shadow-sm-soft sm:max-w-none sm:p-5">
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">Recent projects</h2>
                    <p className="text-sm text-muted-foreground">Pick up the edit, or search by project name.</p>
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

                {loading ? (
                  <WorkspaceSkeleton />
                ) : filteredProjects.length > 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {filteredProjects.slice(0, 9).map((project) => (
                      <ProjectTile key={project.id} project={project} />
                    ))}
                  </div>
                ) : (
                  <div className="flex min-h-[240px] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/25 px-5 py-10 text-center">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Clapperboard size={22} strokeWidth={1.8} aria-hidden />
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
              </section>
            </div>

            <aside className="min-w-0 space-y-5">
              <section className="w-full max-w-[calc(100vw-32px)] overflow-hidden rounded-lg border border-border bg-card shadow-sm-soft sm:max-w-none">
                <div className="border-b border-border p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <MonitorPlay size={20} strokeWidth={1.8} aria-hidden />
                    </div>
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">Studio flow</h2>
                      <p className="text-xs text-muted-foreground">The shortest path to a watchable interactive cut.</p>
                    </div>
                  </div>
                </div>
                <div className="divide-y divide-border">
                  {WORKFLOW.map((step, index) => {
                    const Icon = step.icon;
                    return (
                      <div key={step.label} className="flex items-center gap-3 p-4">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-muted-foreground">
                          {index + 1}
                        </div>
                        <Icon className={step.tone} size={17} strokeWidth={1.9} aria-hidden />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{step.label}</p>
                          <p className="truncate text-xs text-muted-foreground">{step.note}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="w-full max-w-[calc(100vw-32px)] rounded-lg border border-border bg-card p-4 shadow-sm-soft sm:max-w-none">
                <div className="mb-4 flex items-center gap-2">
                  <Sparkles size={17} strokeWidth={1.8} className="text-primary" aria-hidden />
                  <h2 className="text-sm font-semibold text-foreground">Start faster</h2>
                </div>
                <div className="grid gap-2">
                  {TEMPLATE_STARTERS.map((starter) => (
                    <button
                      key={starter}
                      onClick={() => setCreateOpen(true)}
                      className="flex h-10 items-center justify-between rounded-lg border border-border bg-background px-3 text-left text-sm text-foreground transition-colors hover:border-primary/35 hover:bg-primary/5 focus-ring"
                    >
                      <span>{starter}</span>
                      <ArrowRight size={14} strokeWidth={2} className="text-muted-foreground" aria-hidden />
                    </button>
                  ))}
                </div>
              </section>

              <section className="w-full max-w-[calc(100vw-32px)] rounded-lg border border-border bg-card p-4 shadow-sm-soft sm:max-w-none">
                <div className="mb-4 flex items-center gap-2">
                  <CheckCircle2 size={17} strokeWidth={1.9} className="text-emerald-500" aria-hidden />
                  <h2 className="text-sm font-semibold text-foreground">Production checks</h2>
                </div>
                <div className="space-y-3">
                  {[
                    ['Timeline', 'Clips and sections arranged'],
                    ['B-roll', 'Generated or selected cutaways'],
                    ['Watch link', 'Share preview ready'],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                      <span className="text-xs font-medium text-muted-foreground">{label}</span>
                      <span className="truncate text-right text-xs font-semibold text-foreground">{value}</span>
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </div>
      </section>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
