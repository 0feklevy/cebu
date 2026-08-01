'use client';

// Resident simulation pool — one persistent hidden iframe per sim PACKAGE (not per section
// URL: a package's combined bridge serves all of its sections via dynamic dispatch). Frames
// boot muted + guidance-gated, paint off-screen, freeze, and reveal by opacity swap — the
// video↔sim boundary loads nothing. Membership is adaptive: on strong devices every active-
// path package mounts up front (staggered, after the video starts playing); on weak devices
// the player keeps only the active + next package resident (sliding window).
//
// A frame's src changes ONLY for deliberate navigations (legacy non-dynamic bridges, or a
// back-to-video pristine reload) — the player marks those with an expected-reload epoch so a
// late native `load` event (which fires after subresources, often AFTER the bridge handshake)
// can never reset a live frame's lifecycle flags.

import { memo, useCallback, useEffect, useState } from 'react';
import type { SimPoolFrameSpec } from '../../lib/simPool';
import { resolveAssetUrl } from '../../lib/assetUrl';
import { resolveSimUrl } from '../../lib/simUrl';

interface FrameProps {
  spec: SimPoolFrameSpec;
  active: boolean;                // this frame is the current section's package
  visible: boolean;               // the overlay as a whole is revealed
  delayMs: number;                // staggered boot offset (counted from armGate)
  armGate: boolean;               // false until the VIDEO's own boot is out of the way
  registerFrame: (key: string, el: HTMLIFrameElement | null) => void;
  onFrameLoad: (key: string) => void;
}

function SimPoolFrame({ spec, active, visible, delayMs, armGate, registerFrame, onFrameLoad }: FrameProps) {
  // Boot scheduling: fetch/boot starts once the gate opens (video reached 'playing', fallback
  // timer, or sim-first), staggered so several packages don't slam the network/GPU at once.
  // A frame that becomes ACTIVE arms immediately — a seek must never wait on the stagger.
  // Initial false keeps SSR/hydration DOM identical (no iframes server-side).
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (armed) return;
    if (active) { setArmed(true); return; }
    if (!armGate) return;
    const t = setTimeout(() => setArmed(true), delayMs);
    return () => clearTimeout(t);
  }, [armed, active, armGate, delayMs]);

  // STABLE callback ref — an inline ref would detach/re-register this frame in the player's
  // routing map on EVERY re-render, and any SIM_READY/SIM_PAINTED landing in that window
  // would be dropped (the measured cause of painted frames still hitting the bounded hold).
  const refCb = useCallback((el: HTMLIFrameElement | null) => registerFrame(spec.key, el), [registerFrame, spec.key]);
  const loadCb = useCallback(() => onFrameLoad(spec.key), [onFrameLoad, spec.key]);

  if (!armed) return null;

  const src = resolveSimUrl(
    resolveAssetUrl(spec.src) ?? spec.src,
    spec.bootHide?.length ? { hideSelectors: spec.bootHide } : undefined,
  );

  const shown = active && visible;
  return (
    <iframe
      ref={refCb}
      src={src}
      onLoad={loadCb}
      loading="eager"
      className="sim-pool-frame"
      style={{ opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none', zIndex: shown ? 2 : 1 }}
      sandbox="allow-scripts allow-same-origin allow-forms"
      title="Interactive simulation"
      // opacity:0 removes nothing from the a11y tree and pointer-events doesn't block Tab —
      // a hidden resident frame must be unreachable to keyboard and assistive tech (audited).
      inert={!shown}
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
    />
  );
}

interface Props {
  frames: SimPoolFrameSpec[];
  activeKey: string | null;
  visible: boolean;
  /** Opens when the main video's own boot is out of the way (playing / fallback / sim-first). */
  armGate: boolean;
  /** Genuinely broken sim that never painted (≥5s) — honest failure affordance. */
  stalled?: boolean;
  /** Waiting for a not-yet-painted sim with no video frame underneath to hold. */
  coldCover?: boolean;
  registerFrame: (key: string, el: HTMLIFrameElement | null) => void;
  onFrameLoad: (key: string) => void;
}

// Boot stagger between pool frames (counted from the arm gate opening).
const POOL_STAGGER_MS = 1200;

function SimPoolOverlayInner({ frames, activeKey, visible, armGate, stalled = false, coldCover = false, registerFrame, onFrameLoad }: Props) {
  if (frames.length === 0) return null;
  // The wait/stall affordance is a SIBLING of the fading overlay, not a child: the player
  // holds the video (overlay opacity 0) while a sim hasn't painted, and the spinner must be
  // able to show during that hold. It never captures pointer events — controls stay usable.
  const affordance = stalled || coldCover;
  return (
    <>
      <div className={`sim-overlay${visible ? ' visible' : ''}`}>
        {frames.map((spec, i) => (
          <SimPoolFrame
            key={spec.key}
            spec={spec}
            active={spec.key === activeKey}
            visible={visible}
            delayMs={i * POOL_STAGGER_MS}
            armGate={armGate}
            registerFrame={registerFrame}
            onFrameLoad={onFrameLoad}
          />
        ))}
      </div>
      {affordance && (
        <div className={`sim-wait-affordance${stalled ? ' stalled' : ''}`} aria-hidden>
          <div className="sim-overlay-spinner" />
        </div>
      )}
    </>
  );
}

export const SimPoolOverlay = memo(SimPoolOverlayInner);
