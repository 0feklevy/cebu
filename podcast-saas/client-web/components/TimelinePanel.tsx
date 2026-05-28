'use client';

import { useRef, useState, useCallback } from 'react';
import type { VideoFile, TimelineSection } from 'shared/src/generated/client-v1';
import { SectionEditor } from './SectionEditor';
import { api } from '../lib/api';

const TYPE_COLORS: Record<string, string> = {
  video: 'bg-blue-500/70 border-blue-500',
  simulation: 'bg-amber-500/70 border-amber-500',
  intro: 'bg-emerald-500/70 border-emerald-500',
  outro: 'bg-violet-500/70 border-violet-500',
  cut: 'bg-red-500/70 border-red-500',
  custom: 'bg-gray-400/70 border-gray-400',
};

const TRACK_HEIGHT = 52;
const MIN_PIXELS_PX = 4;

interface DragState {
  videoId: string;
  startSec: number;
  curSec: number;
  trackWidth: number;
  duration: number;
}

interface Props {
  projectId: string;
  videos: VideoFile[];
  sections: TimelineSection[];
  playheadSec: number;
  activeVideoId: string | null;
  onSeek: (sec: number, videoId: string) => void;
  onSelectVideo: (v: VideoFile) => void;
  onSectionsChange: (sections: TimelineSection[]) => void;
}

export function TimelinePanel({
  projectId,
  videos,
  sections,
  playheadSec,
  activeVideoId,
  onSeek,
  onSelectVideo,
  onSectionsChange,
}: Props) {
  const trackRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selectedSection, setSelectedSection] = useState<TimelineSection | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null);

  const maxDuration = Math.max(...videos.map((v) => v.duration_sec ?? 60), 60);

  const secToPercent = (sec: number, duration: number) => (sec / duration) * 100;

  const pixelsToSec = useCallback((pixels: number, trackWidth: number, duration: number) => {
    return (pixels / trackWidth) * duration;
  }, []);

  const handleTrackMouseDown = (e: React.MouseEvent, video: VideoFile) => {
    if (e.button !== 0) return;
    const track = trackRefs.current.get(video.id);
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const startSec = pixelsToSec(e.clientX - rect.left, rect.width, video.duration_sec ?? maxDuration);
    setDrag({ videoId: video.id, startSec, curSec: startSec, trackWidth: rect.width, duration: video.duration_sec ?? maxDuration });
    setSelectedSection(null);
    e.preventDefault();
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!drag) return;
    const track = trackRefs.current.get(drag.videoId);
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const curSec = Math.max(0, Math.min(drag.duration, pixelsToSec(e.clientX - rect.left, rect.width, drag.duration)));
    setDrag((d) => d ? { ...d, curSec } : d);
  }, [drag, pixelsToSec]);

  const handleMouseUp = useCallback(async () => {
    if (!drag) return;
    const start_sec = Math.min(drag.startSec, drag.curSec);
    const end_sec = Math.max(drag.startSec, drag.curSec);
    const minDuration = pixelsToSec(MIN_PIXELS_PX, drag.trackWidth, drag.duration);
    if (end_sec - start_sec < minDuration) {
      setDrag(null);
      return;
    }
    try {
      const section = await api.createSection(projectId, {
        video_file_id: drag.videoId,
        start_sec,
        end_sec,
        type: 'video',
      });
      onSectionsChange([...sections, section]);
      setSelectedSection(section);
    } catch { /* ignore */ }
    setDrag(null);
  }, [drag, projectId, sections, onSectionsChange, pixelsToSec]);

  // Attach global mouse events for drag
  const isDragging = useRef(false);
  if (drag && !isDragging.current) {
    isDragging.current = true;
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', handleMouseMove);
      handleMouseUp();
    }, { once: true });
  }

  const handleSectionClick = (e: React.MouseEvent, section: TimelineSection) => {
    e.stopPropagation();
    setSelectedSection(section);
    setPopoverPos({ x: e.clientX, y: e.clientY });
  };

  const handleTrackClick = (e: React.MouseEvent, video: VideoFile) => {
    const track = trackRefs.current.get(video.id);
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const sec = pixelsToSec(e.clientX - rect.left, rect.width, video.duration_sec ?? maxDuration);
    onSeek(sec, video.id);
    onSelectVideo(video);
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-full bg-card border-t border-border overflow-hidden">
      {/* Time ruler */}
      <div className="shrink-0 h-6 border-b border-border bg-muted/30 relative overflow-hidden">
        <div className="absolute inset-0 flex items-center">
          {Array.from({ length: Math.ceil(maxDuration / 10) + 1 }).map((_, i) => (
            <div
              key={i}
              className="absolute top-0 bottom-0 border-l border-border/50 flex items-end pb-0.5 pl-1"
              style={{ left: `${(i * 10 / maxDuration) * 100}%` }}
            >
              <span className="text-[9px] text-muted-foreground font-mono">{fmt(i * 10)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Tracks */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {videos.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            Upload videos to see them here
          </div>
        ) : (
          videos.map((video) => {
            const duration = video.duration_sec ?? maxDuration;
            const videoSections = sections.filter((s) => s.video_file_id === video.id);
            const isActive = activeVideoId === video.id;
            const playheadLeft = isActive ? `${(playheadSec / duration) * 100}%` : null;

            const dragLeft = drag?.videoId === video.id
              ? `${secToPercent(Math.min(drag.startSec, drag.curSec), duration)}%`
              : null;
            const dragWidth = drag?.videoId === video.id
              ? `${secToPercent(Math.abs(drag.curSec - drag.startSec), duration)}%`
              : null;

            return (
              <div
                key={video.id}
                className={`flex border-b border-border ${isActive ? 'bg-primary/3' : 'bg-background'}`}
                style={{ height: TRACK_HEIGHT }}
              >
                {/* Label */}
                <div
                  className="shrink-0 w-32 px-2 flex flex-col justify-center border-r border-border cursor-pointer hover:bg-muted/40 transition-colors"
                  onClick={() => onSelectVideo(video)}
                >
                  <p className="text-[10px] font-medium text-foreground truncate">{video.filename}</p>
                  {video.duration_sec && (
                    <p className="text-[9px] text-muted-foreground">{fmt(video.duration_sec)}</p>
                  )}
                </div>

                {/* Track area */}
                <div
                  ref={(el) => { if (el) trackRefs.current.set(video.id, el); }}
                  className="flex-1 relative cursor-crosshair select-none"
                  onMouseDown={(e) => handleTrackMouseDown(e, video)}
                  onClick={(e) => handleTrackClick(e, video)}
                >
                  {/* Sections */}
                  {videoSections.map((s) => (
                    <div
                      key={s.id}
                      className={`absolute top-2 bottom-2 rounded border opacity-80 hover:opacity-100 cursor-pointer transition-opacity flex items-center px-1 overflow-hidden ${TYPE_COLORS[s.type] ?? 'bg-gray-400/70 border-gray-400'} ${selectedSection?.id === s.id ? 'ring-2 ring-white' : ''}`}
                      style={{
                        left: `${secToPercent(s.start_sec, duration)}%`,
                        width: `${secToPercent(s.end_sec - s.start_sec, duration)}%`,
                      }}
                      onClick={(e) => handleSectionClick(e, s)}
                    >
                      {s.label && (
                        <span className="text-[9px] text-white font-medium truncate">{s.label}</span>
                      )}
                    </div>
                  ))}

                  {/* Drag preview */}
                  {dragLeft && dragWidth && (
                    <div
                      className="absolute top-2 bottom-2 rounded border bg-primary/40 border-primary pointer-events-none"
                      style={{ left: dragLeft, width: dragWidth }}
                    />
                  )}

                  {/* Playhead */}
                  {playheadLeft && (
                    <div
                      className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none z-10"
                      style={{ left: playheadLeft }}
                    />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Section editor popover */}
      {selectedSection && popoverPos && (
        <div
          className="fixed z-50"
          style={{ left: Math.min(popoverPos.x, window.innerWidth - 310), top: Math.min(popoverPos.y - 20, window.innerHeight - 420) }}
        >
          <SectionEditor
            section={selectedSection}
            projectId={projectId}
            onUpdate={(updated) => {
              onSectionsChange(sections.map((s) => (s.id === updated.id ? updated : s)));
              setSelectedSection(updated);
            }}
            onDelete={(id) => {
              onSectionsChange(sections.filter((s) => s.id !== id));
              setSelectedSection(null);
              setPopoverPos(null);
            }}
            onClose={() => { setSelectedSection(null); setPopoverPos(null); }}
          />
        </div>
      )}
    </div>
  );
}
