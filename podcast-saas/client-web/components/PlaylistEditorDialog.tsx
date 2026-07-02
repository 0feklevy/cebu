'use client';

import { useEffect, useRef, useState, useCallback, type ChangeEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Check, Copy, ExternalLink, GripVertical, ImageIcon, Link2,
  Loader2, Plus, Search, Sparkles, Trash2, Unlink2, Upload, X, Play,
} from 'lucide-react';
import { api } from '../lib/api';
import { LockPriceControl } from './LockPriceControl';
import { CollaboratorsSection } from './CollaboratorsSection';
import type { Project } from 'shared/src/generated/client-v1';

interface Props {
  playlistId: string | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

interface EditorItem { project_id: string; title: string | null; thumbnail_url: string | null; }

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm text-foreground">{label}</span>
        {hint && <span className="block text-[11px] text-muted-foreground leading-[1.4]">{hint}</span>}
      </span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="relative h-5 w-9 shrink-0 rounded-full transition-colors focus-ring"
        style={{ background: checked ? '#6366f1' : 'hsl(var(--border))' }}
        role="switch"
        aria-checked={checked}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-card shadow transition-all"
          style={{ left: checked ? 18 : 2 }}
        />
      </button>
    </label>
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
  const [showBannerTools, setShowBannerTools] = useState(false);

  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  const dragIndex = useRef<number | null>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !playlistId) return;
    let cancelled = false;
    setLoading(true);
    setQuery('');
    Promise.all([api.getPlaylist(playlistId), api.listProjects(), api.getPlaylistShare(playlistId)])
      .then(([pl, projects, share]) => {
        if (cancelled) return;
        setTitle(pl.title ?? '');
        setDescription(pl.description ?? '');
        setAutoplay(pl.autoplay);
        setShowSidebar(pl.show_sidebar);
        setAllowShuffle(pl.allow_shuffle);
        setItems(pl.items.map((i) => ({ project_id: i.project_id, title: i.title, thumbnail_url: i.thumbnail_url ?? null })));
        setBannerUrl(pl.banner_url ?? null);
        setBannerPrompt(pl.banner_prompt ?? '');
        setBannerProvider(pl.banner_provider === 'gemini' ? 'gemini' : 'openai');
        setBannerError(null);
        setShowBannerTools(false);
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

  const addItem = (p: Project) => setItems((prev) => [...prev, { project_id: p.id, title: projectTitle(p), thumbnail_url: p.thumbnail_url ?? null }]);
  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.project_id !== id));
  const move = (from: number, to: number) => {
    setItems((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev]; const [m] = next.splice(from, 1); next.splice(to, 0, m); return next;
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
    } catch { /* ignore */ } finally { setSaving(false); }
  }, [playlistId, title, description, autoplay, showSidebar, allowShuffle, bannerUrl, bannerPrompt, bannerProvider, items, onChanged, onClose]);

  const applyBanner = (pl: { banner_url: string | null; banner_prompt: string | null; banner_provider: string | null }) => {
    setBannerUrl(pl.banner_url);
    setBannerPrompt(pl.banner_prompt ?? '');
    setBannerProvider(pl.banner_provider === 'gemini' ? 'gemini' : 'openai');
    setBannerError(null);
    onChanged();
  };

  const handleBannerUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!playlistId || !file || bannerBusy) return;
    setBannerBusy(true); setBannerError(null);
    try { applyBanner(await api.uploadPlaylistBanner(playlistId, file)); }
    catch (err) { setBannerError((err as Error).message || 'Upload failed'); }
    finally { setBannerBusy(false); }
  };

  const handleBannerGenerate = async () => {
    if (!playlistId || bannerBusy) return;
    setBannerBusy(true); setBannerError(null);
    try { applyBanner(await api.generatePlaylistBanner(playlistId, { provider: bannerProvider, prompt: bannerPrompt.trim() || null })); }
    catch (err) { setBannerError((err as Error).message || 'Generation failed'); }
    finally { setBannerBusy(false); }
  };

  const handleCreateShare = async () => {
    if (!playlistId) return;
    setShareLoading(true);
    try {
      await api.setPlaylistItems(playlistId, items.map((i) => i.project_id));
      setShareUrl((await api.createPlaylistShare(playlistId)).shareUrl);
      onChanged();
    } catch { /* ignore */ } finally { setShareLoading(false); }
  };

  const handleRevokeShare = async () => {
    if (!playlistId) return;
    setShareLoading(true);
    try { await api.revokePlaylistShare(playlistId); setShareUrl(null); }
    catch { /* ignore */ } finally { setShareLoading(false); }
  };

  const handleDelete = async () => {
    if (!playlistId) return;
    if (!window.confirm('Delete this playlist? This cannot be undone.')) return;
    try { await api.deletePlaylist(playlistId); onChanged(); onClose(); } catch { /* ignore */ }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[900] bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[901] flex h-dvh w-screen -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden bg-card shadow-2xl sm:h-[min(880px,calc(100dvh-32px))] sm:w-[calc(100vw-32px)] sm:max-w-[1000px] sm:rounded-2xl sm:border sm:border-border data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">

          {/* ── Header ── */}
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3.5">
            <Dialog.Title className="text-[15px] font-semibold text-foreground">Edit playlist</Dialog.Title>
            <div className="flex items-center gap-2">
              {playlistId && (
                <a href={`/playlists/${playlistId}/view`} target="_blank" rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-ring sm:px-3">
                  <ExternalLink size={12} strokeWidth={1.9} aria-hidden />
                  <span className="hidden min-[390px]:inline">Preview</span>
                </a>
              )}
              <Dialog.Close onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring">
                <X size={16} strokeWidth={1.8} aria-hidden />
              </Dialog.Close>
            </div>
          </header>

          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="animate-spin text-muted-foreground" size={24} />
            </div>
          ) : (
            /* ── Two-column body ── */
            <div className="flex min-h-0 flex-1 overflow-hidden sm:grid sm:grid-cols-[minmax(0,1fr)_296px]">

              {/* ── LEFT: Videos ── */}
              <div className="flex min-h-0 flex-col overflow-hidden border-r border-border">
                {/* Title + desc */}
                <div className="shrink-0 space-y-2.5 border-b border-border px-5 py-4">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Playlist title"
                    className="h-10 w-full rounded-lg border border-transparent bg-muted/50 px-3 text-[15px] font-semibold text-foreground transition-colors placeholder:text-muted-foreground/50 hover:border-border focus:border-primary/40 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring/20"
                  />
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    placeholder="Add a description…"
                    className="w-full resize-none rounded-lg border border-transparent bg-muted/40 px-3 py-2 text-sm text-foreground transition-colors placeholder:text-muted-foreground/50 hover:border-border focus:border-primary/40 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring/20"
                  />
                </div>

                {/* Search to add */}
                <div className="shrink-0 border-b border-border/60 px-4 py-2.5">
                  <label className="relative flex items-center gap-2">
                    <Search size={14} className="pointer-events-none absolute left-3 text-muted-foreground" aria-hidden />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search projects to add…"
                      className="h-9 w-full rounded-lg border border-input bg-card pl-8 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25 placeholder:text-muted-foreground/60"
                    />
                  </label>

                  {/* Search results inline */}
                  {query.trim() && (
                    <div className="mt-2 max-h-32 overflow-y-auto rounded-lg border border-border bg-card shadow-sm fine-scrollbar">
                      {addable.length === 0 ? (
                        <p className="py-3 text-center text-xs text-muted-foreground">No matching projects</p>
                      ) : addable.slice(0, 8).map((p) => (
                        <button
                          key={p.id}
                          onClick={() => { addItem(p); setQuery(''); }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/60"
                        >
                          <span className="relative h-8 w-12 shrink-0 overflow-hidden rounded-md bg-primary/8">
                            {p.thumbnail_url ? (
                              <img
                                src={p.thumbnail_url}
                                alt=""
                                className="h-full w-full object-cover"
                                draggable={false}
                                onError={(event) => { event.currentTarget.style.display = 'none'; }}
                              />
                            ) : null}
                            <span className="absolute inset-0 flex items-center justify-center text-primary">
                              <Plus size={11} strokeWidth={2.5} aria-hidden />
                            </span>
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{projectTitle(p)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Video list */}
                <div className="min-h-0 flex-1 overflow-y-auto fine-scrollbar px-4 py-3">
                  {items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-dashed border-border">
                        <Play size={18} strokeWidth={1.5} className="text-muted-foreground/50" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">No videos yet</p>
                        <p className="mt-1 text-xs text-muted-foreground">Search above to add projects to this playlist</p>
                      </div>
                    </div>
                  ) : (
                    <ul className="space-y-1">
                      {items.map((it, idx) => (
                        <li
                          key={it.project_id}
                          draggable
                          onDragStart={() => { dragIndex.current = idx; }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => { e.preventDefault(); if (dragIndex.current != null) { move(dragIndex.current, idx); dragIndex.current = null; } }}
                          className="group flex items-center gap-2 rounded-lg border border-transparent bg-muted/30 px-2.5 py-2 transition-colors hover:border-border/70 hover:bg-muted/50"
                        >
                          <GripVertical size={14} className="shrink-0 cursor-grab text-muted-foreground/40 group-hover:text-muted-foreground/70" aria-hidden />
                          <span className="relative h-9 w-14 shrink-0 overflow-hidden rounded-md bg-primary/8 text-[10px] font-bold text-primary/70">
                            {it.thumbnail_url ? (
                              <img
                                src={it.thumbnail_url}
                                alt=""
                                className="h-full w-full object-cover"
                                draggable={false}
                                onError={(event) => { event.currentTarget.style.display = 'none'; }}
                              />
                            ) : null}
                            <span className="absolute left-1 top-1 rounded bg-black/55 px-1 text-[9px] font-bold text-white">{idx + 1}</span>
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{it.title ?? 'Untitled video'}</span>
                          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <button onClick={() => move(idx, idx - 1)} disabled={idx === 0} title="Move up" className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-20">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
                            </button>
                            <button onClick={() => move(idx, idx + 1)} disabled={idx === items.length - 1} title="Move down" className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-20">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                            </button>
                            <button onClick={() => removeItem(it.project_id)} title="Remove" className="rounded p-1 text-muted-foreground hover:text-destructive">
                              <X size={12} strokeWidth={2} aria-hidden />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Quick add — non-search list */}
                  {!query.trim() && addable.length > 0 && (
                    <div className="mt-4 border-t border-border/50 pt-3">
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">Add from library</p>
                      <div className="space-y-0.5">
                        {addable.slice(0, 6).map((p) => (
                          <button
                            key={p.id}
                            onClick={() => addItem(p)}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
                          >
                            <span className="relative h-8 w-12 shrink-0 overflow-hidden rounded-md bg-primary/8 text-primary">
                              {p.thumbnail_url ? (
                                <img
                                  src={p.thumbnail_url}
                                  alt=""
                                  className="h-full w-full object-cover"
                                  draggable={false}
                                  onError={(event) => { event.currentTarget.style.display = 'none'; }}
                                />
                              ) : null}
                              <span className="absolute inset-0 flex items-center justify-center">
                                <Plus size={11} strokeWidth={2.5} aria-hidden />
                              </span>
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{projectTitle(p)}</span>
                          </button>
                        ))}
                        {addable.length > 6 && (
                          <p className="pt-1 text-center text-xs text-muted-foreground">Search to find more</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── RIGHT: Details sidebar ── */}
              <div className="flex min-h-0 max-h-[55dvh] shrink-0 flex-col overflow-y-auto fine-scrollbar sm:max-h-none">

                {/* Banner */}
                <section className="border-b border-border p-4">
                  <div className="relative overflow-hidden rounded-lg" style={{ aspectRatio: '16/7' }}>
                    {bannerUrl ? (
                      <img src={bannerUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center" style={{ background: 'radial-gradient(circle at 20% 50%, rgba(99,102,241,0.35), transparent 60%), linear-gradient(135deg,#080818,#181828)' }}>
                        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-card/8">
                          <ImageIcon size={18} strokeWidth={1.5} className="text-white/40" />
                        </span>
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3">
                      <p className="line-clamp-1 text-xs font-semibold text-white/90">{title.trim() || 'Untitled playlist'}</p>
                      <p className="text-[10px] text-white/50">{items.length} video{items.length !== 1 ? 's' : ''}</p>
                    </div>
                    {/* Hover overlay */}
                    <button
                      onClick={() => setShowBannerTools((v) => !v)}
                      className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all hover:bg-black/30 hover:opacity-100"
                    >
                      <span className="rounded-lg bg-black/50 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-sm">Edit banner</span>
                    </button>
                  </div>

                  {showBannerTools && (
                    <div className="mt-2.5 space-y-2">
                      <div className="flex gap-2">
                        <button onClick={() => bannerInputRef.current?.click()} disabled={bannerBusy}
                          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40">
                          <Upload size={12} strokeWidth={1.9} aria-hidden />
                          Upload
                        </button>
                        {bannerUrl && (
                          <button onClick={() => { setBannerUrl(null); setBannerPrompt(''); }} className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-2.5 text-xs text-muted-foreground hover:text-red-500 transition-colors">
                            <Trash2 size={12} strokeWidth={1.8} aria-hidden />
                          </button>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <select value={bannerProvider} onChange={(e) => setBannerProvider(e.target.value === 'gemini' ? 'gemini' : 'openai')}
                          className="h-8 w-24 shrink-0 rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25">
                          <option value="openai">OpenAI</option>
                          <option value="gemini">Gemini</option>
                        </select>
                        <input value={bannerPrompt} onChange={(e) => setBannerPrompt(e.target.value)} placeholder="Prompt (optional)"
                          className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-card px-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25" />
                        <button onClick={handleBannerGenerate} disabled={bannerBusy}
                          className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-semibold text-white disabled:opacity-40"
                          style={{ background: 'linear-gradient(135deg,#7c3aed,#2563eb)' }}>
                          {bannerBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} strokeWidth={1.8} />}
                        </button>
                      </div>
                      {bannerError && <p className="text-[11px] text-red-500">{bannerError}</p>}
                    </div>
                  )}
                  <input ref={bannerInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={handleBannerUpload} />
                </section>

                {/* Playback settings */}
                <section className="border-b border-border px-4 py-4 space-y-3">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60">Playback</p>
                  <Toggle checked={autoplay} onChange={setAutoplay} label="Autoplay" hint="Auto-advance with countdown" />
                  <Toggle checked={showSidebar} onChange={setShowSidebar} label="Show sidebar" hint="Up-next list during playback" />
                  <Toggle checked={allowShuffle} onChange={setAllowShuffle} label="Shuffle" hint="Show shuffle on the lobby" />
                </section>

                {/* Share */}
                <section className="border-b border-border px-4 py-4 space-y-2.5">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60">Share link</p>
                  {shareUrl ? (
                    <>
                      <div className="rounded-xl border border-border bg-background p-1.5 shadow-sm-soft">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
                            <Check size={13} strokeWidth={2.1} aria-hidden />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={shareUrl}>{shareUrl}</span>
                          <button
                            onClick={async () => { try { await navigator.clipboard.writeText(shareUrl); setShareCopied(true); setTimeout(() => setShareCopied(false), 1500); } catch {} }}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring"
                            title={shareCopied ? 'Copied' : 'Copy link'}
                            aria-label={shareCopied ? 'Copied' : 'Copy playlist share link'}
                          >
                            {shareCopied ? <Check size={14} strokeWidth={2.4} /> : <Copy size={14} strokeWidth={1.9} />}
                          </button>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <a href={shareUrl} target="_blank" rel="noreferrer"
                          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring">
                          <ExternalLink size={12} strokeWidth={1.9} aria-hidden />
                          Open viewer
                        </a>
                        <button onClick={handleRevokeShare} disabled={shareLoading}
                          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100 disabled:opacity-40 focus-ring">
                          {shareLoading ? <Loader2 size={12} className="animate-spin" /> : <Unlink2 size={12} strokeWidth={1.8} aria-hidden />}
                          Revoke link
                        </button>
                      </div>
                      <p className="text-[11px] leading-5 text-muted-foreground">Revoking disables this playlist URL immediately.</p>
                    </>
                  ) : (
                    <button onClick={handleCreateShare} disabled={shareLoading || items.length === 0}
                      className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-40">
                      {shareLoading ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} strokeWidth={1.9} />}
                      Create public link
                    </button>
                  )}
                </section>

                {/* Access / lock */}
                {playlistId && (
                  <section className="border-b border-border px-4 py-4 space-y-2">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60">Access</p>
                    <LockPriceControl contentType="playlist" contentId={playlistId} bordered={false} />
                  </section>
                )}

                {/* Collaboration */}
                {playlistId && (
                  <section className="border-b border-border px-4 py-4 space-y-2.5">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60">Collaborators</p>
                    <CollaboratorsSection contentType="playlist" contentId={playlistId} />
                  </section>
                )}

                {/* Danger */}
                <div className="px-4 py-3 mt-auto">
                  <button onClick={handleDelete}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-red-500">
                    <Trash2 size={12} strokeWidth={1.8} aria-hidden />
                    Delete playlist
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Footer ── */}
          <footer className="flex shrink-0 items-center justify-end gap-2.5 border-t border-border px-5 py-3">
            <button onClick={onClose}
              className="h-9 rounded-lg border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-ring">
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              className="inline-flex h-9 items-center gap-2 rounded-lg px-5 text-sm font-semibold text-white shadow-sm transition-all hover:opacity-90 disabled:opacity-40 focus-ring"
              style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}>
              {saving && <Loader2 size={14} className="animate-spin" />}
              Save changes
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
