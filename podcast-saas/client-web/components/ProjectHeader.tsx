'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import { useAuth } from '../lib/firebase';
import { UserProfileButton } from './UserProfileButton';
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

interface Props {
  projectId: string;
}

export function ProjectHeader({ projectId }: Props) {
  const { loading: authLoading } = useAuth();
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    if (!authLoading) {
      api.getProject(projectId).then(setProject).catch(() => null);
    }
  }, [projectId, authLoading]);

  const statusStyle = project ? (STATUS_STYLES[project.status] ?? 'bg-muted text-muted-foreground') : '';
  const statusLabel = project ? (STATUS_LABELS[project.status] ?? project.status) : '';
  const rawTitle = project?.title ?? project?.topic ?? '';
  const title = rawTitle.length > 60 ? rawTitle.slice(0, 60) + '…' : rawTitle;

  return (
    <header className="shrink-0 h-12 border-b border-border bg-background/95 backdrop-blur flex items-center px-4 gap-3 z-20">
      <Link
        href="/"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Home
      </Link>

      <div className="w-px h-4 bg-border shrink-0" />

      <div className="flex-1 flex items-center gap-2 min-w-0">
        {title && (
          <span className="text-sm text-foreground truncate">{title}</span>
        )}
        {statusLabel && (
          <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusStyle}`}>
            {statusLabel}
          </span>
        )}
      </div>

      <a
        href={`/projects/${projectId}/view`}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 h-7 px-3 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors inline-flex items-center gap-1.5"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M4 2H2a1 1 0 00-1 1v5a1 1 0 001 1h5a1 1 0 001-1V6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M6 1h3m0 0v3m0-3L5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Show final video
      </a>

      <UserProfileButton />
    </header>
  );
}
