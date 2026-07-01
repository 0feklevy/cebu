'use client';

import type { RefObject } from 'react';

interface Props {
  simulationUrl: string | null;
  visible:       boolean;
  iframeRef:     RefObject<HTMLIFrameElement | null>;
}

// Keep iframe mounted while simulationUrl is set so the sim doesn't reload
// when the overlay briefly hides between sections. Visibility is CSS-driven
// via the .sim-overlay.visible class (opacity fade). The black background
// lives ON the fading layer (.sim-overlay { background:#0e0e0e }) so that when
// the sim is hidden the video shows through — a true video↔sim crossfade.
// (A separate always-opaque backdrop would stay black forever because
// simulationUrl is intentionally never cleared → permanent black screen.)
export function SimOverlayDynamic({ simulationUrl, visible, iframeRef }: Props) {
  if (!simulationUrl) return null;

  return (
    <div className={`sim-overlay${visible ? ' visible' : ''}`}>
      <iframe
        ref={iframeRef}
        src={simulationUrl}
        loading="lazy"
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
        title="Interactive simulation"
      />
    </div>
  );
}
