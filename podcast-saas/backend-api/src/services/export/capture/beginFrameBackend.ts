/**
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * │ CONTAINER-ONLY. macOS CANNOT RUN THIS (measured). Its tests are LOGIC-ONLY.                 │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * The deterministic capture backend: `chrome-headless-shell` + `--deterministic-mode` +
 * `HeadlessExperimental.beginFrame` (plan §4 Branch A). It is the CORRECT capture path — clock AND
 * compositor both driven — but it runs in a Linux container and NOWHERE ELSE:
 *
 *   • macOS is a hard blocker from Chromium source (`target_handler.cc`:
 *     `#if BUILDFLAG(IS_MAC) … "BeginFrameControl is not supported on MacOS yet"`). MEASURED: that
 *     exact error. So this cannot be verified on the dev Mac at all.
 *   • The whole `HeadlessExperimental` domain exists ONLY in `chrome-headless-shell`. MEASURED on
 *     Chrome 151 `--headless`: `-32601 "'HeadlessExperimental.beginFrame' wasn't found"`. Wrong
 *     binary ⇒ method-not-found (plan §4 "Verified by live measurement").
 *
 * THEREFORE: this file DOES NOT CLAIM TO CAPTURE HERE. It provides the parts that CAN be verified
 * without a browser and are pinned by unit tests — the exact flag set (the six `--deterministic-mode`
 * switches spelled out, the GL flags, and the forbidden list), the CDP message SHAPES
 * (`Target.createTarget` with `enableBeginFrameControl`, the beginFrame frame schedule, and the
 * measured JPEG-q80-`optimizeForSpeed` screenshot params — the 24 ms vs 267 ms / ~11× lever) — and a
 * `captureSection` that assembles all of that and then fails LOUDLY with `CaptureUnavailable` at the
 * transport boundary on any host where it cannot legitimately run. The CDP transport itself is wired
 * in the container by the isolation/Docker sibling (§0.2, Phase 2 Dockerfile), not here.
 */

import { buildInitScript } from './injection.js';
import {
  CaptureUnavailable,
  DEFAULT_FRAME_EPOCH_MS,
  DEFAULT_WARMUP_FRAMES,
  frameCountFor,
  type CaptureResult,
  type CaptureSpec,
  type SimCaptureBackend,
} from './captureTypes.js';

/**
 * The six switches `--deterministic-mode` implies, from `headless/lib/browser/command_line_handler.cc`
 * (read from source, not docs — plan §4 "Corrections and additions from a second research pass").
 * Spelled out so the intent is explicit and a hand-assembled command line can be checked against them.
 */
export const DETERMINISTIC_MODE_SWITCHES = [
  '--enable-begin-frame-control',
  '--run-all-compositor-stages-before-draw',
  '--disable-new-content-rendering-timeout',
  '--disable-image-animation-resync',
  '--disable-threaded-animation',
  '--disable-checker-imaging',
] as const;

/**
 * Flags we must set OURSELVES — `--deterministic-mode` does not touch scrollbars, DPI, the colour
 * profile, timer throttling, audio, or /dev/shm (plan §4 "`--deterministic-mode` is exactly six
 * switches and a veto").
 */
export const SELF_APPLIED_SWITCHES = [
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--force-color-profile=srgb',
  '--disable-background-timer-throttling',
  '--mute-audio',
  '--disable-dev-shm-usage',
] as const;

/**
 * GL flags. `--use-angle=swiftshader` is itself sufficient to permit the SwiftShader WebGL fallback
 * (plan §4 "`--enable-unsafe-swiftshader` is not actually required"), and `--enable-unsafe-swiftshader`
 * is kept as cheap belt-and-braces insurance.
 */
export const GL_SWITCHES = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] as const;

/**
 * Flags that MUST NEVER appear. `--site-per-process` makes `--deterministic-mode` refuse to start
 * (measured); `--disable-gpu` and `--use-angle=gl`/`--in-process-gpu`/`--single-process` all break
 * WebGL on a GPU-less box in one silent way or another (plan §4 "The trap that will actually bite
 * us"); `--deterministic-fetch` (removed M69) and `--disable-threaded-scrolling` (removed 2023) are
 * stale noise. `--no-sandbox` is excluded on purpose: keep Chrome's own sandbox, grant the container
 * the capabilities instead (§0.2).
 */
export const FORBIDDEN_SWITCHES = [
  '--site-per-process',
  '--disable-gpu',
  '--in-process-gpu',
  '--single-process',
  '--use-angle=gl',
  '--deterministic-fetch',
  '--disable-threaded-scrolling',
  '--no-sandbox',
] as const;

export interface BeginFrameFlagOptions {
  /** Capture width in px. */
  width: number;
  /** Capture height in px. */
  height: number;
  /** Extra flags to append (validated against the forbidden list). */
  extra?: readonly string[];
}

/**
 * Assemble the full `chrome-headless-shell` command-line flag set for deterministic capture. Pure;
 * pinned by tests. Includes `--deterministic-mode` itself AND its six switches spelled out (redundant
 * but explicit), the self-applied set, the GL set, and the window size. Throws if any flag is on the
 * forbidden list.
 */
export function assembleBeginFrameFlags(opts: BeginFrameFlagOptions): string[] {
  const flags = [
    '--deterministic-mode',
    ...DETERMINISTIC_MODE_SWITCHES,
    ...SELF_APPLIED_SWITCHES,
    ...GL_SWITCHES,
    `--window-size=${opts.width},${opts.height}`,
    ...(opts.extra ?? []),
  ];
  assertNoForbiddenFlags(flags);
  return flags;
}

/** Throw if any forbidden switch (by name, ignoring `=value`) is present. */
export function assertNoForbiddenFlags(flags: readonly string[]): void {
  const forbidden = new Set<string>(FORBIDDEN_SWITCHES);
  for (const f of flags) {
    const name = f.split('=')[0];
    // `--use-angle=gl` is forbidden specifically; `--use-angle=swiftshader` is allowed — compare full.
    if (forbidden.has(f) || (forbidden.has(name) && name !== '--use-angle')) {
      throw new Error(`beginFrame: forbidden Chrome flag present: ${f}`);
    }
  }
}

// ── CDP message shapes ────────────────────────────────────────────────────────────────────────

/** `Target.createTarget` params — `enableBeginFrameControl` is honoured only by headless-shell. */
export function buildCreateTargetParams(url: string, width: number, height: number): {
  method: 'Target.createTarget';
  params: { url: string; enableBeginFrameControl: true; width: number; height: number; newWindow: true };
} {
  return {
    method: 'Target.createTarget',
    params: { url, enableBeginFrameControl: true, width, height, newWindow: true },
  };
}

/** `Page.addScriptToEvaluateOnNewDocument` — installs the document-start clock/PRNG/probe bundle. */
export function buildAddInitScriptParams(source: string): {
  method: 'Page.addScriptToEvaluateOnNewDocument';
  params: { source: string };
} {
  return { method: 'Page.addScriptToEvaluateOnNewDocument', params: { source } };
}

/**
 * The measured screenshot params: JPEG, quality 80, `optimizeForSpeed`. 24 ms/frame vs 267 ms for
 * default PNG — "the single biggest lever" (plan APPENDIX / §4).
 */
export function buildScreenshotParams(): { format: 'jpeg'; quality: 80; optimizeForSpeed: true } {
  return { format: 'jpeg', quality: 80, optimizeForSpeed: true };
}

export interface BeginFrameStep {
  readonly method: 'HeadlessExperimental.beginFrame';
  readonly params: {
    frameTimeTicks: number;
    interval: number;
    noDisplayUpdates: boolean;
    screenshot?: { format: 'jpeg'; quality: 80; optimizeForSpeed: true };
  };
}

/**
 * The frame schedule for one section: `totalFrames` beginFrames at `1000/fps` ms apart, each
 * `frameTimeTicks` exactly `startTicks + k·interval` so the compositor clock matches the JS virtual
 * clock frame-for-frame. `capture[k]` says whether that frame is read back (warmup frames are not).
 */
export function buildBeginFrameSchedule(opts: {
  fps: number;
  totalFrames: number;
  warmupFrames: number;
  startTicks?: number;
}): BeginFrameStep[] {
  const interval = 1000 / opts.fps;
  const startTicks = opts.startTicks ?? DEFAULT_FRAME_EPOCH_MS;
  const steps: BeginFrameStep[] = [];
  for (let k = 0; k < opts.totalFrames; k++) {
    const isWarmup = k < opts.warmupFrames;
    steps.push({
      method: 'HeadlessExperimental.beginFrame',
      params: {
        frameTimeTicks: startTicks + k * interval,
        interval,
        // Warmup frames only prime the compositor; no readback and no display churn.
        noDisplayUpdates: isWarmup,
        ...(isWarmup ? {} : { screenshot: buildScreenshotParams() }),
      },
    });
  }
  return steps;
}

/**
 * This host cannot run beginFrame. macOS: the measured Chromium error. Anything else: the transport
 * is not wired in this build (it belongs to the container). Either way, a `CaptureUnavailable` that
 * the export service turns into the poster fallback.
 */
export function assertBeginFrameRunnable(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin') {
    throw new CaptureUnavailable(
      'beginFrame is not supported on macOS (Chromium: "BeginFrameControl is not supported on MacOS yet"). ' +
        'This backend is Linux-container-only.',
    );
  }
  throw new CaptureUnavailable(
    'beginFrame backend: the CDP transport is not wired in this build — it runs only in the Phase-2 ' +
      'Linux container (chrome-headless-shell). Use the Playwright screenshot backend for local dev.',
  );
}

/**
 * The beginFrame backend. `isAvailable()` is honest (false on macOS, and false here because the
 * transport is container-wired); `captureSection` assembles the flags, init script, and frame
 * schedule (all exercised) and then refuses loudly at the transport boundary.
 */
export class BeginFrameBackend implements SimCaptureBackend {
  readonly name = 'begin-frame';

  async isAvailable(): Promise<boolean> {
    // Never available on macOS; and this build does not ship the CDP transport, so: not here.
    return false;
  }

  async captureSection(spec: CaptureSpec): Promise<CaptureResult> {
    // Assemble everything that CAN be built without a browser — the parts under test.
    const totalFrames = DEFAULT_WARMUP_FRAMES + frameCountFor(spec.durationSec, spec.fps);
    assembleBeginFrameFlags({ width: spec.width, height: spec.height });
    buildInitScript({ fps: spec.fps, configHash: spec.configHash, epochMs: DEFAULT_FRAME_EPOCH_MS });
    buildBeginFrameSchedule({ fps: spec.fps, totalFrames, warmupFrames: DEFAULT_WARMUP_FRAMES });
    // …then stop at the boundary this build does not cross.
    assertBeginFrameRunnable();
    // Unreachable — assertBeginFrameRunnable always throws. Keeps the return type honest.
    throw new CaptureUnavailable('beginFrame backend is not runnable on this host');
  }
}
