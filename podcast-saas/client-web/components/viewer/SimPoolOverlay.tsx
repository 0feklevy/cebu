'use client';

// Resident simulation pool — ALL of a video's sims (max ~3) are mounted ONCE, up front, in
// persistent hidden iframes that live for the whole viewing session. Each frame boots muted +
// guidance-gated, paints its scene while hidden, then freezes. Entering a sim section is then
// just an opacity swap of an already-running, already-painted frame — there is nothing left to
// load at the boundary, so the video↔sim transition is a pure 200ms crossfade.
//
// Frames NEVER navigate (src is fixed per URL for the session), which also eliminates the
// stale-document message races of the old single navigated iframe. Boot is staggered so the
// sims' network/GPU warmup doesn't fight the video's own startup.

import { memo, useEffect, useMemo, useState } from 'react';
import { resolveAssetUrl } from '../../lib/assetUrl';
import { resolveSimUrl } from '../../lib/simUrl';

export interface SimPoolFrameSpec {
  url: string;                    // RAW simulation_url — the identity key everywhere
  bootHide: string[] | null;      // minimal-UI selectors for the #simboot first-paint hint
}

interface FrameProps {
  spec: SimPoolFrameSpec;
  active: boolean;                // this frame is the current section's sim
  visible: boolean;               // the overlay as a whole is revealed
  delayMs: number;                // staggered boot offset
  registerFrame: (url: string, el: HTMLIFrameElement | null) => void;
  onFrameLoad: (url: string) => void;
}

function SimPoolFrame({ spec, active, visible, delayMs, registerFrame, onFrameLoad }: FrameProps) {
  // Stagger: render the iframe (i.e. start its fetch/boot) only after this frame's slot delay,
  // so three sims don't all slam the network/GPU at t=0 alongside the video's own startup.
  const [armed, setArmed] = useState(delayMs <= 0);
  useEffect(() => {
    if (armed) return;
    const t = setTimeout(() => setArmed(true), delayMs);
    return () => clearTimeout(t);
  }, [armed, delayMs]);
  // Boot immediately when this frame becomes the active section's sim — a seek can outrun the stagger.
  useEffect(() => { if (active) setArmed(true); }, [active]);

  const src = useMemo(
    () => resolveSimUrl(
      resolveAssetUrl(spec.url) ?? spec.url,
      spec.bootHide?.length ? { hideSelectors: spec.bootHide } : undefined,
    ),
    [spec.url, spec.bootHide],
  );

  if (!armed) return null;

  const shown = active && visible;
  return (
    <iframe
      ref={(el) => registerFrame(spec.url, el)}
      src={src}
      onLoad={() => onFrameLoad(spec.url)}
      loading="eager"
      className="sim-pool-frame"
      style={{ opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none', zIndex: shown ? 2 : 1 }}
      sandbox="allow-scripts allow-same-origin allow-forms"
      title="Interactive simulation"
    />
  );
}

interface Props {
  frames: SimPoolFrameSpec[];
  activeUrl: string | null;
  visible: boolean;
  /** Genuinely broken sim that never painted (≥5s) — the only routine loading affordance. */
  stalled?: boolean;
  /** Sim-first entry with no video frame underneath to hold — a brief loader is correct here. */
  coldCover?: boolean;
  registerFrame: (url: string, el: HTMLIFrameElement | null) => void;
  onFrameLoad: (url: string) => void;
}

// Boot stagger between pool frames. The first frame starts immediately.
const POOL_STAGGER_MS = 1200;

function SimPoolOverlayInner({ frames, activeUrl, visible, stalled = false, coldCover = false, registerFrame, onFrameLoad }: Props) {
  if (frames.length === 0) return null;
  return (
    <div className={`sim-overlay${visible ? ' visible' : ''}`}>
      {frames.map((spec, i) => (
        <SimPoolFrame
          key={spec.url}
          spec={spec}
          active={spec.url === activeUrl}
          visible={visible}
          delayMs={i * POOL_STAGGER_MS}
          registerFrame={registerFrame}
          onFrameLoad={onFrameLoad}
        />
      ))}
      {visible && (stalled || coldCover) && (
        <div className="sim-overlay-boot" aria-hidden>
          <div className="sim-overlay-spinner" />
        </div>
      )}
    </div>
  );
}

export const SimPoolOverlay = memo(SimPoolOverlayInner);
