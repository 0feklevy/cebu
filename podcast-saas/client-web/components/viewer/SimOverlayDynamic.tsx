'use client';

import { useMemo } from 'react';
import type { RefObject } from 'react';
import { resolveAssetUrl } from '../../lib/assetUrl';
import { resolveSimUrl } from '../../lib/simUrl';

interface Props {
  simulationUrl: string | null;
  visible:       boolean;
  iframeRef:     RefObject<HTMLIFrameElement | null>;
  onLoad?:       () => void;   // fires per document load — re-arms the player's start/ready machinery
  /** Minimal-UI selectors the sim should boot with already hidden (fragment hint). */
  bootHide?:     string[] | null;
  /** A genuinely broken sim that never painted (≥5s) — the ONLY routine loading affordance. */
  stalled?:      boolean;
  /** Sim-first entry with no video frame underneath to hold — a brief loader is correct here. */
  coldCover?:    boolean;
}

// Keep iframe mounted while simulationUrl is set so the sim doesn't reload when the overlay
// briefly hides between sections. Visibility is CSS-driven via .sim-overlay.visible (opacity
// fade). The wrapper is TRANSPARENT: a revealed sim composites over the outgoing content
// (still-playing video / frozen last frame) — no black backdrop, so the crossfade never flashes.
// The overlay is only ever revealed once the sim has actually painted (paint-gated in the
// player), so there is no loading state in normal operation; the spinner shows solely for a
// genuine 5s stall or a sim-first entry with nothing to hold underneath.
export function SimOverlayDynamic({ simulationUrl, visible, iframeRef, onLoad, bootHide, stalled = false, coldCover = false }: Props) {
  // Resolve once per URL: resolveSimUrl appends device hints (dpr/mem/lowend) and the minimal-UI
  // boot hint (#simboot=…, painted already-minimal). bootKey serializes the dep — a hash-only src
  // change never reloads the document.
  const bootKey = bootHide?.length ? JSON.stringify(bootHide) : null;
  const src = useMemo(
    () => (simulationUrl
      ? resolveSimUrl(
          resolveAssetUrl(simulationUrl) ?? simulationUrl,
          bootKey ? { hideSelectors: JSON.parse(bootKey) as string[] } : undefined,
        )
      : null),
    [simulationUrl, bootKey],
  );

  if (!src) return null;

  return (
    <div className={`sim-overlay${visible ? ' visible' : ''}`}>
      <iframe
        ref={iframeRef}
        src={src}
        onLoad={onLoad}
        // Eager: this iframe is deliberately pre-mounted off-screen to warm the sim; lazy would
        // defer the fetch on intersection distance and defeat the preload.
        loading="eager"
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
        title="Interactive simulation"
      />
      {(stalled || coldCover) && (
        <div className="sim-overlay-boot" aria-hidden>
          <div className="sim-overlay-spinner" />
        </div>
      )}
    </div>
  );
}
