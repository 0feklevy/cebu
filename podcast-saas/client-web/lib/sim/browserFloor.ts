/**
 * The browser capability floor for simulation packages (audit P0.8).
 *
 * A simulation package is customer-uploaded bytes. The flagship ones resolve `three` through an
 * `<script type="importmap">`, and WebKit only shipped import maps in Safari/iOS 16.4 — so on
 * 16.3 and older those packages do not run slowly, they do not run AT ALL: the bare specifier
 * never resolves, no module evaluates, and nothing ever paints. That is a deterministic
 * compatibility boundary, not a performance tail.
 *
 * WHAT THIS MODULE IS FOR
 * Turning that certain failure into an honest, covered one. The presentation policy already has
 * the surface for it — `posterOnlyMode` → `poster-only-device`
 * (`presentationPolicy.ts`) — and until now NOTHING in production ever set it, so the path was
 * dead code. This module supplies the missing trigger.
 *
 * TWO RULES IT FOLLOWS
 *  1. FEATURE-DETECT, NEVER UA-SNIFF. The audit is explicit that device capability must not be
 *     inferred from a name (`navigator.deviceMemory` is called out for the same reason), and a
 *     user-agent string tells you nothing reliable about `importmap` support. `HTMLScriptElement
 *     .supports('importmap')` is the exact question, asked directly.
 *  2. ONLY PENALISE PACKAGES THAT ACTUALLY NEED IT. Blanket poster-only on an older Safari would
 *     break packages that use no import map at all and would have run fine. The requirement is a
 *     PROPERTY OF THE PACKAGE, detected when it is published and carried on the section, so an
 *     unsupported browser degrades exactly the packages that cannot run and nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not rewrite or bundle bare imports at publication time. That is the other half of the
 * audit's P0.8 (and the only half that would let those clients actually RUN the package); it is a
 * publication-pipeline project, and it needs this detection either way to know when it mattered.
 */

/**
 * Does this browser resolve bare module specifiers through an import map?
 *
 * `HTMLScriptElement.supports` is itself newer than some browsers we serve, so its absence is
 * treated as "cannot confirm support". Conservative in the right direction: the consequence of a
 * false negative is a poster where a live simulation would have worked, and the consequence of a
 * false positive is the blank frame this whole module exists to prevent.
 */
export function supportsImportMaps(): boolean {
  if (typeof HTMLScriptElement === 'undefined') return false;   // SSR / non-DOM
  const supports = (HTMLScriptElement as unknown as { supports?: (t: string) => boolean }).supports;
  if (typeof supports !== 'function') return false;
  try {
    return supports.call(HTMLScriptElement, 'importmap') === true;
  } catch {
    // A throwing `supports` is not a supported `supports`.
    return false;
  }
}

/** What a section needs from the browser. Fields are optional: an unknown requirement is not a claim. */
export interface SimPackageRequirements {
  /**
   * The package's entry HTML carries `<script type="importmap">`, detected at publication
   * (`shared/src/sim/bridgeCapability.ts` → `sim_revisions.metadata.bridgeCapabilities` →
   * `simulations.requires_import_maps` → the section's `requires_import_maps` field).
   *
   * `undefined` AND `null` both mean UNKNOWN — a package published before detection existed, or a
   * row read without the column — and unknown is never treated as "requires", because guessing
   * would poster-only every legacy package on an older browser for a requirement it may not have.
   * `null` is accepted alongside `undefined` so the wire value can be passed straight through: a
   * conversion step is a place for the three states to be flattened into two.
   */
  requiresImportMaps?: boolean | null;
}

/**
 * A section as the floor needs to see it, on EITHER surface.
 *
 * `simulation_id` is not read — it is here so the type is not a "weak type" (all-optional), which
 * TypeScript refuses to accept a `SimulationOverlay` or a `TimelineSection` for. That makes this
 * usable structurally, with no cast, from both the viewer's player config and the editor's section
 * rows, which is the point: one floor, asked the same way in both places.
 */
export interface SimFloorSection {
  simulation_id: string | null;
  requires_import_maps?: boolean | null;
}

/** The wire field, as the floor's own vocabulary. Absent section → no known requirement. */
export function sectionRequirements(
  section: SimFloorSection | null | undefined,
): SimPackageRequirements {
  return { requiresImportMaps: section?.requires_import_maps ?? null };
}

/** The browser side of the same question, injectable so tests never depend on the host. */
export interface BrowserCapabilities {
  importMaps: boolean;
}

export function detectBrowserCapabilities(): BrowserCapabilities {
  return { importMaps: supportsImportMaps() };
}

/**
 * What to assume BEFORE detection has run — on the server, and on the first client render.
 *
 * "Capable", deliberately, and it is the one place in this module that errs towards running the
 * package. `supportsImportMaps()` cannot be called during render: it answers `false` under SSR
 * (there is no `HTMLScriptElement`), so a render-time call would make the server and the first
 * client render disagree about which layer is on screen — and a hydration mismatch on the element
 * that hosts the sim iframe REMOUNTS the iframe, destroying a warmed document to answer a feature
 * query. So callers seed with this and correct in a mount effect, exactly as the presentation
 * surface already does for `prefers-reduced-motion`. The correction lands in the first commit,
 * long before any package could have painted.
 */
export const ASSUMED_CAPABILITIES: BrowserCapabilities = { importMaps: true };

/**
 * What a browser can be missing. A CAPABILITY name, never a device or a browser name — the value
 * travels into telemetry and into the DOM, and the moment it names a product instead of a feature
 * it stops being checkable and starts being a guess about who the user is.
 */
export type MissingCapability = 'import-maps';

export type FloorVerdict =
  /** Nothing known to be missing — run the package normally. */
  | { runnable: true }
  /** A requirement this browser cannot meet. The package would never paint; cover it instead. */
  | { runnable: false; missing: MissingCapability };

/**
 * Can this browser run this package?
 *
 * Pure, so the decision is unit-testable and identical wherever it is asked. Callers map
 * `runnable: false` onto the presentation policy's existing `posterOnlyMode`, which yields the
 * `poster-only-device` reason and the poster/cover layer — no new presentation path.
 */
export function evaluateFloor(
  requirements: SimPackageRequirements | null | undefined,
  caps: BrowserCapabilities,
): FloorVerdict {
  if (requirements?.requiresImportMaps === true && !caps.importMaps) {
    return { runnable: false, missing: 'import-maps' };
  }
  return { runnable: true };
}

/** Human-readable, for a recovery cover and for telemetry. Not a UA string — a capability name. */
export const FLOOR_MESSAGES: Record<MissingCapability, string> = {
  'import-maps':
    'This simulation needs a newer browser to run (Safari 16.4 or later). '
    + 'Showing a still image of it instead.',
};
