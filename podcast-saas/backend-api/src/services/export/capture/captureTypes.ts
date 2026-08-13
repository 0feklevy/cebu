/**
 * The capture contract — the ONE interface the export service (a sibling's LinearAssembler /
 * ProjectExportService) calls to turn a scripted simulation section into frames. Phase 2 of the
 * Linear Video Export plan (md-files/LINEAR-VIDEO-EXPORT-PLAN.md §4 and its appendices).
 *
 * TWO backends implement this behind the same `SimCaptureBackend` interface:
 *   • playwrightScreenshotBackend — real Chrome + a JS virtual clock + per-frame screenshots.
 *     Runs on macOS; this is the one verified end-to-end locally.
 *   • beginFrameBackend — chrome-headless-shell + `--deterministic-mode` +
 *     HeadlessExperimental.beginFrame. Linux-container-only; macOS cannot run beginFrame at all
 *     (measured — Chromium returns "BeginFrameControl is not supported on MacOS yet").
 *
 * The export service depends only on this file. Whether a browser exists here is answered by
 * `isAvailable()`, and a "there is no browser on this host" outcome is the typed `CaptureUnavailable`
 * error — the signal the plan calls the *poster fallback*: an export always completes, degraded
 * loudly in the plan, rather than failing because a dev box has no Chrome (§ THE DECISION, point 5).
 */

/** Fixed Date epoch so `Date.now()` inside a captured sim is reproducible run to run. 2025-01-01Z. */
export const DEFAULT_FRAME_EPOCH_MS = 1_735_689_600_000;

/**
 * Frames discarded before the first captured frame. `beginFrame` "may or may not be answered with a
 * display update" (plan §4, failure mode 4) and the first compositor frames are stale; Replit's
 * number is 30 and the plan adopts it.
 */
export const DEFAULT_WARMUP_FRAMES = 30;

/** Exactly how many frames a section of `durationSec` at `fps` yields — `round(duration × fps)`. */
export function frameCountFor(durationSec: number, fps: number): number {
  return Math.round(durationSec * fps);
}

/**
 * What the export service hands a backend for one scripted simulation section.
 *
 * `servedSimUrl` is the loopback URL the (already-immutable) package is served from on the trusted
 * side (§0.2) — it MUST already carry the section dispatch query `?section=<id>&v=<hash>` and the
 * pre-paint UI cloak fragment `#simboot=…`; the driver navigates to it verbatim so neither is lost
 * (plan §4 "Navigate directly to the simulation").
 */
export interface CaptureSpec {
  /** Top-level URL to navigate to. Carries `?section=&v=` and `#simboot=` already. */
  readonly servedSimUrl: string;
  /** Timeline section id — echoed into the v2 `startScript` as the script name. */
  readonly sectionId: string;
  /** Hide irrelevant controls (Minimal UI). Sent as `startScript` param `simpleUi`. */
  readonly simpleUi: boolean;
  /** Animate the target control. Sent as `startScript` param `autoScript`. */
  readonly autoScript: boolean;
  /**
   * Minimal-UI selectors to mechanically hide. Sent as `startScript` param `hideSelectors` (the
   * viewer's own name for it — `ui_hide` on the row, `hideSelectors` on the wire).
   */
  readonly uiHide: readonly string[];
  /** Section window length in seconds (≤ VISUAL_MAX_SEC = 15). */
  readonly durationSec: number;
  /** Frames per second of the capture (30 for this product). */
  readonly fps: number;
  /** Capture width in CSS px. */
  readonly width: number;
  /** Capture height in CSS px. */
  readonly height: number;
  /**
   * The section's canonical config hash. Seeds the mulberry32 that replaces `Math.random` so the
   * capture is byte-reproducible (plan §4 "Determinism of the simulation itself").
   */
  readonly configHash: string;
  /** Poster identity the caller falls back to if capture is unavailable/fails. Opaque here. */
  readonly posterKey: string;
}

/**
 * What a backend returns for one section. Exactly one of `framesDir` / `clipPath` is set:
 * the screenshot backend emits a directory of numbered PNGs; a backend that pipes straight to
 * ffmpeg emits a clip path.
 */
export interface CaptureResult {
  /** Directory of numbered, zero-padded frame PNGs (screenshot backend). */
  readonly framesDir?: string;
  /** A single encoded clip (a backend that pipes frames to ffmpeg itself). */
  readonly clipPath?: string;
  /** How many frames were actually produced. The caller asserts this against the plan. */
  readonly frameCount: number;
  /**
   * `UNMASKED_RENDERER_WEBGL` (or `RENDERER`) as recorded by the injected probe. Written to the job
   * row so the "silent degradation to a 2D fallback" failure (plan §4, mode 2) is auditable. Empty
   * for a sim that never created a WebGL context.
   */
  readonly rendererString: string;
  /**
   * The rendering sanity gate verdict (§0.3). `failed` is trustworthy (something is wrong — a black
   * canvas, no paint, a dead WebGL context); `passed` is strong evidence, not proof.
   */
  readonly gate: 'passed' | 'failed';
  /** Why the gate failed, or any non-fatal note on a pass. */
  readonly reason?: string;
}

/**
 * "No browser on this host." Thrown by `captureSection` when the backend cannot run here (e.g. the
 * screenshot backend on a box with no Playwright/Chrome, or the beginFrame backend on macOS). The
 * export service catches THIS specifically and renders the section's poster still + silence instead
 * — never a silent black frame, never a failed export.
 */
export class CaptureUnavailable extends Error {
  readonly code = 'CAPTURE_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CaptureUnavailable';
  }
}

/**
 * A gate failure that is NOT "unavailable" — the browser ran, produced frames, and they did not pass
 * the sanity gate (black canvas, dead WebGL context, no animation). Distinct from CaptureUnavailable
 * so the caller can tell "no browser" (fall back quietly) from "the render is wrong" (a loud, plan
 * warning). A backend MAY instead return a CaptureResult with `gate: 'failed'` and let the caller
 * decide; this error exists for backends that would rather fail hard.
 */
export class CaptureGateFailed extends Error {
  readonly code = 'CAPTURE_GATE_FAILED' as const;
  constructor(
    message: string,
    readonly rendererString: string,
    readonly frameCount: number,
  ) {
    super(message);
    this.name = 'CaptureGateFailed';
  }
}

/**
 * The interface the export service programs against. Both backends implement it; the service picks
 * one (or is handed one) and never imports a concrete backend, Playwright, or CDP directly.
 */
export interface SimCaptureBackend {
  /** Stable identifier for logs / the job plan (e.g. `playwright-screenshot`, `begin-frame`). */
  readonly name: string;
  /**
   * Can this backend run on THIS host right now? Cheap, side-effect-free preflight (does the browser
   * resolve, is the platform supported). `false` ⇒ the caller uses the poster fallback without ever
   * calling `captureSection`.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Capture one scripted simulation section.
   * @throws {CaptureUnavailable} when no browser can run here (poster-fallback signal).
   */
  captureSection(spec: CaptureSpec): Promise<CaptureResult>;
}
