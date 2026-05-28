'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  src: string | null;
  currentTime: number;
  onTimeUpdate: (t: number) => void;
  sectionLabel?: string | null;
}

export function VideoPlayer({ src, currentTime, onTimeUpdate, sectionLabel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const seekingRef = useRef(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Math.abs(v.currentTime - currentTime) > 0.3) {
      seekingRef.current = true;
      v.currentTime = currentTime;
    }
  }, [currentTime]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  const handleTimeUpdate = () => {
    if (!videoRef.current || seekingRef.current) return;
    onTimeUpdate(videoRef.current.currentTime);
  };

  const handleSeeked = () => {
    seekingRef.current = false;
    if (videoRef.current) onTimeUpdate(videoRef.current.currentTime);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  };

  const handleSeekBar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    if (videoRef.current) videoRef.current.currentTime = t;
    onTimeUpdate(t);
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  if (!src) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-black/5 rounded-xl border border-dashed border-border text-center px-8">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="text-muted-foreground/30 mb-3" aria-hidden>
          <rect x="4" y="8" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M16 14l10 6-10 6V14z" fill="currentColor" />
        </svg>
        <p className="text-sm text-muted-foreground">Select a video to preview</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-black rounded-xl overflow-hidden relative">
      <video
        ref={videoRef}
        src={src}
        className="w-full flex-1 object-contain"
        onTimeUpdate={handleTimeUpdate}
        onSeeked={handleSeeked}
        onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />

      {sectionLabel && (
        <div className="absolute top-3 left-3 bg-black/70 text-white text-xs font-medium px-2 py-1 rounded-md backdrop-blur-sm">
          {sectionLabel}
        </div>
      )}

      {/* Controls */}
      <div className="shrink-0 bg-black/80 backdrop-blur px-4 py-2.5 space-y-2">
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={handleSeekBar}
          className="w-full h-1 accent-primary cursor-pointer"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={togglePlay} className="text-white hover:text-primary transition-colors">
              {playing ? (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <rect x="4" y="3" width="3.5" height="12" rx="1" fill="currentColor" />
                  <rect x="10.5" y="3" width="3.5" height="12" rx="1" fill="currentColor" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <path d="M5 3l11 6-11 6V3z" fill="currentColor" />
                </svg>
              )}
            </button>
            <span className="text-xs text-white/70 font-mono">{fmt(currentTime)} / {fmt(duration)}</span>
          </div>
          <div className="flex gap-1">
            {([0.5, 1, 1.5, 2] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors ${speed === s ? 'bg-primary text-white' : 'text-white/50 hover:text-white'}`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
