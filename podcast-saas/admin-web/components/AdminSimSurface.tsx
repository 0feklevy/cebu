/**
 * AdminSimSurface — the one simulation/preview <iframe> in admin-web.
 *
 * WHY A SECOND IMPLEMENTATION EXISTS (it is not an oversight):
 * client-web/lib/sim/SimSurface.tsx holds the same rules, and the obvious fix — hoist it into
 * `shared`, the one package both apps import — was attempted and is blocked three ways, each
 * verified by compiling a probe rather than assumed:
 *   1. `shared/tsconfig.json` sets no `jsx` flag and `shared/package.json` declares no react, so a
 *      .tsx there fails with TS17004 + TS7026. Adding React to `shared` also drags it into
 *      backend-api's dependency graph, which imports `shared` from a Node server.
 *   2. shared's subpath export is literally `"./src/*": "./src/*.ts"`, so
 *      `import 'shared/src/sim/SimSurface'` cannot resolve a .tsx file at all (TS2307) without
 *      changing the export map that backend-api also resolves through.
 *   3. SimSurface's fade duration is `SIM_FADE_MS` from client-web/lib/sim/protocol.ts — a
 *      client-only module admin cannot reach either.
 *
 * Drift between the two is therefore prevented by a test, not by hope:
 * client-web/__tests__/passiveSimSurfaces.test.tsx renders BOTH components with identical props
 * and asserts the rules that matter (sandbox, inert, aria-hidden, tabIndex, pointer-events, and
 * the resolveSimUrl-processed src) produce identical DOM.
 *
 * The rules themselves, and why each one is load-bearing:
 *   • resolveSimUrl is REQUIRED, not cosmetic: stored sim URLs are denormalised with whatever API
 *     origin minted them, and framing a foreign origin is blocked outright by the frame-src CSP —
 *     the raw URL rendered a blank frame (audited).
 *   • the boot-hide fragment is ALWAYS emitted for a URL frame: per the HTML navigation spec a
 *     src change is same-document only while the NEW fragment is non-null, so dropping `#simboot=`
 *     turns a hash-only change into a full navigation that hard-reloads a live sim.
 *   • a hidden frame is `inert` + `aria-hidden` + untabbable: opacity:0 removes nothing from the
 *     accessibility tree and pointer-events does not block Tab, so a hidden preview was still
 *     reachable by keyboard and by assistive tech.
 *   • pointer events follow visibility, never the other way round.
 *
 * Presentation only. There is no activation protocol here on purpose: admin previews are passive.
 */
'use client';

import { memo } from 'react';
import { resolveSimUrl } from 'shared/src/sim/simUrl';

/**
 * Mirrors client-web's SIM_FADE_MS. It is duplicated rather than imported because that constant
 * lives in a client-web module (see the header): the agreement test pins the two values together,
 * so changing one without the other fails CI instead of drifting silently.
 */
const ADMIN_SIM_FADE_MS = 200;

/** Same default token set as client-web's SimSurface. */
const DEFAULT_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

export interface AdminSimSurfaceProps {
  /** Raw stored sim URL. Resolved (origin rebase + device hints + boot cloak) internally. */
  src?: string | null;
  /**
   * Inline document, for visuals stored as HTML rather than as a packaged sim. Mutually exclusive
   * with `src`. A srcDoc frame inherits nothing from us, so callers must NOT grant it
   * allow-same-origin — that combination lets sandboxed script remove its own sandbox.
   */
  srcDoc?: string | null;
  /** Minimal-UI selectors to hide before the first paint. [] is meaningful: "cloak nothing". */
  bootHide?: string[] | null;
  visible: boolean;
  onLoad?: () => void;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
  sandbox?: string;
  /**
   * Permissions-Policy delegated to the frame (`allow="fullscreen"`, `autoplay`, …). Mirrors
   * client-web's SimSurface prop of the same name; the agreement test renders both with it and
   * compares the resulting DOM, so the two cannot drift on it.
   *
   * Distinct from `sandbox`: sandbox REMOVES capabilities from the document, `allow` DELEGATES ones
   * the embedder holds. Omitted by default, so no surface gains a capability by accident.
   */
  allow?: string;
  /** Set false for a frame that must never take pointer input even while visible. */
  interactive?: boolean;
  /** Opt out of the fade for surfaces that have no transition. */
  fade?: boolean;
  /** Rendered alongside the frame (placeholder, cover). */
  children?: React.ReactNode;
}

function AdminSimSurfaceImpl({
  src, srcDoc, bootHide, visible, onLoad,
  title = 'Interactive simulation',
  className, style, sandbox, allow, interactive = true, fade = true, children,
}: AdminSimSurfaceProps) {
  if (!src && !srcDoc) return null;

  // Always boot-aware: an empty hide list still emits `#simboot=`, keeping every src change a
  // same-document fragment navigation. See shared/src/sim/simUrl.ts for why dropping it reloads.
  const resolved = src ? resolveSimUrl(src, { hideSelectors: bootHide ?? [] }) : undefined;
  const shown = visible;

  return (
    <>
      <iframe
        {...(resolved ? { src: resolved } : { srcDoc: srcDoc ?? undefined })}
        onLoad={onLoad}
        title={title}
        className={className}
        loading="eager"
        sandbox={sandbox ?? DEFAULT_SANDBOX}
        allow={allow}
        style={{
          opacity: shown ? 1 : 0,
          ...(fade ? { transition: `opacity ${ADMIN_SIM_FADE_MS}ms ease` } : {}),
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

export const AdminSimSurface = memo(AdminSimSurfaceImpl);
