'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import { useAuth } from '../lib/firebase';
import { UserProfileButton } from './UserProfileButton';
import { HowItWorksDialog } from './HowItWorksDialog';
import { CreateProjectDialog } from './CreateProjectDialog';
import type { Project } from 'shared/src/generated/client-v1';

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  draft:      { dot: '#94a3b8', label: 'Draft' },
  has_videos: { dot: '#3b82f6', label: 'Has videos' },
  ready:      { dot: '#10b981', label: 'Ready' },
  failed:     { dot: '#ef4444', label: 'Failed' },
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

interface ProjectCardProps {
  project: Project;
  onRename: (id: string, newTitle: string) => void;
  onDelete: (id: string) => void;
}

function ProjectCard({ project, onRename, onDelete }: ProjectCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditValue(projectTitle(project));
    setIsEditing(true);
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 50);
  };

  const commitEdit = useCallback(async () => {
    if (!isEditing) return;
    const trimmed = editValue.trim();
    setIsEditing(false);
    if (!trimmed || trimmed === projectTitle(project)) return;
    setSaving(true);
    try {
      await api.renameProject(project.id, trimmed);
      onRename(project.id, trimmed);
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  }, [isEditing, editValue, project, onRename]);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try {
      await api.deleteProject(project.id);
      onDelete(project.id);
    } catch { setDeleting(false); setConfirmDelete(false); }
  };

  const status = STATUS_STYLES[project.status];

  return (
    <div
      className="group relative rounded-lg transition-colors"
      style={{ backgroundColor: 'transparent' }}
      onMouseLeave={() => setConfirmDelete(false)}
    >
      <a
        href={`/projects/${project.id}/editor`}
        className="block px-2 py-2.5 rounded-lg transition-colors shell-hover"
        style={{ textDecoration: 'none' }}
      >
        <div className="flex items-start gap-1.5 mb-1 pr-14">
          {/* Status dot */}
          <span
            className="mt-0.5 shrink-0 inline-block rounded-full"
            style={{ width: 6, height: 6, backgroundColor: status?.dot ?? '#94a3b8', marginTop: 5 }}
          />
          {isEditing ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                if (e.key === 'Escape') { setIsEditing(false); }
              }}
              onClick={e => e.preventDefault()}
              className="flex-1 text-xs font-medium rounded border border-violet-400/50 bg-background px-1.5 py-0.5 text-foreground outline-none focus:border-violet-300"
              style={{ minWidth: 0 }}
            />
          ) : (
            <span className="flex-1 text-xs font-medium shell-text line-clamp-1" style={{ opacity: saving ? 0.5 : 1 }}>
              {saving ? editValue : projectTitle(project)}
            </span>
          )}
        </div>
        <p className="text-[10px] shell-muted pl-[14px]">{timeAgo(project.created_at)}</p>
      </a>

      {/* Action buttons — visible on hover */}
      <div
        className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ pointerEvents: 'auto' }}
      >
        {/* Edit / rename */}
        <button
          onClick={startEdit}
          title="Rename"
          className="w-5 h-5 rounded flex items-center justify-center shell-muted hover:bg-[var(--shell-hover)] hover:text-[hsl(var(--shell-foreground))] transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M7 1.5l1.5 1.5M1 9h1.5L7.5 3.5 6 2 1 7.5V9z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {/* Delete */}
        <button
          onClick={handleDelete}
          disabled={deleting}
          title={confirmDelete ? 'Click again to confirm delete' : 'Delete project'}
          className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
            confirmDelete
              ? 'bg-red-500 text-white'
              : 'shell-muted hover:text-red-400 hover:bg-red-500/10'
          } disabled:opacity-40`}
        >
          {deleting ? (
            <span style={{ fontSize: 8 }}>…</span>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1.5 3h7M4 3V1.5h2V3M3 3l.5 5.5h3L7 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export function HomeSidebar() {
  const { loading: authLoading, user, isAnonymous } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    api.listProjects().then(setProjects).catch(() => null);
  }, [authLoading]);

  const handleRename = useCallback((id: string, newTitle: string) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, title: newTitle } : p));
  }, []);

  const handleDelete = useCallback((id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
  }, []);

  return (
    <>
      <aside className="z-30 flex h-auto w-full max-w-full shrink-0 flex-col overflow-hidden border-b shell-bg lg:h-full lg:w-[276px] lg:border-b-0 lg:border-r">
        {/* Logo */}
        <div className="shrink-0 px-4 py-3 lg:pt-5 lg:pb-3 flex items-center justify-between">
          <Link href="/" className="min-w-0 flex flex-col gap-1">
            <span className="max-w-[210px] truncate text-[11px] font-medium shell-muted">
              {authLoading ? 'Loading account...' : user && !isAnonymous ? user.email : 'Guest workspace'}
            </span>
            <span className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg flex items-center justify-center shadow-sm gradient-action">
                <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden>
                  <ellipse cx="5" cy="5" rx="4" ry="4" fill="white" fillOpacity="0.9" />
                  <ellipse cx="11" cy="5" rx="2.5" ry="2.5" fill="white" fillOpacity="0.5" />
                </svg>
              </span>
              <span className="font-semibold tracking-tight text-sm shell-text">Podcast Studio</span>
            </span>
          </Link>
        </div>

        <div className="shrink-0 px-4 pb-3">
          <button
            onClick={() => setCreateOpen(true)}
            className="gradient-action flex h-9 w-full max-w-[calc(100vw-32px)] items-center justify-center gap-2 rounded-lg text-sm font-semibold shadow-sm transition-all hover:brightness-110 active:translate-y-px focus-ring sm:max-w-none"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
              <path d="M6.5 2v9M2 6.5h9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            New project
          </button>
        </div>

        {/* My Projects */}
        <div className="hidden flex-1 overflow-y-auto px-3 pb-3 fine-scrollbar lg:block">
          <div className="flex items-center justify-between px-1 mb-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest shell-muted">
              My Projects
            </p>
            {projects.length > 0 && (
              <span className="text-[10px] shell-muted">{projects.length}</span>
            )}
          </div>

          {authLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-14 rounded-lg bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="text-center py-10 px-2">
              <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="shell-muted">
                  <rect x="2" y="4" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M7 7l4 2-4 2V7z" fill="currentColor" />
                </svg>
              </div>
              <p className="text-xs shell-muted mb-3">No projects yet</p>
              <button
                onClick={() => setCreateOpen(true)}
                className="text-xs font-medium text-primary hover:opacity-80"
              >
                Create your first one
              </button>
            </div>
          ) : (
            <div className="space-y-0.5">
              {projects.map(p => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onRename={handleRename}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="hidden shrink-0 border-t px-3 py-3 space-y-1 lg:block" style={{ borderColor: 'hsl(var(--shell-border))' }}>
          <button
            onClick={() => setHowItWorksOpen(true)}
            className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm shell-muted shell-hover transition-colors text-left hover:text-[hsl(var(--shell-foreground))]"
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

        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t px-3 py-2 lg:hidden" style={{ borderColor: 'hsl(var(--shell-border))' }}>
          <button
            onClick={() => setHowItWorksOpen(true)}
            className="h-8 min-w-0 rounded-lg border text-sm font-medium shell-muted shell-hover transition-colors hover:text-[hsl(var(--shell-foreground))]"
            style={{ borderColor: 'hsl(var(--shell-border))' }}
          >
            How it works
          </button>
          <UserProfileButton />
        </div>
      </aside>

      <HowItWorksDialog open={howItWorksOpen} onOpenChange={setHowItWorksOpen} />
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
