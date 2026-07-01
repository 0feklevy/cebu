'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import type { VideoFile, TimelineSection, VideoGenerationJob } from 'shared/src/generated/client-v1';

type Model = 'kling' | 'seedance' | 'veo';
type Tab = 'generate' | 'existing';

const MODEL_LABELS: Record<Model, string> = {
  kling: 'kling',
  seedance: 'seedance',
  veo: 'veo',
};

const JOB_STATUS_LABEL: Record<string, string> = {
  queued:      'Waiting…',
  enhancing:   'Enhancing prompt…',
  submitting:  'Submitting…',
  generating:  'Generating video…',
  downloading: 'Downloading…',
  transcoding: 'Transcoding HLS…',
  ready:       'Clip added to timeline!',
  failed:      'Failed',
};

function fmtSec(s: number) {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

function elapsed(createdAt: string): string {
  const secs = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

interface Props {
  projectId: string;
  mark: { start: number; end: number };
  videos: VideoFile[];
  jobs: VideoGenerationJob[];
  onNewJob: (job: VideoGenerationJob) => void;
  onJobUpdate: (job: VideoGenerationJob) => void;
  onInserted: (section: TimelineSection) => void;
  onClose: () => void;
}

export function BrollPanel({ projectId, mark, videos, jobs, onNewJob, onJobUpdate, onInserted, onClose }: Props) {
  const [tab, setTab]               = useState<Tab>('generate');
  const [prompt, setPrompt]         = useState('');
  const [enhance, setEnhance]       = useState(true);
  const [model, setModel]           = useState<Model>('kling');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError]     = useState<string | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [inserting, setInserting]   = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const [dismissedJobIds, setDismissedJobIds] = useState<Set<string>>(new Set());

  const prevJobsRef = useRef<VideoGenerationJob[]>([]);

  const markDuration  = mark.end - mark.start;
  const activeJobs    = jobs.filter(j => j.status !== 'ready' && j.status !== 'failed');
  const activeJobIds  = activeJobs.map(j => j.id).join(',');

  // Auto-switch to "Use Existing" when a job just completed and auto-select the new video
  useEffect(() => {
    const prev = prevJobsRef.current;
    const newlyReady = jobs.filter(j => {
      if (j.status !== 'ready' || !j.video_file_id) return false;
      const prevJob = prev.find(p => p.id === j.id);
      return prevJob && prevJob.status !== 'ready';
    });
    if (newlyReady.length > 0) {
      const videoId = newlyReady[0].video_file_id!;
      setTab('existing');
      setSelectedVideoId(videoId);
    }
    prevJobsRef.current = jobs;
  }, [jobs]);

  // Poll active jobs every 3s
  useEffect(() => {
    if (!activeJobIds) return;
    const ids = activeJobIds.split(',').filter(Boolean);
    const poll = async () => {
      for (const id of ids) {
        try {
          const updated = await api.getBrollJob(projectId, id);
          onJobUpdate(updated);
        } catch { /* ignore */ }
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobIds, projectId]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return;
    setGenerating(true);
    setGenError(null);
    try {
      const result = await api.generateBroll(projectId, {
        prompt:                    prompt.trim(),
        model,
        enhance,
        target_duration_sec:       markDuration,
        target_global_offset_sec:  mark.start,
      });
      const job = await api.getBrollJob(projectId, result.jobId);
      onNewJob(job);
      setPrompt('');
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }, [projectId, prompt, model, enhance, markDuration, mark.start, onNewJob]);

  const handleInsertExisting = useCallback(async () => {
    if (!selectedVideoId) return;
    setInserting(true);
    setInsertError(null);
    try {
      const section = await api.insertExistingBroll(projectId, {
        video_file_id:    selectedVideoId,
        global_offset_sec: mark.start,
        start_sec:        0,
        end_sec:          markDuration,
      });
      onInserted(section);
    } catch (err) {
      setInsertError(err instanceof Error ? err.message : 'Insert failed');
      setInserting(false);
    }
  }, [projectId, selectedVideoId, mark.start, markDuration, onInserted]);

  const readyVideos = videos.filter(v => v.hls_status === 'ready' || v.duration_sec != null);
  const visibleJobs = jobs.filter(j => !dismissedJobIds.has(j.id));

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-lg border border-border bg-card shadow-card">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2.5 shell-bg">
        <div className="min-w-0">
          <p className="text-xs font-semibold shell-text">B-roll</p>
          <p className="truncate font-mono text-[10px] text-cyan-500">
            {fmtSec(mark.start)} → {fmtSec(mark.end)} · {markDuration.toFixed(1)}s
          </p>
        </div>
        <button
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-lg shell-muted transition-colors shell-hover hover:text-[hsl(var(--shell-foreground))] focus-ring"
        >
          <X size={15} strokeWidth={1.9} aria-hidden />
        </button>
      </div>

      {/* Tab switcher */}
      <div className="flex shrink-0 border-b border-border bg-slate-50">
        {(['generate', 'existing'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex-1 py-2 text-[11px] font-semibold transition-colors focus-ring"
            style={{
              color: tab === t ? '#0891b2' : '#9ca3af',
              borderBottom: tab === t ? '2px solid #06b6d4' : '2px solid transparent',
            }}
          >
            {t === 'generate' ? 'Generate' : 'Use Existing'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 fine-scrollbar">
        {tab === 'generate' ? (
          <div className="rounded-lg border border-border bg-card p-3 shadow-sm-soft">
            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1">Prompt</label>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder="Describe the shot… e.g. aerial cityscape at sunset, slow pan"
                  rows={3}
                  maxLength={500}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-cyan-400/30 focus:border-cyan-400"
                />
                <p className="text-right text-[9px] text-muted-foreground mt-0.5">{prompt.length}/500</p>
              </div>

              <div className="rounded-lg border border-border bg-muted/35 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-foreground">Enhance prompt</p>
                    <p className="text-[9px] text-muted-foreground">Add camera motion, lighting, and style.</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enhance}
                    aria-label="Enhance prompt"
                    onClick={() => setEnhance(v => !v)}
                    className="relative w-9 h-5 rounded-full transition-colors shrink-0 focus-ring"
                    style={{ backgroundColor: enhance ? '#06b6d4' : '#d1d5db' }}
                  >
                    <span
                      className="absolute top-0.5 w-4 h-4 rounded-full bg-card shadow-sm transition-transform"
                      style={{ transform: enhance ? 'translateX(18px)' : 'translateX(2px)' }}
                    />
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">Model</label>
                <div className="grid grid-cols-1 gap-1.5 min-[360px]:grid-cols-3">
                  {(Object.keys(MODEL_LABELS) as Model[]).map(m => (
                    <button
                      key={m}
                      onClick={() => setModel(m)}
                      className="rounded-lg border px-2 py-2 text-center text-xs font-semibold transition-all focus-ring"
                      style={{
                        borderColor: model === m ? '#06b6d4' : '#e5e7eb',
                        backgroundColor: model === m ? '#ecfeff' : 'transparent',
                        color: model === m ? '#0e7490' : undefined,
                      }}
                    >
                      {MODEL_LABELS[m]}
                    </button>
                  ))}
                </div>
              </div>

              {model === 'veo' && markDuration > 8 && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                  <p className="text-[10px] text-amber-700 font-medium">
                    Veo max is 8s — generation will be capped.
                  </p>
                </div>
              )}

              {genError && (
                <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                  <p className="text-[10px] text-red-600">{genError}</p>
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={generating || !prompt.trim()}
                className="w-full h-9 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 focus-ring"
                style={{ background: 'linear-gradient(135deg,#06b6d4,#6366f1)' }}
              >
                {generating ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Queuing…
                  </span>
                ) : 'Generate'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Use existing video */}
            {readyVideos.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">No videos available yet.</p>
            ) : (
              <div className="space-y-2">
                {readyVideos.map(v => (
                  <button
                    key={v.id}
                    onClick={() => setSelectedVideoId(v.id)}
                    className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5 border transition-all text-left focus-ring"
                    style={{
                      borderColor: selectedVideoId === v.id ? '#06b6d4' : '#e5e7eb',
                      backgroundColor: selectedVideoId === v.id ? '#ecfeff' : 'transparent',
                    }}
                  >
                    <div
                      className="w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center"
                      style={{ borderColor: selectedVideoId === v.id ? '#06b6d4' : '#d1d5db' }}
                    >
                      {selectedVideoId === v.id && <div className="w-1.5 h-1.5 rounded-full bg-cyan-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground truncate">{v.filename}</p>
                      <p className="text-[9px] text-muted-foreground">
                        {v.duration_sec ? `${v.duration_sec.toFixed(1)}s` : ''}
                        {v.hls_status === 'ready' && <span className="ml-1 text-emerald-500">HLS ✓</span>}
                        {v.is_broll && <span className="ml-1 text-cyan-500">AI</span>}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {insertError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                <p className="text-[10px] text-red-600">{insertError}</p>
              </div>
            )}

            {selectedVideoId && (
              <div className="rounded-lg bg-cyan-50 border border-cyan-200 px-3 py-2">
                <p className="text-[10px] text-cyan-700">
                  Video will be trimmed / looped to fit the {markDuration.toFixed(1)}s mark.
                </p>
              </div>
            )}

            <button
              onClick={handleInsertExisting}
              disabled={inserting || !selectedVideoId}
              className="w-full h-9 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 focus-ring"
              style={{ background: 'linear-gradient(135deg,#06b6d4,#6366f1)' }}
            >
              {inserting ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Inserting…
                </span>
              ) : 'Insert'}
            </button>
          </>
        )}

        {/* Jobs list (active + recently completed) */}
        {visibleJobs.length > 0 && (
          <div className="pt-2 border-t border-border space-y-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Jobs</p>
            {visibleJobs.map(job => {
              const isActive = job.status !== 'ready' && job.status !== 'failed';
              const isDone   = job.status === 'ready';
              const isFailed = job.status === 'failed';
              return (
                <div
                  key={job.id}
                  className="rounded-lg border px-3 py-2.5 space-y-1.5"
                  style={{
                    borderColor: isDone ? '#6ee7b7' : isFailed ? '#fca5a5' : '#e5e7eb',
                    backgroundColor: isDone ? '#f0fdf4' : isFailed ? '#fef2f2' : 'transparent',
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[10px] font-medium text-foreground truncate flex-1">
                      {job.original_prompt}
                    </p>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-[9px] text-muted-foreground font-mono">
                        {MODEL_LABELS[job.model as Model] ?? job.model}
                      </span>
                      {(isDone || isFailed) && (
                        <button
                          onClick={() => setDismissedJobIds(prev => new Set([...prev, job.id]))}
                          className="w-4 h-4 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          title="Dismiss"
                        >
                          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
                            <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isActive && (
                      <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
                    )}
                    {isDone && (
                      <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                    )}
                    <p className="text-[9px] font-medium" style={{ color: isDone ? '#059669' : isFailed ? '#dc2626' : '#0891b2' }}>
                      {JOB_STATUS_LABEL[job.status] ?? job.status}
                    </p>
                    {isActive && (
                      <span className="text-[9px] text-muted-foreground ml-auto">{elapsed(job.created_at)}</span>
                    )}
                  </div>
                  {isDone && (
                    <p className="text-[9px] text-emerald-600">
                      Placed at {fmtSec(job.target_global_offset_sec)} on V2 track · switch to &quot;Use Existing&quot; to reuse
                    </p>
                  )}
                  {isFailed && job.error && (
                    <p className="text-[9px] text-red-500 truncate">{job.error}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
