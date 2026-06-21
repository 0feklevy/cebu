'use client';

// Audio-reactive avatar circles shown in the bottom corners while a b-roll covers
// the main video. A shared Web Audio AnalyserNode taps the main <video> audio
// (volume-preserving — see avatarAudioGraph). The circle whose speaker is active
// (from the script timeline) animates at full level; the other is damped. When
// the audio graph can't be tapped, bars fall back to a gentle idle motion.

import { useRef } from 'react';
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
}

export function AvatarCirclesOverlay({ config, visible, videoARef, videoBRef, globalTime = 0, speakerTimeline }: Props) {
  const timeRef = useRef(globalTime); timeRef.current = globalTime;
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const freqRef = useRef(new Uint8Array(512));

  if (!config?.enabled) return null;
  const faces = facesFor(config);  // render configured circles even before a face image is set

  const size = Math.max(48, Math.min(200, config.circleSize ?? 128));
  const frame = Math.round(size * 2.3);

  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 12, opacity: visible ? 1 : 0, transition: 'opacity 0.3s ease' }} aria-hidden>
      {faces.map((f) => {
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
        return (
          <div key={f.side} style={{ position: 'absolute', bottom: '4%', [f.side === 'left' ? 'left' : 'right']: '3%', width: frame, height: frame } as React.CSSProperties}>
            <AvatarCircleViz config={config} face={f} size={size} frame={frame} getFrame={getFrame} />
          </div>
        );
      })}
    </div>
  );
}
