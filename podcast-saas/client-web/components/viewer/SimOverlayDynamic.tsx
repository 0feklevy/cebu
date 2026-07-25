'use client';

import { useMemo } from 'react';
import type { RefObject } from 'react';
import { resolveAssetUrl } from '../../lib/assetUrl';
import { resolveSimUrl } from '../../lib/simUrl';

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
// simulationUrl is never cleared mid-fade — the player only clears it after a
// destroy-grace well past the 200ms fade → the overlay is long invisible.)
export function SimOverlayDynamic({ simulationUrl, visible, iframeRef }: Props) {
  // Resolve once per URL: resolveSimUrl appends device hints (dpr/mem/lowend).
  // Memoizing keeps the src stable across re-renders so a mid-session
  // devicePixelRatio change (e.g. browser zoom) can't rewrite src and reload a
  // live sim. The RAW url stays the identity everywhere else (state/compares).
  const src = useMemo(
    () => (simulationUrl ? resolveSimUrl(resolveAssetUrl(simulationUrl) ?? simulationUrl) : null),
    [simulationUrl],
  );

  if (!src) return null;

  return (
    <div className={`sim-overlay${visible ? ' visible' : ''}`}>
      <iframe
        ref={iframeRef}
        src={src}
        loading="lazy"
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
        title="Interactive simulation"
      />
    </div>
  );
}
