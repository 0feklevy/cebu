'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import { UserProfileButton } from './UserProfileButton';
import type { Project } from 'shared/src/generated/client-v1';

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  scripting: 'bg-blue-500/10 text-blue-600',
  script_ready: 'bg-violet-500/10 text-violet-600',
  approved: 'bg-amber-500/10 text-amber-600',
  generating: 'bg-blue-500/10 text-blue-600',
  ready: 'bg-emerald-500/10 text-emerald-600',
  failed: 'bg-destructive/10 text-destructive',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  scripting: 'Scripting…',
  script_ready: 'Script ready',
  approved: 'Approved',
  generating: 'Generating…',
  ready: 'Ready',
  failed: 'Failed',
};

interface Props {
  projectId: string;
}

export function ProjectHeader({ projectId }: Props) {
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    api.getProject(projectId).then(setProject).catch(() => null);
  }, [projectId]);

  const statusStyle = project ? (STATUS_STYLES[project.status] ?? 'bg-muted text-muted-foreground') : '';
  const statusLabel = project ? (STATUS_LABELS[project.status] ?? project.status) : '';
  const title = project?.topic
    ? project.topic.length > 60 ? project.topic.slice(0, 60) + '…' : project.topic
    : '';

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

      <UserProfileButton />
    </header>
  );
}
