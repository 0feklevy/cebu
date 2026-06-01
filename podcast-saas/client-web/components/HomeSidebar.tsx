'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { HelpCircle, Pencil, Plus, Trash2 } from 'lucide-react';
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
        className="block rounded-lg px-3 py-3 transition-colors shell-hover"
        style={{ textDecoration: 'none' }}
      >
        <div className="mb-1.5 flex items-start gap-2 pr-[72px]">
          {/* Status dot */}
          <span
            className="mt-0.5 shrink-0 inline-block rounded-full"
            style={{ width: 8, height: 8, backgroundColor: status?.dot ?? '#94a3b8', marginTop: 6 }}
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
              className="flex-1 rounded border border-violet-400/50 bg-background px-2 py-1 text-sm font-medium text-foreground outline-none focus:border-violet-300"
              style={{ minWidth: 0 }}
            />
          ) : (
            <span className="flex-1 text-sm font-semibold leading-5 shell-text line-clamp-1" style={{ opacity: saving ? 0.5 : 1 }}>
              {saving ? editValue : projectTitle(project)}
            </span>
          )}
        </div>
        <p className="pl-4 text-xs shell-muted">{timeAgo(project.created_at)}</p>
      </a>

      {/* Action buttons — visible on hover */}
      <div
        className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
        style={{ pointerEvents: 'auto' }}
      >
        {/* Edit / rename */}
        <button
          onClick={startEdit}
          title="Rename"
          className="flex h-8 w-8 items-center justify-center rounded-lg shell-muted transition-colors hover:bg-[var(--shell-hover)] hover:text-[hsl(var(--shell-foreground))]"
        >
          <Pencil size={15} strokeWidth={1.9} aria-hidden />
        </button>
        {/* Delete */}
        <button
          onClick={handleDelete}
          disabled={deleting}
          title={confirmDelete ? 'Click again to confirm delete' : 'Delete project'}
          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
            confirmDelete
              ? 'bg-red-500 text-white'
              : 'shell-muted hover:text-red-400 hover:bg-red-500/10'
          } disabled:opacity-40`}
        >
          {deleting ? (
            <span className="text-xs">…</span>
          ) : (
            <Trash2 size={15} strokeWidth={1.9} aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
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

  const handleRename = useCallback((id: string, newTitle: string) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, title: newTitle } : p));
  }, []);

  const handleDelete = useCallback((id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
  }, []);

  return (
    <>
      <aside className="z-30 flex h-auto w-full max-w-full shrink-0 flex-col overflow-hidden border-b shell-bg lg:h-full lg:w-[320px] lg:border-b-0 lg:border-r">
        {/* Account */}
        <div className="shrink-0 px-4 py-4">
          <UserProfileButton showLabel />
        </div>

        <div className="shrink-0 px-4 pb-4">
          <button
            onClick={() => setCreateOpen(true)}
            className="gradient-action flex h-11 w-full max-w-[calc(100vw-32px)] items-center justify-center gap-2 rounded-lg text-sm font-semibold shadow-sm transition-all hover:brightness-110 active:translate-y-px focus-ring sm:max-w-none"
          >
            <Plus size={17} strokeWidth={2} aria-hidden />
            New project
          </button>
        </div>

        {/* My Projects */}
        <div className="hidden flex-1 overflow-y-auto px-3 pb-3 fine-scrollbar lg:block">
          <div className="mb-3 flex items-center justify-between px-1">
            <p className="text-xs font-semibold uppercase tracking-widest shell-muted">
              My Projects
            </p>
            {projects.length > 0 && (
              <span className="rounded-full border px-2 py-0.5 text-xs font-semibold shell-muted" style={{ borderColor: 'hsl(var(--shell-border))' }}>
                {projects.length}
              </span>
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
            <div className="space-y-1">
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
        <div className="hidden shrink-0 border-t px-3 py-3 lg:block" style={{ borderColor: 'hsl(var(--shell-border))' }}>
          <button
            onClick={() => setHowItWorksOpen(true)}
            className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium shell-muted transition-colors shell-hover hover:text-[hsl(var(--shell-foreground))]"
          >
            <HelpCircle size={16} strokeWidth={1.8} aria-hidden />
            How it works
          </button>
        </div>

        <div className="border-t px-3 py-2 lg:hidden" style={{ borderColor: 'hsl(var(--shell-border))' }}>
          <button
            onClick={() => setHowItWorksOpen(true)}
            className="h-9 w-full min-w-0 rounded-lg border text-sm font-medium shell-muted shell-hover transition-colors hover:text-[hsl(var(--shell-foreground))]"
            style={{ borderColor: 'hsl(var(--shell-border))' }}
          >
            How it works
          </button>
        </div>
      </aside>

      <HowItWorksDialog open={howItWorksOpen} onOpenChange={setHowItWorksOpen} />
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
