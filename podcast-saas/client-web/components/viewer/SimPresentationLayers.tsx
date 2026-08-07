'use client';

/**
 * The safe presentation surface — three stacked layers, and NO opinion of its own about when a
 * simulation may be seen.
 *
 * Everything this component decides is decided by `decidePresentation`. What is left here is
 * rendering plus the two facts only the DOM knows: whether the poster's bytes have actually
 * decoded, and whether the user asked for reduced motion. Both are fed back INTO the policy rather
 * than acted on locally, so there is exactly one place where presentation is decided.
 *
 * WHAT THIS COMPONENT DELIBERATELY DOES NOT DO
 *   • It never mounts or unmounts the incoming frame. The `incoming` node is owned by the caller
 *     (the resident pool), whose whole design is that documents survive section changes. A
 *     presentation layer that unmounted a frame to hide it would destroy a warmed document every
 *     time the cover came up, and rebuild it — slower AND less safe, because the rebuilt document
 *     has to re-handshake before it can be presented again. `prepareIncoming` is REPORTED to the
 *     caller; the caller decides what to mount.
 *   • It never runs a timer that leads to a reveal. There is no timer in this file at all. The
 *     only clock-derived input is `remainingMs`, and it can only make the reveal LESS likely.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { SIM_MIN_LIVE_DWELL_MS } from 'shared/src/sim/activationMachine';
import {
  decidePresentation,
  type OutgoingKind,
  type PresentationDecision,
  type PresentationIntent,
} from '../../lib/sim/presentationPolicy';
import './simLayers.css';

export interface SimPresentationLayersProps {
  intent: PresentationIntent;

  /**
   * `mayReveal({...}).allowed`, computed by the caller against the activation machine.
   *
   * This is a PROP and not something the component derives, because every wrong-frame incident in
   * this product's history came from a surface that computed its own version of it — from a load
   * event, from a paint ping, from a stall timeout. The component cannot make that mistake if it
   * has no way to express it.
   */
  presented: boolean;

  samePackage?: boolean;

  /** True when the pixels beneath this component are still valid content to show. */
  outgoingValid: boolean;
  outgoingKind?: OutgoingKind;

  /** URL of the poster for the TARGET identity. Absent/empty means no poster exists. */
  posterSrc?: string | null;
  posterAlt?: string;

  transparentSection?: boolean;

  /** Milliseconds of the target section still to run. */
  remainingMs: number;
  /** Minimum live dwell. A prop because a 4s cutaway and a 90s explainer want different values. */
  minDwellMs?: number;

  failure?: boolean;
  retrying?: boolean;
  posterOnlyMode?: boolean;
  contextLost?: boolean;

  simpleUi?: boolean;
  /** The caller's fade-out completion signal. Defaults false: while unknown, Minimal UI stays on. */
  iframeFullyCovered?: boolean;

  /** Overrides the OS preference. Undefined means "ask matchMedia". */
  reducedMotion?: boolean;

  /** The live iframe. Owned and kept mounted by the caller. */
  incoming: ReactNode;
  /** An outgoing simulation frame, for a sim → sim handover. Omitted when the video is beneath. */
  outgoing?: ReactNode;
  /** Recovery actions, built from `recoveryActionsFor()`. */
  recovery?: ReactNode;
  /** Shown inside a neutral (no-poster) cover — the player's existing wait affordance goes here. */
  coverFallback?: ReactNode;

  onDecision?: (decision: PresentationDecision) => void;
  onMinimalUiActiveChange?: (active: boolean) => void;
  /**
   * Extra class on the root.
   *
   * Exists for ONE supported use: `sim-presentation--overlay`, which raises the surface above a
   * frame that lives OUTSIDE this component. A caller that keeps the incoming frame in its own
   * fixed slot — as the viewer must, because re-parenting the resident pool would rebuild every
   * warmed iframe — passes no `incoming` and uses this to composite the cover over it instead.
   */
  className?: string;
}

/**
 * The OS preference, with an explicit override.
 *
 * Initialised to `false` and corrected in an effect rather than read during render: reading
 * matchMedia during render makes the server and the first client render disagree, and a hydration
 * mismatch on the element that holds the sim iframe remounts the iframe — losing a warmed document
 * to a preference query.
 */
function usePrefersReducedMotion(override: boolean | undefined): boolean {
  const [pref, setPref] = useState(false);

  useEffect(() => {
    if (override !== undefined) return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPref(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setPref(e.matches);
    // Safari before 14 exposes only the deprecated addListener; the modern path is tried first so
    // the deprecated one is never used where it is not needed.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, [override]);

  return override ?? pref;
}

export function SimPresentationLayers({
  intent,
  presented,
  samePackage = false,
  outgoingValid,
  outgoingKind = 'none',
  posterSrc,
  posterAlt = '',
  transparentSection = false,
  remainingMs,
  minDwellMs = SIM_MIN_LIVE_DWELL_MS,
  failure = false,
  retrying = false,
  posterOnlyMode = false,
  contextLost = false,
  simpleUi = false,
  iframeFullyCovered = false,
  reducedMotion,
  incoming,
  outgoing,
  recovery,
  coverFallback,
  onDecision,
  onMinimalUiActiveChange,
  className,
}: SimPresentationLayersProps) {
  const prefersReducedMotion = usePrefersReducedMotion(reducedMotion);

  // Tracked by URL, not by a boolean: a boolean reset in an effect is stale for one render after
  // the poster changes, and that render is exactly the one where the old poster's "loaded" would
  // authorise mounting the incoming frame at full opacity behind a cover that is no longer there.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const src = posterSrc || null;
  // A poster that 404s or decodes badly is NOT available. Without this the cover would stay a blank
  // rectangle for the whole section, with no path to the outgoing content the policy would
  // otherwise have chosen.
  const posterAvailable = !!src && failedSrc !== src;
  const posterLoaded = !!src && loadedSrc === src;

  const decision = useMemo(
    () =>
      decidePresentation({
        intent,
        presented,
        samePackage,
        outgoingValid,
        outgoingKind,
        posterAvailable,
        posterLoaded,
        transparentSection,
        remainingMs,
        minDwellMs,
        failure,
        retrying,
        posterOnlyMode,
        contextLost,
        simpleUi,
        iframeFullyCovered,
        reducedMotion: prefersReducedMotion,
      }),
    [
      intent, presented, samePackage, outgoingValid, outgoingKind, posterAvailable, posterLoaded,
      transparentSection, remainingMs, minDwellMs, failure, retrying, posterOnlyMode, contextLost,
      simpleUi, iframeFullyCovered, prefersReducedMotion,
    ],
  );

  useEffect(() => { onDecision?.(decision); }, [decision, onDecision]);

  const minimalUiActive = decision.minimalUiActive;
  useEffect(() => { onMinimalUiActiveChange?.(minimalUiActive); }, [minimalUiActive, onMinimalUiActiveChange]);

  // A cached poster can already be `complete` when React attaches the element, in which case no
  // load event will ever fire. Without this check the cover would be treated as undecoded forever
  // and the incoming frame could never take the covered-preparation path.
  const posterRef = useCallback(
    (el: HTMLImageElement | null) => {
      if (!el || !src) return;
      if (el.complete && el.naturalWidth > 0) setLoadedSrc(src);
    },
    [src],
  );

  const revealed = decision.incoming === 'revealed';

  return (
    <div
      className={`sim-presentation${decision.crossFade ? '' : ' no-motion'}${className ? ` ${className}` : ''}`}
      data-testid="sim-presentation"
      data-layer={decision.layer}
      data-reason={decision.reason}
      data-minimal-ui={minimalUiActive ? 'active' : 'inactive'}
      data-prepare-incoming={decision.prepareIncoming ? 'true' : 'false'}
      data-cross-fade={decision.crossFade ? 'true' : 'false'}
    >
      <div
        className="sim-layer sim-layer-bottom"
        data-testid="sim-layer-bottom"
        data-fill={decision.beneathCover}
        data-outgoing-kind={outgoingKind}
      >
        {outgoing}
      </div>

      {/* `inert` (not just pointer-events) because an opacity-0 subtree is still in the a11y tree
          and still reachable by Tab — a hidden simulation that can be focused is a simulation the
          user can drive while looking at a poster of a different one. */}
      <div
        className="sim-layer sim-layer-middle"
        data-testid="sim-layer-incoming"
        data-visibility={decision.incoming}
        inert={!revealed}
        aria-hidden={!revealed}
      >
        {incoming}
      </div>

      {decision.cover !== 'none' && (
        <div
          className="sim-layer sim-layer-top"
          data-testid="sim-layer-cover"
          data-cover={decision.cover}
          data-opacity={decision.coverOpacity}
          data-poster-loaded={posterLoaded ? 'true' : 'false'}
        >
          {decision.cover === 'poster' && src && (
            // A raw <img>, not next/image: the poster's whole promise is that it is byte-identical
            // to the frame it stands in for (posterIdentity.ts records a checksum for exactly that
            // reason). Routing it through the image optimizer re-encodes it at a different quality
            // and strips the PNG alpha a transparent section depends on.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              // Keyed by src so the ref callback re-runs on a poster change and re-checks
              // `complete` for the NEW image rather than reporting the old one's state.
              key={src}
              ref={posterRef}
              src={src}
              alt={posterAlt}
              draggable={false}
              className="sim-poster"
              data-testid="sim-poster"
              onLoad={() => setLoadedSrc(src)}
              onError={() => setFailedSrc(src)}
            />
          )}
          {decision.cover === 'neutral' && coverFallback && (
            <div className="sim-cover-fallback" data-testid="sim-cover-fallback" aria-hidden>
              {coverFallback}
            </div>
          )}
        </div>
      )}

      {decision.layer === 'recovery' && (
        <div className="sim-layer sim-layer-recovery" data-testid="sim-recovery" role="alert">
          {decision.showRecoveryActions ? recovery : <div className="sim-recovery-spinner" />}
        </div>
      )}
    </div>
  );
}

export default SimPresentationLayers;
