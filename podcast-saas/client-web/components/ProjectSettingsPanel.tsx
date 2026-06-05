'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crop, Loader2, RefreshCw, Settings, Sparkles, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { LockPriceControl } from './LockPriceControl';
import type { Project, VideoFile } from 'shared/src/generated/client-v1';

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

  // Crop state
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [cropping, setCropping] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);

  // Generate controls
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<'gpt-4o-mini' | 'gpt-4o'>('gpt-4o-mini');
  const [regenerating, setRegenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [canPortal, setCanPortal] = useState(false);
  const thumbInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setCanPortal(true), []);

  // Sync from project
  useEffect(() => {
    setTitle(project?.title ?? '');
    setDesc(project?.topic ?? '');
  }, [project?.title, project?.topic]);

  // Load videos when panel opens
  useEffect(() => {
    if (!open) return;
    api.listVideos(projectId).then(setVideos).catch(() => {});
  }, [open, projectId]);

  // Poll crop status while any video is processing
  useEffect(() => {
    const mainVideos = videos.filter(v => !v.is_broll);
    const anyProcessing = mainVideos.some(v => v.crop_status === 'processing' || v.crop_status === 'none' && cropping);
    if (!anyProcessing) return;
    const timer = setInterval(() => {
      api.listVideos(projectId).then(setVideos).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [videos, cropping, projectId]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  const saveMeta = async () => {
    setSavingMeta(true);
    try {
      const updated = await api.updateProjectMeta(projectId, {
        title: title.trim() || '',
        description: desc.trim() || null,
      });
      onProjectChange(updated);
      setSavedMeta(true);
      setTimeout(() => setSavedMeta(false), 1500);
    } catch { /* ignore */ } finally { setSavingMeta(false); }
  };

  const regen = async () => {
    setRegenerating(true);
    setGenError(null);
    try {
      await api.regenerateVideoMetadata(projectId, {
        prompt: prompt.trim() || undefined,
        model,
      });
      // Poll until ready (max 60s)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const updated = await api.getProject(projectId).catch(() => null);
        if (updated) {
          onProjectChange(updated);
          setTitle(updated.title ?? '');
          setDesc(updated.topic ?? '');
          if (updated.metadata_status === 'ready') break;
          if (updated.metadata_status === 'failed') { setGenError('Generation failed — check OPENAI_API_KEY'); break; }
        }
      }
    } catch (e) {
      setGenError((e as Error).message?.slice(0, 120));
    } finally { setRegenerating(false); }
  };

  const recrop = async () => {
    setCropping(true);
    setCropError(null);
    try {
      await api.recropProject(projectId);
      const updated = await api.listVideos(projectId);
      setVideos(updated);
    } catch (e) {
      setCropError((e as Error).message?.slice(0, 120));
    } finally {
      setCropping(false);
    }
  };

  const mainVideos = videos.filter(v => !v.is_broll && v.crop_status !== 'none');
  const lastCropTime = mainVideos.reduce<string | null>((latest, v) => {
    if (!v.crop_updated_at) return latest;
    if (!latest || v.crop_updated_at > latest) return v.crop_updated_at;
    return latest;
  }, null);
  const anyCropProcessing = videos.some(v => !v.is_broll && v.crop_status === 'processing');

  const thumbnailUrl = project?.thumbnail_url ?? null;
  const isGenerating = regenerating || project?.metadata_status === 'processing';

  const modal = !open ? null : (
    <>
      {/* Backdrop — same as SectionEditor */}
      <div
        onClick={() => setOpen(false)}
        style={{
          position: 'fixed', inset: 0,
          backgroundColor: 'rgba(2,6,23,0.55)',
          backdropFilter: 'blur(10px)',
          zIndex: 800,
        }}
      />

      {/* Modal window — centered, same style as SectionEditor */}
      <div
        style={{
          position: 'fixed',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 801,
          width: 'min(560px, 96vw)',
          maxHeight: '92dvh',
          display: 'flex', flexDirection: 'column',
          backgroundColor: '#ffffff',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.22), 0 4px 16px rgba(0,0,0,0.10)',
          overflow: 'hidden',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Settings size={16} strokeWidth={1.8} color="#6b7280" />
            <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>Video settings</span>
          </div>
          <button
            onClick={() => setOpen(false)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: '#9ca3af' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <X size={16} strokeWidth={1.8} aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>

          {/* ── Thumbnail ─────────────────────────────────────────────────── */}
          <div style={{ paddingTop: 20, paddingBottom: 20, borderBottom: '1px solid #f3f4f6' }}>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9ca3af', marginBottom: 12 }}>Thumbnail</p>

            {/* Preview */}
            <div style={{ position: 'relative', width: '100%', aspectRatio: '16/7', borderRadius: 8, overflow: 'hidden', background: '#f9fafb', border: '1px solid #e5e7eb', marginBottom: 12 }}>
              {isGenerating ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: '#9ca3af' }}>
                  <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
                  <span style={{ fontSize: 13 }}>Generating…</span>
                </div>
              ) : thumbnailUrl ? (
                <img src={thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} draggable={false} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 6, color: '#d1d5db' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9l4-4 4 4 5-5 5 5"/></svg>
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>No thumbnail yet</span>
                </div>
              )}
            </div>

            {/* Prompt input */}
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                Prompt <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>(optional — helps AI understand the video)</span>
              </label>
              <input
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder='e.g. "A podcast about AI and tech, two hosts in a studio"'
                style={{ width: '100%', height: 36, border: '1px solid #d1d5db', borderRadius: 8, padding: '0 12px', fontSize: 13, color: '#111827', outline: 'none', boxSizing: 'border-box', background: '#fafafa' }}
                onFocus={e => (e.target.style.borderColor = '#a855f7')}
                onBlur={e => (e.target.style.borderColor = '#d1d5db')}
              />
            </div>

            {/* Model + generate row */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                value={model}
                onChange={e => setModel(e.target.value as 'gpt-4o-mini' | 'gpt-4o')}
                style={{ height: 36, border: '1px solid #d1d5db', borderRadius: 8, padding: '0 8px', fontSize: 12, color: '#374151', background: '#fff', cursor: 'pointer', outline: 'none' }}
              >
                <option value="gpt-4o-mini">GPT-4o mini — faster</option>
                <option value="gpt-4o">GPT-4o — best quality</option>
              </select>

              <button
                onClick={regen}
                disabled={isGenerating}
                style={{
                  flex: 1, height: 36, border: 'none', borderRadius: 8,
                  background: isGenerating ? '#e5e7eb' : 'linear-gradient(135deg,#a855f7,#6366f1)',
                  color: isGenerating ? '#9ca3af' : '#fff',
                  fontSize: 13, fontWeight: 600, cursor: isGenerating ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                {isGenerating
                  ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Generating…</>
                  : <><Sparkles size={13} strokeWidth={2} /> {thumbnailUrl ? 'Regenerate' : 'Generate'}</>
                }
              </button>

              <input
                ref={thumbInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: 'none' }}
                onChange={async e => { e.target.value = ''; await regen(); }}
              />
              <button
                onClick={() => thumbInputRef.current?.click()}
                title="Upload thumbnail"
                disabled={isGenerating}
                style={{ width: 36, height: 36, border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', flexShrink: 0 }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
              >
                <Upload size={13} strokeWidth={1.9} />
              </button>
            </div>

            {genError && <p style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{genError}</p>}
            <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
              Extracts a frame from your video · used as the thumbnail in playlists
            </p>
          </div>

          {/* ── Name & Description ────────────────────────────────────────── */}
          <div style={{ paddingTop: 20, paddingBottom: 20, borderBottom: '1px solid #f3f4f6' }}>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9ca3af', marginBottom: 12 }}>Details</p>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Name</label>
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Video name"
                style={{ width: '100%', height: 38, border: '1px solid #d1d5db', borderRadius: 8, padding: '0 12px', fontSize: 14, color: '#111827', outline: 'none', boxSizing: 'border-box', background: '#fafafa' }}
                onFocus={e => (e.target.style.borderColor = '#a855f7')}
                onBlur={e => (e.target.style.borderColor = '#d1d5db')}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Description</label>
              <textarea
                value={desc}
                onChange={e => setDesc(e.target.value)}
                rows={3}
                placeholder="What is this video about?"
                style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#111827', outline: 'none', boxSizing: 'border-box', resize: 'none', background: '#fafafa', fontFamily: 'inherit' }}
                onFocus={e => (e.target.style.borderColor = '#a855f7')}
                onBlur={e => (e.target.style.borderColor = '#d1d5db')}
              />
            </div>

            <button
              onClick={saveMeta}
              disabled={savingMeta}
              style={{
                width: '100%', height: 38, border: 'none', borderRadius: 8,
                background: savedMeta ? '#10b981' : 'linear-gradient(135deg,#a855f7,#6366f1)',
                color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: savingMeta ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                opacity: savingMeta ? 0.7 : 1, transition: 'background 0.2s',
              }}
            >
              {savingMeta
                ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</>
                : savedMeta ? '✓ Saved' : 'Save changes'
              }
            </button>
          </div>

          {/* ── Smart Crop ───────────────────────────────────────────────── */}
          <div style={{ paddingTop: 20, paddingBottom: 20, borderBottom: '1px solid #f3f4f6' }}>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9ca3af', marginBottom: 12 }}>Smart Crop</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={recrop}
                disabled={cropping || anyCropProcessing}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  height: 36, padding: '0 16px', border: 'none', borderRadius: 8,
                  background: (cropping || anyCropProcessing) ? '#e5e7eb' : 'linear-gradient(135deg,#a855f7,#6366f1)',
                  color: (cropping || anyCropProcessing) ? '#9ca3af' : '#fff',
                  fontSize: 13, fontWeight: 600,
                  cursor: (cropping || anyCropProcessing) ? 'not-allowed' : 'pointer',
                  flexShrink: 0,
                }}
              >
                {(cropping || anyCropProcessing)
                  ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Cropping…</>
                  : <><Crop size={13} strokeWidth={2} /> Recrop</>
                }
              </button>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>
                {anyCropProcessing
                  ? 'Running…'
                  : lastCropTime
                    ? `Last cropped ${new Date(lastCropTime).toLocaleString()}`
                    : 'Never cropped'
                }
              </span>
            </div>
            {cropError && <p style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{cropError}</p>}
            <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
              Re-runs the smart portrait-crop pipeline · detects active speakers for 9:16 framing
            </p>
          </div>

          {/* ── Access / Lock ─────────────────────────────────────────────── */}
          <div style={{ paddingTop: 20 }}>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9ca3af', marginBottom: 12 }}>Access</p>
            <LockPriceControl contentType="project" contentId={projectId} bordered={false} />
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors focus-ring ${
          open
            ? 'border-primary/40 bg-primary/8 text-primary'
            : 'shell-muted shell-hover hover:text-[hsl(var(--shell-foreground))]'
        }`}
        style={{ borderColor: open ? undefined : 'hsl(var(--shell-border))' }}
      >
        <Settings size={13} strokeWidth={1.8} aria-hidden />
        Settings
      </button>

      {canPortal && createPortal(
        <>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          {modal}
        </>,
        document.body,
      )}
    </>
  );
}
