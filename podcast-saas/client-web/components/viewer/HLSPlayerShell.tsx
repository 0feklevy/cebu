'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import type { PlayerConfig, SimulationOverlay } from './types';
import { useProjectPlayer } from './useProjectPlayer';
import { VideoLayer } from './VideoLayer';
import { SimOverlayDynamic } from './SimOverlayDynamic';
import { ControlsBar } from './ControlsBar';
import './viewer.css';

interface Props {
  config: PlayerConfig;
}

export function HLSPlayerShell({ config }: Props) {
  const videoARef             = useRef<HTMLVideoElement>(null);
  const videoBRef             = useRef<HTMLVideoElement>(null);
  const videoBrollRef         = useRef<HTMLVideoElement>(null);
  const videoBrollStandbyRef  = useRef<HTMLVideoElement>(null);
  const tapFeedbackRef        = useRef<HTMLDivElement>(null);
  const [homeVisible, setHomeVisible] = useState(false);
  const progressFill   = useRef<HTMLDivElement>(null);
  const progressThumb  = useRef<HTMLDivElement>(null);
  const progressBuf    = useRef<HTMLDivElement>(null);
  const progressTrack  = useRef<HTMLDivElement>(null);
  const progressWrap   = useRef<HTMLDivElement>(null);
  const curTime        = useRef<HTMLSpanElement>(null);
  const totTime        = useRef<HTMLSpanElement>(null);
  const rootRef        = useRef<HTMLDivElement>(null);
  const simFrameRef    = useRef<HTMLIFrameElement>(null);

  const { state, actions } = useProjectPlayer(config, {
    videoA: videoARef,
    videoB: videoBRef,
    videoBroll: videoBrollRef,
    videoBrollStandby: videoBrollStandbyRef,
    tapFeedback: tapFeedbackRef,
    progressFill,
    progressThumb,
    progressBuf,
    progressTrack,
    progressWrap,
    curTime,
    totTime,
    root: rootRef,
    simFrame: simFrameRef,
  });

  const allMarkers = config.segments.flatMap((seg, idx) => {
    const offset = state.timeline[idx]?.offset ?? 0;
    return seg.simulations.map((s): SimulationOverlay & { globalStart: number; globalEnd: number } => ({
      ...s,
      globalStart: offset + s.start_sec,
      globalEnd:   offset + s.end_sec,
    }));
  });

  const simMarkers   = allMarkers.filter((s) => s.type === 'simulation');
  const videoMarkers = allMarkers.filter((s) => s.type !== 'simulation');

  const rootClass = [
    'viewer-root',
    'relative w-full h-full bg-black overflow-hidden select-none',
    state.playing         ? 'playing'          : '',
    state.controlsVisible ? 'controls-visible' : '',
  ].filter(Boolean).join(' ');

  return (
    <div ref={rootRef} className={rootClass}>
      <VideoLayer
        videoARef={videoARef}
        videoBRef={videoBRef}
        onClick={actions.handleVideoClick}
      />

      {/* Standby broll element — preloads next clip; hidden behind everything */}
      <video
        ref={videoBrollStandbyRef}
        className="absolute inset-0 w-full h-full object-contain bg-transparent pointer-events-none"
        style={{ zIndex: -1, opacity: 0 }}
        playsInline
        muted
        preload="auto"
      />

      {/* B-roll overlay — plays the AI-generated broll clip over the main video */}
      <video
        ref={videoBrollRef}
        className="absolute inset-0 w-full h-full object-contain bg-transparent pointer-events-none"
        style={{
          zIndex: 8,
          opacity: state.showBrollOverlay ? 1 : 0,
          transition: 'opacity 0.25s ease',
        }}
        playsInline
        muted
        preload="auto"
      />

      {/* Home button — appears on hover over top-left corner */}
      <div
        className="absolute top-0 left-0 z-30"
        style={{ width: 140, height: 80 }}
        onMouseEnter={() => setHomeVisible(true)}
        onMouseLeave={() => setHomeVisible(false)}
      >
        <Link
          href="/"
          className="absolute top-4 left-4 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white backdrop-blur-sm"
          style={{
            background: 'rgba(0,0,0,0.55)',
            opacity: homeVisible ? 1 : 0,
            transition: 'opacity 0.2s ease',
            pointerEvents: homeVisible ? 'auto' : 'none',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Home
        </Link>
      </div>

      <SimOverlayDynamic
        simulationUrl={state.activeSimUrl}
        visible={state.showSimOverlay}
        iframeRef={simFrameRef}
      />

      {state.showResumeBtn && (
        <button className="sim-resume-btn" onClick={actions.resumeFromSim}>
          {state.resumeAction === 'backToVideo' ? 'Go back to video' : 'Resume video →'}
        </button>
      )}

      {!state.started && (
        <div
          className="absolute inset-0 z-25 flex items-center justify-center cursor-pointer"
          onClick={actions.startPlayback}
        >
          <div className="w-20 h-20 bg-white/20 hover:bg-white/30 transition-colors rounded-full flex items-center justify-center backdrop-blur-sm">
            <svg className="w-10 h-10 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      <div
        ref={tapFeedbackRef}
        className="absolute inset-0 z-10 pointer-events-none"
        style={{ opacity: 0, transition: 'opacity 0.3s' }}
      />

      <ControlsBar
        playing={state.playing}
        started={state.started}
        timeline={state.timeline}
        totalDuration={state.totalDuration}
        simMarkers={simMarkers}
        videoMarkers={videoMarkers}
        badgeText={state.badgeText}
        badgeMode={state.badgeMode}
        progressFillRef={progressFill}
        progressThumbRef={progressThumb}
        progressBufRef={progressBuf}
        progressTrackRef={progressTrack}
        progressWrapRef={progressWrap}
        curTimeRef={curTime}
        totTimeRef={totTime}
        onTogglePlay={actions.togglePlay}
      />
    </div>
  );
}
