'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RefreshCw, Settings, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { LockPriceControl } from './LockPriceControl';
import type { Project } from 'shared/src/generated/client-v1';

interface Props {
  projectId: string;
  project: Project | null;
  onProjectChange: (p: Project) => void;
}

export function ProjectSettingsPanel({ projectId, project, onProjectChange }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [savedMeta, setSavedMeta] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [canPortal, setCanPortal] = useState(false);
  const thumbInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setCanPortal(true), []);

  // Sync local state from project
  useEffect(() => {
    setTitle(project?.title ?? '');
    setDesc(project?.topic ?? '');
  }, [project?.title, project?.topic]);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onMouse = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouse);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onMouse); };
  }, [open]);

  const saveMeta = async () => {
    setSavingMeta(true);
    try {
      const updated = await api.updateProjectMeta(projectId, {
        title:       title.trim() || '',
        description: desc.trim() || null,
      });
      onProjectChange(updated);
      setSavedMeta(true);
      setTimeout(() => setSavedMeta(false), 1500);
    } catch { /* ignore */ } finally { setSavingMeta(false); }
  };

  const regen = async () => {
    setRegenerating(true);
    try {
      await api.regenerateVideoMetadata(projectId);
      // Poll until metadata_status = ready (max 60 s)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const updated = await api.getProject(projectId).catch(() => null);
        if (updated) {
          onProjectChange(updated);
          setTitle(updated.title ?? '');
          setDesc(updated.topic ?? '');
          if (updated.metadata_status === 'ready' || updated.metadata_status === 'failed') break;
        }
      }
    } catch { /* ignore */ } finally { setRegenerating(false); }
  };

  const uploadThumb = async (file: File) => {
    // Direct upload via the existing image upload, store as thumbnail
    // We use the generate-metadata route to handle it server-side
    // For now, just trigger regen which handles both
    await regen();
  };

  const thumbnailUrl = project?.thumbnail_url ?? null;
  const isGenerating = regenerating || project?.metadata_status === 'processing';

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(v => !v)}
        aria-label="Video settings"
        title="Settings"
        className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors focus-ring ${
          open ? 'border-primary/40 bg-primary/8 text-primary' : 'border-transparent shell-muted shell-hover hover:text-[hsl(var(--shell-foreground))]'
        }`}
        style={{ borderColor: open ? undefined : 'hsl(var(--shell-border))' }}
      >
        <Settings size={14} strokeWidth={1.8} aria-hidden />
      </button>

      {/* Panel */}
      {canPortal && open && createPortal(
        <div
          ref={panelRef}
          className="fixed right-0 top-[48px] bottom-0 z-[9999] flex w-[min(360px,100vw)] flex-col overflow-hidden shadow-2xl"
          style={{ background: 'hsl(var(--background))', borderLeft: '1px solid hsl(var(--border))' }}
        >
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Settings size={15} strokeWidth={1.8} className="text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Video settings</h2>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X size={15} strokeWidth={1.8} aria-hidden />
            </button>
          </div>

          {/* Scrollable body */}
          <div className="min-h-0 flex-1 overflow-y-auto fine-scrollbar divide-y divide-border/60">

            {/* ── Thumbnail ─────────────────────────────────────────── */}
            <section className="px-4 py-4 space-y-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60">Thumbnail</p>

              <div className="relative aspect-video overflow-hidden rounded-lg bg-muted/40">
                {isGenerating ? (
                  <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
                    <Loader2 size={18} className="animate-spin" />
                    <span className="text-xs">Generating…</span>
                  </div>
                ) : thumbnailUrl ? (
                  <img
                    src={thumbnailUrl}
                    alt="Video thumbnail"
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/50">
                    <div className="h-8 w-8 rounded-lg border-2 border-dashed border-current opacity-40" />
                    <p className="text-xs">No thumbnail yet</p>
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={regen}
                  disabled={isGenerating}
                  className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
                >
                  {isGenerating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} strokeWidth={2} />}
                  {thumbnailUrl ? 'Regenerate' : 'Generate'}
                </button>
                <input
                  ref={thumbInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) await uploadThumb(f); }}
                />
                <button
                  onClick={() => thumbInputRef.current?.click()}
                  disabled={isGenerating}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40"
                >
                  <Upload size={12} strokeWidth={1.9} />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground/60">
                Auto-generated from the first frame · used in playlists
              </p>
            </section>

            {/* ── Name & Description ────────────────────────────────── */}
            <section className="px-4 py-4 space-y-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60">Details</p>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">Name</label>
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="Video name"
                  className="h-9 w-full rounded-lg border border-input bg-muted/30 px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground/50 focus:border-primary/40 focus:bg-white focus:outline-none focus:ring-2 focus:ring-ring/20"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">Description</label>
                <textarea
                  value={desc}
                  onChange={e => setDesc(e.target.value)}
                  rows={3}
                  placeholder="What is this video about?"
                  className="w-full resize-none rounded-lg border border-input bg-muted/30 px-3 py-2 text-sm text-foreground transition-colors placeholder:text-muted-foreground/50 focus:border-primary/40 focus:bg-white focus:outline-none focus:ring-2 focus:ring-ring/20"
                />
              </div>

              <button
                onClick={saveMeta}
                disabled={savingMeta}
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg text-xs font-semibold text-white shadow-sm transition-all hover:opacity-90 disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
              >
                {savingMeta && <Loader2 size={13} className="animate-spin" />}
                {savedMeta ? '✓ Saved' : 'Save changes'}
              </button>
            </section>

            {/* ── Premium / Lock ────────────────────────────────────── */}
            <section className="px-4 py-4 space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60">Access</p>
              <LockPriceControl contentType="project" contentId={projectId} bordered={false} />
            </section>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
