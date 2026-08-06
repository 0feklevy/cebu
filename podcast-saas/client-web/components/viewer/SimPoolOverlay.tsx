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
import { SimSurface } from '../../lib/sim/SimSurface';

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

  const shown = active && visible;
  // SimSurface owns every rule that must hold for ANY hosted simulation frame: the boot-hide
  // fragment (dropping it turns a hash-only src change into a full navigation that reloads a
  // resident frame — audited), the origin rebase, and the inert/aria-hidden/tabIndex policy that
  // keeps a hidden frame out of the keyboard and assistive-tech tree. This surface used to
  // re-implement all three; the pool-specific part is only the z-order swap below.
  //
  // `fade={false}` because `.sim-pool-frame` already carries the opacity transition in CSS — one
  // owner for the duration, not an inline literal racing a stylesheet.
  return (
    <SimSurface
      src={resolveAssetUrl(spec.src) ?? spec.src}
      bootHide={spec.bootHide ?? []}
      visible={shown}
      frameRef={refCb}
      onLoad={loadCb}
      fade={false}
      className="sim-pool-frame"
      style={{ zIndex: shown ? 2 : 1 }}
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
  /**
   * The active section's captured poster — its own first frame.
   *
   * Shown INSTEAD of a bare spinner while a cold document boots. Seeking forward onto a
   * simulation cannot make its bytes arrive faster, but it can stop the wait from looking like a
   * loading screen: the poster is a picture of exactly what is about to appear. Until now this
   * only reached the v3 presentation path, which no package in storage is on, so every real cold
   * seek showed a featureless spinner while the captured frame sat unused.
   */
  posterSrc?: string | null;
  /** A poster captured over a transparent background must not get an opaque backdrop. */
  posterTransparent?: boolean;
  registerFrame: (key: string, el: HTMLIFrameElement | null) => void;
  onFrameLoad: (key: string) => void;
}

// Boot stagger between pool frames (counted from the arm gate opening).
const POOL_STAGGER_MS = 1200;

function SimPoolOverlayInner({
  frames, activeKey, visible, armGate, stalled = false, coldCover = false,
  posterSrc = null, posterTransparent = false, registerFrame, onFrameLoad,
}: Props) {
  // A poster only replaces the spinner once it has actually PAINTED. Keying suppression on the
  // URL merely EXISTING left two holes: the poster's own fetch (a black rectangle with no cue,
  // because .sim-cold-poster paints `background:#000` from its first frame) and a poster that
  // 404s (that black rectangle forever). Both are tracked against the specific src, so a section
  // change re-arms the spinner instead of inheriting the previous poster's "ready".
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const onPosterLoad = useCallback(() => setLoadedSrc(posterSrc), [posterSrc]);
  const onPosterError = useCallback(() => setFailedSrc(posterSrc), [posterSrc]);
  if (frames.length === 0) return null;
  // The wait/stall affordance is a SIBLING of the fading overlay, not a child: the player
  // holds the video (overlay opacity 0) while a sim hasn't painted, and the spinner must be
  // able to show during that hold. It never captures pointer events — controls stay usable.
  const affordance = stalled || coldCover;
  const posterFailed = posterSrc !== null && failedSrc === posterSrc;
  const posterPainted = posterSrc !== null && loadedSrc === posterSrc;
  // A poster that failed to load is not shown at all — its `background:#000` would be an opaque
  // black box standing in for a picture that will never arrive.
  const showPoster = posterSrc !== null && !posterFailed;
  const showSpinner = !showPoster || !posterPainted || stalled;
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
        <div
          className={`sim-wait-affordance${stalled ? ' stalled' : ''}${showPoster ? ' has-poster' : ''}`}
          aria-hidden
        >
          {showPoster && (
            <img
              className={`sim-cold-poster${posterTransparent ? ' transparent' : ''}`}
              src={resolveAssetUrl(posterSrc) ?? posterSrc}
              alt=""
              // decoding=async so a large poster cannot block the frame that reveals the sim; the
              // poster is a courtesy and must never itself become the reason the sim appears late.
              decoding="async"
              onLoad={onPosterLoad}
              onError={onPosterError}
            />
          )}
          {/* The spinner is kept when there is no poster, while the poster has not painted yet,
              when the poster failed outright, or when the sim has genuinely stalled — a still
              image with no motion would otherwise read as "finished loading" when it is broken.
              `.sim-overlay-spinner` carries its own stacking context in viewer.css: the poster is
              absolutely positioned, so a statically-positioned spinner paints UNDERNEATH it and
              the stall cue silently disappears. */}
          {showSpinner && <div className="sim-overlay-spinner" />}
        </div>
      )}
    </>
  );
}

export const SimPoolOverlay = memo(SimPoolOverlayInner);
