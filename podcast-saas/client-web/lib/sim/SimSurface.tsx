/**
 * SimSurface — the one simulation <iframe> in the product.
 *
 * Every rule that must hold for a hosted simulation frame regardless of which screen it is on
 * lives here, so no surface can forget one:
 *   • the boot-hide fragment is ALWAYS emitted for a boot-aware caller (removing it turns a
 *     hash-only src change into a full navigation that hard-reloads a live sim);
 *   • a hidden frame is `inert` + `aria-hidden` + untabbable — opacity:0 removes nothing from the
 *     accessibility tree and pointer-events does not block Tab, so a hidden simulation was still
 *     reachable by keyboard and assistive tech;
 *   • pointer events follow visibility, never the other way round;
 *   • the fade duration is the shared constant, not a per-surface literal.
 *
 * Presentation only. Lifecycle decisions belong to SimRuntimeClient; this component renders the
 * state the client reports.
 */
'use client';

import { memo } from 'react';
import { resolveSimUrl } from '../simUrl';
import { SIM_FADE_MS } from './protocol';

export interface SimSurfaceProps {
  /** Raw stored sim URL. Resolved (origin rebase + device hints + boot cloak) internally. */
  src?: string | null;
  /**
   * Inline document, for sims generated on the fly rather than stored. Mutually exclusive with
   * `src`. A srcDoc frame has an opaque ('null') origin, so it can only ever be messaged with
   * targetOrigin '*' — which is why the runtime posts that way.
   */
  srcDoc?: string | null;
  /** Minimal-UI selectors to hide before the first paint. [] is meaningful: "cloak nothing". */
  bootHide?: string[] | null;
  visible: boolean;
  /** Ref callback from useSimRuntime. */
  frameRef: (el: HTMLIFrameElement | null) => void;
  onLoad?: () => void;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Extra sandbox tokens beyond the default set (the editor preview needs pointer lock). */
  sandbox?: string;
  /** Set false for a frame that must never take pointer input even while visible. */
  interactive?: boolean;
  /**
   * Opt out of the fade for surfaces that have no transition (the editor preview is simply
   * present while its tab is open). Never use this to work around a reveal gate.
   */
  fade?: boolean;
  /** Rendered above the frame while it is hidden (spinner, cover). */
  children?: React.ReactNode;
}

const DEFAULT_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

function SimSurfaceImpl({
  src, srcDoc, bootHide, visible, frameRef, onLoad,
  title = 'Interactive simulation',
  className, style, sandbox, interactive = true, fade = true, children,
}: SimSurfaceProps) {
  if (!src && !srcDoc) return null;

  // Always boot-aware: an empty hide list still emits `#simboot=`, keeping every src change a
  // same-document fragment navigation. See lib/simUrl.ts for why dropping it reloads the sim.
  const resolved = src ? resolveSimUrl(src, { hideSelectors: bootHide ?? [] }) : undefined;
  const shown = visible;

  return (
    <>
      <iframe
        ref={frameRef}
        {...(resolved ? { src: resolved } : { srcDoc: srcDoc ?? undefined })}
        onLoad={onLoad}
        title={title}
        className={className}
        loading="eager"
        sandbox={sandbox ?? DEFAULT_SANDBOX}
        style={{
          opacity: shown ? 1 : 0,
          ...(fade ? { transition: `opacity ${SIM_FADE_MS}ms ease` } : {}),
          pointerEvents: shown && interactive ? 'auto' : 'none',
          ...style,
        }}
        inert={!shown}
        aria-hidden={!shown}
        tabIndex={shown ? undefined : -1}
      />
      {children}
    </>
  );
}

export const SimSurface = memo(SimSurfaceImpl);
