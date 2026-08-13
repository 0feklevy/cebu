/**
 * The simulation capture worker core (Linear Video Export, Phase 2). The export service imports
 * ONLY from here — never a concrete backend, Playwright, or CDP directly.
 *
 * See LINEAR-VIDEO-EXPORT-PLAN.md §4 and its appendices. Two backends implement one interface:
 *   • PlaywrightScreenshotBackend — real Chrome + JS clock + screenshots; runs on macOS (verified).
 *   • BeginFrameBackend — chrome-headless-shell + beginFrame; Linux-container-only, macOS-unrunnable.
 */

export {
  CaptureUnavailable,
  CaptureGateFailed,
  DEFAULT_FRAME_EPOCH_MS,
  DEFAULT_WARMUP_FRAMES,
  frameCountFor,
  type CaptureSpec,
  type CaptureResult,
  type SimCaptureBackend,
} from './captureTypes.js';

export {
  buildInitScript,
  composeInitBody,
  clockShimSource,
  seededRandomSource,
  webglProbeSource,
  messageCollectorSource,
  mulberry32,
  hashToSeed,
  frameTimeMs,
  SIM_CLOCK_GLOBAL,
  SIM_CAPTURE_GLOBAL,
  type InitScriptOptions,
} from './injection.js';

export {
  runCaptureHandshake,
  parseSimUrl,
  CaptureTimeoutError,
  type DriverDeps,
  type DriverOptions,
  type DriverResult,
} from './driver.js';

export {
  evaluateSanityGate,
  isFrameUniform,
  frameSignature,
  type GateInput,
  type GateResult,
  type FrameSample,
} from './sanityGate.js';

export {
  PlaywrightScreenshotBackend,
  createPlaywrightScreenshotBackend,
  type PlaywrightBackendOptions,
} from './playwrightScreenshotBackend.js';

export {
  BeginFrameBackend,
  assembleBeginFrameFlags,
  assertNoForbiddenFlags,
  buildCreateTargetParams,
  buildAddInitScriptParams,
  buildScreenshotParams,
  buildBeginFrameSchedule,
  assertBeginFrameRunnable,
  DETERMINISTIC_MODE_SWITCHES,
  SELF_APPLIED_SWITCHES,
  GL_SWITCHES,
  FORBIDDEN_SWITCHES,
} from './beginFrameBackend.js';
