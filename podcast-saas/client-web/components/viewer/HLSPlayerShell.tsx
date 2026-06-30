'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { PlayerConfig, PlayerSegment, SimulationOverlay } from './types';
import { useProjectPlayer } from './useProjectPlayer';
import { useCropOverlay } from './useCropOverlay';
import { VideoLayer } from './VideoLayer';
import { SimOverlayDynamic } from './SimOverlayDynamic';
import { ControlsBar, type CaptionStyle } from './ControlsBar';
import { ImageOverlay } from '../ImageOverlay';
import { AvatarCirclesOverlay } from './AvatarCirclesOverlay';
import { ChoiceOverlay } from './ChoiceOverlay';
import './viewer.css';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSize: 22,
  backgroundColor: '#000000',
  backgroundOpacity: 72,
  textOpacity: 100,
};

interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

type SegmentCaptionState = NonNullable<PlayerConfig['segments'][number]['captions']>;
type CaptionStatusResponse = {
  segments?: Array<SegmentCaptionState & { id: string }>;
};

function parseVttTime(raw: string): number {
  const parts = raw.trim().replace(',', '.').split(':');
  const seconds = Number(parts.pop() ?? 0);
  const minutes = Number(parts.pop() ?? 0);
  const hours = Number(parts.pop() ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function parseVtt(vtt: string): CaptionCue[] {
  return vtt
    .replace(/\r/g, '')
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => {
      const lines = block.split('\n').filter(Boolean);
      const timeIdx = lines.findIndex((line) => line.includes('-->'));
      if (timeIdx < 0) return [];
      const [startRaw, endRaw] = lines[timeIdx].split('-->').map((part) => part.trim().split(/\s+/)[0]);
      const text = lines.slice(timeIdx + 1).join('\n').replace(/<[^>]*>/g, '').trim();
      if (!text) return [];
      return [{ start: parseVttTime(startRaw), end: parseVttTime(endRaw), text }];
    });
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean;
  const int = parseInt(full, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function loadCaptionStyle(): CaptionStyle {
  if (typeof window === 'undefined') return DEFAULT_CAPTION_STYLE;
  try {
    return { ...DEFAULT_CAPTION_STYLE, ...JSON.parse(window.localStorage.getItem('viewerCaptionStyle') ?? '{}') };
  } catch {
    return DEFAULT_CAPTION_STYLE;
  }
}

interface Props {
  config: PlayerConfig;
  /** Fired when the project finishes all segments (playlist auto-advance). */
  onProjectComplete?: () => void;
  /** Auto-start playback on mount (playlist videos after the first). */
  autoStart?: boolean;
  /** Hide the top-left "Home" link (playlist viewer provides its own chrome). */
  hideHomeLink?: boolean;
  /** Extra controls that share the player's top-right chrome. */
  topRightControls?: ReactNode;
  /** Floating action that tracks the bottom-right player chrome. */
  bottomRightOverlay?: ReactNode;
  /** Reports whether the player chrome is visible, so wrappers can sync their overlays. */
  onControlsVisibleChange?: (visible: boolean) => void;
  /** Reports caption-settings-menu open state, so overlays (e.g. "Ask!") can hide. */
  onCaptionMenuOpenChange?: (open: boolean) => void;
  /** Branching: navigate to another project/playlist/external URL on a cross-destination choice. */
  onNavigate?: (dest: { type: 'project' | 'playlist' | 'external_url'; url?: string | null; token?: string | null }) => void;
}

export function HLSPlayerShell({
  config,
  onProjectComplete,
  autoStart,
  hideHomeLink,
  topRightControls,
  bottomRightOverlay,
  onControlsVisibleChange,
  onCaptionMenuOpenChange,
  onNavigate,
}: Props) {
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
  const [captionState, setCaptionState] = useState<Record<string, SegmentCaptionState>>(() =>
    Object.fromEntries(config.segments.map((seg) => [seg.id, seg.captions ?? { status: 'none' as const, vtt_url: null }])),
  );
  const [captionCues, setCaptionCues] = useState<Record<string, CaptionCue[]>>({});
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(loadCaptionStyle);

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
  }, { onProjectComplete, autoStart, onNavigate });

  // Smart portrait crop — no-op in landscape, follows the active speaker in portrait.
  // Disabled in branching mode: flat segment indices don't map onto per-sequence timelines.
  useCropOverlay(
    { videoA: videoARef, videoB: videoBRef, root: rootRef },
    config.branching ? [] : config.segments,
    state.currentSegIdx,
  );

  // Scrub-bar markers are positioned off the *live* timeline (state.timeline) and matched
  // to segments by id — correct both for linear projects (timeline === flat segments) and
  // branching projects (timeline === the currently-playing sequence). Matching by id (not
  // by config.segments index) is why sim markers now appear in branching mode and stay put
  // as segment durations sync to the real video metadata.
  const segmentById = new Map<string, PlayerSegment>();
  config.segments.forEach((seg) => segmentById.set(seg.id, seg));
  config.branching?.sequences.forEach((seq) => seq.segments.forEach((seg) => segmentById.set(seg.id, seg)));

  const allMarkers = state.timeline.flatMap((tseg) => {
    const seg = segmentById.get(tseg.id);
    if (!seg) return [];
    return seg.simulations.map((s): SimulationOverlay & { globalStart: number; globalEnd: number } => ({
      ...s,
      globalStart: tseg.offset + s.start_sec,
      globalEnd:   tseg.offset + s.end_sec,
    }));
  });

  const simMarkers   = allMarkers.filter((s) => s.type === 'simulation');
  const videoMarkers = allMarkers.filter((s) => s.type !== 'simulation');

  // B-roll markers — AI b-roll clips (track 'broll') and trimmed library clip overlays are
  // never part of seg.simulations, so they previously had no scrub-bar marker at all. They
  // carry absolute global offsets on the flat timeline, so they're shown only in linear mode
  // (branching disables flat overlays in the player). Dedupe against sections that already
  // render as a marker (a clip overlay placed on the main track is also a seg.simulation).
  const markedIds = new Set(allMarkers.map((m) => m.id));
  const brollMarkers = config.branching ? [] : [
    ...(config.broll_clips ?? []),
    ...(config.clip_overlays ?? []),
  ]
    .filter((b) => !markedIds.has(b.id))
    .map((b) => ({
      id:          b.id,
      globalStart: b.global_offset_sec,
      globalEnd:   b.global_offset_sec + Math.max(0, b.end_sec - b.start_sec),
    }));
  // Look up by id so captions stay aligned in branching mode (currentSegIdx is per-sequence).
  const activeSegment = config.segments.find((s) => s.id === state.activeSegmentId) ?? config.segments[state.currentSegIdx];
  const activeCaptionState = activeSegment ? captionState[activeSegment.id] : undefined;
  const captionStatus = activeCaptionState?.status ?? 'none';
  const captionsAvailable = captionStatus === 'ready' && !!activeCaptionState?.vtt_url;
  const activeLocalTime = Math.max(0, state.globalTime - (state.timeline[state.currentSegIdx]?.offset ?? 0));
  const activeCaptionText = captionsEnabled && activeSegment
    ? (captionCues[activeSegment.id] ?? []).find((cue) => activeLocalTime >= cue.start && activeLocalTime <= cue.end)?.text ?? ''
    : '';

  useEffect(() => {
    setCaptionState(Object.fromEntries(config.segments.map((seg) => [seg.id, seg.captions ?? { status: 'none' as const, vtt_url: null }])));
    setCaptionCues({});
    setCaptionsEnabled(false);
  }, [config.project_id, config.segments]);

  useEffect(() => {
    window.localStorage.setItem('viewerCaptionStyle', JSON.stringify(captionStyle));
  }, [captionStyle]);

  useEffect(() => {
    const urls = Object.entries(captionState)
      .filter(([, captions]) => captions.status === 'ready' && captions.vtt_url)
      .map(([segmentId, captions]) => [segmentId, captions.vtt_url!] as const)
      .filter(([segmentId]) => !captionCues[segmentId]);
    if (urls.length === 0) return;

    let cancelled = false;
    Promise.all(urls.map(async ([segmentId, url]) => {
      const res = await fetch(url);
      if (!res.ok) return [segmentId, []] as const;
      return [segmentId, parseVtt(await res.text())] as const;
    })).then((items) => {
      if (cancelled) return;
      setCaptionCues((current) => ({ ...current, ...Object.fromEntries(items) }));
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [captionState, captionCues]);

  useEffect(() => {
    const shouldPoll = Object.values(captionState).some((captions) => captions.status === 'none' || captions.status === 'processing');
    if (!shouldPoll || !config.project_id) return;

    let cancelled = false;
    const poll = async () => {
      const res = await fetch(`${API_URL}/api/v1/projects/${config.project_id}/captions`).catch(() => null);
      if (!res?.ok) return;
      const json = (await res.json()) as CaptionStatusResponse;
      const segments = json.segments;
      if (cancelled || !segments) return;
      setCaptionState((current) => {
        // Only produce a new object when something actually changed — otherwise
        // returning `current` lets React bail out, so the 8s poll interval and the
        // VTT-fetch effect don't tear down/rebuild on every identical poll
        // (review frontend-001/007).
        const changed = segments.some((seg) => {
          const prev = current[seg.id];
          return !prev || prev.status !== seg.status || prev.vtt_url !== seg.vtt_url || (prev.error ?? null) !== (seg.error ?? null);
        });
        if (!changed) return current;
        return {
          ...current,
          ...Object.fromEntries(segments.map((seg) => [seg.id, { status: seg.status, vtt_url: seg.vtt_url, error: seg.error ?? null }])),
        };
      });
    };
    poll();
    const interval = setInterval(poll, 8000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [captionState, config.project_id]);

  const updateCaptionStyle = (style: CaptionStyle) => setCaptionStyle(style);
  const [captionBgR, captionBgG, captionBgB] = hexToRgb(captionStyle.backgroundColor);

  useEffect(() => {
    onControlsVisibleChange?.(state.controlsVisible);
  }, [onControlsVisibleChange, state.controlsVisible]);

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

      {config.thumbnail_url && !state.started && (
        <img
          src={config.thumbnail_url}
          alt=""
          draggable={false}
          className="absolute inset-0 z-[24] h-full w-full bg-black object-contain"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}

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

      {/* Avatar circles — speaker circles shown in the corners during b-roll */}
      <AvatarCirclesOverlay
        config={config.avatar_circles}
        visible={state.showBrollOverlay || !!state.activeImageOverlay}
        videoARef={videoARef}
        videoBRef={videoBRef}
        globalTime={state.globalTime}
        speakerTimeline={config.speaker_timeline}
        controlsVisible={state.controlsVisible}
        avoidAskButton={!!bottomRightOverlay}
      />

      {/* Home button — appears on hover over top-left corner */}
      {!hideHomeLink && (
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
      )}

      {/* Animated still-image overlay */}
      {state.activeImageOverlay && (
        <ImageOverlay
          zIndex={9}
          data={{
            image: {
              id: state.activeImageOverlay.id,
              project_id: '',
              filename: state.activeImageOverlay.label ?? '',
              storage_key: '',
              original_url: state.activeImageOverlay.image_url,
              width: null,
              height: null,
              crop_x: state.activeImageOverlay.crop_x,
              crop_y: state.activeImageOverlay.crop_y,
              crop_w: state.activeImageOverlay.crop_w,
              crop_h: state.activeImageOverlay.crop_h,
              created_at: '',
            },
            durationSec: state.activeImageOverlay.duration_sec,
            cameraMovement: state.activeImageOverlay.camera_movement,
            visible: true,
          }}
        />
      )}

      <SimOverlayDynamic
        simulationUrl={state.activeSimUrl}
        visible={state.showSimOverlay}
        iframeRef={simFrameRef}
      />

      {state.guidanceCaption && (
        <div className="guidance-caption">{state.guidanceCaption}</div>
      )}

      {activeCaptionText && (
        <div className="viewer-caption-overlay">
          <span
            className="viewer-caption-text"
            style={{
              fontSize: captionStyle.fontSize,
              backgroundColor: `rgba(${captionBgR}, ${captionBgG}, ${captionBgB}, ${captionStyle.backgroundOpacity / 100})`,
              color: `rgba(255, 255, 255, ${captionStyle.textOpacity / 100})`,
            }}
          >
            {activeCaptionText}
          </span>
        </div>
      )}

      {bottomRightOverlay && (
        <div className="viewer-bottom-right-overlay">
          {bottomRightOverlay}
        </div>
      )}

      {(state.showResumeBtn || topRightControls) && (
        <div className={`viewer-top-controls ${state.showResumeBtn ? 'viewer-top-controls--resume' : ''}`}>
          {state.showResumeBtn && (
            <button className="viewer-top-btn viewer-top-btn--primary" onClick={actions.resumeFromSim}>
              {state.resumeAction === 'backToVideo' ? 'Go back to video' : 'Resume video →'}
            </button>
          )}
          {topRightControls}
        </div>
      )}

      {!state.started && (
        <div
          className="absolute inset-0 z-[25] flex items-center justify-center cursor-pointer"
          role="button"
          tabIndex={0}
          aria-label="Play video"
          onClick={actions.startPlayback}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actions.startPlayback(); } }}
        >
          <div className="w-20 h-20 bg-white/20 hover:bg-white/30 transition-colors rounded-full flex items-center justify-center backdrop-blur-sm">
            <svg className="w-10 h-10 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {state.activeChoice && (
        <ChoiceOverlay
          choice={state.activeChoice}
          countdown={state.choiceCountdown}
          canGoBack={state.canGoBack}
          onSelect={actions.selectEdge}
          onBack={actions.goBack}
        />
      )}

      <div
        ref={tapFeedbackRef}
        className="absolute inset-0 z-10 pointer-events-none"
        style={{ opacity: 0, transition: 'opacity 0.3s' }}
      />

      {/* Sim hover zone — the sim iframe captures the mouse, so the root mousemove that
          normally reveals the controls never fires over it. While a sim overlay is up, this
          bottom strip catches hover to bring the controls bar back (YouTube-style). It's
          click-through (pointer-events:none) once the bar is already visible, so it never
          blocks the bar's own controls. */}
      {state.showSimOverlay && (
        <div
          className="viewer-sim-hover-zone"
          style={{ pointerEvents: state.controlsVisible ? 'none' : 'auto' }}
          onMouseEnter={actions.revealControls}
          onMouseMove={actions.revealControls}
        />
      )}

      <ControlsBar
        playing={state.playing}
        started={state.started}
        timeline={state.timeline}
        totalDuration={state.totalDuration}
        simMarkers={simMarkers}
        videoMarkers={videoMarkers}
        brollMarkers={brollMarkers}
        progressFillRef={progressFill}
        progressThumbRef={progressThumb}
        progressBufRef={progressBuf}
        progressTrackRef={progressTrack}
        progressWrapRef={progressWrap}
        curTimeRef={curTime}
        totTimeRef={totTime}
        onTogglePlay={actions.togglePlay}
        volume={state.volume}
        muted={state.muted}
        onVolumeChange={actions.setVolume}
        onToggleMute={actions.toggleMute}
        captionsAvailable={captionsAvailable}
        captionsEnabled={captionsEnabled}
        captionStatus={captionStatus}
        captionStyle={captionStyle}
        onToggleCaptions={() => { if (captionsAvailable) setCaptionsEnabled((enabled) => !enabled); }}
        onCaptionStyleChange={updateCaptionStyle}
        onCaptionMenuOpenChange={onCaptionMenuOpenChange}
      />
    </div>
  );
}
