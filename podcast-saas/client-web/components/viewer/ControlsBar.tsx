'use client';

import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { SimulationOverlay, TimelineSeg } from './types';

type MarkerWithGlobal = SimulationOverlay & { globalStart: number; globalEnd: number };
type BrollMarker = { id: string; globalStart: number; globalEnd: number };

interface Props {
  playing: boolean;
  started: boolean;
  timeline: TimelineSeg[];
  totalDuration: number;
  simMarkers: MarkerWithGlobal[];
  videoMarkers: MarkerWithGlobal[];
  brollMarkers: BrollMarker[];
  progressFillRef:  RefObject<HTMLDivElement | null>;
  progressThumbRef: RefObject<HTMLDivElement | null>;
  progressBufRef:   RefObject<HTMLDivElement | null>;
  progressTrackRef: RefObject<HTMLDivElement | null>;
  progressWrapRef:  RefObject<HTMLDivElement | null>;
  curTimeRef:       RefObject<HTMLSpanElement | null>;
  totTimeRef:       RefObject<HTMLSpanElement | null>;
  onTogglePlay: () => void;
  volume: number;
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  captionsAvailable: boolean;
  captionsEnabled: boolean;
  captionStatus: 'none' | 'processing' | 'ready' | 'failed';
  captionStyle: CaptionStyle;
  onToggleCaptions: () => void;
  onCaptionStyleChange: (style: CaptionStyle) => void;
  /** Notifies when the caption-settings menu opens/closes (so overlays like the
   *  "Ask!" button can hide and not overlap it). */
  onCaptionMenuOpenChange?: (open: boolean) => void;
}

export interface CaptionStyle {
  fontSize: number;
  backgroundColor: string;
  backgroundOpacity: number;
  textOpacity: number;
}

export function ControlsBar({
  timeline,
  totalDuration,
  simMarkers,
  videoMarkers,
  brollMarkers,
  progressFillRef,
  progressThumbRef,
  progressBufRef,
  progressTrackRef,
  progressWrapRef,
  curTimeRef,
  totTimeRef,
  onTogglePlay,
  volume,
  muted,
  onVolumeChange,
  onToggleMute,
  captionsAvailable,
  captionsEnabled,
  captionStatus,
  captionStyle,
  onToggleCaptions,
  onCaptionStyleChange,
  onCaptionMenuOpenChange,
}: Props) {
  const tot = totalDuration || 1;
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [captionMenuOpen, setCaptionMenuOpen] = useState(false);
  useEffect(() => { onCaptionMenuOpenChange?.(captionMenuOpen); }, [captionMenuOpen, onCaptionMenuOpenChange]);
  const volumePct = Math.round(volume * 100);
  const captionDisabled = !captionsAvailable;

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

          {/* B-roll markers — AI b-roll & clip overlays, teal band */}
          <div className="viewer-seg-markers">
            {brollMarkers.map((s) => (
              <div
                key={s.id}
                className="viewer-seg-marker viewer-seg-marker--broll"
                style={{
                  left:  `${(s.globalStart / tot) * 100}%`,
                  width: `${((s.globalEnd - s.globalStart) / tot) * 100}%`,
                }}
              />
            ))}
          </div>

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
              />
            ))}
          </div>

          {/* Simulation markers */}
          <div className="viewer-seg-markers">
            {simMarkers.map((s) => (
              <div
                key={s.id}
                className="viewer-seg-marker"
                style={{
                  left:  `${(s.globalStart / tot) * 100}%`,
                  width: `${((s.globalEnd - s.globalStart) / tot) * 100}%`,
                }}
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

        <div className="viewer-volume-wrap" onMouseEnter={() => setVolumeOpen(true)} onMouseLeave={() => setVolumeOpen(false)}>
          <button
            className="viewer-ctrl-btn"
            onClick={onToggleMute}
            aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
            title={muted || volume === 0 ? 'Unmute' : 'Mute'}
          >
            {muted || volume === 0 ? (
              <svg className="viewer-icon" viewBox="0 0 24 24"><path d="M16 8.8v6.4L12.8 12 16 8.8ZM4 9v6h4l5 5V4L8 9H4Zm15.8 3 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4L17 12l-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4L19.8 12Z"/></svg>
            ) : volume < 0.5 ? (
              <svg className="viewer-icon" viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9H4Zm12.5 3c0-1.8-1-3.3-2.5-4.1v8.2c1.5-.8 2.5-2.3 2.5-4.1Z"/></svg>
            ) : (
              <svg className="viewer-icon" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3c0-1.8-1-3.3-2.5-4.1v8.2c1.5-.8 2.5-2.3 2.5-4.1Zm-2.5-9v2.1c3.4 1 5.8 3.8 5.8 6.9s-2.4 5.9-5.8 6.9V21c4.5-1.1 7.8-4.8 7.8-9S18.5 4.1 14 3Z"/></svg>
            )}
          </button>
          <div className={`viewer-volume-pop${volumeOpen ? ' is-open' : ''}`}>
            <input
              type="range"
              min={0}
              max={100}
              value={muted ? 0 : volumePct}
              aria-label="Volume"
              onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
            />
          </div>
        </div>

        <div className="viewer-caption-wrap">
          <button
            className={`viewer-cc-btn${captionsEnabled ? ' is-on' : ''}${captionStatus === 'processing' ? ' is-loading' : ''}`}
            onClick={onToggleCaptions}
            disabled={captionDisabled}
            aria-label="Closed captions"
            aria-pressed={captionsEnabled}
            title={captionStatus === 'processing' ? 'Captions processing' : captionDisabled ? 'Captions unavailable' : 'Closed captions'}
          >
            CC
          </button>
          <button
            className="viewer-ctrl-btn viewer-ctrl-btn--small"
            onClick={() => setCaptionMenuOpen((open) => !open)}
            disabled={captionDisabled}
            aria-label="Caption settings"
            title="Caption settings"
          >
            <svg className="viewer-icon viewer-icon--small" viewBox="0 0 24 24"><path d="M19.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-2.6-1.5L14 2h-4l-.4 2.9A7.6 7.6 0 0 0 7 6.4l-2.5-1-2 3.5 2.1 1.6c-.1.5-.1 1-.1 1.5s0 1 .1 1.5l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 2.6 1.5L10 22h4l.4-2.9a7.6 7.6 0 0 0 2.6-1.5l2.5 1 2-3.5-2.1-1.6ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>
          </button>
          {captionMenuOpen && !captionDisabled && (
            <div className="viewer-cc-menu">
              <label>
                <span>Font size</span>
                <select
                  value={captionStyle.fontSize}
                  onChange={(e) => onCaptionStyleChange({ ...captionStyle, fontSize: Number(e.target.value) })}
                >
                  <option value={18}>Small</option>
                  <option value={22}>Medium</option>
                  <option value={28}>Large</option>
                  <option value={34}>Extra large</option>
                </select>
              </label>
              <label>
                <span>Background</span>
                <select
                  value={captionStyle.backgroundColor}
                  onChange={(e) => onCaptionStyleChange({ ...captionStyle, backgroundColor: e.target.value })}
                >
                  <option value="#000000">Black</option>
                  <option value="#1f2937">Gray</option>
                  <option value="#ffffff">White</option>
                  <option value="#2563eb">Blue</option>
                </select>
              </label>
              <label>
                <span>Background opacity</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={captionStyle.backgroundOpacity}
                  onChange={(e) => onCaptionStyleChange({ ...captionStyle, backgroundOpacity: Number(e.target.value) })}
                />
              </label>
              <label>
                <span>Text opacity</span>
                <input
                  type="range"
                  min={35}
                  max={100}
                  value={captionStyle.textOpacity}
                  onChange={(e) => onCaptionStyleChange({ ...captionStyle, textOpacity: Number(e.target.value) })}
                />
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
