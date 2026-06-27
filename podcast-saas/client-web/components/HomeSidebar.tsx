'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { ChevronDown, ChevronRight, HelpCircle, ListVideo, Pencil, PlaySquare, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';
import { useAuth } from '../lib/firebase';
import { UserProfileButton } from './UserProfileButton';
import { HowItWorksDialog } from './HowItWorksDialog';
import { CreateProjectDialog } from './CreateProjectDialog';
import type { PlaylistItem, PlaylistWithItems, Project } from 'shared/src/generated/client-v1';

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

function playlistTitle(p: PlaylistWithItems): string {
  const t = p.title?.trim() || 'Untitled playlist';
  return t.length > 42 ? t.slice(0, 42) + '…' : t;
}

function videoTitle(item: PlaylistItem): string {
  const t = item.title?.trim() || item.description?.trim() || 'Untitled video';
  return t.length > 44 ? t.slice(0, 44) + '…' : t;
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
    } catch (err) {
      // Don't swallow the failure: log it, reopen the editor with the attempted name
      // so the change visibly didn't stick, and tell the user (review ui-ux-011).
      console.error('Rename failed', err);
      setEditValue(trimmed);
      setIsEditing(true);
      if (typeof window !== 'undefined') window.alert('Could not rename the project — please try again.');
    } finally {
      setSaving(false);
    }
  }, [isEditing, editValue, project, onRename]);

  const confirmDeleteNow = async () => {
    setDeleting(true);
    try {
      await api.deleteProject(project.id);
      onDelete(project.id);
    } catch (err) {
      console.error('Delete failed', err);
      setDeleting(false); setConfirmDelete(false);
      if (typeof window !== 'undefined') window.alert('Could not delete the project — please try again.');
    }
  };

  const status = STATUS_STYLES[project.status];

  return (
    <div
      className="group relative rounded-lg transition-colors"
      style={{ backgroundColor: 'transparent' }}
    >
      <a
        href={`/projects/${project.id}/editor`}
        className="block rounded-lg px-3 py-3 transition-colors shell-hover"
        style={{ textDecoration: 'none' }}
      >
        <div className="mb-1.5 flex items-start gap-2 pr-[72px]">
          <span className="relative mt-0.5 h-8 w-12 shrink-0 overflow-hidden rounded-md bg-[var(--shell-hover)]">
            {project.thumbnail_url ? (
              <img
                src={project.thumbnail_url}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
                onError={(event) => { event.currentTarget.style.display = 'none'; }}
              />
            ) : null}
            <span
              className="absolute bottom-1 left-1 inline-block rounded-full ring-1 ring-black/20"
              style={{ width: 6, height: 6, backgroundColor: status?.dot ?? '#94a3b8' }}
            />
          </span>
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
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmDelete(true); }}
          disabled={deleting}
          title="Delete project"
          className="flex h-8 w-8 items-center justify-center rounded-lg shell-muted transition-colors hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40"
        >
          {deleting ? (
            <span className="text-xs">…</span>
          ) : (
            <Trash2 size={15} strokeWidth={1.9} aria-hidden />
          )}
        </button>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete project?"
          description={`"${projectTitle(project)}" and its videos will be permanently removed. This cannot be undone.`}
          confirmLabel="Delete"
          busy={deleting}
          onConfirm={confirmDeleteNow}
          onCancel={() => { if (!deleting) setConfirmDelete(false); }}
        />
      )}
    </div>
  );
}

function PlaylistVideoRow({ item }: { item: PlaylistItem }) {
  const status = STATUS_STYLES[item.status] ?? STATUS_STYLES.draft;

  return (
    <a
      href={`/projects/${item.project_id}/editor`}
      className="group/video flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 transition-colors shell-hover"
      style={{ textDecoration: 'none' }}
    >
      <span className="relative h-8 w-12 shrink-0 overflow-hidden rounded-md bg-[var(--shell-hover)]" aria-hidden>
        {item.thumbnail_url ? (
          <img
            src={item.thumbnail_url}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
            onError={(event) => { event.currentTarget.style.display = 'none'; }}
          />
        ) : null}
        <span
          className="absolute bottom-1 left-1 rounded-full ring-1 ring-black/20"
          style={{ width: 6, height: 6, backgroundColor: status.dot }}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium shell-text">
        {videoTitle(item)}
      </span>
      <PlaySquare
        size={13}
        strokeWidth={1.8}
        className="shrink-0 opacity-0 transition-opacity group-hover/video:opacity-70"
        aria-hidden
      />
    </a>
  );
}

function SidebarPlaylistGroup({
  playlist,
  expanded,
  onToggle,
}: {
  playlist: PlaylistWithItems;
  expanded: boolean;
  onToggle: () => void;
}) {
  const items = playlist.items ?? [];
  const itemCount = items.length;

  return (
    <div className="rounded-lg">
      <button
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2.5 text-left transition-colors shell-hover focus-ring"
      >
        {expanded ? (
          <ChevronDown size={14} strokeWidth={2} className="shrink-0 shell-muted" aria-hidden />
        ) : (
          <ChevronRight size={14} strokeWidth={2} className="shrink-0 shell-muted" aria-hidden />
        )}
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--shell-hover)] shell-text">
          <ListVideo size={14} strokeWidth={1.9} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-5 shell-text">
            {playlistTitle(playlist)}
          </span>
          <span className="block text-xs shell-muted">
            {itemCount} video{itemCount !== 1 ? 's' : ''}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="ml-[27px] border-l pl-2" style={{ borderColor: 'hsl(var(--shell-border))' }}>
          {itemCount > 0 ? (
            items.map((item) => (
              <PlaylistVideoRow key={item.id} item={item} />
            ))
          ) : (
            <p className="px-2 py-2 text-xs shell-muted">No videos in this playlist yet</p>
          )}
        </div>
      )}
    </div>
  );
}

export function HomeSidebar() {
  const { loading: authLoading } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistWithItems[]>([]);
  const [expandedPlaylists, setExpandedPlaylists] = useState<Set<string>>(new Set());
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;

    async function loadWorkspace() {
      // Single parallel pair of calls instead of the old listPlaylists + N×getPlaylist pattern
      const [projectItems, playlistDetails] = await Promise.all([
        api.listProjects().catch(() => [] as Project[]),
        api.listPlaylistsWithItems().catch(() => [] as PlaylistWithItems[]),
      ]);

      if (cancelled) return;
      setProjects(projectItems);
      setPlaylists(playlistDetails);
      setExpandedPlaylists((previous) => {
        if (previous.size > 0) return previous;
        return new Set(playlistDetails.slice(0, 4).map((playlist) => playlist.id));
      });
    }

    loadWorkspace();
    return () => {
      cancelled = true;
    };
  }, [authLoading]);

  const handleRename = useCallback((id: string, newTitle: string) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, title: newTitle } : p));
  }, []);

  const handleDelete = useCallback((id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
  }, []);

  const togglePlaylist = useCallback((id: string) => {
    setExpandedPlaylists((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <>
      <aside className="z-30 flex h-auto w-[100dvw] max-w-[100dvw] shrink-0 flex-col overflow-x-hidden border-b shell-bg lg:h-full lg:w-[320px] lg:max-w-none lg:overflow-hidden lg:border-b-0 lg:border-r">
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
            {playlists.length > 0 && (
              <span className="rounded-full border px-2 py-0.5 text-xs font-semibold shell-muted" style={{ borderColor: 'hsl(var(--shell-border))' }}>
                {playlists.length}
              </span>
            )}
          </div>

          {authLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-14 rounded-lg bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : playlists.length === 0 ? (
            <div className="text-center py-10 px-2">
              <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
                <ListVideo size={18} strokeWidth={1.8} className="shell-muted" aria-hidden />
              </div>
              <p className="text-xs shell-muted mb-3">No playlists yet</p>
              <button
                onClick={() => setCreateOpen(true)}
                className="text-xs font-medium text-primary hover:opacity-80"
              >
                Create a project first
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              {playlists.map((playlist) => (
                <SidebarPlaylistGroup
                  key={playlist.id}
                  playlist={playlist}
                  expanded={expandedPlaylists.has(playlist.id)}
                  onToggle={() => togglePlaylist(playlist.id)}
                />
              ))}

              {projects.length > 0 && (
                <div className="pt-4">
                  <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-widest shell-muted">
                    Recent videos
                  </div>
                  <div className="space-y-1">
                    {projects.slice(0, 5).map(p => (
                      <ProjectCard
                        key={p.id}
                        project={p}
                        onRename={handleRename}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </div>
              )}
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
