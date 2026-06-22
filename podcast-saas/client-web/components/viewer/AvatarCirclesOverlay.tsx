'use client';

// Audio-reactive avatar circles shown in the bottom corners while a b-roll covers
// the main video. A shared Web Audio AnalyserNode taps the main <video> audio
// (volume-preserving — see avatarAudioGraph). The circle whose speaker is active
// (from the script timeline) animates at full level; the other is damped. When
// the audio graph can't be tapped, bars fall back to a gentle idle motion.

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { AvatarCirclesConfig, AvatarCircleFace } from './types';
import { activeSpeakerAt, type SpeakerSpan } from '../../lib/avatarCirclesViz';
import { ensureAvatarAnalyser, syncAvatarGains } from '../../lib/avatarAudioGraph';
import { AvatarCircleViz, type CircleFrame } from './AvatarCircleViz';

function facesFor(cfg: AvatarCirclesConfig): AvatarCircleFace[] {
  const all = cfg.faces ?? [];
  const left = all.find((f) => f.side === 'left') ?? { speaker: 'host_a', side: 'left' };
  const right = all.find((f) => f.side === 'right') ?? { speaker: 'host_b', side: 'right' };
  return cfg.count === 1 ? [left] : [left, right];
}

interface Props {
  config: AvatarCirclesConfig | null | undefined;
  visible: boolean;
  videoARef?: RefObject<HTMLVideoElement | null>;
  videoBRef?: RefObject<HTMLVideoElement | null>;
  globalTime?: number;
  speakerTimeline?: SpeakerSpan[];
  controlsVisible?: boolean;
  avoidAskButton?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function askClearancePx(viewport: { width: number; height: number }, controlsVisible: boolean): number {
  if (viewport.height > 0 && viewport.height <= 420) return controlsVisible ? 92 : 58;
  if (viewport.width > 0 && viewport.width <= 520) return controlsVisible ? 114 : 64;
  return controlsVisible ? 130 : 70;
}

export function AvatarCirclesOverlay({
  config,
  visible,
  videoARef,
  videoBRef,
  globalTime = 0,
  speakerTimeline,
  controlsVisible = false,
  avoidAskButton = false,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef(globalTime); timeRef.current = globalTime;
  const visibleRef = useRef(visible);
  const freqRef = useRef(new Uint8Array(512));
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setViewport({ width: rect.width, height: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, [config?.enabled, config?.visibility]);

  if (!config?.enabled) return null;
  // Visibility mode: 'broll' = only while a b-roll/image overlay covers the main
  // video (the parent-supplied `visible`); 'always' = whenever enabled; 'none' = off.
  // Defaults to 'broll' for configs saved before this option existed.
  const mode = config.visibility ?? 'broll';
  if (mode === 'none') return null;
  const effectiveVisible = mode === 'always' ? true : visible;
  visibleRef.current = effectiveVisible;

  const faces = facesFor(config);  // render configured circles even before a face image is set

  const width = viewport.width || 1280;
  const height = viewport.height || 720;
  const shortSide = Math.min(width, height);
  const isPhoneSized = width <= 520 || height <= 430;
  const isShortPhone = height <= 430;
  const baseSize = clamp(config.circleSize ?? 128, 36, 220);
  const responsiveCap = isShortPhone ? shortSide * 0.16 : isPhoneSized ? shortSide * 0.18 : 220;
  const size = Math.round(clamp(Math.min(baseSize, responsiveCap), 36, 220));
  const frame = Math.round(size * 2.3);
  const opacity = clamp(config.circleOpacity ?? 1, 0, 1);
  const sideInsetPx = (width * clamp(config.circleSideInsetPct ?? 3, 0, 45)) / 100;
  const bottomBasePx = (height * clamp(config.circleBottomPct ?? 4, 0, 70)) / 100;
  const gapPx = clamp((height * clamp(config.circleGapPct ?? 4, 0, 20)) / 100, 8, 30);
  const stackRight = config.circleLayout === 'right-stack' || (faces.length > 1 && isPhoneSized);
  const askClearPx = avoidAskButton ? askClearancePx(viewport, controlsVisible) : 0;

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0" style={{ zIndex: 12, opacity: effectiveVisible ? opacity : 0, transition: 'opacity 0.3s ease' }} aria-hidden>
      {faces.map((f, index) => {
        const getFrame = (): CircleFrame => {
          const running = visibleRef.current;
          if (!running) return { spectrum: null, level: 0, running: false };
          const els = [videoARef?.current, videoBRef?.current].filter(Boolean) as HTMLMediaElement[];
          const analyser = ensureAvatarAnalyser(els);
          let spectrum: Uint8Array | null = null;
          if (analyser) {
            syncAvatarGains();
            analyser.getByteFrequencyData(freqRef.current);
            spectrum = freqRef.current;
          }
          const speaking = activeSpeakerAt(speakerTimeline, timeRef.current ?? 0);
          const level = speaking == null ? 1 : (speaking === f.speaker ? 1 : 0.22);
          return { spectrum, level, running: true };
        };

        const shouldAvoidAsk = avoidAskButton && (stackRight || (faces.length > 1 && f.side === 'right'));
        const bottom = Math.max(bottomBasePx, shouldAvoidAsk ? askClearPx : 0) + (stackRight ? index * (frame + gapPx) : 0);
        const positionStyle: React.CSSProperties = stackRight
          ? { right: sideInsetPx }
          : f.side === 'left'
            ? { left: sideInsetPx }
            : { right: sideInsetPx };

        return (
          <div key={f.side} style={{ position: 'absolute', bottom, width: frame, height: frame, ...positionStyle }}>
            <AvatarCircleViz config={config} face={f} size={size} frame={frame} getFrame={getFrame} />
          </div>
        );
      })}
    </div>
  );
}
