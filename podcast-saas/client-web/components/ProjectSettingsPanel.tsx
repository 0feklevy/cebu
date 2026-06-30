'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crop, Film, Loader2, Settings, Sparkles, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { LockPriceControl } from './LockPriceControl';
import { AvatarSettingsModal } from './avatar/AvatarSettingsModal';
import { AvatarCirclesSettings } from './avatar/AvatarCirclesSettings';
import type { Project, VideoFile } from 'shared/src/generated/client-v1';

interface Props {
  projectId: string;
  project: Project | null;
  onProjectChange: (p: Project) => void;
}

export function ProjectSettingsPanel({ projectId, project, onProjectChange }: Props) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<'main' | 'avatar' | 'circles'>('main');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [savedMeta, setSavedMeta] = useState(false);
  const [genMeta, setGenMeta] = useState(false);
  const [genMetaError, setGenMetaError] = useState<string | null>(null);

  // Crop state
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [cropping, setCropping] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);

  // Generate controls
  const [thumbMode, setThumbMode] = useState<'ai' | 'timeline'>('ai');
  const [prompt, setPrompt] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [uploadingThumb, setUploadingThumb] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [timelineSec, setTimelineSec] = useState(0);
  const [pickingThumb, setPickingThumb] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  // Frame preview (JPEG from server, debounced)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevBlobRef = useRef<string | null>(null);

  const [isCompact, setIsCompact] = useState(false);
  const [canPortal, setCanPortal] = useState(false);
  const thumbInputRef = useRef<HTMLInputElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);

  // Focus management + trap for the settings modal: focus into it on open, keep Tab inside,
  // close on Escape, restore focus on close (a11y — ui-ux-003, mirrors AvatarPopup).
  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    settingsPanelRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key === 'Tab' && settingsPanelRef.current) {
        const f = settingsPanelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (f.length === 0) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); prevActive?.focus?.(); };
  }, [open]);

  useEffect(() => setCanPortal(true), []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 900px), (max-height: 680px)');
    const sync = () => setIsCompact(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

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
    const anyProcessing = mainVideos.some(
      v => v.crop_status === 'processing' || (v.crop_status === 'none' && cropping)
        || v.hls_status === 'pending' || v.hls_status === 'processing',
    );
    if (!anyProcessing) return;
    const timer = setInterval(() => {
      api.listVideos(projectId).then(setVideos).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [videos, cropping, projectId]);

  // Reset preview when switching away from timeline mode
  useEffect(() => {
    if (thumbMode !== 'timeline') {
      setPreviewUrl(null);
      setPreviewLoading(false);
    }
  }, [thumbMode]);

  // Revoke old blob URL on unmount
  useEffect(() => () => {
    if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current);
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
  }, []);

  // Reset to the main page whenever the panel closes
  useEffect(() => { if (!open) setPage('main'); }, [open]);

  // Escape: on the avatar wizard page go back to main; otherwise close the panel
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (page === 'avatar' || page === 'circles') setPage('main'); else setOpen(false); } };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, page]);

  // Debounced frame preview fetch (600ms after slider stops)
  const fetchPreview = useCallback((sec: number) => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const url = await api.getFramePreview(projectId, sec);
        if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current);
        prevBlobRef.current = url;
        setPreviewUrl(url);
      } catch {
        // preview failed silently — user still sees timestamp
      } finally {
        setPreviewLoading(false);
      }
    }, 600);
  }, [projectId]);

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

  // AI-generate the title + description (SEO) from the video's transcript/captions. The backend
  // job (regenerateVideoMetadata) is async, so poll the project until metadata is ready.
  const generateDetails = async () => {
    setGenMeta(true);
    setGenMetaError(null);
    try {
      await api.regenerateVideoMetadata(projectId);
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const p = await api.getProject(projectId).catch(() => null);
        if (!p) continue;
        if (p.metadata_status === 'ready') { onProjectChange(p); setTitle(p.title ?? ''); setDesc(p.topic ?? ''); return; }
        if (p.metadata_status === 'failed') { setGenMetaError('Generation failed. Please try again.'); return; }
      }
      setGenMetaError('Still generating — reopen settings shortly to see the result.');
    } catch (e) {
      setGenMetaError((e as Error).message?.slice(0, 160) || 'Generation failed');
    } finally {
      setGenMeta(false);
    }
  };

  const [savingVisibility, setSavingVisibility] = useState(false);
  const changeVisibility = async (v: 'private' | 'unlisted' | 'public') => {
    setSavingVisibility(true);
    try {
      onProjectChange(await api.setProjectVisibility(projectId, v));
    } catch { /* ignore */ } finally { setSavingVisibility(false); }
  };

  // Generate a NEW thumbnail IMAGE with an image model (gpt-image-1) from the
  // video's known info (title + SEO summary/keywords) + the optional hint.
  const genAiThumb = async () => {
    setRegenerating(true);
    setGenError(null);
    try {
      const { project: updated } = await api.generateAiThumbnail(projectId, prompt.trim() || undefined);
      if (updated) {
        onProjectChange(updated);
        setTitle(updated.title ?? '');
        setDesc(updated.topic ?? '');
      }
    } catch (e) {
      setGenError((e as Error).message?.slice(0, 160) || 'AI generation failed');
    } finally { setRegenerating(false); }
  };

  const uploadThumbnail = async (file: File) => {
    setUploadingThumb(true);
    setGenError(null);
    try {
      const updated = await api.uploadProjectThumbnail(projectId, file);
      onProjectChange(updated);
      setTitle(updated.title ?? '');
      setDesc(updated.topic ?? '');
      setThumbMode('ai');
    } catch (e) {
      setGenError((e as Error).message?.slice(0, 120) || 'Upload failed');
    } finally {
      setUploadingThumb(false);
    }
  };

  const recrop = async () => {
    setCropping(true);
    setCropError(null);
    try {
      await api.recropProject(projectId);
      // Poll up to 6s to catch the 'none' → 'processing' transition
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const updated = await api.listVideos(projectId);
        setVideos(updated);
        if (updated.some(v => !v.is_broll && v.crop_status === 'processing')) break;
      }
    } catch (e) {
      setCropError((e as Error).message?.slice(0, 120));
    } finally {
      setCropping(false);
    }
  };

  const pickFromTimeline = async () => {
    setPickingThumb(true);
    setPickError(null);
    try {
      const result = await api.thumbnailFromTimeline(projectId, timelineSec);
      const updated = await api.getProject(projectId).catch(() => null);
      if (updated) onProjectChange({ ...updated, thumbnail_url: result.thumbnail_url });
    } catch (e) {
      setPickError((e as Error).message?.slice(0, 120));
    } finally { setPickingThumb(false); }
  };

  const mainVideos = videos.filter(v => !v.is_broll && v.crop_status !== 'none');
  const lastCropTime = mainVideos.reduce<string | null>((latest, v) => {
    if (!v.crop_updated_at) return latest;
    if (!latest || v.crop_updated_at > latest) return v.crop_updated_at;
    return latest;
  }, null);
  const anyCropProcessing = videos.some(v => !v.is_broll && v.crop_status === 'processing');
  const anyCropReady = videos.some(v => !v.is_broll && v.crop_status === 'ready');
  const anyCropFailed = videos.some(v => !v.is_broll && v.crop_status === 'failed');

  // "From Timeline" needs the main clip transcoded — disable + warn while it's still processing.
  const mainClipProcessing = videos.length > 0 && videos.some(v => !v.is_broll && (v.hls_status === 'pending' || v.hls_status === 'processing'));

  const thumbnailUrl = project?.thumbnail_url ?? null;
  const isGenerating = regenerating || uploadingThumb || project?.metadata_status === 'processing';

  const mainVid = videos.find(v => !v.is_broll);
  const dur = mainVid?.duration_sec ?? 0;
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const inputStyle: React.CSSProperties = {
    width: '100%', height: 40, border: '1px solid #e2e8f0', borderRadius: 8,
    padding: '0 14px', fontSize: 14, color: 'hsl(var(--foreground))', outline: 'none',
    boxSizing: 'border-box', background: '#fff', fontFamily: 'inherit',
  };

  const btnStyle = (active: boolean): React.CSSProperties => ({
    width: '100%', height: 38, border: 'none', borderRadius: 8,
    background: active ? '#e5e7eb' : 'linear-gradient(135deg,#a855f7,#6366f1)',
    color: active ? '#9ca3af' : '#fff',
    fontSize: 13, fontWeight: 600, cursor: active ? 'not-allowed' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  });

  const sectionCardStyle: React.CSSProperties = {
    backgroundColor: 'hsl(var(--card))',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  };

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    flexWrap: 'wrap',
  };

  const sectionKickerStyle: React.CSSProperties = {
    fontSize: 10,
    color: '#4338ca',
    background: '#eef2ff',
    borderRadius: 6,
    padding: '2px 8px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  };

  const sectionTitleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: 13,
    fontWeight: 700,
    color: '#0f172a',
  };

  const settingsActionCard = (color: string, from: string, to: string): React.CSSProperties => ({
    minWidth: 0,
    minHeight: 84,
    padding: '12px',
    borderRadius: 10,
    border: '1px solid #e2e8f0',
    background: `linear-gradient(135deg, ${from}, ${to})`,
    color,
    display: 'grid',
    gridTemplateColumns: '34px minmax(0, 1fr) 14px',
    alignItems: 'center',
    gap: 10,
    textAlign: 'left',
    cursor: 'pointer',
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  });

  const settingsActionIcon = (color: string): React.CSSProperties => ({
    width: 34,
    height: 34,
    borderRadius: 8,
    background: '#fff',
    color,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 1px 3px rgba(15,23,42,0.08)',
  });

  const settingsActionTitle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    fontWeight: 800,
    color: '#1e1b4b',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const settingsActionSub: React.CSSProperties = {
    display: 'block',
    marginTop: 3,
    fontSize: 10.5,
    lineHeight: 1.35,
    color: '#64748b',
  };

  const settingsActionArrow: React.CSSProperties = {
    color: '#94a3b8',
    fontSize: 18,
    lineHeight: 1,
    justifySelf: 'end',
  };

  // Active preview image in timeline mode
  const timelinePreview = thumbMode === 'timeline'
    ? (previewUrl ?? (thumbnailUrl || null))
    : null;

  const modal = !open ? null : (
    <>
      {/* Backdrop */}
      <div
        onClick={() => setOpen(false)}
        style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(2,6,23,0.55)', backdropFilter: 'blur(10px)', zIndex: 800 }}
      />

      {/* Modal */}
      <div
        ref={settingsPanelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Project settings"
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: isCompact ? 0 : '50%',
          left: isCompact ? 0 : '50%',
          transform: isCompact ? 'none' : 'translate(-50%, -50%)',
          zIndex: 801,
          width: isCompact ? '100vw' : '94vw',
          height: isCompact ? '100dvh' : 'min(820px, 92dvh)',
          maxHeight: '100dvh',
          display: 'flex', flexDirection: 'column',
          backgroundColor: 'hsl(var(--card))',
          borderRadius: isCompact ? 0 : 10,
          boxShadow: '0 16px 48px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
          overflow: 'hidden', fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        {/* Wizard page 2 — Avatar persona, overlaying this same window */}
        {page === 'avatar' && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 5 }}>
            <AvatarSettingsModal embedded open projectId={projectId} videoTitle={project?.title ?? null} onClose={() => setPage('main')} />
          </div>
        )}
        {page === 'circles' && (
          <AvatarCirclesSettings projectId={projectId} duration={dur} onClose={() => setPage('main')} />
        )}

        {/* ── Header ── */}
        <div style={{
          flexShrink: 0, padding: isCompact ? '12px 14px' : '16px 24px',
          borderBottom: '1px solid hsl(var(--shell-border))',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, background: 'hsl(var(--shell))',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: '#a855f7', display: 'inline-block', flexShrink: 0, boxShadow: '0 0 0 4px rgba(168,85,247,0.18)' }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'hsl(var(--shell-foreground))' }}>Video settings</span>
            {project?.title && (
              <span style={{ fontSize: 10, fontWeight: 600, color: 'hsl(var(--shell-muted))', backgroundColor: 'var(--shell-hover)', borderRadius: 6, padding: '2px 8px', fontFamily: 'monospace' }}>
                {project.title.slice(0, 40)}
              </span>
            )}
          </div>
          <button
            onClick={() => setOpen(false)}
            style={{ width: 30, height: 30, borderRadius: 8, border: 'none', backgroundColor: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'hsl(var(--shell-muted))', flexShrink: 0 }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--shell-hover)'; (e.currentTarget as HTMLElement).style.color = 'hsl(var(--shell-foreground))'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'hsl(var(--shell-muted))'; }}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
        </div>

        {/* ── Body: two-column ── */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: isCompact ? 'column' : 'row' }}>

          {/* LEFT panel — Thumbnail controls */}
          <div style={{
            width: isCompact ? '100%' : 470,
            maxHeight: isCompact ? '50dvh' : undefined,
            flexShrink: 0, overflowY: 'auto',
            padding: isCompact ? '14px' : '20px 22px',
            display: 'flex', flexDirection: 'column', gap: 16,
            borderRight: isCompact ? 'none' : '1px solid #e2e8f0',
            borderBottom: isCompact ? '1px solid #e2e8f0' : 'none',
            backgroundColor: 'hsl(var(--card))', boxSizing: 'border-box',
          }}>
            <div style={sectionCardStyle}>
              <div style={sectionHeaderStyle}>
                <span style={sectionKickerStyle}>Media</span>
                <h3 style={sectionTitleStyle}>Thumbnail</h3>
              </div>

            {/* Preview */}
            <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', borderRadius: 10, overflow: 'hidden', background: '#0f172a', border: '1px solid #e2e8f0', flexShrink: 0 }}>
              {/* Show frame preview or existing thumbnail */}
              {timelinePreview && !isGenerating && !pickingThumb && (
                <img src={timelinePreview} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />
              )}
              {thumbMode === 'ai' && thumbnailUrl && !isGenerating && (
                <img src={thumbnailUrl} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />
              )}
              {(isGenerating || pickingThumb || previewLoading) && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#fff', background: 'rgba(0,0,0,0.55)' }}>
                  <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {pickingThumb ? 'Extracting frame…' : previewLoading ? 'Loading preview…' : uploadingThumb ? 'Uploading…' : 'Generating…'}
                  </span>
                </div>
              )}
              {!timelinePreview && thumbMode === 'timeline' && !isGenerating && !pickingThumb && !previewLoading && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Film size={24} stroke="rgba(255,255,255,0.25)" strokeWidth={1.2} />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>Scrub to preview</span>
                </div>
              )}
              {thumbMode === 'ai' && !thumbnailUrl && !isGenerating && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9l4-4 4 4 5-5 5 5"/></svg>
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>No thumbnail yet</span>
                </div>
              )}
            </div>

            {/* Mode tabs */}
            <div style={{ display: 'flex', gap: 4, background: 'hsl(var(--muted))', borderRadius: 9, padding: 3 }}>
              {(['ai', 'timeline'] as const).map(mode => {
                const disabled = mode === 'timeline' && mainClipProcessing;
                return (
                  <button
                    key={mode}
                    onClick={() => !disabled && setThumbMode(mode)}
                    disabled={disabled}
                    title={disabled ? 'The clip is still processing — available once it finishes.' : undefined}
                    style={{
                      flex: 1, height: 32, border: 'none', borderRadius: 7,
                      background: thumbMode === mode ? 'hsl(var(--card))' : 'transparent',
                      boxShadow: thumbMode === mode ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
                      fontSize: 12, fontWeight: 600,
                      color: thumbMode === mode ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                    }}
                  >
                    {mode === 'ai' ? <><Sparkles size={12} strokeWidth={2} /> AI Generate</> : <><Film size={12} strokeWidth={1.9} /> From Timeline</>}
                  </button>
                );
              })}
            </div>

            {thumbMode === 'ai' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input
                  value={prompt} onChange={e => setPrompt(e.target.value)}
                  placeholder='Hint for the AI image (optional)'
                  style={{ ...inputStyle, height: 36, fontSize: 13 }}
                  onFocus={e => (e.target.style.borderColor = '#a855f7')}
                  onBlur={e => (e.target.style.borderColor = '#e2e8f0')}
                />
                <span style={{ fontSize: 11, color: '#94a3b8', marginTop: -4 }}>
                  Generates a thumbnail image from your video&apos;s title &amp; AI summary. Takes ~20–40s.
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={genAiThumb} disabled={isGenerating} style={{ ...btnStyle(isGenerating), flex: 1, height: 36 }}>
                    {isGenerating ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Generating…</> : <><Sparkles size={13} strokeWidth={2} /> {thumbnailUrl ? 'Regenerate AI thumbnail' : 'Generate AI thumbnail'}</>}
                  </button>
                  <input
                    ref={thumbInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    style={{ display: 'none' }}
                    onChange={async e => {
                      const file = e.target.files?.[0] ?? null;
                      e.target.value = '';
                      if (file) await uploadThumbnail(file);
                    }}
                  />
                  <button onClick={() => thumbInputRef.current?.click()} title="Upload image" disabled={isGenerating}
                    style={{ width: 36, height: 36, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', flexShrink: 0 }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                  >
                    <Upload size={14} strokeWidth={1.9} />
                  </button>
                </div>
                {genError && <p style={{ fontSize: 11, color: '#ef4444' }}>{genError}</p>}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {mainClipProcessing ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderRadius: 8, background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))', fontSize: 12 }}>
                    <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                    <span>The clip is still processing — picking a frame from the timeline will be available once it finishes.</span>
                  </div>
                ) : dur > 0 ? (<>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Scrub to pick frame</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#a855f7', fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'right' }}>{fmtTime(timelineSec)}</span>
                  </div>
                  <input type="range" min={0} max={Math.floor(dur)} step={1} value={timelineSec}
                    onChange={e => {
                      const sec = Number(e.target.value);
                      setTimelineSec(sec);
                      fetchPreview(sec);
                    }}
                    style={{ width: '100%', accentColor: '#a855f7', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8' }}>
                    <span>0:00</span><span>{fmtTime(Math.floor(dur))}</span>
                  </div>
                  <button onClick={pickFromTimeline} disabled={pickingThumb} style={btnStyle(pickingThumb)}>
                    {pickingThumb ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Extracting frame…</> : <><Film size={13} strokeWidth={1.9} /> Use this frame</>}
                  </button>
                  {pickError && <p style={{ fontSize: 11, color: '#ef4444' }}>{pickError}</p>}
                  <p style={{ fontSize: 11, color: '#94a3b8' }}>Preview loads ~1s after you stop scrubbing</p>
                </>) : (
                  <p style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: '24px 0' }}>Upload a video first to use timeline scrubbing</p>
                )}
              </div>
            )}
            </div>

            <div style={sectionCardStyle}>
              <div style={sectionHeaderStyle}>
                <span style={sectionKickerStyle}>Avatar</span>
                <h3 style={sectionTitleStyle}>Interactive overlays</h3>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                <button onClick={() => setPage('avatar')} style={settingsActionCard('#4338ca', 'rgba(99,102,241,0.1)', 'rgba(168,85,247,0.05)')}>
                  <span style={settingsActionIcon('#6366f1')}><Sparkles size={15} strokeWidth={1.9} aria-hidden /></span>
                  <span style={{ minWidth: 0 }}>
                    <span style={settingsActionTitle}>Ask-the-Avatar persona</span>
                    <span style={settingsActionSub}>Greeting, knowledge, language, avatar &amp; voice</span>
                  </span>
                  <span style={settingsActionArrow}>›</span>
                </button>
                <button onClick={() => setPage('circles')} style={settingsActionCard('#9333ea', 'rgba(168,85,247,0.1)', 'rgba(236,72,153,0.05)')}>
                  <span style={settingsActionIcon('#a855f7')}><Sparkles size={15} strokeWidth={1.9} aria-hidden /></span>
                  <span style={{ minWidth: 0 }}>
                    <span style={settingsActionTitle}>Avatar circles</span>
                    <span style={settingsActionSub}>Audio-reactive speaker circles during b-roll</span>
                  </span>
                  <span style={settingsActionArrow}>›</span>
                </button>
              </div>
            </div>
          </div>

          {/* RIGHT panel — Details + Crop + Access */}
          <div style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: isCompact ? '14px' : '20px 24px',
            display: 'grid',
            gridTemplateColumns: isCompact ? '1fr' : 'repeat(2, minmax(280px, 1fr))',
            gap: 16,
            alignContent: 'start',
            backgroundColor: 'hsl(var(--card))',
            boxSizing: 'border-box',
          }}>

            {/* Details */}
            <div style={{ ...sectionCardStyle, gridColumn: isCompact ? undefined : '1 / -1' }}>
              <div style={sectionHeaderStyle}>
                <span style={sectionKickerStyle}>Metadata</span>
                <h3 style={sectionTitleStyle}>Details</h3>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input
                  value={title} onChange={e => setTitle(e.target.value)} placeholder="Video name"
                  style={inputStyle}
                  onFocus={e => (e.target.style.borderColor = '#a855f7')}
                  onBlur={e => (e.target.style.borderColor = '#e2e8f0')}
                />
                <textarea
                  value={desc} onChange={e => setDesc(e.target.value)} rows={6} placeholder="What is this video about?"
                  style={{ ...inputStyle, height: 'auto', padding: '12px 14px', resize: 'vertical', lineHeight: 1.6, minHeight: 120 }}
                  onFocus={e => (e.target.style.borderColor = '#a855f7')}
                  onBlur={e => (e.target.style.borderColor = '#e2e8f0')}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <button onClick={saveMeta} disabled={savingMeta} style={{ ...btnStyle(savingMeta), width: 'auto', padding: '0 24px' }}>
                    {savingMeta ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</> : savedMeta ? '✓ Saved' : 'Save details'}
                  </button>
                  <button
                    onClick={generateDetails}
                    disabled={genMeta}
                    title="Generate the title & description from the video's captions/transcript"
                    style={{
                      width: 'auto', padding: '0 16px', height: 38, borderRadius: 8,
                      border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))',
                      color: 'hsl(var(--foreground))', fontSize: 13, fontWeight: 600,
                      cursor: genMeta ? 'not-allowed' : 'pointer', opacity: genMeta ? 0.6 : 1,
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    {genMeta ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Generating…</> : <><Sparkles size={13} strokeWidth={2} /> Generate with AI</>}
                  </button>
                </div>
                {genMetaError && <p style={{ fontSize: 12, color: '#ef4444' }}>{genMetaError}</p>}
                <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>
                  AI fills the title &amp; description from your video&apos;s captions — generate captions first for the best result.
                </p>
              </div>
            </div>

            {/* Smart Crop */}
            <div style={sectionCardStyle}>
              <div style={sectionHeaderStyle}>
                <span style={sectionKickerStyle}>Crop</span>
                <h3 style={sectionTitleStyle}>Smart Crop</h3>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                <button
                  onClick={recrop} disabled={cropping || anyCropProcessing}
                  style={{ ...btnStyle(cropping || anyCropProcessing), width: 'auto', padding: '0 20px', height: 38, flexShrink: 0 }}
                >
                  {(cropping || anyCropProcessing) ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Cropping…</> : <><Crop size={13} strokeWidth={2} /> Recrop</>}
                </button>
                <span style={{ fontSize: 13, color: '#6b7280' }}>
                  {(anyCropProcessing || cropping)
                    ? 'Cropping…'
                    : lastCropTime
                      ? `Last cropped ${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(lastCropTime))}`
                      : anyCropReady
                        ? 'Cropped'
                        : anyCropFailed
                          ? 'Crop failed'
                          : 'Never cropped'}
                </span>
              </div>
              {cropError && <p style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>{cropError}</p>}
            </div>

            {/* Access */}
            <div style={sectionCardStyle}>
              <div style={sectionHeaderStyle}>
                <span style={sectionKickerStyle}>Access</span>
                <h3 style={sectionTitleStyle}>Access</h3>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>
                  Who can view this video
                </label>
                <select
                  value={project?.visibility ?? 'private'}
                  onChange={(e) => changeVisibility(e.target.value as 'private' | 'unlisted' | 'public')}
                  disabled={savingVisibility}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, background: '#fff' }}
                >
                  <option value="private">Private — only you</option>
                  <option value="unlisted">Unlisted — anyone with the share link</option>
                  <option value="public">Public — anyone with the link</option>
                </select>
                <p style={{ fontSize: 10, color: '#9ca3af', marginTop: 5 }}>
                  Private drafts can&apos;t be opened by their id. Share links still work for unlisted/private.
                </p>
              </div>
              <LockPriceControl contentType="project" contentId={projectId} bordered={false} />
            </div>
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
