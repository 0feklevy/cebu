'use client';

import { ConfirmDialog } from './ConfirmDialog';
import { useState, useEffect, useRef, useCallback } from 'react';
import { getAuth } from 'firebase/auth';
import { Archive, Check, ChevronDown, ChevronUp, Copy, Download, Maximize2, Minimize2, Play, Square } from 'lucide-react';
import type { TimelineSection, Simulation, VideoFile, VideoGenerationJob, SimFile, SimMeta, ImageFile, GuidanceEntry, GuidanceMeta, GuidanceStatus } from 'shared/src/generated/client-v1';
import { api } from '../lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

const GUIDANCE_LANGS: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'he', label: 'עברית' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ar', label: 'العربية' },
  { code: 'zh', label: '中文' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
];

type GenModel = 'kling' | 'seedance' | 'veo';

const GEN_MODELS: Record<GenModel, string> = {
  kling: 'kling',
  seedance: 'seedance',
  veo: 'veo',
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

// 'clip' is no longer a top-level type in the UI — it lives inside 'video' as a sub-mode
const TYPES = [
  { value: 'video',      label: 'Video',      color: '#3b82f6', bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8' },
  { value: 'simulation', label: 'Simulation', color: '#f59e0b', bg: '#fffbeb', border: '#fcd34d', text: '#92400e' },
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

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

const CAMERA_MOVEMENTS = [
  { value: 'zoom_in',   label: 'Zoom In'     },
  { value: 'zoom_out',  label: 'Zoom Out'    },
  { value: 'pan_right', label: 'Pan Right'   },
  { value: 'pan_left',  label: 'Pan Left'    },
  { value: 'dolly_in',  label: 'Dolly In'    },
  { value: 'drift',     label: 'Drift'       },
] as const;

interface Props {
  section: TimelineSection;
  projectId: string;
  simulations: Simulation[];
  videos: VideoFile[];
  videoUrls: Record<string, string>;
  images?: ImageFile[];
  onUpdate: (s: TimelineSection) => void;
  onDelete: (id: string) => void;
  onSimulationUpdate?: (sim: Simulation) => void;
  onClose: () => void;
}

export function SectionEditor({
  section, projectId, simulations, videos, videoUrls, images = [],
  onUpdate, onDelete, onSimulationUpdate, onClose,
}: Props) {
  const isBroll = section.track === 'broll';
  const knownTypes = TYPES.map(t => t.value) as string[];
  // 'clip' maps to 'video' in the switcher (it's a sub-mode), preserve it internally for save
  const initialType = isBroll ? 'video' : (knownTypes.includes(section.type) ? section.type : section.type === 'clip' ? 'clip' : 'video');

  const [type, setType]         = useState(initialType);
  const [label, setLabel]       = useState(section.label ?? '');
  const [simId, setSimId]       = useState(section.simulation_id ?? '');
  const [simScript] = useState(section.sim_script ?? '');
  const [simPrompt, setSimPrompt]   = useState(section.sim_prompt ?? '');
  const [simpleUi, setSimpleUi]     = useState(section.simple_ui ?? false);
  const [autoScript, setAutoScript] = useState(section.auto_script ?? true);
  const [showTiming, setShowTiming]   = useState(false);
  const [brollVolume, setBrollVolume] = useState<number>(
    (section as unknown as { broll_volume?: number }).broll_volume ?? 1.0
  );
  const [generating, setGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [simGenError, setSimGenError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // ── Guided Simulation (mother-sim-level voice guidance) ───────────────────
  const [guidanceLang, setGuidanceLang]         = useState('en');
  const [guidance, setGuidance]                 = useState<GuidanceEntry[] | null>(null);
  const [guidanceStatus, setGuidanceStatus]     = useState<GuidanceStatus>('none');
  const [guidanceMeta, setGuidanceMeta]         = useState<GuidanceMeta | null>(null);
  const [guidanceBusy, setGuidanceBusy]         = useState<false | 'analyzing' | 'publishing'>(false);
  const [guidanceStatusMsg, setGuidanceStatusMsg] = useState<string | null>(null);
  const [guidanceError, setGuidanceError]       = useState<string | null>(null);
  const guidanceEsRef = useRef<EventSource | null>(null);
  const [startStr, setStartStr] = useState(fmtTime(section.start_sec));
  const [endStr, setEndStr]     = useState(fmtTime(section.end_sec));
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Video generation state
  const [genPrompt, setGenPrompt]   = useState('');
  const [genModel, setGenModel]     = useState<GenModel>('kling');
  const [genEnhance, setGenEnhance] = useState(true);
  const [genBusy, setGenBusy]       = useState(false);
  const [genError, setGenError]     = useState<string | null>(null);
  const [genJob, setGenJob]         = useState<VideoGenerationJob | null>(null);

  // Preview iframe control (simulation)
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const simPreviewShellRef = useRef<HTMLDivElement>(null);
  const rightVideoRef = useRef<HTMLVideoElement>(null);
  const [previewRunning, setPreviewRunning] = useState(false);

  // Right-panel tabs (simulation only)
  const [rightTab, setRightTab]               = useState<'preview' | 'files'>('preview');
  const [simFiles, setSimFiles]               = useState<SimFile[]>([]);
  const [simFilesLoading, setSimFilesLoading] = useState(false);
  const [simFilesError, setSimFilesError]     = useState<string | null>(null);
  const [activeFileKey, setActiveFileKey]     = useState<string | null>(null);
  const [fileContent, setFileContent]         = useState<string | null>(null);
  const [fileContentLoading, setFileContentLoading] = useState(false);
  const [copiedFile, setCopiedFile] = useState(false);
  const [fileDownloadBusy, setFileDownloadBusy] = useState(false);
  const [zipDownloadBusy, setZipDownloadBusy] = useState(false);

  // ── Clip section state ─────────────────────────────────────────────────────
  const [localVideos, setLocalVideos]   = useState<VideoFile[]>(videos);
  const [localClipUrls, setLocalClipUrls] = useState<Record<string, string>>({});
  const [clipSourceVideoId, setClipSourceVideoId] = useState(section.clip_source_video_id ?? '');
  const [clipSourceImageId, setClipSourceImageId] = useState(section.clip_source_image_id ?? '');
  const [cameraMovement, setCameraMovement] = useState(section.camera_movement ?? 'zoom_in');
  // 'visual' sub-mode: 'video' = existing video clip, 'image' = uploaded still image
  const [clipVisualMode, setClipVisualMode] = useState<'video' | 'image'>(
    section.clip_source_image_id ? 'image' : 'video',
  );
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
  const [isCompactModal, setIsCompactModal] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = window.matchMedia('(max-width: 900px), (max-height: 680px)');
    const sync = () => setIsCompactModal(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const t = isBroll ? 'video' : (knownTypes.includes(section.type) ? section.type : section.type === 'clip' ? 'clip' : 'video');
    setType(t);
    setLabel(section.label ?? '');
    setSimId(section.simulation_id ?? '');
    setSimPrompt(section.sim_prompt ?? '');
    setSimpleUi(section.simple_ui ?? false);
    setAutoScript(section.auto_script ?? true);
    setSimGenError(null);
    setGenerating(false);
    setGenerationStatus(null);
    setShowTiming(false);
    setBrollVolume((section as unknown as { broll_volume?: number }).broll_volume ?? 1.0);
    // Close any active SSE stream when section changes
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
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
    setCopiedFile(false);
    setFileDownloadBusy(false);
    setZipDownloadBusy(false);
    // Clip state reset
    setClipSourceVideoId(section.clip_source_video_id ?? '');
    setClipSourceImageId(section.clip_source_image_id ?? '');
    setCameraMovement(section.camera_movement ?? 'zoom_in');
    setClipVisualMode(section.clip_source_image_id ? 'image' : 'video');
    setClipInSec(section.clip_in_sec ?? 0);
    setClipCurrentTime(section.clip_in_sec ?? 0);
    setClipPlaying(false);
    setClipUploadErr(null);
    setTimeout(() => labelRef.current?.focus(), 80);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.id]);

  // Sync localVideos whenever the parent videos prop changes (e.g., new uploads or status changes).
  // Merge: locally uploaded clips take precedence; prop additions are appended.
  useEffect(() => {
    setLocalVideos(prev => {
      const propMap = new Map(videos.map(v => [v.id, v]));
      const merged = prev.map(v => propMap.get(v.id) ?? v);
      for (const v of videos) {
        if (!merged.find(m => m.id === v.id)) merged.push(v);
      }
      return merged;
    });
  }, [videos]);

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

  // Close SSE stream on unmount
  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

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
    setSimFilesError(null);
    setActiveFileKey(null);
    setFileContent(null);
    api.listSimFiles(projectId, simId)
      .then(files => {
        setSimFiles(files);
        const firstText = files.find(f => f.isText) ?? files[0] ?? null;
        if (firstText) setActiveFileKey(firstText.key);
      })
      .catch(err => setSimFilesError((err as Error).message ?? 'Failed to load files'))
      .finally(() => setSimFilesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightTab, simId, section.simulation_url]);

  // Load sim file content
  useEffect(() => {
    if (!activeFileKey || !simId) { setFileContent(null); return; }
    const activeFile = simFiles.find(f => f.key === activeFileKey);
    if (activeFile && !activeFile.isText) { setFileContent(null); return; }
    setFileContentLoading(true);
    setFileContent(null);
    setCopiedFile(false);
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

  // SIM_READY listener — passes simpleUi/autoScript as runtime params so toggle changes take effect immediately
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'SIM_READY' && previewIframeRef.current) {
        const script = section.sim_script ?? 'main';
        // Use the live toggle state, not the saved props, so the preview reflects what the
        // viewer just toggled (and what Save will persist) — frontend-005.
        previewIframeRef.current.contentWindow?.postMessage(
          { type: 'startScript', script, params: { simpleUi, autoScript } },
          '*',
        );
        setPreviewRunning(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.sim_script, simpleUi, autoScript]);

  const sendToPreview = useCallback((type: string) => {
    const msg: Record<string, unknown> = { type };
    // Pass current toggle state as runtime params so the bridge responds without re-generation
    if (type === 'startScript') msg.params = { simpleUi, autoScript };
    previewIframeRef.current?.contentWindow?.postMessage(msg, '*');
    if (type === 'stopScript') setPreviewRunning(false);
    if (type === 'startScript') setPreviewRunning(true);
  }, [simpleUi, autoScript]);

  const [isSimFullscreen, setIsSimFullscreen] = useState(false);

  useEffect(() => {
    const handler = () => setIsSimFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleSimFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      simPreviewShellRef.current?.requestFullscreen?.().catch(() => {});
    }
  }, []);

  const openFullscreen = useCallback((target: HTMLElement | null) => {
    target?.requestFullscreen?.().catch(() => {});
  }, []);

  const handleCopyActiveFile = useCallback(async () => {
    const file = simFiles.find(f => f.key === activeFileKey) ?? null;
    if (!file || !simId) return;
    const content = fileContent ?? await api.getSimFileContent(projectId, simId, file.key);
    await copyTextToClipboard(content);
    setCopiedFile(true);
    window.setTimeout(() => setCopiedFile(false), 1400);
  }, [activeFileKey, fileContent, projectId, simFiles, simId]);

  const handleDownloadActiveFile = useCallback(async () => {
    const file = simFiles.find(f => f.key === activeFileKey) ?? null;
    if (!file || !simId) return;
    setFileDownloadBusy(true);
    try {
      const content = fileContent ?? await api.getSimFileContent(projectId, simId, file.key);
      saveBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), file.filename);
    } catch { /* ignore */ }
    finally {
      setFileDownloadBusy(false);
    }
  }, [activeFileKey, fileContent, projectId, simFiles, simId]);

  const handleDownloadSimulationZip = useCallback(async () => {
    if (!simId) return;
    setZipDownloadBusy(true);
    try {
      const blob = await api.downloadSimZip(projectId, simId);
      const simName = simulations.find(s => s.id === simId)?.name ?? 'simulation';
      const safeName = simName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'simulation';
      saveBlob(blob, `${safeName}.zip`);
    } catch (err) {
      alert(`ZIP download failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setZipDownloadBusy(false);
    }
  }, [projectId, simulations, simId]);

  const handleGenerateScript = useCallback(async () => {
    if (!simId || !simPrompt.trim()) return;

    // Ensure section is set to simulation type first
    if (section.type !== 'simulation' || section.simulation_id !== simId) {
      try {
        const patched = await api.updateSection(projectId, section.id, {
          type: 'simulation',
          simulation_id: simId,
        });
        onUpdate(patched);
      } catch (err) {
        setSimGenError((err as Error).message ?? 'Failed to update section');
        return;
      }
    }

    eventSourceRef.current?.close();
    setGenerating(true);
    setGenerationStatus('Starting…');
    setSimGenError(null);

    const idToken = await getAuth().currentUser?.getIdToken();

    const url = new URL(
      `${API_URL}/api/v1/projects/${projectId}/sections/${section.id}/generate-sim-script/stream`,
    );
    url.searchParams.set('prompt', simPrompt.trim());
    url.searchParams.set('simple_ui', String(simpleUi));
    url.searchParams.set('auto_script', String(autoScript));
    if (idToken) url.searchParams.set('token', idToken);

    const es = new EventSource(url.toString());
    eventSourceRef.current = es;
    let errorHandled = false;

    es.addEventListener('status', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { status: string };
      setGenerationStatus(data.status);
    });

    // Token heartbeat: LLM is actively generating (no raw JSON shown to user)
    es.addEventListener('token', (_e: MessageEvent) => {
      setGenerationStatus(prev =>
        prev && !prev.endsWith('…') ? prev + '…' : (prev ?? 'Generating bridge script…'),
      );
    });

    es.addEventListener('done', (e: MessageEvent) => {
      // Mark handled BEFORE close(): closing an EventSource fires onerror synchronously in
      // some browsers, which would otherwise flash "Connection lost" after success — frontend-011.
      errorHandled = true;
      const data = JSON.parse(e.data) as { section: TimelineSection };
      onUpdate(data.section);
      setGenerating(false);
      setGenerationStatus(null);
      es.close();
      eventSourceRef.current = null;
    });

    es.addEventListener('error', (e: MessageEvent) => {
      if (!e.data || errorHandled) return;
      errorHandled = true;
      const data = JSON.parse(e.data) as { error: string; errorType?: string };
      setSimGenError(data.error || 'Generation failed');
      setGenerating(false);
      setGenerationStatus(null);
      es.close();
      eventSourceRef.current = null;
    });

    es.onerror = () => {
      if (errorHandled) return;
      errorHandled = true;
      setSimGenError('Connection lost. Please try again.');
      setGenerating(false);
      setGenerationStatus(null);
      es.close();
      eventSourceRef.current = null;
    };
  }, [projectId, section, simId, simPrompt, simpleUi, autoScript, onUpdate]);

  const handleCancelGeneration = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setGenerating(false);
    setGenerationStatus(null);
  }, []);

  // ── Guided Simulation handlers ────────────────────────────────────────────
  // Sync local guidance state when the user picks a different simulation.
  // We track whether guidance state was already populated from a live server response
  // so we don't overwrite it with stale props when simulations array reference changes.
  const guidanceInitializedForSimRef = useRef<string | null>(null);
  useEffect(() => {
    if (guidanceInitializedForSimRef.current === simId) return;  // already live-synced, don't stomp
    guidanceInitializedForSimRef.current = simId;
    const s = simulations.find(x => x.id === simId);
    setGuidance(s?.guidance ?? null);
    setGuidanceStatus(s?.guidance_status ?? 'none');
    setGuidanceMeta(s?.guidance_meta ?? null);
    setGuidanceError(null);
    if (s?.guidance_meta?.language) setGuidanceLang(s.guidance_meta.language);
  // Only re-run when simId changes (not on every stale simulations prop update)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simId]);

  useEffect(() => () => { guidanceEsRef.current?.close(); }, []);

  const applyGuidanceSim = (sim: Simulation) => {
    guidanceInitializedForSimRef.current = sim.id;  // mark as live-synced so useEffect won't stomp
    setGuidance(sim.guidance ?? null);
    setGuidanceStatus(sim.guidance_status ?? 'none');
    setGuidanceMeta(sim.guidance_meta ?? null);
    onSimulationUpdate?.(sim);  // propagate up so VideoEditor's simulations state stays current
  };

  const runGuidanceStream = async (kind: 'generate' | 'publish') => {
    if (!simId) return;
    guidanceEsRef.current?.close();
    setGuidanceBusy(kind === 'generate' ? 'analyzing' : 'publishing');
    setGuidanceStatusMsg(kind === 'generate' ? 'Starting analysis…' : 'Starting…');
    setGuidanceError(null);

    const idToken = await getAuth().currentUser?.getIdToken();
    const path = kind === 'generate' ? 'generate-guidance/stream' : 'publish-guidance/stream';
    const url = new URL(`${API_URL}/api/v1/projects/${projectId}/simulations/${simId}/${path}`);
    if (kind === 'generate') url.searchParams.set('language', guidanceLang);
    if (idToken) url.searchParams.set('token', idToken);

    const es = new EventSource(url.toString());
    guidanceEsRef.current = es;
    let handled = false;

    es.addEventListener('status', (e: MessageEvent) => {
      setGuidanceStatusMsg((JSON.parse(e.data) as { status: string }).status);
    });
    es.addEventListener('done', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { simulation: Simulation };
      applyGuidanceSim(data.simulation);
      setGuidanceBusy(false);
      setGuidanceStatusMsg(null);
      es.close();
      guidanceEsRef.current = null;
    });
    es.addEventListener('error', (e: MessageEvent) => {
      if (!e.data || handled) return;
      handled = true;
      setGuidanceError((JSON.parse(e.data) as { error: string }).error || 'Guidance generation failed');
      setGuidanceBusy(false);
      setGuidanceStatusMsg(null);
      es.close();
      guidanceEsRef.current = null;
    });
    es.onerror = () => {
      if (handled) return;
      handled = true;
      setGuidanceError('Connection lost. Please try again.');
      setGuidanceBusy(false);
      setGuidanceStatusMsg(null);
      es.close();
      guidanceEsRef.current = null;
    };
  };

  const saveGuidanceDraft = async (entries: GuidanceEntry[]) => {
    const idToken = await getAuth().currentUser?.getIdToken();
    await fetch(`${API_URL}/api/v1/projects/${projectId}/simulations/${simId}/guidance`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
      body: JSON.stringify({ entries }),
    }).catch(() => { /* best-effort; publish re-reads from DB */ });
  };

  const handlePublishGuidance = async () => {
    if (guidance) await saveGuidanceDraft(guidance);   // persist edits before TTS
    await runGuidanceStream('publish');
  };

  const handleCancelGuidance = () => {
    guidanceEsRef.current?.close();
    guidanceEsRef.current = null;
    setGuidanceBusy(false);
    setGuidanceStatusMsg(null);
  };

  const setEntryNarration = (id: string, text: string) =>
    setGuidance(g => (g ? g.map(e => (e.id === id ? { ...e, narration: text } : e)) : g));
  const toggleEntryEnabled = (id: string) =>
    setGuidance(g => (g ? g.map(e => (e.id === id ? { ...e, enabled: !e.enabled } : e)) : g));

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
        // Persist the simulation toggle state so a plain Save no longer discards it
        // (these were previously only written by AI generation) — frontend-001. (sim_prompt
        // is intentionally not in the PATCH contract; it is owned by the generate endpoint.)
        simple_ui: simpleUi,
        auto_script: autoScript,
        start_sec,
        end_sec,
        ...(type === 'clip' ? {
          clip_source_video_id: clipVisualMode === 'video' ? (clipSourceVideoId || null) : null,
          clip_in_sec: clipVisualMode === 'video' ? safeClipIn : 0,
          clip_source_image_id: clipVisualMode === 'image' ? (clipSourceImageId || null) : null,
          camera_movement: cameraMovement,
        } : {}),
        ...(isBroll ? { broll_volume: brollVolume } as Record<string, unknown> : {}),
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

  // 'clip' is a sub-mode of 'video' — use video colors in the switcher
  const activeTypeDef = TYPES.find(t => t.value === (type === 'clip' ? 'video' : type)) ?? TYPES[0];
  const readySims = simulations.filter(s => s.status === 'ready');
  const activeSim = readySims.find(s => s.id === simId) ?? null;
  const activeSimFile = simFiles.find(f => f.key === activeFileKey) ?? null;
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
          backgroundColor: 'rgba(2,6,23,0.55)',
          backdropFilter: 'blur(10px)', zIndex: 800,
        }}
      />

      {/* Modal */}
      <div
        style={{
          position: 'fixed',
          top: isCompactModal ? 0 : '50%',
          left: isCompactModal ? 0 : '50%',
          transform: isCompactModal ? 'none' : 'translate(-50%, -50%)',
          zIndex: 801,
          width: isCompactModal ? '100vw' : '90vw',
          height: isCompactModal ? '100dvh' : 'min(820px, 92dvh)',
          maxHeight: '100dvh',
          display: 'flex', flexDirection: 'column',
          backgroundColor: '#ffffff', borderRadius: isCompactModal ? 0 : 10,
          boxShadow: '0 16px 48px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
          overflow: 'hidden', fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          flexShrink: 0, padding: isCompactModal ? '12px 14px' : '16px 24px',
          borderBottom: '1px solid hsl(var(--shell-border))',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12, background: 'hsl(var(--shell))',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 220px', flexWrap: 'wrap' }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              backgroundColor: isBroll ? '#06b6d4' : activeTypeDef.color,
              display: 'inline-block', flexShrink: 0,
              boxShadow: `0 0 0 4px ${isBroll ? 'rgba(6,182,212,0.18)' : 'rgba(99,102,241,0.18)'}`,
            }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'hsl(var(--shell-foreground))' }}>
              {isBroll ? 'B-Roll Clip' : 'Edit Section'}
            </span>
            <span style={{
              fontSize: 10, fontWeight: 600, color: 'hsl(var(--shell-muted))',
              backgroundColor: 'var(--shell-hover)', borderRadius: 6, padding: '2px 8px',
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
              color: 'hsl(var(--shell-muted))', flexShrink: 0,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--shell-hover)'; (e.currentTarget as HTMLElement).style.color = 'hsl(var(--shell-foreground))'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'hsl(var(--shell-muted))'; }}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* ── Body: two-column ── */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: isCompactModal ? 'column' : 'row' }}>

          {/* LEFT: Controls */}
          <div style={{
            width: isCompactModal ? '100%' : 380,
            maxHeight: isCompactModal ? '44dvh' : undefined,
            flexShrink: 0, overflowY: 'auto',
            padding: isCompactModal ? '14px' : '20px 24px',
            display: 'flex', flexDirection: 'column', gap: isCompactModal ? 14 : 20,
            borderRight: isCompactModal ? 'none' : '1px solid #e2e8f0',
            borderBottom: isCompactModal ? '1px solid #e2e8f0' : 'none',
            backgroundColor: '#f8fafc',
            boxSizing: 'border-box',
          }}>

            {/* Type switcher — Video / Simulation only; Clip is a sub-mode inside Video */}
            {!isBroll && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={labelStyle}>Type</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {TYPES.map(t => {
                    const active = (type === t.value) || (t.value === 'video' && type === 'clip');
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
                {/* Clip sub-mode selector inside Video */}
                {(type === 'video' || type === 'clip') && (
                  <div
                    role="group"
                    aria-label="Video section mode"
                    style={{
                      display: 'flex',
                      width: '100%',
                      height: 36,
                      borderRadius: 9,
                      border: '1.5px solid #bfdbfe',
                      backgroundColor: '#f8fafc',
                      padding: 2,
                      boxSizing: 'border-box',
                    }}
                  >
                    {[
                      { key: 'video', label: 'Generate B-Roll'  },
                      { key: 'clip',  label: 'Existing Visual'  },
                    ].map(({ key, label: subLabel }) => (
                      <button
                        key={key}
                        onClick={() => setType(key as 'video' | 'clip')}
                        aria-pressed={type === key}
                        style={{
                          flex: 1,
                          height: '100%',
                          borderRadius: 7,
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: 'pointer',
                          border: 'none',
                          backgroundColor: type === key ? '#dbeafe' : 'transparent',
                          color: type === key ? '#1d4ed8' : '#6b7280',
                          transition: 'background-color 0.12s, color 0.12s, box-shadow 0.12s',
                          boxShadow: type === key ? '0 1px 3px rgba(59,130,246,0.18)' : 'none',
                        }}
                      >
                        {subLabel}
                      </button>
                    ))}
                  </div>
                )}
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

            {/* ── CLIP SOURCE PICKER (Existing Visual) ── */}
            {type === 'clip' && !isBroll && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ height: 1, backgroundColor: '#f3f4f6' }} />

                <div style={{
                  backgroundColor: '#fff', border: '1px solid #f1f5f9', borderTop: '3px solid #10b981',
                  borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14 }}>{clipVisualMode === 'image' ? '🖼' : '🎞'}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#065f46' }}>Clip Source</span>
                    <span style={{ fontSize: 10, color: '#059669', backgroundColor: '#d1fae5', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
                      {fmtTime(sectionDuration)} slot
                    </span>
                  </div>

                  {/* Visual type toggle: Video clip vs Still image */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['video', 'image'] as const).map(mode => (
                      <button
                        key={mode}
                        onClick={() => setClipVisualMode(mode)}
                        style={{
                          flex: 1, padding: '5px 0', borderRadius: 7, border: '1.5px solid',
                          fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          borderColor: clipVisualMode === mode ? '#10b981' : '#e5e7eb',
                          background: clipVisualMode === mode ? '#d1fae5' : '#f9fafb',
                          color: clipVisualMode === mode ? '#065f46' : '#6b7280',
                        }}
                      >
                        {mode === 'video' ? 'Video Clip' : 'Still Image'}
                      </button>
                    ))}
                  </div>

                  {/* ── IMAGE MODE ── */}
                  {clipVisualMode === 'image' && (
                    <>
                      <div>
                        <label style={{ ...labelStyle, color: '#059669' }}>Select Image</label>
                        {images.length === 0 ? (
                          <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>
                            Upload images in the Library panel first.
                          </p>
                        ) : (
                          <select
                            value={clipSourceImageId}
                            onChange={e => setClipSourceImageId(e.target.value)}
                            style={{ ...inputStyle, borderColor: '#6ee7b7', color: clipSourceImageId ? '#111827' : '#9ca3af' }}
                          >
                            <option value="">— choose an image —</option>
                            {images.map(img => (
                              <option key={img.id} value={img.id}>{img.filename}</option>
                            ))}
                          </select>
                        )}
                        {/* Selected image preview */}
                        {clipSourceImageId && (() => {
                          const img = images.find(i => i.id === clipSourceImageId);
                          if (!img) return null;
                          return (
                            <div style={{ marginTop: 8, borderRadius: 8, overflow: 'hidden', aspectRatio: '16/9', background: '#000', position: 'relative' }}>
                              <img
                                src={img.original_url}
                                alt={img.filename}
                                style={{
                                  position: 'absolute',
                                  width: `${(1 / img.crop_w) * 100}%`,
                                  height: `${(1 / img.crop_h) * 100}%`,
                                  left: `${(-img.crop_x / img.crop_w) * 100}%`,
                                  top: `${(-img.crop_y / img.crop_h) * 100}%`,
                                  objectFit: 'fill',
                                }}
                              />
                            </div>
                          );
                        })()}
                      </div>

                      {/* Camera Movement */}
                      <div>
                        <label style={{ ...labelStyle, color: '#059669' }}>Camera Movement</label>
                        <select
                          value={cameraMovement}
                          onChange={e => setCameraMovement(e.target.value)}
                          style={{ ...inputStyle, borderColor: '#6ee7b7', color: '#111827' }}
                        >
                          {CAMERA_MOVEMENTS.map(m => (
                            <option key={m.value} value={m.value}>{m.label}</option>
                          ))}
                        </select>
                        <p style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>
                          Animation runs for the full section duration ({fmtTime(sectionDuration)}).
                        </p>
                      </div>
                    </>
                  )}

                  {/* ── VIDEO MODE ── */}
                  {clipVisualMode === 'video' && (<>
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
                  </>) /* end clipVisualMode === 'video' */}
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
                    backgroundColor: '#fff', border: '1px solid #f1f5f9', borderTop: '3px solid #f59e0b',
                    borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14,
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
                      <div style={{ backgroundColor: '#fff', border: '1px solid #f1f5f9', borderLeft: '3px solid #10b981', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#166534' }}>Last generation</span>
                          {simMeta.confidence != null && (
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
                              backgroundColor: simMeta.confidence >= 0.8 ? '#dcfce7' : simMeta.confidence >= 0.5 ? '#fef9c3' : '#fee2e2',
                              color: simMeta.confidence >= 0.8 ? '#166534' : simMeta.confidence >= 0.5 ? '#713f12' : '#991b1b',
                            }}>
                              {Math.round(simMeta.confidence * 100)}% confidence
                            </span>
                          )}
                        </div>
                        {/* Render any/all sim_meta fields safely — handles both old BridgePlan shape and new Phase 4 shape */}
                        {(() => {
                          const m = simMeta as unknown as Record<string, unknown>;
                          const provider = m.provider as string | undefined;
                          const model    = m.model    as string | undefined;
                          const targetId = m.targetControlId as string | undefined;
                          const hidden   = [
                            ...((m.hideControlIds    as string[] | undefined) ?? []).map(id => `#${id}`),
                            ...((m.hideButtonIds     as string[] | undefined) ?? []).map(id => `#${id}`),
                            ...((m.hideSelectorStrings as string[] | undefined) ?? []),
                          ];
                          const warns = (m.warnings as string[] | undefined) ?? [];
                          return (
                            <>
                              {provider && (
                                <p style={{ fontSize: 10, color: '#4b5563', margin: 0 }}>
                                  Provider: {provider}{model ? ` · ${model}` : ''}
                                </p>
                              )}
                              {targetId && (
                                <p style={{ fontSize: 11, color: '#15803d', margin: 0 }}>
                                  Control: <strong>#{targetId}</strong>
                                </p>
                              )}
                              {hidden.length > 0 && (
                                <p style={{ fontSize: 10, color: '#4b5563', margin: 0 }}>
                                  Hidden: {hidden.join(', ')}
                                </p>
                              )}
                              {warns.length > 0 && (
                                <div style={{ backgroundColor: '#fef9c3', border: '1px solid #fde68a', borderRadius: 6, padding: '5px 8px' }}>
                                  {warns.map((w, i) => (
                                    <p key={i} style={{ fontSize: 10, color: '#713f12', margin: 0 }}>⚠ {w}</p>
                                  ))}
                                </div>
                              )}
                            </>
                          );
                        })()}
                        {simMeta.confidence != null && simMeta.confidence < 0.45 && (
                          <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '5px 8px' }}>
                            <p style={{ fontSize: 10, color: '#dc2626', margin: 0 }}>
                              ⚠ Low confidence ({Math.round(simMeta.confidence * 100)}%) — verify the bridge runs correctly before recording
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    <button
                      onClick={handleGenerateScript}
                      disabled={generating || !simPrompt.trim()}
                      style={{
                        width: '100%', height: 42, borderRadius: 10, border: 'none',
                        background: generating || !simPrompt.trim() ? 'linear-gradient(135deg,#fde68a,#fcd34d)' : 'linear-gradient(135deg,#f59e0b,#d97706)',
                        color: '#78350f', fontSize: 13, fontWeight: 700,
                        cursor: generating || !simPrompt.trim() ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        transition: 'background-color 0.12s',
                      }}
                      onMouseEnter={e => { if (!generating && simPrompt.trim()) (e.currentTarget as HTMLElement).style.opacity = '0.88'; }}
                      onMouseLeave={e => { if (!generating && simPrompt.trim()) (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                    >
                      {generating ? (
                        <>
                          <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #92400e44', borderTopColor: '#92400e', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                          {generationStatus ?? 'Generating…'}
                        </>
                      ) : '✦ Generate with AI'}
                    </button>
                    {generating && (
                      <button
                        onClick={handleCancelGeneration}
                        style={{
                          width: '100%', height: 32, borderRadius: 8,
                          border: '1.5px solid #fcd34d', backgroundColor: 'transparent',
                          color: '#b45309', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          marginTop: 6,
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}

                {/* ── GUIDED SIMULATION (mother-sim-level voice guidance) ── */}
                {simId && (
                  <div style={{
                    backgroundColor: '#fff', border: '1px solid #eef2ff', borderTop: '3px solid #6366f1',
                    borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)',
                    padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 14 }}>🎙</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#3730a3' }}>Guided Simulation</span>
                      <span style={{ fontSize: 10, color: '#4f46e5', backgroundColor: '#eef2ff', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>Whole simulation</span>
                      {guidanceStatus !== 'none' && (
                        <span style={{
                          marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 5,
                          backgroundColor: guidanceStatus === 'ready' ? '#dcfce7' : guidanceStatus === 'error' ? '#fee2e2' : '#e0e7ff',
                          color: guidanceStatus === 'ready' ? '#166534' : guidanceStatus === 'error' ? '#991b1b' : '#3730a3',
                        }}>{guidanceStatus}</span>
                      )}
                    </div>

                    <p style={{ fontSize: 10.5, color: '#6b7280', margin: 0, lineHeight: 1.5 }}>
                      Analyzes the whole simulation, writes a 1–2 sentence voice cue per feature and interesting
                      configuration, and plays each once when a viewer first reaches it. Separate from Simple UI / Auto Script.
                    </p>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <div style={{ flex: '0 0 auto' }}>
                        <label style={{ ...labelStyle, color: '#4338ca' }}>Language</label>
                        <select
                          value={guidanceLang}
                          onChange={e => setGuidanceLang(e.target.value)}
                          disabled={!!guidanceBusy}
                          style={{ ...inputStyle, cursor: 'pointer', width: 130 }}
                        >
                          {GUIDANCE_LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                        </select>
                      </div>
                      <button
                        onClick={() => runGuidanceStream('generate')}
                        disabled={!!guidanceBusy}
                        style={{
                          flex: 1, height: 42, borderRadius: 10, border: 'none',
                          background: guidanceBusy ? 'linear-gradient(135deg,#c7d2fe,#a5b4fc)' : 'linear-gradient(135deg,#6366f1,#4f46e5)',
                          color: '#fff', fontSize: 13, fontWeight: 700, cursor: guidanceBusy ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        }}
                      >
                        {guidanceBusy === 'analyzing'
                          ? (<><span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #ffffff66', borderTopColor: '#fff', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />{guidanceStatusMsg ?? 'Analyzing…'}</>)
                          : (guidance && guidance.length > 0 ? '↻ Re-analyze' : '✦ Analyze & draft')}
                      </button>
                    </div>

                    {guidanceError && (
                      <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
                        <p style={{ fontSize: 11, color: '#dc2626', margin: 0 }}>{guidanceError}</p>
                      </div>
                    )}

                    {guidanceMeta && (
                      <p style={{ fontSize: 10, color: '#6b7280', margin: 0 }}>
                        {guidanceMeta.provider ? `${guidanceMeta.provider}${guidanceMeta.model ? ` · ${guidanceMeta.model}` : ''} · ` : ''}
                        {guidanceMeta.entryCount != null ? `${guidanceMeta.entryCount} cues` : ''}
                        {guidanceMeta.droppedCount ? ` · ${guidanceMeta.droppedCount} dropped` : ''}
                        {guidanceMeta.mdUrl ? <> · <a href={guidanceMeta.mdUrl} target="_blank" rel="noreferrer" style={{ color: '#4f46e5' }}>analysis ↗</a></> : null}
                      </p>
                    )}

                    {guidance && guidance.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto' }}>
                        {guidance.map(e => (
                          <div key={e.id} style={{ border: '1px solid #eef2ff', borderRadius: 10, padding: '8px 10px', backgroundColor: e.enabled ? '#fff' : '#f9fafb' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                              <button
                                onClick={() => toggleEntryEnabled(e.id)}
                                title={e.enabled ? 'Enabled' : 'Disabled'}
                                style={{ width: 30, height: 17, borderRadius: 9, border: 'none', flexShrink: 0, backgroundColor: e.enabled ? '#6366f1' : '#d1d5db', position: 'relative', cursor: 'pointer' }}
                              >
                                <span style={{ position: 'absolute', top: 2.5, left: e.enabled ? 15 : 2.5, width: 12, height: 12, borderRadius: '50%', backgroundColor: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left .15s' }} />
                              </button>
                              <span style={{ fontSize: 9, fontWeight: 700, color: e.kind === 'config' ? '#7c3aed' : '#0369a1', backgroundColor: e.kind === 'config' ? '#f3e8ff' : '#e0f2fe', borderRadius: 4, padding: '1px 6px' }}>{e.kind}</span>
                              <span style={{ fontSize: 11, fontWeight: 600, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
                              <span style={{ marginLeft: 'auto', fontSize: 9, color: '#9ca3af' }}>{Math.round((e.confidence ?? 0) * 100)}%</span>
                            </div>
                            <textarea
                              value={e.narration}
                              onChange={ev => setEntryNarration(e.id, ev.target.value)}
                              rows={2}
                              maxLength={400}
                              style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 11.5, color: '#111827', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.45, outline: 'none' }}
                            />
                            {e.warnings && e.warnings.length > 0 && (
                              <p style={{ fontSize: 9, color: '#b45309', margin: '3px 0 0' }}>⚠ {e.warnings.join('; ')}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {guidance && guidance.some(e => e.enabled) && (
                      <button
                        onClick={handlePublishGuidance}
                        disabled={!!guidanceBusy}
                        style={{
                          width: '100%', height: 40, borderRadius: 10, border: 'none',
                          background: guidanceBusy ? '#a7f3d0' : 'linear-gradient(135deg,#10b981,#059669)',
                          color: '#fff', fontSize: 13, fontWeight: 700, cursor: guidanceBusy ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                        }}
                      >
                        {guidanceBusy === 'publishing'
                          ? (<><span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #ffffff66', borderTopColor: '#fff', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />{guidanceStatusMsg ?? 'Publishing…'}</>)
                          : (guidanceStatus === 'ready' ? '🔊 Update voice guidance' : '🔊 Approve & generate voice')}
                      </button>
                    )}

                    {guidanceBusy && (
                      <button
                        onClick={handleCancelGuidance}
                        style={{ width: '100%', height: 30, borderRadius: 8, border: '1.5px solid #c7d2fe', backgroundColor: 'transparent', color: '#4f46e5', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── VIDEO GENERATION (non-broll video sections) ── */}
            {type === 'video' && !isBroll && (
              <div style={{
                backgroundColor: '#fff', border: '1px solid #f1f5f9', borderTop: '3px solid #3b82f6',
                borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14,
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
                    <>
                      <button
                        onClick={handleGenerateVideo}
                        disabled={isVidGenerating || !genPrompt.trim()}
                        style={{
                          width: '100%', height: 42, borderRadius: 10, border: 'none',
                          background: isVidGenerating || !genPrompt.trim() ? 'linear-gradient(135deg,#bfdbfe,#93c5fd)' : 'linear-gradient(135deg,#3b82f6,#6366f1)',
                          color: '#fff', fontSize: 13, fontWeight: 700,
                          cursor: isVidGenerating || !genPrompt.trim() ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                          transition: 'background-color 0.12s',
                        }}
                        onMouseEnter={e => { if (!isVidGenerating && genPrompt.trim()) (e.currentTarget as HTMLElement).style.opacity = '0.88'; }}
                        onMouseLeave={e => { if (!isVidGenerating && genPrompt.trim()) (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                      >
                        {isVidGenerating ? (
                          <>
                            <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
                            {genBusy ? 'Queuing…' : 'Generating…'}
                          </>
                        ) : '🎬 Generate Video'}
                      </button>

                      {/* Model dropdown + Enhanced toggle — below generate button */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <select
                          value={genModel}
                          onChange={e => setGenModel(e.target.value as GenModel)}
                          style={{
                            flex: 1, height: 34, padding: '0 8px', borderRadius: 8,
                            border: '1.5px solid #bfdbfe', backgroundColor: '#f0f9ff',
                            fontSize: 12, color: '#1d4ed8', fontWeight: 600,
                            cursor: 'pointer', outline: 'none',
                          }}
                        >
                          {(Object.keys(GEN_MODELS) as GenModel[]).map(m => (
                            <option key={m} value={m}>{GEN_MODELS[m]}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => setGenEnhance(v => !v)}
                          title="Enhance prompt with Claude"
                          style={{
                            height: 34, padding: '0 10px', borderRadius: 8, flexShrink: 0,
                            border: `1.5px solid ${genEnhance ? '#3b82f6' : '#e5e7eb'}`,
                            backgroundColor: genEnhance ? '#eff6ff' : '#f9fafb',
                            color: genEnhance ? '#1d4ed8' : '#6b7280',
                            fontSize: 11, fontWeight: 600, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 5,
                            transition: 'all 0.12s',
                          }}
                        >
                          <span style={{ width: 26, height: 14, borderRadius: 7, flexShrink: 0, backgroundColor: genEnhance ? '#3b82f6' : '#d1d5db', position: 'relative', display: 'inline-block', transition: 'background-color 0.15s' }}>
                            <span style={{ position: 'absolute', top: 2, left: genEnhance ? 13 : 2, width: 10, height: 10, borderRadius: '50%', backgroundColor: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left 0.15s' }} />
                          </span>
                          Enhanced
                        </button>
                      </div>
                      {genModel === 'veo' && (section.end_sec - section.start_sec) > 8 && (
                        <p style={{ fontSize: 10, color: '#92400e', margin: 0 }}>Veo max is 8s — generation will be capped.</p>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {/* ── BROLL INFO ── */}
            {isBroll && (
              <div style={{
                backgroundColor: '#fff', border: '1px solid #f1f5f9', borderTop: '3px solid #06b6d4',
                borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
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

                {/* Volume control — Premiere-style audio gain */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: '#0e7490', flexShrink: 0 }}>🔊</span>
                  <input
                    type="range"
                    min={0} max={1} step={0.01}
                    value={brollVolume}
                    onChange={e => setBrollVolume(parseFloat(e.target.value))}
                    onMouseUp={async () => {
                      try {
                        await api.updateSection(projectId, section.id, {
                          broll_volume: brollVolume,
                        } as Parameters<typeof api.updateSection>[2]);
                      } catch { /* ignore */ }
                    }}
                    style={{ flex: 1, accentColor: '#06b6d4', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#0891b2', fontFamily: 'monospace', minWidth: 34 }}>
                    {Math.round(brollVolume * 100)}%
                  </span>
                </div>
              </div>
            )}

            {/* ── TIMING (collapsible) ── */}
            <div>
              <button
                onClick={() => setShowTiming(v => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none',
                  cursor: 'pointer', padding: '2px 0', width: '100%', textAlign: 'left',
                }}
              >
                <span style={labelStyle as React.CSSProperties}>Timing</span>
                <span style={{
                  width: 28, height: 28, borderRadius: 8, display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center', color: '#6b7280',
                  backgroundColor: '#f3f4f6', border: '1px solid #e5e7eb',
                }}>
                  {showTiming ? <ChevronUp size={16} strokeWidth={1.9} aria-hidden /> : <ChevronDown size={16} strokeWidth={1.9} aria-hidden />}
                </span>
                {!showTiming && (
                  <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 'auto', fontFamily: 'monospace' }}>
                    {startStr} → {endStr}
                  </span>
                )}
              </button>
              {showTiming && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
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
              )}
            </div>

            {saveError && (
              <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
                <p style={{ fontSize: 11, color: '#dc2626', margin: 0 }}>{saveError}</p>
              </div>
            )}
          </div>

          {/* RIGHT: Preview / Trimmer / Files */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
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
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundColor: '#f8fafc', color: '#111827' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, padding: '10px 12px', borderBottom: '1px solid #e5e7eb', backgroundColor: '#ffffff' }}>
                  <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 8, backgroundColor: '#f1f5f9', border: '1px solid #e2e8f0' }}>
                    {(['preview', 'files'] as const).map(t => (
                      <button
                        key={t}
                        onClick={() => setRightTab(t)}
                        style={{
                          height: 30, minWidth: 82, padding: '0 12px', borderRadius: 6, border: 'none',
                          backgroundColor: rightTab === t ? '#ffffff' : 'transparent',
                          color: rightTab === t ? '#111827' : '#64748b',
                          boxShadow: rightTab === t ? '0 1px 3px rgba(15,23,42,0.12)' : 'none',
                          fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        }}
                      >
                        {t === 'preview' ? 'Preview' : 'Files'}
                      </button>
                    ))}
                  </div>

                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {rightTab === 'preview' && simPreviewUrl && (
                      <>
                        <button
                          onClick={() => sendToPreview('startScript')}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #bbf7d0',
                            backgroundColor: previewRunning ? '#dcfce7' : '#f0fdf4',
                            color: '#166534', fontSize: 11, fontWeight: 800, cursor: 'pointer',
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <Play size={13} strokeWidth={2.2} aria-hidden />
                          Run
                        </button>
                        <button
                          onClick={() => sendToPreview('stopScript')}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #e5e7eb',
                            backgroundColor: '#ffffff', color: '#475569', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <Square size={12} strokeWidth={2.2} aria-hidden />
                          Stop
                        </button>
                        <button
                          onClick={handleDownloadSimulationZip}
                          disabled={zipDownloadBusy || !simId}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #ede9fe',
                            backgroundColor: '#f5f3ff', color: '#6d28d9', fontSize: 11, fontWeight: 800,
                            cursor: zipDownloadBusy || !simId ? 'not-allowed' : 'pointer', opacity: zipDownloadBusy ? 0.6 : 1,
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <Archive size={13} strokeWidth={2} aria-hidden />
                          {zipDownloadBusy ? 'Zipping…' : 'ZIP'}
                        </button>
                      </>
                    )}

                    {rightTab === 'files' && (
                      <>
                        <button
                          onClick={handleCopyActiveFile}
                          disabled={!activeSimFile || fileContentLoading || fileContent == null}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #e0f2fe',
                            backgroundColor: copiedFile ? '#dcfce7' : '#f0f9ff',
                            color: copiedFile ? '#166534' : '#0369a1', fontSize: 11, fontWeight: 800,
                            cursor: !activeSimFile || fileContentLoading || fileContent == null ? 'not-allowed' : 'pointer',
                            opacity: !activeSimFile || fileContentLoading || fileContent == null ? 0.5 : 1,
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          {copiedFile ? <Check size={13} strokeWidth={2.2} aria-hidden /> : <Copy size={13} strokeWidth={2} aria-hidden />}
                          {copiedFile ? 'Copied' : 'Copy'}
                        </button>
                        <button
                          onClick={handleDownloadActiveFile}
                          disabled={!activeSimFile || fileDownloadBusy}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #e5e7eb',
                            backgroundColor: '#ffffff', color: '#475569', fontSize: 11, fontWeight: 700,
                            cursor: !activeSimFile || fileDownloadBusy ? 'not-allowed' : 'pointer', opacity: fileDownloadBusy ? 0.6 : 1,
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <Download size={13} strokeWidth={2} aria-hidden />
                          {fileDownloadBusy ? 'Saving…' : 'File'}
                        </button>
                        <button
                          onClick={handleDownloadSimulationZip}
                          disabled={zipDownloadBusy || !simId}
                          style={{
                            height: 30, padding: '0 10px', borderRadius: 7, border: '1px solid #ede9fe',
                            backgroundColor: '#f5f3ff', color: '#6d28d9', fontSize: 11, fontWeight: 800,
                            cursor: zipDownloadBusy || !simId ? 'not-allowed' : 'pointer', opacity: zipDownloadBusy ? 0.6 : 1,
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <Archive size={13} strokeWidth={2} aria-hidden />
                          {zipDownloadBusy ? 'Zipping…' : 'ZIP'}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {rightTab === 'preview' ? (
                  simPreviewUrl ? (
                    <div ref={simPreviewShellRef} style={{ flex: 1, minHeight: 0, backgroundColor: '#ffffff', overflow: 'hidden', position: 'relative' }}>
                      <iframe
                        key={simPreviewUrl}
                        ref={previewIframeRef}
                        src={simPreviewUrl}
                        style={{ border: 'none', width: '100%', height: '100%', backgroundColor: '#fff' }}
                        title={activeSim?.name ?? 'Simulation preview'}
                        sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
                        onLoad={() => setPreviewRunning(false)}
                      />
                      {/* Fullscreen toggle — always visible, uses fixed when in fullscreen */}
                      <button
                        onClick={toggleSimFullscreen}
                        title={isSimFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                        style={{
                          position: isSimFullscreen ? 'fixed' : 'absolute',
                          top: 8, right: 8,
                          zIndex: 9999,
                          width: 32, height: 32,
                          borderRadius: 8,
                          border: '1px solid rgba(255,255,255,0.3)',
                          background: 'rgba(0,0,0,0.45)',
                          backdropFilter: 'blur(4px)',
                          color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer',
                          opacity: 0.7,
                          transition: 'opacity 0.15s',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                        onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
                      >
                        {isSimFullscreen
                          ? <Minimize2 size={14} strokeWidth={2} aria-hidden />
                          : <Maximize2 size={14} strokeWidth={2} aria-hidden />
                        }
                      </button>
                    </div>
                  ) : (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: '#f8fafc' }}>
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                        <circle cx="24" cy="24" r="19" stroke="#cbd5e1" strokeWidth="2" />
                        <path d="M24 14v10l6 4.5" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>Select a simulation to preview</p>
                    </div>
                  )
                ) : (
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundColor: '#ffffff' }}>
                    {simFilesLoading ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid #e2e8f0', borderTopColor: '#3b82f6', animation: 'spin 0.8s linear infinite' }} />
                      </div>
                    ) : simFilesError ? (
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                        <p style={{ fontSize: 12, color: '#ef4444', margin: 0 }}>Failed to load files</p>
                        <p style={{ fontSize: 10, color: '#94a3b8', margin: 0 }}>{simFilesError}</p>
                      </div>
                    ) : simFiles.length === 0 ? (
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>No source files found</p>
                        <p style={{ fontSize: 10, color: '#94a3b8', margin: 0 }}>Re-upload the simulation to restore files</p>
                      </div>
                    ) : (
                      <>
                        <div className="fine-scrollbar" style={{ display: 'flex', overflowX: 'auto', flexShrink: 0, borderBottom: '1px solid #e5e7eb', backgroundColor: '#f8fafc' }}>
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
                                  display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                                  padding: '9px 12px', fontSize: 11, fontWeight: isActive ? 800 : 600,
                                  color: isActive ? '#1d4ed8' : '#64748b',
                                  background: isActive ? '#eff6ff' : 'transparent',
                                  borderTop: 'none', borderLeft: 'none', borderRight: '1px solid #e5e7eb',
                                  borderBottom: isActive ? '2px solid #3b82f6' : '2px solid transparent',
                                  cursor: 'pointer', whiteSpace: 'nowrap',
                                }}
                              >
                                {f.filename}
                                {(isAiBridge || isAiHtml) && (
                                  <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4, backgroundColor: '#dbeafe', color: '#1d4ed8' }}>AI</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        <div className="fine-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', backgroundColor: '#ffffff' }}>
                          {fileContentLoading ? (
                            <div style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #e2e8f0', borderTopColor: '#3b82f6', animation: 'spin 0.8s linear infinite' }} />
                              <span style={{ fontSize: 11, color: '#64748b' }}>Loading…</span>
                            </div>
                          ) : activeSimFile && !activeSimFile.isText ? (
                            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <p style={{ fontSize: 11, color: '#64748b', margin: 0 }}>Binary file — cannot display</p>
                              <a href={activeSimFile.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#3b82f6' }}>Open in new tab ↗</a>
                            </div>
                          ) : fileContent !== null ? (
                            <pre style={{ margin: 0, padding: '16px 18px', fontSize: 11.5, lineHeight: 1.65, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#1e293b', whiteSpace: 'pre-wrap', wordBreak: 'break-word', tabSize: 2 }}>
                              {fileContent}
                            </pre>
                          ) : (
                            <div style={{ padding: 20 }}>
                              <p style={{ fontSize: 11, color: '#64748b', margin: 0 }}>Select a file above</p>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── VIDEO / BROLL right panel ── */}
            {(type === 'video' || isBroll) && (
              videoUrl ? (
                <div style={{ flex: 1, position: 'relative', minHeight: 0, backgroundColor: '#111827' }}>
                  <video
                    ref={rightVideoRef}
                    src={videoUrl}
                    controls
                    style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#111827' }}
                  />
                  <button
                    type="button"
                    onClick={() => openFullscreen(rightVideoRef.current)}
                    title="Fullscreen"
                    style={{
                      position: 'absolute', top: 12, right: 12,
                      height: 32, width: 32, borderRadius: 8,
                      border: '1px solid rgba(255,255,255,0.16)',
                      backgroundColor: 'rgba(15,23,42,0.74)', color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', boxShadow: '0 6px 18px rgba(0,0,0,0.2)',
                    }}
                  >
                    <Maximize2 size={15} strokeWidth={2} aria-hidden />
                  </button>
                </div>
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
          flexShrink: 0,
          padding: isCompactModal ? '10px 14px max(10px, env(safe-area-inset-bottom))' : '14px 24px',
          borderTop: '1px solid #f3f4f6',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 10, backgroundColor: '#fafafa',
        }}>
          <button
            onClick={() => setShowDeleteConfirm(true)}
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

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
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
                background: saving ? 'linear-gradient(135deg,#93c5fd,#818cf8)' : 'linear-gradient(135deg,#3b82f6,#6366f1)',
                color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer', transition: 'background-color 0.12s',
              }}
              onMouseEnter={e => { if (!saving) (e.currentTarget as HTMLElement).style.opacity = '0.88'; }}
              onMouseLeave={e => { if (!saving) (e.currentTarget as HTMLElement).style.opacity = '1'; }}
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

      {showDeleteConfirm && (
        <ConfirmDialog
          title={type === 'simulation' ? 'Delete simulation section?' : type === 'clip' ? 'Delete clip section?' : 'Delete section?'}
          description="This will permanently remove the section from your timeline. This cannot be undone."
          confirmLabel="Delete section"
          onConfirm={() => { setShowDeleteConfirm(false); handleDelete(); }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </>
  );
}
