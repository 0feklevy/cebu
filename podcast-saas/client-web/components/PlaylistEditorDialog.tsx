'use client';

import { useEffect, useRef, useState, useCallback, type ChangeEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Check, Copy, ExternalLink, GripVertical, ImageIcon, Link2, Loader2, Plus, Search, Sparkles, Trash2, Unlink2, Upload, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { LockPriceControl } from './LockPriceControl';
import type { Project } from 'shared/src/generated/client-v1';

interface Props {
  playlistId: string | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;   // list should refetch
}

interface EditorItem {
  project_id: string;
  title: string | null;
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
      <span
        className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? '#6366f1' : 'hsl(var(--border))' }}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all"
          style={{ left: checked ? 18 : 2 }}
        />
      </span>
    </button>
  );
}

export function PlaylistEditorDialog({ playlistId, open, onClose, onChanged }: Props) {
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [autoplay, setAutoplay] = useState(true);
  const [showSidebar, setShowSidebar] = useState(true);
  const [allowShuffle, setAllowShuffle] = useState(true);
  const [items, setItems] = useState<EditorItem[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [bannerPrompt, setBannerPrompt] = useState('');
  const [bannerProvider, setBannerProvider] = useState<'openai' | 'gemini'>('openai');
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  const dragIndex = useRef<number | null>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !playlistId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([api.getPlaylist(playlistId), api.listProjects(), api.getPlaylistShare(playlistId)])
      .then(([pl, projects, share]) => {
        if (cancelled) return;
        setTitle(pl.title ?? '');
        setDescription(pl.description ?? '');
        setAutoplay(pl.autoplay);
        setShowSidebar(pl.show_sidebar);
        setAllowShuffle(pl.allow_shuffle);
        setItems(pl.items.map((i) => ({ project_id: i.project_id, title: i.title })));
        setBannerUrl(pl.banner_url);
        setBannerPrompt(pl.banner_prompt ?? '');
        setBannerProvider(pl.banner_provider === 'gemini' ? 'gemini' : 'openai');
        setBannerError(null);
        setAllProjects(projects);
        setShareUrl(share.shareUrl);
      })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, playlistId]);

  const projectTitle = (p: Project) => p.title?.trim() || p.topic?.trim() || 'Untitled project';

  const addable = allProjects
    .filter((p) => !items.some((i) => i.project_id === p.id))
    .filter((p) => {
      const q = query.trim().toLowerCase();
      return !q || projectTitle(p).toLowerCase().includes(q);
    });

  const addItem = (p: Project) => setItems((prev) => [...prev, { project_id: p.id, title: projectTitle(p) }]);
  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.project_id !== id));

  const move = (from: number, to: number) => {
    setItems((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const handleSave = useCallback(async () => {
    if (!playlistId) return;
    setSaving(true);
    try {
      await api.updatePlaylist(playlistId, {
        title: title.trim() || 'Untitled playlist',
        description: description.trim() || null,
        autoplay, show_sidebar: showSidebar, allow_shuffle: allowShuffle,
        banner_url: bannerUrl,
        banner_prompt: bannerPrompt.trim() || null,
        banner_provider: bannerUrl ? bannerProvider : null,
      });
      await api.setPlaylistItems(playlistId, items.map((i) => i.project_id));
      onChanged();
      onClose();
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  }, [playlistId, title, description, autoplay, showSidebar, allowShuffle, bannerUrl, bannerPrompt, bannerProvider, items, onChanged, onClose]);

  const handleCreateShare = async () => {
    if (!playlistId) return;
    setShareLoading(true);
    try {
      // Persist current items first so the shared playlist reflects the latest edit.
      await api.setPlaylistItems(playlistId, items.map((i) => i.project_id));
      const { shareUrl } = await api.createPlaylistShare(playlistId);
      setShareUrl(shareUrl);
      onChanged();
    } catch { /* ignore */ } finally {
      setShareLoading(false);
    }
  };

  const handleRevokeShare = async () => {
    if (!playlistId) return;
    setShareLoading(true);
    try {
      await api.revokePlaylistShare(playlistId);
      setShareUrl(null);
    } catch { /* ignore */ } finally {
      setShareLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    try { await navigator.clipboard.writeText(shareUrl); setShareCopied(true); setTimeout(() => setShareCopied(false), 1600); } catch { /* ignore */ }
  };

  const applyPlaylistBanner = (pl: { banner_url: string | null; banner_prompt: string | null; banner_provider: string | null }) => {
    setBannerUrl(pl.banner_url);
    setBannerPrompt(pl.banner_prompt ?? '');
    setBannerProvider(pl.banner_provider === 'gemini' ? 'gemini' : 'openai');
    setBannerError(null);
    onChanged();
  };

  const handleBannerUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!playlistId || !file || bannerBusy) return;
    setBannerBusy(true);
    setBannerError(null);
    try {
      const updated = await api.uploadPlaylistBanner(playlistId, file);
      applyPlaylistBanner(updated);
    } catch (err) {
      setBannerError((err as Error).message || 'Banner upload failed');
    } finally {
      setBannerBusy(false);
    }
  };

  const handleBannerGenerate = async () => {
    if (!playlistId || bannerBusy) return;
    setBannerBusy(true);
    setBannerError(null);
    try {
      const updated = await api.generatePlaylistBanner(playlistId, {
        provider: bannerProvider,
        prompt: bannerPrompt.trim() || null,
      });
      applyPlaylistBanner(updated);
    } catch (err) {
      setBannerError((err as Error).message || 'Banner generation failed');
    } finally {
      setBannerBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!playlistId) return;
    if (!window.confirm('Delete this playlist? This cannot be undone.')) return;
    try { await api.deletePlaylist(playlistId); onChanged(); onClose(); } catch { /* ignore */ }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[900] bg-slate-950/55 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[901] flex h-dvh w-screen -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden border border-border bg-white shadow-modal sm:h-[min(860px,calc(100dvh-24px))] sm:w-[calc(100vw-24px)] sm:max-w-5xl sm:rounded-xl">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5 sm:py-3.5">
            <Dialog.Title className="text-base font-semibold text-foreground">Edit playlist</Dialog.Title>
            <div className="flex items-center gap-2">
              {playlistId && (
                <a
                  href={`/playlists/${playlistId}/view`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-ring"
                >
                  <ExternalLink size={13} strokeWidth={1.8} aria-hidden />
                  Preview
                </a>
              )}
              <Dialog.Close onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring">
                <X size={15} strokeWidth={1.8} aria-hidden />
              </Dialog.Close>
            </div>
          </div>

          {loading ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="animate-spin text-muted-foreground" size={22} />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden lg:grid lg:grid-cols-[1fr_320px]">
              {/* Left: meta + items */}
              <div className="min-h-0 flex-1 overflow-y-auto fine-scrollbar p-4 space-y-4 sm:p-5">
                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <ImageIcon size={16} strokeWidth={1.9} aria-hidden />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-foreground">Playlist banner</p>
                        <p className="text-xs text-muted-foreground">Shown full-screen behind the playlist lobby.</p>
                      </div>
                    </div>
                    <input
                      ref={bannerInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      onChange={handleBannerUpload}
                    />
                    <button
                      onClick={() => bannerInputRef.current?.click()}
                      disabled={bannerBusy}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-40"
                    >
                      <Upload size={13} strokeWidth={1.8} aria-hidden />
                      Upload
                    </button>
                  </div>

                  <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-slate-950">
                    {bannerUrl ? (
                      <img src={bannerUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                    ) : (
                      <div
                        className="flex h-full w-full items-center justify-center"
                        style={{
                          background:
                            'radial-gradient(circle at 22% 20%, rgba(14,165,233,0.42), transparent 32%), radial-gradient(circle at 78% 24%, rgba(168,85,247,0.36), transparent 34%), linear-gradient(135deg,#020617,#111827)',
                        }}
                      >
                        <span className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/70 backdrop-blur">
                          No banner yet
                        </span>
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3">
                      <p className="line-clamp-1 text-sm font-semibold text-white">{title.trim() || 'Untitled playlist'}</p>
                      <p className="text-xs text-white/60">{items.length} video{items.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)_auto]">
                    <select
                      value={bannerProvider}
                      onChange={(e) => setBannerProvider(e.target.value === 'gemini' ? 'gemini' : 'openai')}
                      className="h-9 rounded-lg border border-input bg-white px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25"
                    >
                      <option value="openai">ChatGPT / OpenAI</option>
                      <option value="gemini">Google / Gemini</option>
                    </select>
                    <input
                      value={bannerPrompt}
                      onChange={(e) => setBannerPrompt(e.target.value)}
                      placeholder="Optional image prompt"
                      className="h-9 min-w-0 rounded-lg border border-input bg-white px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25"
                    />
                    <button
                      onClick={handleBannerGenerate}
                      disabled={bannerBusy}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white shadow-sm transition-all hover:brightness-110 disabled:opacity-40"
                      style={{ background: 'linear-gradient(135deg,#7c3aed,#2563eb)' }}
                    >
                      {bannerBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} strokeWidth={1.8} />}
                      Generate
                    </button>
                  </div>

                  <div className="mt-2 flex min-h-[20px] items-center justify-between gap-3">
                    {bannerError ? (
                      <p className="text-xs text-red-500">{bannerError}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Use a 16:9 image. Generated banners are saved immediately.
                      </p>
                    )}
                    {bannerUrl && (
                      <button
                        onClick={() => { setBannerUrl(null); setBannerPrompt(''); }}
                        className="shrink-0 text-xs font-medium text-muted-foreground transition-colors hover:text-red-500"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">Title</label>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Playlist title"
                    className="h-10 w-full rounded-lg border border-input bg-white px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">Description</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    placeholder="What is this playlist about?"
                    className="w-full resize-y rounded-lg border border-input bg-white px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25"
                  />
                </div>

                {/* Items */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label className="text-sm font-medium text-foreground">Videos in playlist</label>
                    <span className="text-xs text-muted-foreground">{items.length}</span>
                  </div>
                  {items.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border bg-muted/25 px-4 py-6 text-center text-xs text-muted-foreground">
                      Add videos from the right panel. Drag to reorder.
                    </div>
                  ) : (
                    <ul className="space-y-1.5">
                      {items.map((it, idx) => (
                        <li
                          key={it.project_id}
                          draggable
                          onDragStart={() => { dragIndex.current = idx; }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => { e.preventDefault(); if (dragIndex.current != null) move(dragIndex.current, idx); dragIndex.current = null; }}
                          className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2"
                        >
                          <GripVertical size={15} className="shrink-0 cursor-grab text-muted-foreground/60" aria-hidden />
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-bold text-muted-foreground">{idx + 1}</span>
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{it.title ?? 'Untitled video'}</span>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button onClick={() => move(idx, idx - 1)} disabled={idx === 0} title="Move up" className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30">
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
                            </button>
                            <button onClick={() => move(idx, idx + 1)} disabled={idx === items.length - 1} title="Move down" className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30">
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                            </button>
                            <button onClick={() => removeItem(it.project_id)} title="Remove" className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                              <Trash2 size={13} strokeWidth={1.8} aria-hidden />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Settings */}
                <div className="space-y-2 border-t border-border/60 pt-4">
                  <p className="text-sm font-medium text-foreground">Playback settings</p>
                  <Toggle checked={autoplay} onChange={setAutoplay} label="Autoplay next" hint="Auto-advance with a countdown at the end of each video" />
                  <Toggle checked={showSidebar} onChange={setShowSidebar} label="Show sidebar" hint="YouTube-style up-next list and description" />
                  <Toggle checked={allowShuffle} onChange={setAllowShuffle} label="Allow shuffle" hint="Show a shuffle button on the lobby" />
                </div>

                {/* Pricing / lock (hidden when Stripe isn't configured) */}
                {playlistId && (
                  <div className="space-y-2 border-t border-border/60 pt-4">
                    <p className="text-sm font-medium text-foreground">Access</p>
                    <LockPriceControl contentType="playlist" contentId={playlistId} />
                  </div>
                )}
              </div>

              {/* Right: add videos + share */}
              <div className="flex min-h-0 max-h-[38dvh] shrink-0 flex-col border-t border-border lg:max-h-none lg:shrink lg:border-l lg:border-t-0">
                <div className="shrink-0 border-b border-border p-3">
                  <p className="mb-2 text-sm font-medium text-foreground">Add videos</p>
                  <label className="relative block">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={14} aria-hidden />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search projects"
                      className="h-9 w-full rounded-lg border border-input bg-white pl-8 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25"
                    />
                  </label>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto fine-scrollbar p-2">
                  {addable.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                      {query.trim() ? 'No matching projects' : 'All projects added'}
                    </p>
                  ) : (
                    addable.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => addItem(p)}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Plus size={13} strokeWidth={2} aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{projectTitle(p)}</span>
                      </button>
                    ))
                  )}
                </div>

                {/* Share */}
                <div className="shrink-0 space-y-2 border-t border-border p-3">
                  <div className="flex items-center gap-1.5">
                    <Link2 size={14} className="text-primary" aria-hidden />
                    <p className="text-sm font-medium text-foreground">Share link</p>
                  </div>
                  {shareUrl ? (
                    <>
                      <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{shareUrl}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button onClick={handleCopy} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold text-white" style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}>
                          {shareCopied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.8} />}
                          {shareCopied ? 'Copied' : 'Copy'}
                        </button>
                        <button onClick={handleRevokeShare} disabled={shareLoading} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-medium text-red-500 transition-colors hover:bg-red-50 disabled:opacity-40">
                          <Unlink2 size={13} strokeWidth={1.8} /> Revoke
                        </button>
                      </div>
                    </>
                  ) : (
                    <button onClick={handleCreateShare} disabled={shareLoading || items.length === 0} className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-40">
                      {shareLoading ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} strokeWidth={1.8} />}
                      Create public link
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-5">
            <button onClick={handleDelete} className="inline-flex items-center gap-1.5 text-xs font-medium text-red-500 transition-colors hover:text-red-600">
              <Trash2 size={13} strokeWidth={1.8} aria-hidden /> Delete playlist
            </button>
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="h-9 rounded-lg border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-ring">Cancel</button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex h-9 items-center gap-2 rounded-lg px-5 text-sm font-semibold text-white shadow-sm transition-all hover:opacity-90 disabled:opacity-40 focus-ring"
                style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
