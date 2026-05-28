'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../lib/firebase';
import { api } from '../lib/api';
import { VideoPlayer } from './VideoPlayer';
import { TimelinePanel } from './TimelinePanel';
import { VideoUploader } from './VideoUploader';
import type { VideoFile, TimelineSection } from 'shared/src/generated/client-v1';

interface Props {
  projectId: string;
}

export function VideoEditor({ projectId }: Props) {
  const { loading: authLoading } = useAuth();
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [sections, setSections] = useState<TimelineSection[]>([]);
  const [activeVideo, setActiveVideo] = useState<VideoFile | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showUploader, setShowUploader] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [vids, secs] = await Promise.all([
        api.listVideos(projectId),
        api.listSections(projectId),
      ]);
      setVideos(vids);
      setSections(secs);
      if (vids.length > 0 && !activeVideo) setActiveVideo(vids[0]);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!authLoading) loadData();
  }, [authLoading, loadData]);

  const activeVideoSrc = activeVideo?.storage_key
    ? `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'}/local-storage/${activeVideo.storage_key}`
    : null;

  const activeSectionLabel = sections.find(
    (s) => s.video_file_id === activeVideo?.id && s.start_sec <= playheadSec && s.end_sec >= playheadSec,
  )?.label ?? null;

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted-foreground animate-pulse text-sm">Loading editor…</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Top toolbar */}
      <div className="shrink-0 border-b border-border bg-card/50 px-4 py-2 flex items-center gap-3">
        <button
          onClick={() => setShowUploader((v) => !v)}
          className="h-7 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors inline-flex items-center gap-1.5 shadow-sm"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          Add video
        </button>
        <span className="text-xs text-muted-foreground">
          {videos.length} video{videos.length !== 1 ? 's' : ''} · {sections.length} section{sections.length !== 1 ? 's' : ''}
        </span>
        <div className="flex-1" />
        {activeVideo && (
          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
            {activeVideo.filename}
          </span>
        )}
      </div>

      {/* Upload panel (collapsible) */}
      {showUploader && (
        <div className="shrink-0 border-b border-border bg-card/30 px-6 py-4">
          <VideoUploader
            projectId={projectId}
            onUploaded={() => { loadData(); setShowUploader(false); }}
          />
        </div>
      )}

      {/* Main split: player top, timeline bottom */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Player */}
        <div className="flex-1 flex min-h-0 p-4 gap-4">
          <VideoPlayer
            src={activeVideoSrc}
            currentTime={playheadSec}
            onTimeUpdate={setPlayheadSec}
            sectionLabel={activeSectionLabel}
          />

          {/* Right panel: video list */}
          <div className="w-56 shrink-0 flex flex-col gap-2 overflow-y-auto">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-1">Videos</p>
            {videos.length === 0 ? (
              <button
                onClick={() => setShowUploader(true)}
                className="text-xs text-primary hover:underline text-left px-1"
              >
                + Upload first video
              </button>
            ) : (
              videos.map((v) => (
                <button
                  key={v.id}
                  onClick={() => { setActiveVideo(v); setPlayheadSec(0); }}
                  className={`text-left px-3 py-2.5 rounded-xl border transition-all ${
                    activeVideo?.id === v.id
                      ? 'border-primary bg-primary/5 shadow-sm'
                      : 'border-border bg-card hover:border-primary/30'
                  }`}
                >
                  <p className="text-xs font-medium text-foreground truncate">{v.filename}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {v.duration_sec ? `${Math.floor(v.duration_sec / 60)}m ${Math.floor(v.duration_sec % 60)}s` : v.status}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Timeline */}
        <div className="shrink-0 h-52 border-t border-border">
          <TimelinePanel
            projectId={projectId}
            videos={videos}
            sections={sections}
            playheadSec={playheadSec}
            activeVideoId={activeVideo?.id ?? null}
            onSeek={(sec, videoId) => {
              setPlayheadSec(sec);
              const v = videos.find((vid) => vid.id === videoId);
              if (v) setActiveVideo(v);
            }}
            onSelectVideo={(v) => { setActiveVideo(v); }}
            onSectionsChange={setSections}
          />
        </div>
      </div>
    </div>
  );
}
