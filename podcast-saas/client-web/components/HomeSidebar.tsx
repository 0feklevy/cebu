'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import { useAuth } from '../lib/firebase';
import { UserProfileButton } from './UserProfileButton';
import { HowItWorksDialog } from './HowItWorksDialog';
import { CreateProjectDialog } from './CreateProjectDialog';
import type { Project } from 'shared/src/generated/client-v1';

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  has_videos: 'bg-blue-500/10 text-blue-600',
  ready: 'bg-emerald-500/10 text-emerald-600',
  failed: 'bg-destructive/10 text-destructive',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  has_videos: 'Has videos',
  ready: 'Ready',
  failed: 'Failed',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function projectTitle(p: Project): string {
  const t = p.title ?? p.topic ?? '';
  return t.length > 50 ? t.slice(0, 50) + '…' : t || 'Untitled';
}

export function HomeSidebar() {
  const { loading: authLoading } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    api.listProjects().then(setProjects).catch(() => null);
  }, [authLoading]);

  return (
    <>
      <aside className="w-[260px] shrink-0 flex flex-col h-full border-r border-border bg-card/60 overflow-hidden">
        {/* Logo + New button */}
        <div className="shrink-0 px-4 pt-5 pb-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shadow-sm">
              <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden>
                <ellipse cx="5" cy="5" rx="4" ry="4" fill="white" fillOpacity="0.9" />
                <ellipse cx="11" cy="5" rx="2.5" ry="2.5" fill="white" fillOpacity="0.5" />
              </svg>
            </div>
            <span className="font-semibold tracking-tight text-sm text-foreground">VideoEditor</span>
          </Link>
          <button
            onClick={() => setCreateOpen(true)}
            className="h-7 w-7 rounded-lg bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 transition-colors shadow-sm"
            title="New project"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* My Projects */}
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-1 mb-2">
            My Projects
          </p>

          {authLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 rounded-lg bg-muted/50 animate-pulse" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="text-center py-8 px-2">
              <p className="text-xs text-muted-foreground mb-3">No projects yet</p>
              <button
                onClick={() => setCreateOpen(true)}
                className="text-xs text-primary hover:underline"
              >
                Create your first one →
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              {projects.map((p) => (
                <a
                  key={p.id}
                  href={`/projects/${p.id}/editor`}
                  className="block px-2 py-2.5 rounded-lg hover:bg-muted/60 transition-colors"
                >
                  <div className="flex items-start justify-between gap-1 mb-1">
                    <span className="text-xs font-medium text-foreground line-clamp-1 flex-1">
                      {projectTitle(p)}
                    </span>
                    <span className={`shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${STATUS_STYLES[p.status] ?? 'bg-muted text-muted-foreground'}`}>
                      {STATUS_LABELS[p.status] ?? p.status}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{timeAgo(p.created_at)}</p>
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border px-3 py-3 space-y-1">
          <button
            onClick={() => setHowItWorksOpen(true)}
            className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors text-left"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M7 6v4M7 4.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            How it works
          </button>
          <div className="px-1">
            <UserProfileButton />
          </div>
        </div>
      </aside>

      <HowItWorksDialog open={howItWorksOpen} onOpenChange={setHowItWorksOpen} />
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
