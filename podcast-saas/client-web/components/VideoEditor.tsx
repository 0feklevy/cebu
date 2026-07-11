'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { AlertTriangle, Clapperboard, Flag, GitBranch, Maximize2, Minimize2, Music, Pencil, Plus, Redo2, RefreshCw, Sparkles, Trash2, Undo2, Upload } from 'lucide-react';
import { useAuth } from '../lib/firebase';
import { api } from '../lib/api';
import { VideoPlayer } from './VideoPlayer';
import type { VideoPlayerHandle } from './VideoPlayer';
import type { Clip } from '../hooks/useClipSequence';
import { TimelinePanel } from './TimelinePanel';
import { GuidedTour, type TourStep } from './GuidedTour';
import { VideoUploader } from './VideoUploader';
import { SimulationUploader } from './SimulationUploader';
import { BrollPanel } from './BrollPanel';
import { ConfirmDialog } from './ConfirmDialog';
import { ImageCropEditor } from './ImageCropEditor';
import { ExtendedLibraryModal } from './avatar/ExtendedLibraryModal';
import { BranchingModal } from './branching/BranchingModal';
import { getAvatarCircles, type AvatarCirclesConfig } from './avatar/avatarApi';
import type { VideoFile, TimelineSection, TimelineMarker, Simulation, VideoGenerationJob, ImageFile, AudioFile } from 'shared/src/generated/client-v1';

type ToolMode = 'video' | 'simulation' | 'broll';

// The main-things-only editor walkthrough (fiji-style). Targets exist via data-tour attrs;
// a step whose target isn't on screen is skipped automatically.
const EDITOR_TOUR_STEPS: TourStep[] = [
  { selector: '[data-tour="library"]',     title: 'Your Library',            content: 'Add videos, images, audio, and AI simulations here. Tip: drag files straight onto this panel and they sort themselves.' },
  { selector: '[data-tour="simulations"]', title: 'Interactive simulations', content: 'Upload or AI-generate an interactive simulation, then drop it onto the timeline to make a moment interactive.' },
  { selector: '[data-tour="timeline"]',    title: 'The timeline',            content: 'Arrange clips and flag sections — mark where a simulation, b-roll, image, or audio plays over the video.' },
  { selector: '[data-tour="preview"]',     title: 'Preview & share',         content: 'Preview the finished interactive video exactly as viewers see it, then share it with a link.' },
];

const HLS_TIERS = ['360p', '480p', '720p', '1080p'] as const;
type HlsTier = typeof HLS_TIERS[number];
type SectionSnapshot = TimelineSection[];

const HISTORY_LIMIT = 50;
const TIMELINE_RULER_H = 24;
const TIMELINE_VIDEO_TRACK_H = 52;
const TIMELINE_AUDIO_TRACK_H = 22;
const TIMELINE_BROLL_TRACK_H = 44;
const TIMELINE_SCROLLBAR_H = 12;

function EditorToolsPanel({
  toolMode,
  layersVisible,
  onToggleAllLayers,
  flagMode,
  onToggleFlagMode,
  markerCount,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  historyBusy,
}: {
  toolMode: ToolMode;
  layersVisible: boolean;
  onToggleAllLayers: () => void;
  flagMode: boolean;
  onToggleFlagMode: () => void;
  markerCount: number;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  historyBusy: boolean;
}) {
  const layersActive = layersVisible || toolMode === 'broll';

  return (
    <div className="surface-panel shrink-0 rounded-lg px-3 py-3">
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          onClick={onToggleAllLayers}
          className={`flex min-h-11 flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors focus-ring ${
            layersActive
              ? 'border-cyan-400 bg-cyan-50 text-cyan-700'
              : 'border-border bg-card text-foreground hover:border-cyan-300 hover:bg-cyan-50/60'
          }`}
        >
          <Clapperboard size={18} strokeWidth={1.9} aria-hidden />
          <span className="min-w-0">
            <span className="block text-xs font-semibold leading-tight">
              {layersActive ? 'Hide all layers' : 'Show all layers'}
            </span>
            <span className={`block truncate text-[10px] leading-tight ${layersActive ? 'opacity-75' : 'text-muted-foreground'}`}>
              {layersActive ? 'Hide additional channels' : 'Add a cutaway layer'}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onToggleFlagMode}
          aria-pressed={flagMode}
          title={flagMode
            ? 'Flag mode ON — click the timeline to drop flags (or press M). Click here to exit.'
            : 'Flag mode — click, then click the timeline to drop editor flags (or press M)'}
          aria-label={flagMode ? 'Exit flag mode' : 'Enter flag mode to drop timeline markers'}
          className={`relative flex min-h-11 w-11 shrink-0 items-center justify-center rounded-lg border transition-colors focus-ring ${
            flagMode
              ? 'border-red-500 bg-red-500 text-white shadow-sm'
              : 'border-border bg-card text-red-500 hover:border-red-300 hover:bg-red-50/70'
          }`}
        >
          <Flag size={18} strokeWidth={1.9} aria-hidden />
          {markerCount > 0 && (
            <span className={`absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold ${flagMode ? 'bg-white text-red-600' : 'bg-red-500 text-white'}`}>
              {markerCount}
            </span>
          )}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/60 pt-3">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo || historyBusy}
          className="flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40 focus-ring"
        >
          <Undo2 size={15} strokeWidth={1.9} aria-hidden />
          Undo
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo || historyBusy}
          className="flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40 focus-ring"
        >
          <Redo2 size={15} strokeWidth={1.9} aria-hidden />
          Redo
        </button>
      </div>
    </div>
  );
}

function cloneSections(sections: TimelineSection[]): SectionSnapshot {
  return sections.map(s => ({ ...s }));
}

function sectionPatchBody(s: TimelineSection): Parameters<typeof api.updateSection>[2] {
  return {
    start_sec: s.start_sec,
    end_sec: s.end_sec,
    type: s.type,
    label: s.label,
    notes: s.notes,
    sort_order: s.sort_order,
    track: s.track,
    simulation_url: s.simulation_url,
    simulation_id: s.simulation_id,
    sim_script: s.sim_script,
    global_offset_sec: s.global_offset_sec,
    clip_source_video_id: s.clip_source_video_id,
    clip_in_sec: s.clip_in_sec ?? 0,
    broll_volume: s.broll_volume,
    simple_ui: s.simple_ui,
    auto_script: s.auto_script,
    clip_source_image_id: s.clip_source_image_id,
    camera_movement: s.camera_movement ?? 'zoom_in',
    clip_source_audio_id: s.clip_source_audio_id,
  };
}

function sectionCreateBody(s: TimelineSection): Parameters<typeof api.createSection>[1] {
  return {
    video_file_id: s.video_file_id,
    start_sec: s.start_sec,
    end_sec: s.end_sec,
    type: s.type,
    label: s.label,
    notes: s.notes,
    sort_order: s.sort_order,
    simulation_url: s.simulation_url,
    simulation_id: s.simulation_id,
    sim_script: s.sim_script,
    track: s.track,
    global_offset_sec: s.global_offset_sec,
    clip_source_video_id: s.clip_source_video_id,
    clip_in_sec: s.clip_in_sec ?? 0,
    broll_volume: s.broll_volume,
    simple_ui: s.simple_ui,
    auto_script: s.auto_script,
    clip_source_image_id: s.clip_source_image_id,
    camera_movement: s.camera_movement ?? 'zoom_in',
    clip_source_audio_id: s.clip_source_audio_id,
  };
}

function sectionComparable(s: TimelineSection) {
  return JSON.stringify(sectionPatchBody(s));
}

function tierIndex(name: string | null): number {
  if (!name) return -1;
  return HLS_TIERS.indexOf(name as HlsTier);
}

function HlsTierProgress({ currentTier, is360pReady, hlsStatus }: { currentTier: string | null; is360pReady: boolean; hlsStatus?: string }) {
  const isPending = hlsStatus === 'pending';
  const effectiveTier = currentTier ?? (hlsStatus === 'processing' ? '360p' : null);
  const activeTierIdx = tierIndex(effectiveTier);
  return (
    <div className="space-y-0.5 pt-0.5">
      {isPending && <p className="text-[8px] text-muted-foreground/50 mb-0.5">Queued…</p>}
      {HLS_TIERS.map((tier, idx) => {
        const done   = idx === 0 ? is360pReady : (activeTierIdx > idx);
        const active = !isPending && activeTierIdx === idx && !(idx === 0 && is360pReady);
        return (
          <div key={tier} className="flex items-center gap-1.5">
            <span className="text-[8px] text-muted-foreground/70 w-7 shrink-0">{tier}</span>
            <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
              {done   ? <div className="h-full w-full bg-emerald-500 rounded-full" />
               : active ? <div className="h-full w-1/2 bg-amber-400 rounded-full animate-pulse" />
               : isPending ? <div className="h-full w-full bg-muted-foreground/15 rounded-full animate-pulse" style={{ animationDelay: `${idx * 200}ms` }} />
               : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  projectId: string;
}

export function VideoEditor({ projectId }: Props) {
  const { loading: authLoading } = useAuth();
  const [videos, setVideos]   = useState<VideoFile[]>([]);     // main videos only (is_broll=false)
  const [allVideos, setAllVideos] = useState<VideoFile[]>([]);  // all videos incl. broll sources
  const [replacingVideoId, setReplacingVideoId] = useState<string | null>(null); // Library "Replace" target
  const [avatarCircles, setAvatarCircles] = useState<AvatarCirclesConfig | null>(null);
  const [sections, setSections] = useState<TimelineSection[]>([]);
  const [markers, setMarkers] = useState<TimelineMarker[]>([]);
  const [undoStack, setUndoStack] = useState<SectionSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<SectionSnapshot[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [showAllLayers, setShowAllLayers] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [images, setImages] = useState<ImageFile[]>([]);
  const [showUploader, setShowUploader] = useState(false);
  const [showBranching, setShowBranching] = useState(false);
  const [showSimUploader, setShowSimUploader] = useState(false);
  const [showImgUploader, setShowImgUploader] = useState(false);
  const [pendingCropImage, setPendingCropImage] = useState<ImageFile | null>(null);
  const [extendedLibraryOpen, setExtendedLibraryOpen] = useState(false);
  const [imgUploading, setImgUploading] = useState(false);
  const imgFileInputRef = useRef<HTMLInputElement>(null);
  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
  const [audioUploading, setAudioUploading] = useState(false);
  const [deletingAudioId, setDeletingAudioId] = useState<string | null>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const [deletingImgId, setDeletingImgId] = useState<string | null>(null);
  const [deletingSimId, setDeletingSimId] = useState<string | null>(null);
  const [renamingSimId, setRenamingSimId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft]     = useState('');
  const [deletingId,    setDeletingId]    = useState<string | null>(null);
  // Confirm dialogs
  const [confirmVideo, setConfirmVideo] = useState<string | null>(null);  // videoId to delete
  const [confirmSim,   setConfirmSim]   = useState<string | null>(null);  // simId to delete
  const [confirmImg,   setConfirmImg]   = useState<string | null>(null);  // imageId to delete (ui-ux-005)
  const [confirmAudio, setConfirmAudio] = useState<string | null>(null);  // audioId to delete (ui-ux-005)
  const [hlsUrls, setHlsUrls] = useState<Record<string, string>>({});
  const [rawUrls, setRawUrls] = useState<Record<string, string>>({});
  const [tierProgress, setTierProgress] = useState<Record<string, { currentTier: string | null; is360pReady: boolean }>>({});

  // B-roll state
  const [toolMode, setToolMode]     = useState<ToolMode>('video');
  const [brollMark, setBrollMark]   = useState<{ start: number; end: number } | null>(null);
  const [brollJobs, setBrollJobs]   = useState<VideoGenerationJob[]>([]);

  // Imperative handle to the VideoPlayer — used for timeline seeks
  const playerRef = useRef<VideoPlayerHandle>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const previewShellRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewViewportSize, setPreviewViewportSize] = useState({ width: 16, height: 9 });
  const [previewShellSize, setPreviewShellSize] = useState({ width: 0, height: 0 });

  // Load the avatar-circles config so the editor preview can show them over b-roll.
  // Re-read it whenever the (sibling) settings panel saves, so toggling Enable +
  // Save reflects in the preview without a full page reload.
  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    const refresh = () => getAvatarCircles(projectId).then((r) => { if (!cancelled) setAvatarCircles(r.config); }).catch(() => {});
    refresh();
    const onSaved = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) refresh();
    };
    window.addEventListener('avatar-circles-saved', onSaved);
    return () => { cancelled = true; window.removeEventListener('avatar-circles-saved', onSaved); };
  }, [projectId, authLoading]);

  const loadData = useCallback(async () => {
    setLoadError(false);
    try {
      // One aggregate round-trip instead of 6 (loadperf-003). Falls back to the parallel list
      // calls if the aggregate endpoint isn't available (e.g. mid-deploy).
      let vids: VideoFile[], secs: TimelineSection[], sims: Simulation[], jobs: VideoGenerationJob[], imgs: ImageFile[], auds: AudioFile[];
      try {
        const st = await api.getEditorState(projectId);
        vids = st.videos; secs = st.sections; sims = st.simulations; jobs = st.brollJobs; imgs = st.images; auds = st.audioFiles;
      } catch {
        [vids, secs, sims, jobs, imgs, auds] = await Promise.all([
          api.listVideos(projectId),
          api.listSections(projectId),
          api.listSimulations(projectId),
          api.listBrollJobs(projectId),
          api.listImages(projectId),
          api.listAudioFiles(projectId),
        ]);
      }
      // Markers load separately + resiliently: a failure here (e.g. before the timeline_markers
      // migration has run) must not blank out the rest of the editor.
      api.listMarkers(projectId).then(setMarkers).catch(() => setMarkers([]));
      // Separate main videos from AI-generated broll source files
      setVideos(vids.filter(v => !v.is_broll));
      setAllVideos(vids);
      setSections(secs);
      setUndoStack([]);
      setRedoStack([]);
      setSimulations(sims);
      setImages(imgs);
      setAudioFiles(auds);
      // Keep in-progress jobs + recently completed ones (last 10 min) so the user sees the result
      const RECENT_MS = 10 * 60 * 1000;
      const now = Date.now();
      setBrollJobs(jobs.filter(j => {
        if (j.status !== 'ready' && j.status !== 'failed') return true;
        if (!j.finished_at) return false;
        return now - new Date(j.finished_at).getTime() < RECENT_MS;
      }));
      const seededHls: Record<string, string> = {};
      const seededRaw: Record<string, string> = {};
      for (const v of vids) {
        if (v.hls_url) seededHls[v.id] = v.hls_url;
        if (v.raw_url) seededRaw[v.id] = v.raw_url;
      }
      setHlsUrls(seededHls);
      setRawUrls(prev => {
        const merged = { ...seededRaw };
        for (const [id, url] of Object.entries(prev)) merged[id] = url;
        return merged;
      });
    } catch {
      // Both the aggregate load and the parallel fallback failed (auth expired, backend
      // down, offline). Surface a retry affordance instead of an indistinguishable-from-empty
      // project (frontend-006).
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!authLoading) loadData();
  }, [authLoading, loadData]);


  // Poll HLS status for pending/processing videos
  const pendingVideoIds = videos
    .filter(v => v.hls_status === 'pending' || v.hls_status === 'processing')
    .map(v => v.id);
  const pendingKey = pendingVideoIds.join(',');

  useEffect(() => {
    if (!pendingKey) return;
    const poll = async () => {
      for (const id of pendingKey.split(',')) {
        try {
          const status = await api.getHlsStatus(projectId, id);
          if (status.raw_url) setRawUrls(prev => prev[id] ? prev : { ...prev, [id]: status.raw_url! });
          if (status.hls_url) setHlsUrls(prev => ({ ...prev, [id]: status.hls_url! }));
          if (status.hls_status === 'ready' || status.hls_status === 'failed') {
            setVideos(prev => prev.map(v => v.id === id ? { ...v, hls_status: status.hls_status } : v));
          }
          setTierProgress(prev => ({
            ...prev,
            [id]: { currentTier: status.hls_current_tier ?? null, is360pReady: status.hls_360p_ready ?? false },
          }));
        } catch { /* ignore */ }
      }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, projectId]);

  // Poll for simulation status while any are still processing
  const pendingSimKey = simulations.filter(s => s.status === 'processing').map(s => s.id).join(',');
  useEffect(() => {
    if (!pendingSimKey) return;
    const poll = async () => {
      try {
        const updated = await api.listSimulations(projectId);
        setSimulations(updated);
      } catch { /* ignore */ }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSimKey, projectId]);

  // B-roll computed values
  const isAudioSection = (s: TimelineSection) => s.track === 'audio' || !!s.clip_source_audio_id;
  const isVisualBrollSection = (s: TimelineSection) => s.track === 'broll' && !s.clip_source_audio_id;
  const brollSections = sections.filter(isVisualBrollSection);
  const audioSections = sections.filter(isAudioSection);
  const hasBroll = toolMode === 'broll' || showAllLayers;

  const activeBrollSection = brollSections.find(s => {
    const start = s.global_offset_sec ?? 0;
    const end   = start + (s.end_sec - s.start_sec);
    return playheadSec >= start && playheadSec < end;
  }) ?? null;

  // Main timeline offsets. Sections may extend past the physical video duration
  // when the user appends a simulation or existing clip after the last clip.
  const mainVideosSorted = [...allVideos.filter(v => !v.is_broll)].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const videoGlobalOffsets = new Map<string, number>();
  let mainVideoDuration = 0;
  for (const v of mainVideosSorted) {
    videoGlobalOffsets.set(v.id, mainVideoDuration);
    mainVideoDuration += v.duration_sec ?? 0;
  }

  const sectionGlobalStart = (s: TimelineSection) => (videoGlobalOffsets.get(s.video_file_id) ?? 0) + s.start_sec;
  const sectionGlobalEnd   = (s: TimelineSection) => (videoGlobalOffsets.get(s.video_file_id) ?? 0) + s.end_sec;
  const timelineDuration = Math.max(
    mainVideoDuration,
    ...sections.filter(s => s.track === 'main').map(sectionGlobalEnd),
  );

  // Clip overlay — library video shown as overlay at playhead position.
  const activeClipSection = sections.find(s => {
    if (s.type !== 'clip' || !s.clip_source_video_id) return false;
    const globalStart = sectionGlobalStart(s);
    const globalEnd   = sectionGlobalEnd(s);
    return playheadSec >= globalStart && playheadSec < globalEnd;
  }) ?? null;

  // Normalize clip section to broll-like shape so VideoPlayer's seek formula works:
  // global_offset_sec = when the clip appears in global timeline
  // clip_in_sec        = in-point of the source video (preserved for VideoPlayer)
  const clipSectionAsOverlay: TimelineSection | null = activeClipSection
    ? ({
        ...activeClipSection,
        global_offset_sec: sectionGlobalStart(activeClipSection),
        video_file_id: activeClipSection.clip_source_video_id!,
      } as TimelineSection)
    : null;

  const activeOverlay = activeBrollSection ?? clipSectionAsOverlay;
  const overlaySourceId = activeOverlay?.video_file_id ?? null;

  const brollHlsUrl = overlaySourceId ? (hlsUrls[overlaySourceId] ?? null) : null;

  // B-roll callbacks
  const handleToolModeChange = useCallback((mode: ToolMode) => {
    setToolMode(mode);
    if (mode !== 'broll') setBrollMark(null);
  }, []);

  const handleToggleAllLayers = useCallback(() => {
    setShowAllLayers((visible) => {
      const next = !visible;
      setToolMode(next ? 'broll' : 'video');
      if (!next) setBrollMark(null);
      return next;
    });
  }, []);

  const handleNewBrollJob = useCallback((job: VideoGenerationJob) => {
    setBrollJobs(prev => [job, ...prev]);
  }, []);

  const handleBrollJobUpdate = useCallback((job: VideoGenerationJob) => {
    setBrollJobs(prev => prev.map(j => j.id === job.id ? job : j));
    if (job.status === 'ready') loadData();
  }, [loadData]);

  const commitSections = useCallback((nextSections: TimelineSection[]) => {
    setUndoStack(stack => [...stack.slice(-(HISTORY_LIMIT - 1)), cloneSections(sections)]);
    setRedoStack([]);
    setSections(nextSections);
  }, [sections]);

  const restoreSectionSnapshot = useCallback(async (target: SectionSnapshot): Promise<TimelineSection[]> => {
    const currentById = new Map(sections.map(s => [s.id, s]));
    const targetIds = new Set(target.map(s => s.id));
    const restored: TimelineSection[] = [];

    for (const targetSection of target) {
      const currentSection = currentById.get(targetSection.id);
      if (currentSection) {
        if (sectionComparable(currentSection) === sectionComparable(targetSection)) {
          restored.push(currentSection);
        } else {
          restored.push(await api.updateSection(projectId, targetSection.id, sectionPatchBody(targetSection)));
        }
      } else {
        restored.push(await api.createSection(projectId, sectionCreateBody(targetSection)));
      }
    }

    for (const currentSection of sections) {
      if (!targetIds.has(currentSection.id)) {
        await api.deleteSection(projectId, currentSection.id);
      }
    }

    return restored;
  }, [projectId, sections]);

  const handleUndo = useCallback(async () => {
    if (historyBusy || undoStack.length === 0) return;
    const target = undoStack[undoStack.length - 1];
    const remainingUndo = undoStack.slice(0, -1);
    const redoSnapshot = cloneSections(sections);
    setHistoryBusy(true);
    try {
      const restored = await restoreSectionSnapshot(target);
      setSections(restored);
      setUndoStack(remainingUndo);
      setRedoStack(stack => [...stack.slice(-(HISTORY_LIMIT - 1)), redoSnapshot]);
    } catch {
      await loadData();
    } finally {
      setHistoryBusy(false);
    }
  }, [historyBusy, loadData, restoreSectionSnapshot, sections, undoStack]);

  const handleRedo = useCallback(async () => {
    if (historyBusy || redoStack.length === 0) return;
    const target = redoStack[redoStack.length - 1];
    const remainingRedo = redoStack.slice(0, -1);
    const undoSnapshot = cloneSections(sections);
    setHistoryBusy(true);
    try {
      const restored = await restoreSectionSnapshot(target);
      setSections(restored);
      setRedoStack(remainingRedo);
      setUndoStack(stack => [...stack.slice(-(HISTORY_LIMIT - 1)), undoSnapshot]);
    } catch {
      await loadData();
    } finally {
      setHistoryBusy(false);
    }
  }, [historyBusy, loadData, redoStack, restoreSectionSnapshot, sections]);

  const handleDeleteSim = (simId: string) => setConfirmSim(simId);

  const startRenameSim = (sim: Simulation) => { setRenamingSimId(sim.id); setRenameDraft(sim.name); };
  const commitRenameSim = async () => {
    const id = renamingSimId;
    const name = renameDraft.trim();
    setRenamingSimId(null);
    if (!id || !name) return;
    setSimulations(prev => prev.map(s => s.id === id ? { ...s, name } : s)); // optimistic
    try {
      const updated = await api.updateSimulation(projectId, id, { name });
      setSimulations(prev => prev.map(s => s.id === id ? updated : s));
    } catch { /* revert on next list refresh */ }
  };

  const confirmDeleteSim = async () => {
    if (!confirmSim) return;
    const simId = confirmSim;
    setConfirmSim(null);
    setDeletingSimId(simId);
    try {
      await api.deleteSimulation(projectId, simId);
      setSimulations(s => s.filter(sim => sim.id !== simId));
    } catch { /* ignore */ } finally {
      setDeletingSimId(null);
    }
  };

  const handleDeleteVideo = (e: React.MouseEvent, videoId: string) => {
    e.stopPropagation();
    setConfirmVideo(videoId);
  };

  const confirmDeleteVideo = async () => {
    if (!confirmVideo) return;
    const videoId = confirmVideo;
    setConfirmVideo(null);
    setDeletingId(videoId);
    try {
      await api.deleteVideo(projectId, videoId);
      setVideos(v => v.filter(vid => vid.id !== videoId));
      setSections(s => s.filter(sec => sec.video_file_id !== videoId));
    } catch { /* ignore */ } finally {
      setDeletingId(null);
    }
  };

  // Sort videos by created_at ASC (oldest = clip 1)
  const sortedVideos = [...videos].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  // Build clips array for VideoPlayer (multi-clip mode)
  const clips: Clip[] = sortedVideos.map(v => ({
    id: v.id,
    hlsUrl: (hlsUrls[v.id] && v.hls_status === 'ready') ? hlsUrls[v.id] : null,
    rawUrl: rawUrls[v.id] ?? null,
    duration: v.duration_sec ?? 0,
  }));

  // Compute active video from playhead (which clip is at playheadSec)
  const activeVideoId = (() => {
    let off = 0;
    for (const v of sortedVideos) {
      const dur = v.duration_sec ?? 0;
      if (playheadSec < off + dur) return v.id;
      off += dur;
    }
    return sortedVideos[sortedVideos.length - 1]?.id ?? null;
  })();

  // Compute active section label (global → local → section lookup)
  const activeSectionLabel = (() => {
    return sections.find(s =>
      s.track === 'main' &&
      playheadSec >= sectionGlobalStart(s) &&
      playheadSec < sectionGlobalEnd(s),
    )?.label ?? null;
  })();

  // Compute active simulation section for the editor preview overlay
  const activeSimSection = (() => {
    return sections.find(s =>
      s.type === 'simulation' &&
      !!s.simulation_url &&
      playheadSec >= sectionGlobalStart(s) &&
      playheadSec < sectionGlobalEnd(s),
    ) ?? null;
  })();

  // Compute active image section for the editor preview overlay
  const activeImageSection = (() => {
    const s = sections.find(sec =>
      sec.type === 'clip' &&
      !!sec.clip_source_image_id &&
      playheadSec >= sectionGlobalStart(sec) &&
      playheadSec < sectionGlobalEnd(sec),
    ) ?? null;
    if (!s) return null;
    const img = images.find(i => i.id === s.clip_source_image_id);
    if (!img) return null;
    return {
      section: s,
      image: img,
      globalStart: sectionGlobalStart(s),
      duration: s.end_sec - s.start_sec,
    };
  })();

  // Image upload handler
  const uploadImageFile = useCallback(async (file: File) => {
    setImgUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const uploaded = await api.uploadImage(projectId, fd);
      setImages(prev => [uploaded, ...prev]);
      setPendingCropImage(uploaded);
    } catch { /* ignore */ } finally {
      setImgUploading(false);
    }
  }, [projectId]);

  const handleImageFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    void uploadImageFile(file);
  }, [uploadImageFile]);

  // Replace an existing image's media — Library "Replace", available on every image.
  const replaceImageInputRef = useRef<HTMLInputElement>(null);
  const replaceImageTargetId = useRef<string | null>(null);
  const handleReplaceImageFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const imageId = replaceImageTargetId.current;
    e.target.value = '';
    if (!file || !imageId) return;
    setImgUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const updated = await api.replaceImage(projectId, imageId, fd);
      setImages(prev => prev.map(i => (i.id === updated.id ? updated : i)));
    } catch { /* ignore */ } finally {
      setImgUploading(false);
      replaceImageTargetId.current = null;
    }
  }, [projectId]);

  const handleCropApprove = useCallback(async (crop: { crop_x: number; crop_y: number; crop_w: number; crop_h: number }) => {
    if (!pendingCropImage) return;
    try {
      const updated = await api.patchImageCrop(projectId, pendingCropImage.id, crop);
      setImages(prev => prev.map(i => i.id === updated.id ? updated : i));
    } catch { /* ignore */ }
    setPendingCropImage(null);
  }, [pendingCropImage, projectId]);

  const handleDeleteImage = useCallback(async (imgId: string) => {
    setDeletingImgId(imgId);
    try {
      await api.deleteImage(projectId, imgId);
      setImages(prev => prev.filter(i => i.id !== imgId));
    } catch { /* ignore */ } finally {
      setDeletingImgId(null);
    }
  }, [projectId]);

  const uploadAudioFile = useCallback(async (file: File) => {
    setAudioUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const uploaded = await api.uploadAudioFile(projectId, fd);
      setAudioFiles(prev => [uploaded, ...prev]);
    } catch { /* ignore */ } finally {
      setAudioUploading(false);
    }
  }, [projectId]);

  const handleAudioFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    void uploadAudioFile(file);
  }, [uploadAudioFile]);

  // ── Whole-Library drop target (frontend-006 / ui-ux-001) ────────────────────
  // Dragging any file over the Library panel highlights the entire panel; on drop the file is
  // routed to the right place (image → images, audio → audio, .zip/folder → the simulation
  // uploader) or a feedback toast explains why it was rejected.
  const [libraryDragOver, setLibraryDragOver] = useState(false);
  const [libraryFeedback, setLibraryFeedback] = useState<{ tone: 'info' | 'error'; message: string } | null>(null);
  const [simAutoFiles, setSimAutoFiles] = useState<File[] | null>(null);
  const libraryDragDepth = useRef(0);

  // ── Guided walkthrough — auto-runs once per browser, re-openable from the header "?" ──
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || window.localStorage.getItem('editor-tour-seen')) return;
    const t = setTimeout(() => setTourOpen(true), 900); // let the editor paint first
    return () => clearTimeout(t);
  }, []);
  // The "?" lives in the top header (next to Settings) and dispatches this event to start the tour.
  useEffect(() => {
    const start = () => setTourOpen(true);
    window.addEventListener('editor:start-tour', start);
    return () => window.removeEventListener('editor:start-tour', start);
  }, []);
  const closeTour = useCallback(() => {
    setTourOpen(false);
    try { window.localStorage.setItem('editor-tour-seen', '1'); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!libraryFeedback) return;
    const t = setTimeout(() => setLibraryFeedback(null), 4000);
    return () => clearTimeout(t);
  }, [libraryFeedback]);

  const onLibraryDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types ?? []).includes('Files')) return;
    e.preventDefault();
    libraryDragDepth.current += 1;
    setLibraryDragOver(true);
  }, []);
  const onLibraryDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types ?? []).includes('Files')) e.preventDefault();
  }, []);
  const onLibraryDragLeave = useCallback(() => {
    libraryDragDepth.current = Math.max(0, libraryDragDepth.current - 1);
    if (libraryDragDepth.current === 0) setLibraryDragOver(false);
  }, []);
  const onLibraryDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    libraryDragDepth.current = 0;
    setLibraryDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) { setShowSimUploader(true); return; } // folder drag → sim uploader
    const images = files.filter(f => f.type.startsWith('image/'));
    const audio  = files.filter(f => f.type.startsWith('audio/'));
    const sims   = files.filter(f => f.name.toLowerCase().endsWith('.zip') || f.type === 'application/zip' || f.type === 'application/x-zip-compressed');
    const other  = files.filter(f => !images.includes(f) && !audio.includes(f) && !sims.includes(f));
    images.forEach(f => void uploadImageFile(f));
    audio.forEach(f => void uploadAudioFile(f));
    if (sims.length > 0) { setShowSimUploader(true); setSimAutoFiles(sims); }
    const parts = [
      images.length && `${images.length} image${images.length > 1 ? 's' : ''}`,
      audio.length && `${audio.length} audio`,
      sims.length && `${sims.length} simulation${sims.length > 1 ? 's' : ''}`,
    ].filter(Boolean);
    if (parts.length) setLibraryFeedback({ tone: 'info', message: `Added ${parts.join(', ')} to the library.` });
    if (other.length) setLibraryFeedback({ tone: 'error', message: `Unsupported: ${other.map(f => f.name).join(', ')}` });
  }, [uploadImageFile, uploadAudioFile]);

  const handleDeleteAudio = useCallback(async (audioId: string) => {
    setDeletingAudioId(audioId);
    try {
      await api.deleteAudioFile(projectId, audioId);
      setAudioFiles(prev => prev.filter(a => a.id !== audioId));
    } catch { /* ignore */ } finally {
      setDeletingAudioId(null);
    }
  }, [projectId]);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setPreviewViewportSize({
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
    });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const node = previewShellRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setPreviewShellSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      playerContainerRef.current?.requestFullscreen();
    }
  }, []);

  const handleTimelineSeek = useCallback((globalSec: number) => {
    setPlayheadSec(globalSec);
    playerRef.current?.seek(globalSec);
  }, []);

  // ── Timeline markers (editor flags) ─────────────────────────────────────────
  // Flag mode is a toggle: while on, a follow-line tracks the timeline and clicking drops a flag
  // (the mode stays on so several can be placed). Playhead is read from a ref so the "m" hotkey
  // handler stays stable. Flags can't overlap (MARKER_MIN_GAP).
  const MARKER_MIN_GAP = 0.25; // seconds — two flags can't sit on the same spot
  const [flagMode, setFlagMode] = useState(false);
  const playheadRef = useRef(0);
  playheadRef.current = playheadSec;
  const markersRef = useRef<TimelineMarker[]>([]);
  markersRef.current = markers;

  const handleToggleFlagMode = useCallback(() => setFlagMode(v => !v), []);

  // Create a flag at a specific timeline second, unless one already sits on that spot.
  const handlePlaceMarker = useCallback(async (atSec: number) => {
    const at = Math.max(0, atSec);
    if (markersRef.current.some(m => Math.abs(m.at_sec - at) < MARKER_MIN_GAP)) return; // no overlap
    const temp: TimelineMarker = {
      id: `temp-${Date.now()}`, project_id: projectId, at_sec: at,
      label: null, notes: null, color: '#ef4444', created_at: new Date().toISOString(),
    };
    setMarkers(prev => [...prev, temp].sort((a, b) => a.at_sec - b.at_sec));
    try {
      const saved = await api.createMarker(projectId, { at_sec: at });
      setMarkers(prev => prev.map(m => (m.id === temp.id ? saved : m)).sort((a, b) => a.at_sec - b.at_sec));
    } catch {
      setMarkers(prev => prev.filter(m => m.id !== temp.id));
    }
  }, [projectId]);

  const handleUpdateMarker = useCallback(async (id: string, patch: { label?: string | null; notes?: string | null; at_sec?: number }) => {
    // A flag whose create hasn't resolved yet has a temp id that doesn't exist server-side —
    // ignore edits/repositions until it's real (a PATCH against a temp id would 404, and the
    // create response would then overwrite the edit anyway). (frontend-201)
    if (id.startsWith('temp-')) return;
    // Repositioning can't drop a flag onto another flag's spot.
    if (patch.at_sec != null) {
      const at = Math.max(0, patch.at_sec);
      if (markersRef.current.some(m => m.id !== id && Math.abs(m.at_sec - at) < MARKER_MIN_GAP)) {
        delete patch.at_sec;
      } else {
        patch.at_sec = at;
      }
    }
    if (Object.keys(patch).length === 0) return;
    setMarkers(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
    try {
      const saved = await api.updateMarker(projectId, id, patch);
      setMarkers(prev => prev.map(m => (m.id === id ? saved : m)).sort((a, b) => a.at_sec - b.at_sec));
    } catch { /* keep optimistic */ }
  }, [projectId]);

  const handleDeleteMarker = useCallback(async (id: string) => {
    // Don't fire a DELETE against a not-yet-created (temp) flag. (frontend-201)
    if (id.startsWith('temp-')) { setMarkers(prev => prev.filter(m => m.id !== id)); return; }
    setMarkers(prev => prev.filter(m => m.id !== id));
    try { await api.deleteMarker(projectId, id); } catch { /* ignore */ }
  }, [projectId]);

  // "m" / "M" hotkey drops a flag at the playhead (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      void handlePlaceMarker(playheadRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlePlaceMarker]);

  const previewAspect = previewViewportSize.width / Math.max(1, previewViewportSize.height);
  const previewFrameStyle: React.CSSProperties = (() => {
    const { width: shellW, height: shellH } = previewShellSize;
    if (!shellW || !shellH) return { width: '100%', height: '100%' };
    const shellAspect = shellW / Math.max(1, shellH);
    if (shellAspect > previewAspect) {
      return { width: Math.round(shellH * previewAspect), height: shellH };
    }
    return { width: shellW, height: Math.round(shellW / previewAspect) };
  })();

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted-foreground animate-pulse text-sm">Loading editor…</div>
      </div>
    );
  }

  const hasAnyVideo = videos.length > 0;
  const showBrollTrack = hasBroll;
  const showAudioTrack = hasBroll;
  const tlHeight =
    TIMELINE_RULER_H +
    TIMELINE_VIDEO_TRACK_H +
    TIMELINE_AUDIO_TRACK_H +
    TIMELINE_SCROLLBAR_H +
    (showBrollTrack ? TIMELINE_BROLL_TRACK_H : 0) +
    (showAudioTrack ? TIMELINE_AUDIO_TRACK_H : 0);
  const timelinePanelHeight = `min(${tlHeight}px, ${showBrollTrack || showAudioTrack ? 44 : 38}dvh)`;

  return (
    <>
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Upload panel (collapsible) */}
      {showUploader && (
        <div className="shrink-0 border-b border-border bg-card/30 px-3 py-3 sm:px-6 sm:py-4">
          <VideoUploader
            projectId={projectId}
            onUploaded={(video) => {
              if (video.raw_url) setRawUrls(prev => ({ ...prev, [video.id]: video.raw_url! }));
              loadData();
              setShowUploader(false);
            }}
          />
        </div>
      )}

      {/* Main split: player top, timeline bottom */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Player + sidebar row */}
        <div className="flex-1 min-h-0 flex flex-col gap-3 p-2 sm:p-3 min-[900px]:flex-row min-[900px]:gap-4 min-[900px]:p-4">
          {/* Player area */}
          <div
            ref={playerContainerRef}
            className="min-w-0 flex-1 min-h-[220px] sm:min-h-[280px] min-[900px]:min-h-0 flex flex-col relative"
            style={isFullscreen ? { backgroundColor: '#000', justifyContent: 'center' } : undefined}
          >
            <div
              ref={previewShellRef}
              className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black ${isFullscreen ? '' : 'rounded-lg shadow-card'}`}
            >
              {hasAnyVideo ? (
                <div className="flex min-h-0 min-w-0 bg-black" style={previewFrameStyle}>
                  <VideoPlayer
                    ref={playerRef}
                    clips={clips}
                    timelineDuration={timelineDuration}
                    currentTime={playheadSec}
                    onTimeUpdate={setPlayheadSec}
                    sectionLabel={activeSectionLabel}
                    activeSimSection={activeSimSection}
                    activeBrollSection={activeOverlay ?? null}
                    brollHlsUrl={brollHlsUrl}
                    activeImageSection={activeImageSection}
                    avatarCircles={avatarCircles}
                    flush
                  />
                </div>
              ) : loadError ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 border border-dashed border-destructive/40 bg-destructive/[0.06] px-8 text-center">
                  <p className="text-sm text-white/70">Couldn&apos;t load this project.</p>
                  <p className="text-xs text-white/45">Check your connection and try again.</p>
                  <button
                    onClick={() => { setLoading(true); loadData(); }}
                    className="h-8 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 border border-dashed border-white/16 bg-card/[0.03] px-8 text-center">
                  <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="text-white/25" aria-hidden>
                    <rect x="4" y="8" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M16 14l10 6-10 6V14z" fill="currentColor" />
                  </svg>
                  <p className="text-sm text-white/55">No videos yet</p>
                  <button
                    onClick={() => setShowUploader(true)}
                    className="h-8 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring"
                  >
                    Upload video
                  </button>
                </div>
              )}

              {/* Fullscreen toggle */}
              {hasAnyVideo && (
                <button
                  onClick={toggleFullscreen}
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  className="absolute right-2 top-2 z-20 flex h-10 w-10 items-center justify-center rounded-lg transition-colors focus-ring"
                  style={{ backgroundColor: 'rgba(0,0,0,0.45)', color: '#fff' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.7)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.45)')}
                >
                  {isFullscreen ? (
                    <Minimize2 size={18} strokeWidth={1.8} aria-hidden />
                  ) : (
                    <Maximize2 size={18} strokeWidth={1.8} aria-hidden />
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Right panel: BrollPanel when marking, otherwise videos + simulations */}
          {toolMode === 'broll' && brollMark ? (
            <div className="max-h-[34dvh] w-full shrink-0 overflow-y-auto fine-scrollbar min-[900px]:max-h-none min-[900px]:w-[300px] xl:w-80">
              <BrollPanel
                projectId={projectId}
                mark={brollMark}
                videos={allVideos}
                jobs={brollJobs}
                onNewJob={handleNewBrollJob}
                onJobUpdate={handleBrollJobUpdate}
                onInserted={(section) => {
                  commitSections([...sections, section]);
                  setBrollMark(null);
                }}
                onClose={() => setBrollMark(null)}
              />
            </div>
          ) : (
            <div className="flex min-h-0 max-h-[36dvh] w-full shrink-0 flex-col gap-2 overflow-hidden min-[900px]:max-h-none min-[900px]:w-[300px] xl:w-80">
              <div
                data-tour="library"
                className={`surface-panel relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg px-3 py-3 fine-scrollbar transition-shadow ${libraryDragOver ? 'ring-2 ring-amber-400 ring-offset-1' : ''}`}
                onDragEnter={onLibraryDragEnter}
                onDragOver={onLibraryDragOver}
                onDragLeave={onLibraryDragLeave}
                onDrop={onLibraryDrop}
              >
                {libraryDragOver && (
                  <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-amber-400 bg-amber-50/85 backdrop-blur-sm">
                    <Upload size={22} className="text-amber-500" aria-hidden />
                    <p className="text-xs font-semibold text-amber-700">Drop to add to the Library</p>
                    <p className="text-[10px] text-amber-600">Images · audio · simulation .zip</p>
                  </div>
                )}
                {libraryFeedback && (
                  <div
                    role="status"
                    className={`shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium ${libraryFeedback.tone === 'error' ? 'bg-destructive/15 text-destructive' : 'bg-emerald-500/15 text-emerald-700'}`}
                  >
                    {libraryFeedback.message}
                  </div>
                )}
                <div className="flex items-start justify-between gap-3 border-b border-border/40 pb-2">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-foreground">Library</h2>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {videos.length} clip{videos.length !== 1 ? 's' : ''} · {sections.length} section{sections.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExtendedLibraryOpen(true)}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-ring"
                    title="Manage the avatar's basic and extended visual library"
                  >
                    <Sparkles size={12} strokeWidth={1.9} aria-hidden />
                    Extended
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-0.5 h-3 rounded-full bg-primary/70" />
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60">Videos</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">
                      {videos.length} clip{videos.length !== 1 ? 's' : ''} · {sections.length} section{sections.length !== 1 ? 's' : ''}
                    </span>
                    <button
                      onClick={() => setShowUploader(v => !v)}
                      title="Add video"
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-ring"
                    >
                      <Plus size={15} strokeWidth={2} aria-hidden />
                    </button>
                  </div>
                </div>
                {videos.length === 0 ? (
                  <button onClick={() => setShowUploader(true)} className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-4 text-left text-xs font-medium text-primary hover:bg-muted/50 transition-colors focus-ring">
                  Upload first video
                </button>
              ) : (
                videos.map(v => (
                  <div
                    key={v.id}
                    className={`relative rounded-xl border transition-all card-interactive ${
                      activeVideoId === v.id
                        ? 'border-primary/40 bg-primary/5 shadow-sm-soft'
                        : 'border-border/60 bg-card/90 hover:border-primary/30'
                    }`}
                  >
                    <div className="w-full text-left px-3 py-2.5 pr-12">
                      <p className="text-xs font-medium text-foreground truncate">{v.filename}</p>
                      <div className="mt-1 space-y-0.5">
                        <p className="text-[10px] text-muted-foreground">
                          {v.duration_sec ? `${Math.floor(v.duration_sec / 60)}m ${Math.floor(v.duration_sec % 60)}s` : v.status}
                        </p>
                        {v.hls_status === 'ready' ? null : v.hls_status === 'failed' ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); setReplacingVideoId(v.id); }}
                            title="This video isn't saved. Click to upload it again."
                            className="inline-flex items-center gap-1 text-[9px] font-semibold text-amber-600 hover:text-amber-500"
                          >
                            <AlertTriangle size={10} strokeWidth={2.2} aria-hidden /> Not saved — re-upload
                          </button>
                        ) : (v.hls_status === 'pending' || v.hls_status === 'processing') ? (
                          <HlsTierProgress
                            currentTier={tierProgress[v.id]?.currentTier ?? null}
                            is360pReady={tierProgress[v.id]?.is360pReady ?? false}
                            hlsStatus={v.hls_status}
                          />
                        ) : null}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); setReplacingVideoId(v.id); }}
                      title="Replace with a new version (re-upload)"
                      className="absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                    >
                      <RefreshCw size={14} strokeWidth={1.9} aria-hidden />
                    </button>
                    <button
                      onClick={e => handleDeleteVideo(e, v.id)}
                      disabled={deletingId === v.id}
                      title="Delete video"
                      className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                    >
                      {deletingId === v.id ? (
                        <span className="text-xs">…</span>
                      ) : (
                        <Trash2 size={14} strokeWidth={1.9} aria-hidden />
                      )}
                    </button>
                  </div>
                ))
              )}

              {/* Simulations section */}
              <div data-tour="simulations" className="mt-3 flex flex-col gap-2 pt-3 border-t border-border/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-0.5 h-3 rounded-full bg-amber-400/80" />
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60">Simulations</p>
                  </div>
                  <button
                    onClick={() => setShowSimUploader(v => !v)}
                    title="Upload simulation"
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500 text-white shadow-sm transition-colors hover:bg-amber-400 focus-ring"
                  >
                    <Plus size={15} strokeWidth={2} aria-hidden />
                  </button>
                </div>

                {showSimUploader && (
                  <SimulationUploader
                    projectId={projectId}
                    autoFiles={simAutoFiles}
                    onAutoFilesConsumed={() => setSimAutoFiles(null)}
                    onUploaded={(sim) => {
                      setSimulations(prev => [...prev, sim]);
                      setShowSimUploader(false);
                    }}
                  />
                )}

                {simulations.length === 0 && !showSimUploader ? (
                  <button onClick={() => setShowSimUploader(true)} className="rounded-lg border border-dashed border-amber-200 bg-amber-50/60 px-3 py-4 text-left text-xs font-medium text-amber-600 hover:bg-amber-50 transition-colors focus-ring">
                    Upload first simulation
                  </button>
                ) : (
                  simulations.map(sim => (
                    <div
                      key={sim.id}
                      className="relative rounded-xl border border-border/60 bg-card/90 hover:border-amber-400/50 transition-all card-interactive"
                    >
                      <div className="w-full text-left px-3 py-2.5 pr-[76px]">
                        {renamingSimId === sim.id ? (
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={commitRenameSim}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitRenameSim(); else if (e.key === 'Escape') setRenamingSimId(null); }}
                            aria-label="Simulation name"
                            className="w-full rounded border border-amber-300 bg-background px-1.5 py-0.5 text-xs font-medium text-foreground outline-none focus-ring"
                          />
                        ) : (
                          <p className="text-xs font-medium text-foreground truncate">{sim.name}</p>
                        )}
                        <div className="mt-0.5 flex items-center gap-2">
                          {sim.status === 'ready' ? null : sim.status === 'failed' ? (
                            <span className="text-[9px] text-red-400 font-medium">Failed</span>
                          ) : (
                            <span className="text-[9px] text-amber-400 font-medium animate-pulse">Processing…</span>
                          )}
                          {sim.bridge_functions && sim.bridge_functions.length > 0 && (
                            <span className="text-[9px] text-muted-foreground">
                              {sim.bridge_functions.length} fn{sim.bridge_functions.length !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => startRenameSim(sim)}
                        title="Rename simulation"
                        aria-label="Rename simulation"
                        className="absolute right-10 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-amber-500/10 hover:text-amber-600 focus-ring"
                      >
                        <Pencil size={13} strokeWidth={1.9} aria-hidden />
                      </button>
                      <button
                        onClick={() => handleDeleteSim(sim.id)}
                        disabled={deletingSimId === sim.id}
                        title="Delete simulation"
                        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                      >
                        {deletingSimId === sim.id ? (
                          <span className="text-xs">…</span>
                        ) : (
                          <Trash2 size={14} strokeWidth={1.9} aria-hidden />
                        )}
                      </button>
                    </div>
                  ))
                )}
                </div>

              {/* Images section */}
              <div className="mt-3 flex flex-col gap-2 pt-3 border-t border-border/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-0.5 h-3 rounded-full bg-violet-400/80" />
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60">Images</p>
                  </div>
                  <button
                    onClick={() => imgFileInputRef.current?.click()}
                    disabled={imgUploading}
                    title="Upload image"
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500 text-white shadow-sm transition-colors hover:bg-violet-400 focus-ring disabled:opacity-50"
                  >
                    {imgUploading ? <span className="text-[9px] animate-pulse">…</span> : <Plus size={15} strokeWidth={2} aria-hidden />}
                  </button>
                  <input
                    ref={imgFileInputRef}
                    type="file"
                    accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                    className="hidden"
                    onChange={handleImageFileChange}
                  />
                  <input
                    ref={replaceImageInputRef}
                    type="file"
                    accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                    className="hidden"
                    onChange={handleReplaceImageFileChange}
                  />
                </div>

                {/* Crop editor modal */}
                {pendingCropImage && (
                  <div style={{
                    border: '1px solid #ddd6fe', borderRadius: 10,
                    background: '#faf5ff', padding: '12px 12px',
                  }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: '#6d28d9', marginBottom: 8 }}>Crop image to 16:9</p>
                    <ImageCropEditor
                      image={pendingCropImage}
                      onApprove={handleCropApprove}
                      onCancel={() => setPendingCropImage(null)}
                    />
                  </div>
                )}

                {images.length === 0 && !pendingCropImage ? (
                  <button
                    onClick={() => imgFileInputRef.current?.click()}
                    className="rounded-lg border border-dashed border-violet-200 bg-violet-50/60 px-3 py-4 text-left text-xs font-medium text-violet-600 hover:bg-violet-50 transition-colors focus-ring"
                  >
                    Upload first image (PNG, JPEG…)
                  </button>
                ) : (
                  images.map(img => (
                    <div
                      key={img.id}
                      className="relative rounded-xl border border-border/60 bg-card/90 hover:border-violet-400/50 transition-all card-interactive"
                    >
                      <div className="flex items-center gap-2 px-3 py-2 pr-10">
                        {/* Thumbnail */}
                        <div style={{
                          width: 40, height: 23, borderRadius: 4, overflow: 'hidden',
                          background: '#f3f4f6', flexShrink: 0, position: 'relative',
                        }}>
                          <img
                            src={img.original_url}
                            alt={img.filename}
                            style={{
                              position: 'absolute',
                              width: `${(1 / (img.crop_w || 1)) * 100}%`,
                              height: `${(1 / (img.crop_h || 1)) * 100}%`,
                              left: `${(-img.crop_x / (img.crop_w || 1)) * 100}%`,
                              top: `${(-img.crop_y / (img.crop_h || 1)) * 100}%`,
                              objectFit: 'fill',
                            }}
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">{img.filename}</p>
                          <button
                            onClick={() => setPendingCropImage(img)}
                            className="text-[9px] text-violet-500 hover:underline"
                          >
                            Edit crop
                          </button>
                        </div>
                      </div>
                      <button
                        onClick={() => { replaceImageTargetId.current = img.id; replaceImageInputRef.current?.click(); }}
                        title="Replace with a new version"
                        className="absolute right-10 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                      >
                        <RefreshCw size={14} strokeWidth={1.9} aria-hidden />
                      </button>
                      <button
                        onClick={() => setConfirmImg(img.id)}
                        disabled={deletingImgId === img.id}
                        title="Delete image"
                        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                      >
                        {deletingImgId === img.id ? <span className="text-xs">…</span> : <Trash2 size={14} strokeWidth={1.9} aria-hidden />}
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Sound section */}
              <div className="mt-3 flex flex-col gap-2 pt-3 border-t border-border/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-0.5 h-3 rounded-full bg-emerald-400/80" />
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60">Sound</p>
                  </div>
                  <button
                    onClick={() => audioFileInputRef.current?.click()}
                    disabled={audioUploading}
                    title="Upload audio file"
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-white shadow-sm transition-colors hover:bg-emerald-400 focus-ring disabled:opacity-50"
                  >
                    {audioUploading ? <span className="text-[9px] animate-pulse">…</span> : <Plus size={15} strokeWidth={2} aria-hidden />}
                  </button>
                  <input
                    ref={audioFileInputRef}
                    type="file"
                    accept=".wav,.mp3,.m4a,.aac,.ogg,.flac,audio/*"
                    className="hidden"
                    onChange={handleAudioFileChange}
                  />
                </div>

                {audioFiles.length === 0 ? (
                  <button
                    onClick={() => audioFileInputRef.current?.click()}
                    className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50/60 px-3 py-4 text-left text-xs font-medium text-emerald-600 hover:bg-emerald-50 transition-colors focus-ring"
                  >
                    Upload audio (wav, mp3, m4a…) — drag to A2 to add a sound layer
                  </button>
                ) : (
                  audioFiles.map(af => (
                    <div
                      key={af.id}
                      draggable
                      onDragStart={e => {
                        e.dataTransfer.setData('application/audio-cutaway', JSON.stringify({ id: af.id, filename: af.filename, url: af.url, duration_sec: af.duration_sec }));
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      className="relative rounded-xl border border-border/60 bg-card/90 hover:border-emerald-400/50 transition-all card-interactive cursor-grab active:cursor-grabbing"
                      title="Drag to A2 audio track to add a sound layer"
                    >
                      <div className="flex items-center gap-2 px-3 py-2.5 pr-10">
                        <Music size={14} strokeWidth={1.9} className="shrink-0 text-emerald-500" aria-hidden />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">{af.filename}</p>
                          {af.duration_sec && (
                            <p className="text-[10px] text-muted-foreground">
                              {Math.floor(af.duration_sec / 60)}m {Math.floor(af.duration_sec % 60)}s
                            </p>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => setConfirmAudio(af.id)}
                        disabled={deletingAudioId === af.id}
                        title="Delete audio"
                        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                      >
                        {deletingAudioId === af.id ? <span className="text-xs">…</span> : <Trash2 size={14} strokeWidth={1.9} aria-hidden />}
                      </button>
                    </div>
                  ))
                )}
              </div>
              </div>
              <EditorToolsPanel
                toolMode={toolMode}
                layersVisible={showAllLayers}
                onToggleAllLayers={handleToggleAllLayers}
                flagMode={flagMode}
                onToggleFlagMode={handleToggleFlagMode}
                markerCount={markers.length}
                onUndo={handleUndo}
                onRedo={handleRedo}
                canUndo={undoStack.length > 0}
                canRedo={redoStack.length > 0}
                historyBusy={historyBusy}
              />
              <button
                type="button"
                onClick={() => setShowBranching(true)}
                className="surface-panel flex min-h-11 w-full shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:border-cyan-300 hover:bg-cyan-50/60 focus-ring"
              >
                <GitBranch size={18} strokeWidth={1.9} aria-hidden className="text-cyan-600" />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold leading-tight">Follow user decisions</span>
                  <span className="block truncate text-[10px] leading-tight text-muted-foreground">Branch the video on viewer choices</span>
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Timeline */}
        <div data-tour="timeline" className="shrink-0 border-t border-border bg-card/70" style={{ height: timelinePanelHeight }}>
          <TimelinePanel
            projectId={projectId}
            videos={videos}
            allVideos={allVideos}
            sections={sections}
            markers={markers}
            flagMode={flagMode}
            onPlaceMarker={handlePlaceMarker}
            onExitFlagMode={() => setFlagMode(false)}
            onUpdateMarker={handleUpdateMarker}
            onDeleteMarker={handleDeleteMarker}
            simulations={simulations}
            images={images}
            audioFiles={audioFiles}
            playheadSec={playheadSec}
            activeVideoId={activeVideoId}
            videoUrls={rawUrls}
            onSeek={handleTimelineSeek}
            onSectionsChange={commitSections}
            onAddVideo={() => setShowUploader(true)}
            toolMode={toolMode}
            showAllLayers={showAllLayers}
            showBrollTrack={showBrollTrack}
            showAudioTrack={showAudioTrack}
            onBrollMarkComplete={setBrollMark}
            onAudioCutawayInserted={section => commitSections([...sections, section])}
            onSimulationUpdate={sim => setSimulations(prev => prev.map(s => s.id === sim.id ? sim : s))}
          />
        </div>
      </div>
    </div>

    {/* ── Confirm dialogs ───────────────────────────────────────────── */}
    <GuidedTour steps={EDITOR_TOUR_STEPS} open={tourOpen} onClose={closeTour} />
    {confirmVideo && (
      <ConfirmDialog
        title="Delete video clip?"
        description="This will permanently delete the video and all timeline sections that reference it. This cannot be undone."
        confirmLabel="Delete video"
        onConfirm={confirmDeleteVideo}
        onCancel={() => setConfirmVideo(null)}
      />
    )}
    {confirmSim && (
      <ConfirmDialog
        title="Delete simulation?"
        description="This will permanently delete the simulation and all bridge scripts generated for it. This cannot be undone."
        confirmLabel="Delete simulation"
        onConfirm={confirmDeleteSim}
        onCancel={() => setConfirmSim(null)}
      />
    )}
    {confirmImg && (
      <ConfirmDialog
        title="Delete image?"
        description="This will permanently delete the image from the library. This cannot be undone."
        confirmLabel="Delete image"
        onConfirm={() => { const id = confirmImg; setConfirmImg(null); void handleDeleteImage(id); }}
        onCancel={() => setConfirmImg(null)}
      />
    )}
    {confirmAudio && (
      <ConfirmDialog
        title="Delete audio?"
        description="This will permanently delete the audio file from the library. This cannot be undone."
        confirmLabel="Delete audio"
        onConfirm={() => { const id = confirmAudio; setConfirmAudio(null); void handleDeleteAudio(id); }}
        onCancel={() => setConfirmAudio(null)}
      />
    )}
    {replacingVideoId && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
        <div className="w-full max-w-md rounded-xl bg-card p-4 shadow-lg">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Replace video</h3>
            <button onClick={() => setReplacingVideoId(null)} aria-label="Cancel" className="text-muted-foreground hover:text-foreground">✕</button>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Upload a new version. It keeps this clip&apos;s place in the timeline — if the new
            video is longer, the extra is trimmed to fit; the captions and avatar circles
            re-process automatically.
          </p>
          <VideoUploader
            projectId={projectId}
            replaceVideoId={replacingVideoId}
            onUploaded={(video) => {
              if (video.raw_url) setRawUrls(prev => ({ ...prev, [video.id]: video.raw_url! }));
              loadData();
              setReplacingVideoId(null);
            }}
          />
        </div>
      </div>
    )}

    <ExtendedLibraryModal
      open={extendedLibraryOpen}
      onClose={() => setExtendedLibraryOpen(false)}
      projectId={projectId}
    />
    {showBranching && (
      <BranchingModal projectId={projectId} onClose={() => setShowBranching(false)} />
    )}
    </>
  );
}
