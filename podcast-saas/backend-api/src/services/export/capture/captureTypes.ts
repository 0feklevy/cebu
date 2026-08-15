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
  /**
   * Discarded warmup frames before the kept capture. Optional so existing callers keep
   * `DEFAULT_WARMUP_FRAMES`, but when the boundary spec names a value it must ARRIVE here: the
   * container spec carried a `warmupFrames` field that the backend never read, so the number an
   * operator or an experiment set was silently ignored and every run used the default.
   */
  readonly warmupFrames?: number;
  /** Poster identity the caller falls back to if capture is unavailable/fails. Opaque here. */
  readonly posterKey: string;
  /**
   * Which renderer this capture must use. Optional in the TYPE so backends that do not render
   * (poster paths, tests of other concerns) need not carry it, but `BeginFrameBackend` REQUIRES it:
   * the value used to be read from the container's own environment, which put the choice on the
   * untrusted side of the boundary and meant the trusted side's `hardware` never reached the flags.
   */
  readonly rendererProfile?: 'swiftshader' | 'hardware';
}

/**
 * What a backend returns for one section. Exactly one of `framesDir` / `clipPath` is set:
 * the screenshot backend emits a directory of numbered PNGs; a backend that pipes straight to
 * ffmpeg emits a clip path.
 */
/**
 * Where a captured frame's wall clock went, in milliseconds, averaged over the kept frames.
 *
 * ADVISORY ONLY. This crosses the trust boundary from the container, so nothing may branch on it:
 * it exists to answer "why is this slow", and the answer it gave — 96.8 % of a frame is
 * rasterisation — is what turned the hardware question from a guess into a decision. Every field is
 * validated finite, non-negative and bounded before it is stored or logged.
 */
export interface CaptureCostBreakdown {
  /** Advancing the page's virtual clock: the simulation's own JavaScript. */
  readonly simMs: number;
  /** The uncaptured compositor turn between kept frames. */
  readonly flushMs: number;
  /** beginFrame with a screenshot: rasterisation plus readback plus JPEG encode. */
  readonly rasterMs: number;
  /** Writing the JPEG to disk. */
  readonly writeMs: number;
  /** Frames the averages are over. */
  readonly frames: number;
}

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
  /** Advisory per-frame cost split. Absent when the backend did not measure one. */
  readonly cost?: CaptureCostBreakdown;
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
   *
   * `signal` is the export job's cancellation signal. It is optional so every existing backend still
   * satisfies the contract, but a backend that spawns a process MUST honour it: a capture is the
   * longest-running thing an export does — minutes of pinned CPU — so a cancellation that cannot
   * reach it means the user's "stop" leaves the host burning both cores until the wall clock fires.
   *
   * @throws {CaptureUnavailable} when no browser can run here (poster-fallback signal).
   */
  captureSection(spec: CaptureSpec, signal?: AbortSignal): Promise<CaptureResult>;
}

/**
 * Where in the capture pipeline a failure happened. A one-word classification that turns the next
 * production incident from "container exited 1" into "failed at cdp_connect: …" — the v0.1.22
 * root cause took `docker events` + live log attachment to find precisely because nothing carried
 * this. Small on purpose: a label on errors, not a telemetry framework.
 */
export type CaptureStage =
  | 'backend_load'
  | 'chrome_launch'
  | 'cdp_connect'
  | 'navigation'
  | 'bridge_ready'
  | 'start_script'
  | 'paint_ready'
  | 'begin_frame'
  | 'screenshot'
  | 'sanity_gate'
  | 'result_write';

/** An error that knows which pipeline stage produced it. `message` already carries the stage. */
export class CaptureStageError extends Error {
  constructor(
    readonly stage: CaptureStage,
    detail: string,
  ) {
    super(`capture stage ${stage}: ${detail}`);
    this.name = 'CaptureStageError';
  }
}

/**
 * Make UNTRUSTED text (sim-controlled stderr, container-reported reasons) safe to carry in one
 * error message or result field: strip C0/C1 control characters and the Unicode line/paragraph
 * separators AND the bidi format controls (terminal-escape, log-injection and right-to-left
 * override smuggling — U+202E can visually reverse a log line the team reads), cap the LINE count, keep the TAIL of
 * the bytes (the newest evidence wins). Shared by the transport and the docker boundary so the
 * caps cannot drift apart.
 */
export function sanitizeUntrustedText(
  raw: string,
  opts: { maxBytes?: number; maxLines?: number } = {},
): string {
  const maxBytes = opts.maxBytes ?? 2_048;
  const maxLines = opts.maxLines ?? 40;
  // eslint-disable-next-line no-control-regex -- stripping control characters IS the point
  const stripped = raw.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  const lines = stripped.split('\n').filter((l) => l.trim().length > 0);
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxBytes ? `…${tail.slice(-maxBytes)}` : tail;
}
