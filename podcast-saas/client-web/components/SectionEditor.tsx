'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { getAuth } from 'firebase/auth';
import type { TimelineSection, Simulation, VideoFile, VideoGenerationJob, SimFile, SimMeta } from 'shared/src/generated/client-v1';
import { api } from '../lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

type GenModel = 'kling' | 'seedance' | 'veo';

const GEN_MODELS: Record<GenModel, { name: string; desc: string }> = {
  kling:    { name: 'Kling 3.0',   desc: 'Kuaishou · 4–15s' },
  seedance: { name: 'Seedance 2.0', desc: 'ByteDance · 4–15s' },
  veo:      { name: 'Veo 3',       desc: 'Google · 4–8s' },
};

const JOB_STATUS_LABEL: Record<string, string> = {
  queued:      'Waiting…',
  enhancing:   'Enhancing prompt…',
  submitting:  'Submitting to model…',
  generating:  'Generating video…',
  downloading: 'Downloading…',
  transcoding: 'Transcoding HLS…',
  ready:       'Done! Video added to library',
  failed:      'Failed',
};

function getClipOffset(videos: VideoFile[], videoFileId: string): number {
  const sorted = [...videos].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  let offset = 0;
  for (const v of sorted) {
    if (v.id === videoFileId) return offset;
    offset += v.duration_sec ?? 0;
  }
  return 0;
}

function elapsed(createdAt: string): string {
  const secs = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

const TYPES = [
  { value: 'video',      label: 'Video',      color: '#3b82f6', bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8' },
  { value: 'simulation', label: 'Simulation', color: '#f59e0b', bg: '#fffbeb', border: '#fcd34d', text: '#92400e' },
  { value: 'clip',       label: 'Clip',       color: '#10b981', bg: '#ecfdf5', border: '#6ee7b7', text: '#065f46' },
] as const;

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function fmtTimeLong(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  const ms = Math.round((sec % 1) * 10);
  return `${m}:${s}.${ms}`;
}

function parseTime(str: string): number | null {
  const parts = str.split(':');
  if (parts.length !== 2) return null;
  const m = parseInt(parts[0], 10);
  const s = parseFloat(parts[1]);
  if (isNaN(m) || isNaN(s)) return null;
  return m * 60 + s;
}

interface Props {
  section: TimelineSection;
  projectId: string;
  simulations: Simulation[];
  videos: VideoFile[];
  videoUrls: Record<string, string>;
  onUpdate: (s: TimelineSection) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function SectionEditor({
  section, projectId, simulations, videos, videoUrls,
  onUpdate, onDelete, onClose,
}: Props) {
  const isBroll = section.track === 'broll';
  const knownTypes = TYPES.map(t => t.value) as string[];
  const initialType = isBroll ? 'video' : (knownTypes.includes(section.type) ? section.type : 'video');

  const [type, setType]         = useState(initialType);
  const [label, setLabel]       = useState(section.label ?? '');
  const [simId, setSimId]       = useState(section.simulation_id ?? '');
  const [simScript] = useState(section.sim_script ?? '');
  const [simPrompt, setSimPrompt]   = useState(section.sim_prompt ?? '');
  const [simpleUi, setSimpleUi]     = useState(section.simple_ui ?? false);
  const [autoScript, setAutoScript] = useState(section.auto_script ?? true);
  const [generating, setGenerating] = useState(false);
  const [simGenError, setSimGenError] = useState<string | null>(null);
  const [startStr, setStartStr] = useState(fmtTime(section.start_sec));
  const [endStr, setEndStr]     = useState(fmtTime(section.end_sec));
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Video generation state
  const [genPrompt, setGenPrompt]   = useState('');
  const [genModel, setGenModel]     = useState<GenModel>('kling');
  const [genEnhance, setGenEnhance] = useState(true);
  const [genBusy, setGenBusy]       = useState(false);
  const [genError, setGenError]     = useState<string | null>(null);
  const [genJob, setGenJob]         = useState<VideoGenerationJob | null>(null);

  // Preview iframe control (simulation)
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const [previewRunning, setPreviewRunning] = useState(false);

  // Right-panel tabs (simulation only)
  const [rightTab, setRightTab]               = useState<'preview' | 'files'>('preview');
  const [simFiles, setSimFiles]               = useState<SimFile[]>([]);
  const [simFilesLoading, setSimFilesLoading] = useState(false);
  const [activeFileKey, setActiveFileKey]     = useState<string | null>(null);
  const [fileContent, setFileContent]         = useState<string | null>(null);
  const [fileContentLoading, setFileContentLoading] = useState(false);

  // ── Clip section state ─────────────────────────────────────────────────────
  const [localVideos, setLocalVideos]   = useState<VideoFile[]>(videos);
  const [localClipUrls, setLocalClipUrls] = useState<Record<string, string>>({});
  const [clipSourceVideoId, setClipSourceVideoId] = useState(section.clip_source_video_id ?? '');
  const [clipInSec, setClipInSec]       = useState(section.clip_in_sec ?? 0);
  const [clipCurrentTime, setClipCurrentTime] = useState(section.clip_in_sec ?? 0);
  const [clipPlaying, setClipPlaying]   = useState(false);
  const [clipUploading, setClipUploading] = useState(false);
  const [clipUploadPct, setClipUploadPct] = useState<number | null>(null);
  const [clipUploadErr, setClipUploadErr] = useState<string | null>(null);
  const clipVideoRef   = useRef<HTMLVideoElement>(null);
  const clipScrubRef   = useRef<HTMLDivElement>(null);
  const clipFileInputRef = useRef<HTMLInputElement>(null);
  // drag state: null = no drag; mode=window → dragging selection; mode=scrub → scrubbing
  const clipDragRef = useRef<{ mode: 'window' | 'scrub'; windowOffsetSec: number } | null>(null);

  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = isBroll ? 'video' : (knownTypes.includes(section.type) ? section.type : 'video');
    setType(t);
    setLabel(section.label ?? '');
    setSimId(section.simulation_id ?? '');
    setSimPrompt(section.sim_prompt ?? '');
    setSimpleUi(section.simple_ui ?? false);
    setAutoScript(section.auto_script ?? true);
    setSimGenError(null);
    setGenerating(false);
    setStartStr(fmtTime(section.start_sec));
    setEndStr(fmtTime(section.end_sec));
    setSaveError(null);
    setGenPrompt('');
    setGenError(null);
    setGenBusy(false);
    setGenJob(null);
    setRightTab('preview');
    setPreviewRunning(false);
    setSimFiles([]);
    setActiveFileKey(null);
    setFileContent(null);
    // Clip state reset
    setClipSourceVideoId(section.clip_source_video_id ?? '');
    setClipInSec(section.clip_in_sec ?? 0);
    setClipCurrentTime(section.clip_in_sec ?? 0);
    setClipPlaying(false);
    setClipUploadErr(null);
    setTimeout(() => labelRef.current?.focus(), 80);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.id]);

  // Poll active generation job
  useEffect(() => {
    if (!genJob || genJob.status === 'ready' || genJob.status === 'failed') return;
    const poll = async () => {
      try {
        const updated = await api.getBrollJob(projectId, genJob.id);
        setGenJob(updated);
      } catch { /* ignore */ }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genJob?.id, genJob?.status]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // 'i' key → mark in-point (clip type only)
  useEffect(() => {
    if (type !== 'clip') return;
    const handler = (e: KeyboardEvent) => {
      if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setClipInSec(clipCurrentTime);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [type, clipCurrentTime]);

  // Document-level mouse handlers for clip scrubber drag
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = clipDragRef.current;
      const scrub = clipScrubRef.current;
      if (!drag || !scrub) return;

      const rect = scrub.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const sourceDuration = localVideos.find(v => v.id === clipSourceVideoId)?.duration_sec ?? 0;
      const sectionDuration = section.end_sec - section.start_sec;

      if (drag.mode === 'scrub') {
        const time = frac * sourceDuration;
        if (clipVideoRef.current) clipVideoRef.current.currentTime = time;
        setClipCurrentTime(time);
      } else {
        // window drag: shift in-point
        const rawIn = frac * sourceDuration - drag.windowOffsetSec;
        const maxIn = Math.max(0, sourceDuration - sectionDuration);
        const newIn = Math.max(0, Math.min(rawIn, maxIn));
        setClipInSec(newIn);
        if (clipVideoRef.current) clipVideoRef.current.currentTime = newIn;
        setClipCurrentTime(newIn);
      }
    };

    const onMouseUp = () => {
      clipDragRef.current = null;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipSourceVideoId, localVideos, section.end_sec, section.start_sec]);

  // Load simulation file list
  useEffect(() => {
    if (rightTab !== 'files' || !simId) return;
    setSimFilesLoading(true);
    setSimFiles([]);
    setActiveFileKey(null);
    setFileContent(null);
    api.listSimFiles(projectId, simId)
      .then(files => {
        setSimFiles(files);
        if (files.length > 0) setActiveFileKey(files[0].key);
      })
      .catch(() => {})
      .finally(() => setSimFilesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightTab, simId, section.simulation_url]);

  // Load sim file content
  useEffect(() => {
    if (!activeFileKey || !simId) { setFileContent(null); return; }
    setFileContentLoading(true);
    setFileContent(null);
    api.getSimFileContent(projectId, simId, activeFileKey)
      .then(text => setFileContent(text))
      .catch(() => setFileContent('/* could not load file */'))
      .finally(() => setFileContentLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileKey]);

  const handleGenerateVideo = useCallback(async () => {
    if (!genPrompt.trim()) return;
    setGenBusy(true);
    setGenError(null);
    setGenJob(null);
    try {
      const clipOffset = getClipOffset(videos, section.video_file_id);
      const duration = section.end_sec - section.start_sec;
      const globalOffset = clipOffset + section.start_sec;
      const result = await api.generateBroll(projectId, {
        prompt: genPrompt.trim(),
        model: genModel as 'kling' | 'seedance' | 'veo',
        enhance: genEnhance,
        target_duration_sec: Math.max(4, duration),
        target_global_offset_sec: globalOffset,
      });
      const job = await api.getBrollJob(projectId, result.jobId);
      setGenJob(job);
    } catch (err) {
      setGenError((err as Error).message ?? 'Generation failed');
    } finally {
      setGenBusy(false);
    }
  }, [projectId, section, videos, genPrompt, genModel, genEnhance]);

  // SIM_READY listener
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'SIM_READY' && previewIframeRef.current) {
        const script = section.sim_script ?? 'main';
        previewIframeRef.current.contentWindow?.postMessage({ type: 'startScript', script }, '*');
        setPreviewRunning(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.sim_script]);

  const sendToPreview = useCallback((type: string) => {
    previewIframeRef.current?.contentWindow?.postMessage({ type }, '*');
    if (type === 'stopScript') setPreviewRunning(false);
    if (type === 'startScript') setPreviewRunning(true);
  }, []);

  const handleGenerateScript = useCallback(async () => {
    if (!simId || !simPrompt.trim()) return;
    setGenerating(true);
    setSimGenError(null);
    try {
      if (section.type !== 'simulation' || section.simulation_id !== simId) {
        const patched = await api.updateSection(projectId, section.id, {
          type: 'simulation',
          simulation_id: simId,
        });
        onUpdate(patched);
      }
      const updated = await api.generateSimScript(projectId, section.id, {
        prompt: simPrompt.trim(),
        simple_ui: simpleUi,
        auto_script: autoScript,
      });
      onUpdate(updated);
    } catch (err) {
      setSimGenError((err as Error).message ?? 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }, [projectId, section, simId, simPrompt, simpleUi, autoScript, onUpdate]);

  // ── Clip source upload ─────────────────────────────────────────────────────

  const handleClipUpload = useCallback(async (file: File) => {
    setClipUploading(true);
    setClipUploadPct(0);
    setClipUploadErr(null);
    try {
      const token = await getAuth().currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');
      const formData = new FormData();
      formData.append('file_size', String(file.size));
      formData.append('file', file, file.name);
      const video = await new Promise<VideoFile>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) setClipUploadPct(Math.round(e.loaded / e.total * 100));
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText) as VideoFile); }
            catch { reject(new Error('Upload response parse failed')); }
          } else reject(new Error(`Upload failed: ${xhr.status}`));
        });
        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.open('POST', `${API_URL}/api/v1/projects/${projectId}/videos/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(formData);
      });
      setLocalVideos(prev => [...prev.filter(v => v.id !== video.id), video]);
      if (video.raw_url) setLocalClipUrls(prev => ({ ...prev, [video.id]: video.raw_url! }));
      setClipSourceVideoId(video.id);
      setClipInSec(0);
      setClipCurrentTime(0);
    } catch (err) {
      setClipUploadErr((err as Error).message);
    } finally {
      setClipUploading(false);
      setClipUploadPct(null);
    }
  }, [projectId]);

  // ── Clip scrubber mouse handlers ───────────────────────────────────────────

  const handleScrubMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = clipScrubRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sourceDuration = localVideos.find(v => v.id === clipSourceVideoId)?.duration_sec ?? 0;
    if (!sourceDuration) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = frac * sourceDuration;
    clipDragRef.current = { mode: 'scrub', windowOffsetSec: 0 };
    if (clipVideoRef.current) clipVideoRef.current.currentTime = time;
    setClipCurrentTime(time);
  }, [clipSourceVideoId, localVideos]);

  const handleWindowMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = clipScrubRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sourceDuration = localVideos.find(v => v.id === clipSourceVideoId)?.duration_sec ?? 0;
    if (!sourceDuration) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const clickedAtSec = frac * sourceDuration;
    const offsetInWindow = clickedAtSec - clipInSec;
    clipDragRef.current = { mode: 'window', windowOffsetSec: offsetInWindow };
  }, [clipSourceVideoId, localVideos, clipInSec]);

  const handleMarkIn = useCallback(() => {
    setClipInSec(clipCurrentTime);
  }, [clipCurrentTime]);

  const handlePlaySection = useCallback(async () => {
    const video = clipVideoRef.current;
    if (!video) return;
    if (clipPlaying) {
      video.pause();
      setClipPlaying(false);
      return;
    }
    video.currentTime = clipInSec;
    try { await video.play(); setClipPlaying(true); } catch { /* autoplay blocked */ }
  }, [clipInSec, clipPlaying]);

  const handleSave = async () => {
    const start_sec = parseTime(startStr);
    const end_sec   = parseTime(endStr);
    if (start_sec == null || end_sec == null || start_sec >= end_sec) {
      setSaveError('Invalid time range');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const sourceDuration = localVideos.find(v => v.id === clipSourceVideoId)?.duration_sec ?? 0;
      const sectionDuration = end_sec - start_sec;
      const safeClipIn = sourceDuration > 0
        ? Math.max(0, Math.min(clipInSec, sourceDuration - sectionDuration))
        : clipInSec;

      const updated = await api.updateSection(projectId, section.id, {
        type,
        label: label.trim() || undefined,
        simulation_id: simId || undefined,
        sim_script: simScript || undefined,
        start_sec,
        end_sec,
        ...(type === 'clip' ? {
          clip_source_video_id: clipSourceVideoId || null,
          clip_in_sec: safeClipIn,
        } : {}),
      });
      onUpdate(updated);
      onClose();
    } catch (err) {
      const msg = (err as Error).message ?? 'Save failed';
      if (msg.toLowerCase().includes('not found')) { onDelete(section.id); return; }
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteSection(projectId, section.id);
      onDelete(section.id);
    } catch {
      onDelete(section.id);
    } finally {
      setDeleting(false);
    }
  };

  // ── Derived values ─────────────────────────────────────────────────────────

  const activeTypeDef = TYPES.find(t => t.value === type) ?? TYPES[0];
  const readySims = simulations.filter(s => s.status === 'ready');
  const activeSim = readySims.find(s => s.id === simId) ?? null;
  const videoUrl = videoUrls[section.video_file_id] ?? null;
  const simPreviewUrl = section.simulation_url ?? activeSim?.entry_file ?? null;
  const simMeta = section.sim_meta as SimMeta | null | undefined ?? null;

  // Clip trimmer derived values
  const clipSourceVideo  = localVideos.find(v => v.id === clipSourceVideoId) ?? null;
  const clipUrl          = localClipUrls[clipSourceVideoId] ?? videoUrls[clipSourceVideoId] ?? null;
  const clipSourceDur    = clipSourceVideo?.duration_sec ?? 0;
  const sectionDuration  = section.end_sec - section.start_sec;
  const clipOutSec       = clipInSec + sectionDuration;
  const winLeft          = clipSourceDur > 0 ? (clipInSec / clipSourceDur) * 100 : 0;
  const winWidth         = clipSourceDur > 0 ? Math.min((sectionDuration / clipSourceDur) * 100, 100 - winLeft) : 100;
  const playheadLeft     = clipSourceDur > 0 ? (clipCurrentTime / clipSourceDur) * 100 : 0;

  // ── Style helpers ──────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    width: '100%', height: 38, padding: '0 12px', borderRadius: 8,
    border: '1.5px solid #e5e7eb', backgroundColor: '#fff',
    fontSize: 13, color: '#111827', outline: 'none',
    boxSizing: 'border-box', fontFamily: 'system-ui, -apple-system, sans-serif',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: '#6b7280',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    display: 'block', marginBottom: 6,
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          backgroundColor: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)', zIndex: 200,
        }}
      />

      {/* Modal */}
      <div
        style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 201, width: '90vw', height: '90vh',
          display: 'flex', flexDirection: 'column',
          backgroundColor: '#ffffff', borderRadius: 16,
          boxShadow: '0 30px 80px rgba(0,0,0,0.3), 0 10px 30px rgba(0,0,0,0.15)',
          overflow: 'hidden', fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          flexShrink: 0, padding: '16px 24px',
          borderBottom: '1px solid #f3f4f6',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, backgroundColor: '#fafafa',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              backgroundColor: isBroll ? '#06b6d4' : activeTypeDef.color,
              display: 'inline-block', flexShrink: 0,
            }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>
              {isBroll ? 'B-Roll Clip' : 'Edit Section'}
            </span>
            <span style={{
              fontSize: 10, fontWeight: 600, color: '#9ca3af',
              backgroundColor: '#f3f4f6', borderRadius: 6, padding: '2px 8px',
              fontFamily: 'monospace',
            }}>
              {fmtTime(section.start_sec)} → {fmtTime(section.end_sec)}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 30, height: 30, borderRadius: 8,
              border: 'none', backgroundColor: 'transparent',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#9ca3af', flexShrink: 0,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f3f4f6'; (e.currentTarget as HTMLElement).style.color = '#374151'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#9ca3af'; }}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* ── Body: two-column ── */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'row' }}>

          {/* LEFT: Controls */}
          <div style={{
            width: 380, flexShrink: 0, overflowY: 'auto',
            padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20,
            borderRight: '1px solid #f3f4f6',
          }}>

            {/* Type switcher */}
            {!isBroll && (
              <div>
                <label style={labelStyle}>Type</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {TYPES.map(t => {
                    const active = type === t.value;
                    return (
                      <button
                        key={t.value}
                        onClick={() => setType(t.value)}
                        style={{
                          flex: 1, height: 36, borderRadius: 9,
                          border: `1.5px solid ${active ? t.color : '#e5e7eb'}`,
                          backgroundColor: active ? t.bg : '#f9fafb',
                          color: active ? t.text : '#6b7280',
                          fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          transition: 'all 0.12s',
                        }}
                      >
                        <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: active ? t.color : '#d1d5db', display: 'inline-block', flexShrink: 0 }} />
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Label */}
            <div>
              <label style={labelStyle}>{isBroll ? 'Clip Label' : 'Label'}</label>
              <input
                ref={labelRef}
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
                placeholder={isBroll ? 'B-roll clip description…' : 'e.g. Introduction, Demo…'}
                style={inputStyle}
                onFocus={e => { e.currentTarget.style.borderColor = '#93c5fd'; }}
                onBlur={e => { e.currentTarget.style.borderColor = '#e5e7eb'; }}
              />
            </div>

            {/* ── CLIP SOURCE PICKER ── */}
            {type === 'clip' && !isBroll && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ height: 1, backgroundColor: '#f3f4f6' }} />

                <div style={{
                  backgroundColor: '#ecfdf5', border: '1.5px solid #6ee7b7',
                  borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14 }}>🎞</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#065f46' }}>Clip Source</span>
                    <span style={{ fontSize: 10, color: '#059669', backgroundColor: '#d1fae5', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
                      {fmtTime(sectionDuration)} slot
                    </span>
                  </div>

                  {/* Library picker */}
                  <div>
                    <label style={{ ...labelStyle, color: '#059669' }}>From Library</label>
                    <select
                      value={clipSourceVideoId}
                      onChange={e => {
                        setClipSourceVideoId(e.target.value);
                        setClipInSec(0);
                        setClipCurrentTime(0);
                        setClipPlaying(false);
                      }}
                      style={{
                        ...inputStyle,
                        cursor: 'pointer',
                        color: clipSourceVideoId ? '#111827' : '#9ca3af',
                        borderColor: '#6ee7b7',
                      }}
                      onFocus={e => { e.currentTarget.style.borderColor = '#10b981'; }}
                      onBlur={e => { e.currentTarget.style.borderColor = '#6ee7b7'; }}
                    >
                      <option value="">— choose a video —</option>
                      {localVideos.map(v => (
                        <option key={v.id} value={v.id}>
                          {v.filename ?? v.id.slice(0, 8)} {v.duration_sec ? `· ${fmtTime(v.duration_sec)}` : ''}
                        </option>
                      ))}
                    </select>
                    {localVideos.length === 0 && (
                      <p style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>Upload a video below to get started</p>
                    )}
                  </div>

                  {/* Divider + Upload */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, height: 1, backgroundColor: '#a7f3d0' }} />
                    <span style={{ fontSize: 10, color: '#6ee7b7', fontWeight: 600 }}>OR</span>
                    <div style={{ flex: 1, height: 1, backgroundColor: '#a7f3d0' }} />
                  </div>

                  <div>
                    <label style={{ ...labelStyle, color: '#059669' }}>Upload New Clip</label>
                    <input
                      ref={clipFileInputRef}
                      type="file"
                      accept=".mp4,.mov,.webm,.mkv,.avi,.m4v"
                      style={{ display: 'none' }}
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) handleClipUpload(file);
                        e.target.value = '';
                      }}
                    />
                    <button
                      onClick={() => clipFileInputRef.current?.click()}
                      disabled={clipUploading}
                      style={{
                        width: '100%', height: 38, borderRadius: 9,
                        border: '1.5px dashed #6ee7b7', backgroundColor: '#f0fdf4',
                        color: '#059669', fontSize: 12, fontWeight: 600,
                        cursor: clipUploading ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        opacity: clipUploading ? 0.7 : 1,
                        transition: 'background-color 0.12s',
                      }}
                      onMouseEnter={e => { if (!clipUploading) (e.currentTarget as HTMLElement).style.backgroundColor = '#dcfce7'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f0fdf4'; }}
                    >
                      {clipUploading ? (
                        <>
                          <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #6ee7b7', borderTopColor: '#059669', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                          {clipUploadPct != null ? `Uploading ${clipUploadPct}%` : 'Uploading…'}
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                            <path d="M6.5 9V4M4 6.5l2.5-2.5 2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            <rect x="1.5" y="9.5" width="10" height="2" rx="1" stroke="currentColor" strokeWidth="1.2" />
                          </svg>
                          Upload Video
                        </>
                      )}
                    </button>
                    {clipUploadErr && (
                      <p style={{ fontSize: 10, color: '#dc2626', marginTop: 4 }}>{clipUploadErr}</p>
                    )}
                  </div>

                  {/* Selected clip info */}
                  {clipSourceVideo && (
                    <div style={{
                      backgroundColor: '#d1fae5', borderRadius: 8, padding: '10px 12px',
                      display: 'flex', flexDirection: 'column', gap: 4,
                    }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: '#065f46', margin: 0 }}>
                        {clipSourceVideo.filename ?? 'Untitled'}
                      </p>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, color: '#059669' }}>
                          Duration: {clipSourceVideo.duration_sec != null ? fmtTime(clipSourceVideo.duration_sec) : '…'}
                        </span>
                        <span style={{ fontSize: 10, color: '#059669' }}>
                          Clip: {fmtTime(clipInSec)} → {fmtTime(clipOutSec)}
                        </span>
                      </div>
                      {clipSourceDur > 0 && clipSourceDur < sectionDuration && (
                        <p style={{ fontSize: 10, color: '#b45309', margin: 0 }}>
                          ⚠ Source shorter than section slot ({fmtTime(clipSourceDur)} vs {fmtTime(sectionDuration)})
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── SIMULATION CONTROLS ── */}
            {type === 'simulation' && !isBroll && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ height: 1, backgroundColor: '#f3f4f6' }} />

                <div>
                  <label style={labelStyle}>Simulation</label>
                  <select
                    value={simId}
                    onChange={e => setSimId(e.target.value)}
                    style={{ ...inputStyle, cursor: 'pointer', color: simId ? '#111827' : '#9ca3af' }}
                    onFocus={e => { e.currentTarget.style.borderColor = '#fcd34d'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = '#e5e7eb'; }}
                  >
                    <option value="">— none —</option>
                    {readySims.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {readySims.length === 0 && (
                    <p style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>Upload a simulation in the panel →</p>
                  )}
                </div>

                {simId && (
                  <div style={{
                    backgroundColor: '#fffbeb', border: '1.5px solid #fde68a',
                    borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 14 }}>✦</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#92400e' }}>AI Script Generation</span>
                      <span style={{ fontSize: 10, color: '#b45309', backgroundColor: '#fef3c7', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>Extended Thinking</span>
                    </div>

                    <div>
                      <label style={{ ...labelStyle, color: '#b45309' }}>Prompt</label>
                      <textarea
                        value={simPrompt}
                        onChange={e => setSimPrompt(e.target.value)}
                        placeholder="Describe exactly what to show in this section…&#10;e.g. Show the lattice size slider and auto-click the start button"
                        rows={4}
                        maxLength={1000}
                        style={{
                          width: '100%', padding: '10px 12px', borderRadius: 8,
                          border: '1.5px solid #fcd34d', backgroundColor: '#fff',
                          fontSize: 13, color: '#111827', outline: 'none',
                          resize: 'vertical', boxSizing: 'border-box',
                          fontFamily: 'system-ui, -apple-system, sans-serif', lineHeight: 1.5,
                        }}
                        onFocus={e => { e.currentTarget.style.borderColor = '#f59e0b'; }}
                        onBlur={e => { e.currentTarget.style.borderColor = '#fcd34d'; }}
                      />
                      <p style={{ fontSize: 10, color: '#b45309', textAlign: 'right', margin: '3px 0 0', opacity: 0.7 }}>{simPrompt.length}/1000</p>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      {([
                        { key: 'simpleUi' as const,   label: 'Simple UI',   desc: 'Hides irrelevant controls', on: simpleUi,   set: setSimpleUi },
                        { key: 'autoScript' as const, label: 'Auto Script', desc: 'Animates demonstration',    on: autoScript, set: setAutoScript },
                      ] as const).map(({ key, label: tLabel, desc, on, set }) => (
                        <button
                          key={key}
                          onClick={() => set((v: boolean) => !v)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 12px', borderRadius: 9,
                            border: `1.5px solid ${on ? '#f59e0b' : '#e5e7eb'}`,
                            backgroundColor: on ? '#fffbeb' : '#f9fafb',
                            cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s',
                          }}
                        >
                          <span style={{
                            width: 36, height: 20, borderRadius: 10, flexShrink: 0,
                            backgroundColor: on ? '#f59e0b' : '#d1d5db',
                            position: 'relative', display: 'inline-block', transition: 'background-color 0.15s',
                          }}>
                            <span style={{
                              position: 'absolute', top: 3,
                              left: on ? 18 : 3, width: 14, height: 14,
                              borderRadius: '50%', backgroundColor: '#fff',
                              boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.15s',
                            }} />
                          </span>
                          <div>
                            <p style={{ fontSize: 12, fontWeight: 600, color: on ? '#92400e' : '#374151', margin: 0 }}>{tLabel}</p>
                            <p style={{ fontSize: 10, color: '#9ca3af', margin: 0 }}>{desc}</p>
                          </div>
                        </button>
                      ))}
                    </div>

                    {simGenError && (
                      <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
                        <p style={{ fontSize: 11, color: '#dc2626', margin: 0 }}>{simGenError}</p>
                      </div>
                    )}

                    {simMeta && !generating && (
                      <div style={{ backgroundColor: '#f0fdf4', border: '1.5px solid #bbf7d0', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#166534' }}>Last generation</span>
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
                            backgroundColor: simMeta.confidence >= 0.8 ? '#dcfce7' : simMeta.confidence >= 0.5 ? '#fef9c3' : '#fee2e2',
                            color: simMeta.confidence >= 0.8 ? '#166534' : simMeta.confidence >= 0.5 ? '#713f12' : '#991b1b',
                          }}>
                            {Math.round(simMeta.confidence * 100)}% confidence
                          </span>
                        </div>
                        {simMeta.targetControlId && (
                          <p style={{ fontSize: 11, color: '#15803d', margin: 0 }}>
                            Control: <strong>#{simMeta.targetControlId}</strong>
                            {simMeta.animation?.enabled && (
                              <span style={{ marginLeft: 6, color: '#16a34a' }}>
                                · animating {simMeta.animation.min}→{simMeta.animation.max} @ {simMeta.animation.intervalMs}ms
                              </span>
                            )}
                          </p>
                        )}
                        {(simMeta.hideControlIds.length > 0 || simMeta.hideButtonIds.length > 0 || simMeta.hideSelectorStrings.length > 0) && (
                          <p style={{ fontSize: 10, color: '#4b5563', margin: 0 }}>
                            Hidden: {[...simMeta.hideControlIds.map(id => `#${id}`), ...simMeta.hideButtonIds.map(id => `#${id}`), ...simMeta.hideSelectorStrings].join(', ')}
                          </p>
                        )}
                        {simMeta.warnings.length > 0 && (
                          <div style={{ backgroundColor: '#fef9c3', border: '1px solid #fde68a', borderRadius: 6, padding: '5px 8px' }}>
                            {simMeta.warnings.map((w, i) => (
                              <p key={i} style={{ fontSize: 10, color: '#713f12', margin: 0 }}>⚠ {w}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <button
                      onClick={handleGenerateScript}
                      disabled={generating || !simPrompt.trim()}
                      style={{
                        width: '100%', height: 42, borderRadius: 10, border: 'none',
                        backgroundColor: generating || !simPrompt.trim() ? '#fde68a' : '#f59e0b',
                        color: '#78350f', fontSize: 13, fontWeight: 700,
                        cursor: generating || !simPrompt.trim() ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        transition: 'background-color 0.12s',
                      }}
                      onMouseEnter={e => { if (!generating && simPrompt.trim()) (e.currentTarget as HTMLElement).style.backgroundColor = '#d97706'; }}
                      onMouseLeave={e => { if (!generating && simPrompt.trim()) (e.currentTarget as HTMLElement).style.backgroundColor = '#f59e0b'; }}
                    >
                      {generating ? (
                        <>
                          <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #92400e44', borderTopColor: '#92400e', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                          Generating bridge script…
                        </>
                      ) : '✦ Generate with AI'}
                    </button>
                    {!generating && (
                      <p style={{ fontSize: 10, color: '#b45309', opacity: 0.7, textAlign: 'center', margin: '-8px 0 0' }}>
                        ~30–60 s · Claude reads your full simulation code
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── VIDEO GENERATION (non-broll video sections) ── */}
            {type === 'video' && !isBroll && (
              <div style={{
                backgroundColor: '#eff6ff', border: '1.5px solid #bfdbfe',
                borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14 }}>🎬</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#1d4ed8' }}>Generate B-Roll</span>
                  <span style={{ fontSize: 10, color: '#2563eb', backgroundColor: '#dbeafe', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>AI Video</span>
                </div>

                <div>
                  <label style={{ ...labelStyle, color: '#2563eb' }}>Prompt</label>
                  <textarea
                    value={genPrompt}
                    onChange={e => setGenPrompt(e.target.value)}
                    placeholder="Describe the shot… e.g. aerial cityscape at sunset, slow pan"
                    rows={3}
                    maxLength={500}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 8,
                      border: '1.5px solid #bfdbfe', backgroundColor: '#fff',
                      fontSize: 13, color: '#111827', outline: 'none',
                      resize: 'vertical', boxSizing: 'border-box',
                      fontFamily: 'system-ui, -apple-system, sans-serif', lineHeight: 1.5,
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = '#3b82f6'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = '#bfdbfe'; }}
                  />
                  <p style={{ fontSize: 10, color: '#3b82f6', textAlign: 'right', margin: '3px 0 0', opacity: 0.7 }}>{genPrompt.length}/500</p>
                </div>

                <div>
                  <label style={{ ...labelStyle, color: '#2563eb' }}>Model</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(Object.keys(GEN_MODELS) as GenModel[]).map(m => {
                      const active = genModel === m;
                      return (
                        <button
                          key={m}
                          onClick={() => setGenModel(m)}
                          style={{
                            flex: 1, padding: '8px 10px', borderRadius: 9, textAlign: 'left',
                            border: `1.5px solid ${active ? '#3b82f6' : '#e5e7eb'}`,
                            backgroundColor: active ? '#eff6ff' : '#f9fafb',
                            cursor: 'pointer', transition: 'all 0.12s',
                            display: 'flex', alignItems: 'center', gap: 8,
                          }}
                        >
                          <div style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0, border: `2px solid ${active ? '#3b82f6' : '#d1d5db'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {active && <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#3b82f6' }} />}
                          </div>
                          <div>
                            <p style={{ fontSize: 11, fontWeight: 700, color: active ? '#1d4ed8' : '#374151', margin: 0 }}>{GEN_MODELS[m].name}</p>
                            <p style={{ fontSize: 9, color: '#9ca3af', margin: 0 }}>{GEN_MODELS[m].desc}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {genModel === 'veo' && (section.end_sec - section.start_sec) > 8 && (
                  <div style={{ backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px' }}>
                    <p style={{ fontSize: 10, color: '#92400e', margin: 0 }}>Veo 3 max is 8s — generation will be capped at 8s.</p>
                  </div>
                )}

                <button
                  onClick={() => setGenEnhance(v => !v)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 9,
                    border: `1.5px solid ${genEnhance ? '#3b82f6' : '#e5e7eb'}`,
                    backgroundColor: genEnhance ? '#eff6ff' : '#f9fafb',
                    cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s',
                  }}
                >
                  <span style={{ width: 36, height: 20, borderRadius: 10, flexShrink: 0, backgroundColor: genEnhance ? '#3b82f6' : '#d1d5db', position: 'relative', display: 'inline-block', transition: 'background-color 0.15s' }}>
                    <span style={{ position: 'absolute', top: 3, left: genEnhance ? 18 : 3, width: 14, height: 14, borderRadius: '50%', backgroundColor: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.15s' }} />
                  </span>
                  <div>
                    <p style={{ fontSize: 12, fontWeight: 600, color: genEnhance ? '#1d4ed8' : '#374151', margin: 0 }}>Enhance prompt</p>
                    <p style={{ fontSize: 10, color: '#9ca3af', margin: 0 }}>Claude adds camera motion, lighting & style</p>
                  </div>
                </button>

                {genError && (
                  <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
                    <p style={{ fontSize: 11, color: '#dc2626', margin: 0 }}>{genError}</p>
                  </div>
                )}

                {genJob && (
                  <div style={{
                    borderRadius: 9,
                    border: `1px solid ${genJob.status === 'ready' ? '#6ee7b7' : genJob.status === 'failed' ? '#fca5a5' : '#bfdbfe'}`,
                    backgroundColor: genJob.status === 'ready' ? '#f0fdf4' : genJob.status === 'failed' ? '#fef2f2' : '#f0f9ff',
                    padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    {genJob.status !== 'ready' && genJob.status !== 'failed' && (
                      <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#3b82f6', flexShrink: 0, animation: 'pulse 1.5s ease-in-out infinite' }} />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 11, fontWeight: 600, margin: 0, color: genJob.status === 'ready' ? '#059669' : genJob.status === 'failed' ? '#dc2626' : '#2563eb' }}>
                        {JOB_STATUS_LABEL[genJob.status] ?? genJob.status}
                      </p>
                      {genJob.status !== 'ready' && genJob.status !== 'failed' && (
                        <p style={{ fontSize: 10, color: '#9ca3af', margin: '2px 0 0' }}>{elapsed(genJob.created_at)}</p>
                      )}
                      {genJob.status === 'failed' && genJob.error && (
                        <p style={{ fontSize: 10, color: '#dc2626', margin: '2px 0 0' }}>{genJob.error}</p>
                      )}
                    </div>
                  </div>
                )}

                {(() => {
                  const isVidGenerating = genBusy || (genJob != null && genJob.status !== 'ready' && genJob.status !== 'failed');
                  return (
                    <button
                      onClick={handleGenerateVideo}
                      disabled={isVidGenerating || !genPrompt.trim()}
                      style={{
                        width: '100%', height: 42, borderRadius: 10, border: 'none',
                        backgroundColor: isVidGenerating || !genPrompt.trim() ? '#bfdbfe' : '#3b82f6',
                        color: '#fff', fontSize: 13, fontWeight: 700,
                        cursor: isVidGenerating || !genPrompt.trim() ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        transition: 'background-color 0.12s',
                      }}
                      onMouseEnter={e => { if (!isVidGenerating && genPrompt.trim()) (e.currentTarget as HTMLElement).style.backgroundColor = '#2563eb'; }}
                      onMouseLeave={e => { if (!isVidGenerating && genPrompt.trim()) (e.currentTarget as HTMLElement).style.backgroundColor = '#3b82f6'; }}
                    >
                      {isVidGenerating ? (
                        <>
                          <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                          {genBusy ? 'Queuing…' : 'Generating…'}
                        </>
                      ) : '🎬 Generate Video'}
                    </button>
                  );
                })()}
              </div>
            )}

            {/* ── BROLL INFO ── */}
            {isBroll && (
              <div style={{
                backgroundColor: '#ecfeff', border: '1.5px solid #a5f3fc',
                borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13 }}>🎬</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#0e7490' }}>AI-Generated B-Roll</span>
                </div>
                {section.label && (
                  <div>
                    <p style={{ fontSize: 10, fontWeight: 600, color: '#0e7490', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 5px' }}>Generation Prompt</p>
                    <p style={{ fontSize: 12, color: '#155e75', margin: 0, lineHeight: 1.55, fontStyle: 'italic' }}>"{section.label}"</p>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, color: '#0891b2', backgroundColor: '#cffafe', borderRadius: 5, padding: '2px 8px', fontWeight: 600 }}>
                    {fmtTime(section.end_sec - section.start_sec)} clip
                  </span>
                </div>
              </div>
            )}

            {/* ── TIMING ── */}
            <div>
              <label style={labelStyle}>Timing</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {[
                  { label: 'Start', value: startStr, set: setStartStr },
                  { label: 'End',   value: endStr,   set: setEndStr   },
                ].map(({ label: tLabel, value, set }) => (
                  <div key={tLabel}>
                    <p style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 5px' }}>{tLabel}</p>
                    <input
                      type="text"
                      value={value}
                      onChange={e => set(e.target.value)}
                      style={{ ...inputStyle, fontFamily: 'monospace', height: 36, fontSize: 13 }}
                      onFocus={e => { e.currentTarget.style.borderColor = '#93c5fd'; }}
                      onBlur={e => { e.currentTarget.style.borderColor = '#e5e7eb'; }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {saveError && (
              <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
                <p style={{ fontSize: 11, color: '#dc2626', margin: 0 }}>{saveError}</p>
              </div>
            )}
          </div>

          {/* RIGHT: Preview / Trimmer / Files */}
          <div style={{
            flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
            backgroundColor: '#111827', position: 'relative',
          }}>

            {/* ── CLIP TRIMMER (right panel, type=clip) ── */}
            {type === 'clip' && !isBroll && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

                {/* Video preview */}
                <div style={{ flex: 1, position: 'relative', backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  {clipUrl ? (
                    <video
                      key={clipUrl}
                      ref={clipVideoRef}
                      src={clipUrl}
                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      preload="metadata"
                      onLoadedMetadata={() => {
                        if (clipVideoRef.current) {
                          clipVideoRef.current.currentTime = clipInSec;
                          setClipCurrentTime(clipInSec);
                        }
                      }}
                      onTimeUpdate={() => {
                        const v = clipVideoRef.current;
                        if (!v) return;
                        setClipCurrentTime(v.currentTime);
                        // Auto-stop at out-point when playing selection
                        if (clipPlaying && v.currentTime >= clipInSec + sectionDuration) {
                          v.pause();
                          v.currentTime = clipInSec;
                          setClipCurrentTime(clipInSec);
                          setClipPlaying(false);
                        }
                      }}
                      onEnded={() => setClipPlaying(false)}
                      onPause={() => setClipPlaying(false)}
                    />
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                      <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                        <rect x="4" y="12" width="44" height="28" rx="5" stroke="#374151" strokeWidth="2" />
                        <path d="M20 20l14 6-14 6V20z" fill="#4b5563" />
                      </svg>
                      <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
                        {clipSourceVideoId ? 'Loading video…' : 'Select a source video'}
                      </p>
                    </div>
                  )}

                  {/* In/Out overlay badges */}
                  {clipUrl && clipSourceDur > 0 && (
                    <div style={{
                      position: 'absolute', bottom: 10, left: 0, right: 0,
                      display: 'flex', justifyContent: 'center', gap: 8, pointerEvents: 'none',
                    }}>
                      <span style={{ fontSize: 10, backgroundColor: 'rgba(0,0,0,0.7)', color: '#f59e0b', padding: '3px 8px', borderRadius: 4, fontFamily: 'monospace', fontWeight: 700 }}>
                        IN {fmtTimeLong(clipInSec)}
                      </span>
                      <span style={{ fontSize: 10, backgroundColor: 'rgba(0,0,0,0.7)', color: '#94a3b8', padding: '3px 8px', borderRadius: 4, fontFamily: 'monospace' }}>
                        {fmtTimeLong(clipCurrentTime)}
                      </span>
                      <span style={{ fontSize: 10, backgroundColor: 'rgba(0,0,0,0.7)', color: '#f59e0b', padding: '3px 8px', borderRadius: 4, fontFamily: 'monospace', fontWeight: 700 }}>
                        OUT {fmtTimeLong(clipOutSec)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Scrubber + controls area */}
                {clipUrl && (
                  <div style={{ flexShrink: 0, backgroundColor: '#0f172a', padding: '14px 20px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>

                    {/* Time ruler labels */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace' }}>
                        {fmtTimeLong(0)}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, color: '#f59e0b', fontFamily: 'monospace', fontWeight: 700 }}>
                          In: {fmtTimeLong(clipInSec)}
                        </span>
                        <span style={{ fontSize: 10, color: '#64748b' }}>·</span>
                        <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
                          Dur: {fmtTime(sectionDuration)}
                        </span>
                        <span style={{ fontSize: 10, color: '#64748b' }}>·</span>
                        <span style={{ fontSize: 10, color: '#f59e0b', fontFamily: 'monospace', fontWeight: 700 }}>
                          Out: {fmtTimeLong(clipOutSec)}
                        </span>
                      </div>
                      <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace' }}>
                        {clipSourceDur > 0 ? fmtTimeLong(clipSourceDur) : '…'}
                      </span>
                    </div>

                    {/* Scrubber track */}
                    <div
                      ref={clipScrubRef}
                      onMouseDown={handleScrubMouseDown}
                      style={{
                        position: 'relative', height: 48,
                        backgroundColor: '#1e293b', borderRadius: 6,
                        cursor: 'crosshair', userSelect: 'none', overflow: 'visible',
                      }}
                    >
                      {/* Track background grid lines */}
                      <div style={{ position: 'absolute', inset: 0, borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(90deg, transparent, transparent calc(10% - 1px), rgba(255,255,255,0.04) calc(10% - 1px), rgba(255,255,255,0.04) 10%)' }} />
                      </div>

                      {/* Selection window */}
                      {clipSourceDur > 0 && (
                        <div
                          onMouseDown={handleWindowMouseDown}
                          style={{
                            position: 'absolute',
                            top: 0, bottom: 0,
                            left: `${winLeft}%`,
                            width: `${winWidth}%`,
                            backgroundColor: 'rgba(245,158,11,0.2)',
                            border: '2px solid #f59e0b',
                            borderRadius: 4,
                            cursor: 'grab',
                            boxSizing: 'border-box',
                          }}
                        >
                          {/* Left in-point handle */}
                          <div style={{
                            position: 'absolute', left: -1, top: 0, bottom: 0, width: 4,
                            backgroundColor: '#f59e0b', borderRadius: '3px 0 0 3px',
                          }} />
                          {/* Right out-point handle */}
                          <div style={{
                            position: 'absolute', right: -1, top: 0, bottom: 0, width: 4,
                            backgroundColor: '#f59e0b', borderRadius: '0 3px 3px 0',
                          }} />
                          {/* Duration label inside window (only if wide enough) */}
                          {winWidth > 10 && (
                            <div style={{
                              position: 'absolute', inset: 0,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              pointerEvents: 'none',
                            }}>
                              <span style={{ fontSize: 9, color: '#f59e0b', fontFamily: 'monospace', fontWeight: 700, opacity: 0.8 }}>
                                {fmtTime(sectionDuration)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Red playhead */}
                      {clipSourceDur > 0 && (
                        <div
                          style={{
                            position: 'absolute',
                            top: -5, bottom: -5,
                            left: `${playheadLeft}%`,
                            width: 2,
                            backgroundColor: '#ef4444',
                            borderRadius: 1,
                            pointerEvents: 'none',
                            transform: 'translateX(-1px)',
                          }}
                        >
                          <div style={{
                            position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)',
                            width: 8, height: 8, borderRadius: '50%', backgroundColor: '#ef4444',
                          }} />
                        </div>
                      )}
                    </div>

                    {/* Controls row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                      {/* Mark In button */}
                      <button
                        onClick={handleMarkIn}
                        title="Set in-point to current time (I)"
                        style={{
                          height: 30, padding: '0 12px', borderRadius: 6,
                          border: '1.5px solid #334155', backgroundColor: '#1e293b',
                          color: '#f59e0b', fontSize: 11, fontWeight: 700,
                          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                          transition: 'background-color 0.1s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#334155'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#1e293b'; }}
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M3 1v8M3 5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                        Mark In
                      </button>

                      {/* Play In→Out */}
                      <button
                        onClick={handlePlaySection}
                        disabled={!clipSourceDur}
                        style={{
                          height: 30, padding: '0 14px', borderRadius: 6,
                          border: 'none',
                          backgroundColor: clipPlaying ? '#7c3aed' : '#10b981',
                          color: '#fff', fontSize: 11, fontWeight: 700,
                          cursor: clipSourceDur ? 'pointer' : 'not-allowed',
                          display: 'flex', alignItems: 'center', gap: 5,
                          opacity: clipSourceDur ? 1 : 0.4,
                          transition: 'background-color 0.1s',
                        }}
                        onMouseEnter={e => { if (clipSourceDur) (e.currentTarget as HTMLElement).style.backgroundColor = clipPlaying ? '#6d28d9' : '#059669'; }}
                        onMouseLeave={e => { if (clipSourceDur) (e.currentTarget as HTMLElement).style.backgroundColor = clipPlaying ? '#7c3aed' : '#10b981'; }}
                      >
                        {clipPlaying ? '⏸ Pause' : '▶ Play In→Out'}
                      </button>

                      <div style={{ flex: 1 }} />

                      {/* Current time display */}
                      <span style={{ fontSize: 11, color: '#ef4444', fontFamily: 'monospace', fontWeight: 700 }}>
                        {fmtTimeLong(clipCurrentTime)}
                      </span>

                      {/* Keyboard hint */}
                      <span style={{ fontSize: 9, color: '#334155', backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 3, padding: '2px 5px', fontFamily: 'monospace' }}>I</span>
                      <span style={{ fontSize: 9, color: '#475569' }}>= mark in</span>
                    </div>
                  </div>
                )}

                {/* Empty state when no video selected */}
                {!clipUrl && (
                  <div style={{ flexShrink: 0, backgroundColor: '#0f172a', padding: '16px 20px' }}>
                    <p style={{ fontSize: 11, color: '#475569', margin: 0, textAlign: 'center' }}>
                      Select or upload a source video on the left to open the clip trimmer
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── SIMULATION right panel ── */}
            {type === 'simulation' && (
              <>
                <div style={{ display: 'flex', borderBottom: '1px solid #1f2937', flexShrink: 0, backgroundColor: '#0f172a', alignItems: 'center' }}>
                  {(['preview', 'files'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setRightTab(t)}
                      style={{
                        flex: 1, padding: '8px 0', fontSize: 11, fontWeight: 600,
                        color: rightTab === t ? '#22d3ee' : '#6b7280',
                        borderTop: 'none', borderLeft: 'none', borderRight: 'none',
                        borderBottom: rightTab === t ? '2px solid #22d3ee' : '2px solid transparent',
                        background: 'none', cursor: 'pointer', transition: 'color 0.15s',
                      }}
                    >
                      {t === 'preview' ? 'Preview' : 'Files'}
                    </button>
                  ))}
                  {rightTab === 'preview' && section.simulation_url && (
                    <div style={{ display: 'flex', gap: 4, paddingRight: 8, flexShrink: 0 }}>
                      <button
                        onClick={() => sendToPreview('startScript')}
                        style={{
                          height: 24, padding: '0 8px', borderRadius: 5, border: 'none',
                          backgroundColor: previewRunning ? '#065f46' : '#1e3a5f',
                          color: previewRunning ? '#6ee7b7' : '#93c5fd',
                          fontSize: 10, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.03em',
                        }}
                      >▶ Run</button>
                      <button
                        onClick={() => sendToPreview('stopScript')}
                        style={{
                          height: 24, padding: '0 8px', borderRadius: 5, border: 'none',
                          backgroundColor: '#1f2937', color: '#6b7280',
                          fontSize: 10, fontWeight: 700, cursor: 'pointer',
                        }}
                      >■ Stop</button>
                    </div>
                  )}
                </div>

                {rightTab === 'preview' ? (
                  simPreviewUrl ? (
                    <iframe
                      key={simPreviewUrl}
                      ref={previewIframeRef}
                      src={simPreviewUrl}
                      style={{ flex: 1, border: 'none', width: '100%', height: '100%' }}
                      title={activeSim?.name ?? 'Simulation preview'}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
                      onLoad={() => setPreviewRunning(false)}
                    />
                  ) : (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                        <circle cx="24" cy="24" r="19" stroke="#374151" strokeWidth="2" />
                        <path d="M24 14v10l6 4.5" stroke="#4b5563" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Select a simulation to preview</p>
                    </div>
                  )
                ) : (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    {simFilesLoading ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid #374151', borderTopColor: '#22d3ee', animation: 'spin 0.8s linear infinite' }} />
                      </div>
                    ) : simFiles.length === 0 ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <p style={{ fontSize: 12, color: '#4b5563', margin: 0 }}>No files found</p>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', overflowX: 'auto', flexShrink: 0, borderBottom: '1px solid #1f2937', backgroundColor: '#0f172a', scrollbarWidth: 'none' }}>
                          {simFiles.map(f => {
                            const isAiBridge = f.filename.startsWith('section_') && f.ext === 'js';
                            const isAiHtml   = f.filename.startsWith('section_') && f.ext === 'html';
                            const isActive   = f.key === activeFileKey;
                            return (
                              <button
                                key={f.key}
                                onClick={() => setActiveFileKey(f.key)}
                                title={f.key}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
                                  padding: '6px 12px', fontSize: 11, fontWeight: isActive ? 600 : 400,
                                  color: isActive ? '#e2e8f0' : '#6b7280',
                                  background: isActive ? '#1e293b' : 'none',
                                  borderTop: 'none', borderLeft: 'none', borderRight: 'none',
                                  borderBottom: isActive ? '2px solid #22d3ee' : '2px solid transparent',
                                  cursor: 'pointer', whiteSpace: 'nowrap',
                                }}
                              >
                                {f.filename}
                                {(isAiBridge || isAiHtml) && (
                                  <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3, backgroundColor: '#0e7490', color: '#cffafe' }}>AI</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
                          {fileContentLoading ? (
                            <div style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #374151', borderTopColor: '#22d3ee', animation: 'spin 0.8s linear infinite' }} />
                              <span style={{ fontSize: 11, color: '#6b7280' }}>Loading…</span>
                            </div>
                          ) : fileContent !== null ? (
                            <pre style={{ margin: 0, padding: '14px 16px', fontSize: 11, lineHeight: 1.6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#94a3b8', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                              {fileContent}
                            </pre>
                          ) : (
                            <div style={{ padding: 20 }}>
                              <p style={{ fontSize: 11, color: '#4b5563', margin: 0 }}>Select a file above</p>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}

            {/* ── VIDEO / BROLL right panel ── */}
            {(type === 'video' || isBroll) && (
              videoUrl ? (
                <video
                  src={videoUrl}
                  controls
                  style={{ flex: 1, width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#111827' }}
                />
              ) : (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <rect x="4" y="10" width="40" height="28" rx="4" stroke="#374151" strokeWidth="2" />
                    <path d="M18 18l14 6-14 6V18z" fill="#4b5563" />
                  </svg>
                  <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Video preview not available</p>
                  <p style={{ fontSize: 11, color: '#4b5563', margin: 0 }}>HLS transcoding may still be in progress</p>
                </div>
              )
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{
          flexShrink: 0, padding: '14px 24px',
          borderTop: '1px solid #f3f4f6',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 10, backgroundColor: '#fafafa',
        }}>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              height: 36, padding: '0 16px', borderRadius: 8,
              border: '1.5px solid #fecaca', backgroundColor: '#fff',
              color: '#ef4444', fontSize: 13, fontWeight: 500,
              cursor: deleting ? 'not-allowed' : 'pointer',
              opacity: deleting ? 0.5 : 1, transition: 'background-color 0.1s',
            }}
            onMouseEnter={e => { if (!deleting) (e.currentTarget as HTMLElement).style.backgroundColor = '#fef2f2'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#fff'; }}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={onClose}
              style={{
                height: 36, padding: '0 16px', borderRadius: 8,
                border: '1.5px solid #e5e7eb', backgroundColor: '#fff',
                color: '#6b7280', fontSize: 13, fontWeight: 500, cursor: 'pointer',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#f9fafb'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#fff'; }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                height: 36, padding: '0 22px', borderRadius: 8,
                border: 'none',
                backgroundColor: saving ? '#93c5fd' : '#3b82f6',
                color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer', transition: 'background-color 0.12s',
              }}
              onMouseEnter={e => { if (!saving) (e.currentTarget as HTMLElement).style.backgroundColor = '#2563eb'; }}
              onMouseLeave={e => { if (!saving) (e.currentTarget as HTMLElement).style.backgroundColor = '#3b82f6'; }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </>
  );
}
