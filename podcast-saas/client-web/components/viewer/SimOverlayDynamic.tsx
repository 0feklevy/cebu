'use client';

import type { RefObject } from 'react';

interface Props {
  simulationUrl: string | null;
  visible:       boolean;
  iframeRef:     RefObject<HTMLIFrameElement | null>;
}

// Keep iframe mounted while simulationUrl is set so the sim doesn't reload
// when the overlay briefly hides between sections. Visibility is CSS-driven
// via the .sim-overlay.visible class (350ms fade, matching the reference).
export function SimOverlayDynamic({ simulationUrl, visible, iframeRef }: Props) {
  if (!simulationUrl) return null;

  return (
    <div className={`sim-overlay${visible ? ' visible' : ''}`}>
      <iframe
        ref={iframeRef}
        src={simulationUrl}
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
        title="Interactive simulation"
      />
    </div>
  );
}
