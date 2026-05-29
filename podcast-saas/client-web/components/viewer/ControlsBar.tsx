'use client';

import type { RefObject } from 'react';
import type { SimulationOverlay, TimelineSeg } from './types';

type MarkerWithGlobal = SimulationOverlay & { globalStart: number; globalEnd: number };

interface Props {
  playing: boolean;
  started: boolean;
  timeline: TimelineSeg[];
  totalDuration: number;
  simMarkers: MarkerWithGlobal[];
  videoMarkers: MarkerWithGlobal[];
  badgeText: string;
  badgeMode: 'sim' | 'free' | '';
  progressFillRef:  RefObject<HTMLDivElement | null>;
  progressThumbRef: RefObject<HTMLDivElement | null>;
  progressBufRef:   RefObject<HTMLDivElement | null>;
  progressTrackRef: RefObject<HTMLDivElement | null>;
  progressWrapRef:  RefObject<HTMLDivElement | null>;
  curTimeRef:       RefObject<HTMLSpanElement | null>;
  totTimeRef:       RefObject<HTMLSpanElement | null>;
  onTogglePlay: () => void;
}

export function ControlsBar({
  timeline,
  totalDuration,
  simMarkers,
  videoMarkers,
  badgeText,
  badgeMode,
  progressFillRef,
  progressThumbRef,
  progressBufRef,
  progressTrackRef,
  progressWrapRef,
  curTimeRef,
  totTimeRef,
  onTogglePlay,
}: Props) {
  const tot = totalDuration || 1;

  return (
    <div className="viewer-controls-bar">
      {/* Progress wrap */}
      <div
        ref={progressWrapRef}
        className="viewer-progress-wrap"
        role="slider"
        aria-label="Video progress"
      >
        <div ref={progressTrackRef} className="viewer-progress-track">
          <div ref={progressBufRef}  className="viewer-progress-buf" />
          <div ref={progressFillRef} className="viewer-progress-fill" />

          {/* Video-type section markers — subtle white, same protrude style */}
          <div className="viewer-seg-markers">
            {videoMarkers.map((s) => (
              <div
                key={s.id}
                className="viewer-seg-marker viewer-seg-marker--video"
                style={{
                  left:  `${(s.globalStart / tot) * 100}%`,
                  width: `${((s.globalEnd - s.globalStart) / tot) * 100}%`,
                }}
                title={s.label ?? s.type}
              />
            ))}
          </div>

          {/* Simulation markers — blue protrude (reference style) */}
          <div className="viewer-seg-markers">
            {simMarkers.map((s) => (
              <div
                key={s.id}
                className="viewer-seg-marker"
                style={{
                  left:  `${(s.globalStart / tot) * 100}%`,
                  width: `${((s.globalEnd - s.globalStart) / tot) * 100}%`,
                }}
                title={s.label ?? 'Simulation'}
              />
            ))}
          </div>

          {/* Clip-transition dividers — white, stick out above/below */}
          <div className="viewer-timeline-dividers">
            {timeline.slice(1).map((seg) => (
              <div
                key={seg.id}
                className="viewer-timeline-divider"
                style={{ left: `${(seg.offset / tot) * 100}%` }}
              />
            ))}
          </div>

          <div ref={progressThumbRef} className="viewer-progress-thumb" />
        </div>
      </div>

      {/* Bottom control row */}
      <div className="viewer-ctrl-row">
        <button
          className="viewer-ctrl-btn"
          onClick={onTogglePlay}
          aria-label="Play or pause"
        >
          <svg className="viewer-icon viewer-icon-play"  viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          <svg className="viewer-icon viewer-icon-pause" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>

        <span className="viewer-time-display">
          <span ref={curTimeRef}>0:00</span>
          <span className="viewer-t-sep">/</span>
          <span ref={totTimeRef}>–:––</span>
        </span>

        <div className="viewer-spacer" />

        {badgeText && (
          <span className={`viewer-mode-badge${badgeMode ? ` ${badgeMode}` : ''}`}>
            {badgeText}
          </span>
        )}
      </div>
    </div>
  );
}
