'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '../lib/firebase';
import { api } from '../lib/api';
import { VideoPlayer } from './VideoPlayer';
import type { VideoPlayerHandle } from './VideoPlayer';
import type { Clip } from '../hooks/useClipSequence';
import { TimelinePanel } from './TimelinePanel';
import { VideoUploader } from './VideoUploader';
import { SimulationUploader } from './SimulationUploader';
import { BrollPanel } from './BrollPanel';
import { ConfirmDialog } from './ConfirmDialog';
import type { VideoFile, TimelineSection, Simulation, VideoGenerationJob } from 'shared/src/generated/client-v1';

type ToolMode = 'video' | 'simulation' | 'broll';

const HLS_TIERS = ['360p', '480p', '720p', '1080p'] as const;
type HlsTier = typeof HLS_TIERS[number];

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
  const [sections, setSections] = useState<TimelineSection[]>([]);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [loading, setLoading] = useState(true);
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [showUploader, setShowUploader] = useState(false);
  const [showSimUploader, setShowSimUploader] = useState(false);
  const [deletingSimId, setDeletingSimId] = useState<string | null>(null);
  const [deletingId,    setDeletingId]    = useState<string | null>(null);
  // Confirm dialogs
  const [confirmVideo, setConfirmVideo] = useState<string | null>(null);  // videoId to delete
  const [confirmSim,   setConfirmSim]   = useState<string | null>(null);  // simId to delete
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
  const [isFullscreen, setIsFullscreen] = useState(false);


  const loadData = useCallback(async () => {
    try {
      const [vids, secs, sims, jobs] = await Promise.all([
        api.listVideos(projectId),
        api.listSections(projectId),
        api.listSimulations(projectId),
        api.listBrollJobs(projectId),
      ]);
      // Separate main videos from AI-generated broll source files
      setVideos(vids.filter(v => !v.is_broll));
      setAllVideos(vids);
      setSections(secs);
      setSimulations(sims);
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
    } catch { /* ignore */ } finally {
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

  // B-roll computed values
  const brollSections = sections.filter(s => s.track === 'broll');
  const hasBroll = brollSections.length > 0 || toolMode === 'broll';

  const activeBrollSection = brollSections.find(s => {
    const start = s.global_offset_sec ?? 0;
    const end   = start + (s.end_sec - s.start_sec);
    return playheadSec >= start && playheadSec < end;
  }) ?? null;

  const brollHlsUrl = activeBrollSection
    ? (hlsUrls[activeBrollSection.video_file_id] ?? null)
    : null;

  // B-roll callbacks
  const handleToolModeChange = useCallback((mode: ToolMode) => {
    setToolMode(mode);
    if (mode !== 'broll') setBrollMark(null);
  }, []);

  const handleNewBrollJob = useCallback((job: VideoGenerationJob) => {
    setBrollJobs(prev => [job, ...prev]);
  }, []);

  const handleBrollJobUpdate = useCallback((job: VideoGenerationJob) => {
    setBrollJobs(prev => prev.map(j => j.id === job.id ? job : j));
    if (job.status === 'ready') loadData();
  }, [loadData]);

  const handleDeleteSim = (simId: string) => setConfirmSim(simId);

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
    let off = 0;
    for (const v of sortedVideos) {
      const dur = v.duration_sec ?? 0;
      if (playheadSec < off + dur) {
        const localSec = playheadSec - off;
        return sections.find(
          s => s.track !== 'broll' && s.video_file_id === v.id && s.start_sec <= localSec && s.end_sec >= localSec,
        )?.label ?? null;
      }
      off += dur;
    }
    return null;
  })();

  // Compute active simulation section for the editor preview overlay
  const activeSimSection = (() => {
    let off = 0;
    for (const v of sortedVideos) {
      const dur = v.duration_sec ?? 0;
      if (playheadSec < off + dur) {
        const localSec = playheadSec - off;
        return sections.find(
          s => s.video_file_id === v.id &&
               s.type === 'simulation' &&
               !!s.simulation_url &&
               s.start_sec <= localSec && s.end_sec >= localSec,
        ) ?? null;
      }
      off += dur;
    }
    return null;
  })();

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
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

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted-foreground animate-pulse text-sm">Loading editor…</div>
      </div>
    );
  }

  const hasAnyVideo = videos.length > 0;
  const tlHeight = hasBroll ? 164 : 110;

  return (
    <>
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Upload panel (collapsible) */}
      {showUploader && (
        <div className="shrink-0 border-b border-border bg-card/30 px-6 py-4">
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
        <div className="flex-1 min-h-0 flex flex-col gap-3 p-3 lg:flex-row lg:gap-4 lg:p-4">
          {/* Player area */}
          <div
            ref={playerContainerRef}
            className="min-w-0 flex-1 min-h-[280px] lg:min-h-0 flex flex-col relative"
            style={isFullscreen ? { backgroundColor: '#000', justifyContent: 'center' } : undefined}
          >
            {hasAnyVideo ? (
              <VideoPlayer
                ref={playerRef}
                clips={clips}
                currentTime={playheadSec}
                onTimeUpdate={setPlayheadSec}
                sectionLabel={activeSectionLabel}
                activeSimSection={activeSimSection}
                activeBrollSection={activeBrollSection}
                brollHlsUrl={brollHlsUrl}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center bg-black/[0.03] rounded-lg border border-dashed border-border gap-3 text-center px-8">
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="text-muted-foreground/30" aria-hidden>
                  <rect x="4" y="8" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M16 14l10 6-10 6V14z" fill="currentColor" />
                </svg>
                <p className="text-sm text-muted-foreground">No videos yet</p>
                <button
                  onClick={() => setShowUploader(true)}
                  className="h-8 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors focus-ring"
                >
                  Upload video
                </button>
              </div>
            )}


            {/* Fullscreen toggle */}
            {hasAnyVideo && (
              <button
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen (F)'}
                className="absolute top-2 right-2 z-10 w-8 h-8 rounded-lg flex items-center justify-center transition-colors focus-ring"
                style={{ backgroundColor: 'rgba(0,0,0,0.45)', color: '#fff' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.7)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.45)')}
              >
                {isFullscreen ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path d="M5 1v4H1M9 1v4h4M5 13v-4H1M9 13v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            )}
          </div>

          {/* Right panel: BrollPanel when marking, otherwise videos + simulations */}
          {toolMode === 'broll' && brollMark ? (
            <div className="w-full lg:w-80 shrink-0 overflow-y-auto fine-scrollbar">
              <BrollPanel
                projectId={projectId}
                mark={brollMark}
                videos={allVideos}
                jobs={brollJobs}
                onNewJob={handleNewBrollJob}
                onJobUpdate={handleBrollJobUpdate}
                onInserted={(section) => {
                  setSections(prev => [...prev, section]);
                  setBrollMark(null);
                }}
                onClose={() => setBrollMark(null)}
              />
            </div>
          ) : (
            <div className="w-full lg:w-80 shrink-0 flex flex-col gap-2 overflow-y-auto surface-panel rounded-lg px-3 py-3 fine-scrollbar">
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
                    className="w-6 h-6 rounded-md flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm focus-ring"
                  >
                    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden>
                      <path d="M4.5 1v7M1 4.5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
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
                        : 'border-border/60 bg-white/90 hover:border-primary/30'
                    }`}
                  >
                    <div className="w-full text-left px-3 py-2.5 pr-8">
                      <p className="text-xs font-medium text-foreground truncate">{v.filename}</p>
                      <div className="mt-1 space-y-0.5">
                        <p className="text-[10px] text-muted-foreground">
                          {v.duration_sec ? `${Math.floor(v.duration_sec / 60)}m ${Math.floor(v.duration_sec % 60)}s` : v.status}
                        </p>
                        {v.hls_status === 'ready' ? (
                          <span className="text-[9px] text-emerald-500 font-medium">HLS ✓</span>
                        ) : v.hls_status === 'failed' ? (
                          <span className="text-[9px] text-red-400 font-medium">Transcode failed</span>
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
                      onClick={e => handleDeleteVideo(e, v.id)}
                      disabled={deletingId === v.id}
                      title="Delete video"
                      className="absolute top-2 right-2 w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                    >
                      {deletingId === v.id ? (
                        <span className="text-[8px]">…</span>
                      ) : (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
                          <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                      )}
                    </button>
                  </div>
                ))
              )}

              {/* Simulations section */}
              <div className="mt-3 flex flex-col gap-2 pt-3 border-t border-border/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-0.5 h-3 rounded-full bg-amber-400/80" />
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60">Simulations</p>
                  </div>
                  <button
                    onClick={() => setShowSimUploader(v => !v)}
                    title="Upload simulation"
                    className="w-6 h-6 rounded-md flex items-center justify-center bg-amber-500 text-white hover:bg-amber-400 transition-colors shadow-sm focus-ring"
                  >
                    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden>
                      <path d="M4.5 1v7M1 4.5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>

                {showSimUploader && (
                  <SimulationUploader
                    projectId={projectId}
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
                      className="relative rounded-xl border border-border/60 bg-white/90 hover:border-amber-400/50 transition-all card-interactive"
                    >
                      <div className="w-full text-left px-3 py-2.5 pr-8">
                        <p className="text-xs font-medium text-foreground truncate">{sim.name}</p>
                        <div className="mt-0.5 flex items-center gap-2">
                          {sim.status === 'ready' ? (
                            <span className="text-[9px] text-emerald-500 font-medium">Ready</span>
                          ) : sim.status === 'failed' ? (
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
                        onClick={() => handleDeleteSim(sim.id)}
                        disabled={deletingSimId === sim.id}
                        title="Delete simulation"
                        className="absolute top-2 right-2 w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                      >
                        {deletingSimId === sim.id ? (
                          <span className="text-[8px]">…</span>
                        ) : (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
                            <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                          </svg>
                        )}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Timeline */}
        <div className="shrink-0 border-t border-border bg-white/70" style={{ height: tlHeight }}>
          <TimelinePanel
            projectId={projectId}
            videos={videos}
            sections={sections}
            simulations={simulations}
            playheadSec={playheadSec}
            activeVideoId={activeVideoId}
            videoUrls={rawUrls}
            onSeek={handleTimelineSeek}
            onSectionsChange={setSections}
            onAddVideo={() => setShowUploader(true)}
            toolMode={toolMode}
            onToolModeChange={handleToolModeChange}
            onBrollMarkComplete={setBrollMark}
          />
        </div>
      </div>
    </div>

    {/* ── Confirm dialogs ───────────────────────────────────────────── */}
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
    </>
  );
}
