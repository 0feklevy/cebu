'use client';

import type { RefObject } from 'react';

interface Props {
  videoARef: RefObject<HTMLVideoElement | null>;
  videoBRef: RefObject<HTMLVideoElement | null>;
  onClick: () => void;
}

export function VideoLayer({ videoARef, videoBRef, onClick }: Props) {
  return (
    <div
      className="absolute inset-0"
      role="button"
      tabIndex={0}
      aria-label="Play or pause video"
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      <video
        ref={videoARef}
        className="absolute inset-0 w-full h-full object-contain bg-black"
        style={{ zIndex: 2 }}
        playsInline
        preload="auto"
      />
      <video
        ref={videoBRef}
        className="absolute inset-0 w-full h-full object-contain bg-black"
        style={{ zIndex: 1 }}
        playsInline
        preload="auto"
      />
    </div>
  );
}
