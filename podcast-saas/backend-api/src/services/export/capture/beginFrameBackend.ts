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
 * This file owns the beginFrame CAPTURE POLICY and composes the pieces that already ship:
 *
 *   flag policy + CDP message shapes + frame schedule   (this file — unit-pinned)
 *        ↓
 *   document-start injection (`injection.ts`) + bridge handshake (`driver.ts` `runCaptureHandshake`)
 *        ↓
 *   `DriverDeps` — implemented here over CDP commands
 *        ↓
 *   the thin pipe transport (`cdpPipeTransport.ts` — the one piece that was missing)
 *        ↓
 *   chrome-headless-shell
 *
 * There is exactly ONE beginFrame backend. The v0.1.22 incident: this module exported no
 * `createBackend()`/default, so the container's `loadBackend()` could never instantiate it — and
 * `captureSection` was a stub that threw unconditionally, so the transport had never been wired at
 * all. Both are fixed here, compositionally: no duplicate navigation/handshake/gate logic exists —
 * the same `runCaptureHandshake`/`buildInitScript`/`evaluateSanityGate` the Playwright backend uses
 * drive this one. Failures carry a `CaptureStage` so the next incident names its stage instead of
 * "container exited 1".
 */

import { access, constants as fsConstants, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchHeadlessShell, type CdpEvent, type HeadlessShellHandle } from './cdpPipeTransport.js';
import { CaptureTimeoutError, runCaptureHandshake, type DriverDeps } from './driver.js';
import { buildInitScript } from './injection.js';
import { evaluateSanityGate, type FrameSample } from './sanityGate.js';
import {
  CaptureStageError,
  CaptureUnavailable,
  DEFAULT_FRAME_EPOCH_MS,
  frameCountFor,
  type CaptureResult,
  type CaptureSpec,
  type CaptureStage,
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
 * The two renderer profiles, and the reason this is a typed allowlist rather than a passthrough.
 *
 * Software rasterisation is ~97 % of a captured frame's cost (measured: 5193 ms of 5366 ms at
 * 640×360), so hardware rendering is the only lever that changes the throughput picture. But moving
 * the same image onto a GPU host does NOTHING on its own — `GL_SWITCHES` pins SwiftShader, so the
 * capture would keep rasterising in software on an expensive machine and the only visible change
 * would be the bill. That failure is silent, which is why the mode is explicit and verified after
 * the fact rather than assumed from the hardware.
 *
 * `--use-angle=gl` stays forbidden in both profiles: it is the flag that breaks WebGL outright on a
 * GPU-less box, and the hardware path must be reached deliberately, not by relaxing a guard.
 */
export const RENDERER_PROFILES = {
  swiftshader: GL_SWITCHES,
  // Vulkan through ANGLE, which is what a real GPU actually exposes to headless Chrome. Every switch
  // here must be proven on the target image before this profile is selected in production.
  hardware: ['--use-angle=vulkan', '--enable-features=Vulkan'] as const,
} as const;

export type RendererProfile = keyof typeof RENDERER_PROFILES;

/** Read the operator's chosen profile. Anything unrecognised is the safe, shipped one. */
export function resolveRendererProfile(value = process.env.EXPORT_CAPTURE_RENDERER): RendererProfile {
  return value === 'hardware' ? 'hardware' : 'swiftshader';
}

/**
 * Fail closed when hardware was asked for and software is what ran.
 *
 * The whole point of the hardware profile is the ~97 % of frame cost that SwiftShader spends. If the
 * driver is missing, the device is not exposed, or a flag was wrong, Chrome falls back to SwiftShader
 * and reports it in the renderer string — and everything still WORKS, just as slowly as before, on a
 * machine chosen for being fast. Left unchecked that is an invisible regression paid for by the
 * hour; checked, it is a loud failure on the first capture.
 */
export function assertRendererMatchesProfile(profile: RendererProfile, rendererString: string): void {
  if (profile !== 'hardware') return;
  if (/swiftshader|llvmpipe|software/i.test(rendererString)) {
    throw new CaptureStageError(
      'sanity_gate',
      `renderer profile "hardware" was requested but the capture rendered in software: ${rendererString.slice(0, 160)}`,
    );
  }
}

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
  /** Which renderer profile to assemble for. Defaults to the shipped software one. */
  profile?: RendererProfile;
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
    ...RENDERER_PROFILES[opts.profile ?? 'swiftshader'],
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
 * Refuse hosts that cannot run beginFrame. macOS: the measured Chromium error. Elsewhere: the
 * pinned browser must be named by `CHROME_HEADLESS_SHELL_PATH` (baked into the worker image).
 * Throws `CaptureUnavailable` — the export service's poster-fallback signal.
 */
export function assertBeginFrameRunnable(
  platform: NodeJS.Platform = process.platform,
  executablePath: string | undefined = process.env.CHROME_HEADLESS_SHELL_PATH,
): string {
  if (platform === 'darwin') {
    throw new CaptureUnavailable(
      'beginFrame is not supported on macOS (Chromium: "BeginFrameControl is not supported on MacOS yet"). ' +
        'This backend is Linux-container-only.',
    );
  }
  if (!executablePath) {
    throw new CaptureUnavailable(
      'beginFrame backend: CHROME_HEADLESS_SHELL_PATH is not set — outside the export-worker container ' +
        'there is no pinned browser. Use the Playwright screenshot backend for local dev.',
    );
  }
  return executablePath;
}

const NAV_TIMEOUT_MS = 30_000;
/** Real-clock pause between navigation beginFrame pumps (load progress under deterministic mode). */
const NAV_PUMP_INTERVAL_MS = 50;

export interface BeginFrameBackendOptions {
  /** Override the browser binary (default: `CHROME_HEADLESS_SHELL_PATH`, baked into the image). */
  executablePath?: string;
  /** Base dir for frames + the browser profile. Default: os tmpdir (the container's tmpfs /tmp). */
  workDir?: string;
  /** Transport seam for tests: a fake launcher avoids any real Chrome. */
  launch?: typeof launchHeadlessShell;
  /** Platform seam for tests. */
  platform?: NodeJS.Platform;
  /** Canvas-region gate sample grid (gridN × gridN). Default 24. */
  gridN?: number;
  /** How many frames across the capture to sample for the gate. Default 6 (min 2). */
  sampleCount?: number;
  log?: (message: string) => void;
}

/** Even sample indices across [0, frameCount), always including the first and last. */
function sampleIndices(frameCount: number, sampleCount: number): Set<number> {
  const n = Math.max(2, Math.min(sampleCount, frameCount));
  const out = new Set<number>();
  if (frameCount <= 0) return out;
  if (frameCount === 1) return new Set([0]);
  for (let i = 0; i < n; i++) out.add(Math.round((i * (frameCount - 1)) / (n - 1)));
  return out;
}

/** Base64 as CDP hands it back. Asserted before the string is embedded in an evaluated expression. */
const BASE64_ONLY = /^[A-Za-z0-9+/=]*$/;

/**
 * Canvas-region sampler over the **composited frame that was just captured** — the exact JPEG bytes
 * about to be written to disk and fed to the encoder.
 *
 * The obvious sampler — `drawImage(theCanvas, …)` in the page, which the Playwright backend still
 * uses — has a spec-level blind spot: a WebGL drawing buffer is cleared once composited unless the
 * context was created with `preserveDrawingBuffer: true`, so reading it back yields transparent
 * black. Real sims do not set that flag (the production `boids-3d` package does not), which made the
 * gate report `uniform_canvas` for a simulation that was rendering perfectly — a false RED that hid
 * behind the identical symptom of the real v0.1.26 dead-canvas failure.
 *
 * Sampling the screenshot removes the blind spot rather than working around it, and is what the gate
 * should always have judged: the artifact itself. Chrome decodes its own JPEG from a `data:` URL,
 * which needs no decoder dependency and no network (`--network none` stays intact). The canvas
 * bounding box is mapped into image pixels so the gate keeps its canvas-region semantics — a static
 * UI around a dead canvas must still fail.
 */
export function compositedSamplerExpression(gridN: number, jpegBase64: string): string {
  if (!BASE64_ONLY.test(jpegBase64)) {
    throw new CaptureStageError('sanity_gate', 'screenshot data is not base64; refusing to evaluate it');
  }
  return `(async () => {
    const d = globalThis.document; if (!d) return 'null';
    const img = new Image();
    img.src = 'data:image/jpeg;base64,${jpegBase64}';
    try { await img.decode(); } catch { return 'null'; }
    const iw = img.naturalWidth || 0, ih = img.naturalHeight || 0;
    if (iw <= 0 || ih <= 0) return 'null';

    // NO CANVAS IS NOT A MISSING SAMPLE (media-003). A DOM or SVG simulation has no canvas region
    // to crop to, and answering 'null' made the gate see zero samples and fail on checks that were
    // never applicable — throwing away JPEGs that were already correct on disk. The whole viewport
    // IS the content for such a document, so it is sampled, and flagged so the gate knows to
    // suspend its canvas-specific checks rather than apply them to the wrong thing.
    const cs = Array.from(d.querySelectorAll('canvas'));
    const canvasRegion = cs.length > 0;

    // The screenshot is the viewport; map the canvas box from CSS px into image px.
    const vw = globalThis.innerWidth || iw, vh = globalThis.innerHeight || ih;
    const sx = iw / vw, sy = ih / vh;
    let x = 0, y = 0, w = iw, h = ih;
    if (canvasRegion) {
      let best = cs[0], bestArea = 0;
      for (const c of cs) { const a = (c.width||0)*(c.height||0); if (a > bestArea) { bestArea = a; best = c; } }
      const r = best.getBoundingClientRect();
      x = Math.round(r.left * sx); y = Math.round(r.top * sy);
      w = Math.round(r.width * sx); h = Math.round(r.height * sy);
      // Clamp to the image; a canvas scrolled or sized out of the viewport is not a sample.
      x = Math.max(0, Math.min(x, iw - 1)); y = Math.max(0, Math.min(y, ih - 1));
      w = Math.min(w, iw - x); h = Math.min(h, ih - y);
      if (w < 1 || h < 1) return 'null';
    }
    const off = d.createElement('canvas'); off.width = ${gridN}; off.height = ${gridN};
    const g = off.getContext('2d', { willReadFrequently: true }); if (!g) return 'null';
    try { g.drawImage(img, x, y, w, h, 0, 0, ${gridN}, ${gridN}); } catch { return 'null'; }
    const data = g.getImageData(0, 0, ${gridN}, ${gridN}).data;
    return JSON.stringify({ width: ${gridN}, height: ${gridN}, rgba: Array.from(data), canvasRegion: canvasRegion });
  })()`;
}

/**
 * THE beginFrame backend — the single production capture implementation. One instance per
 * container run; `captureSection` launches the pinned browser, reuses the shipped handshake, pumps
 * `HeadlessExperimental.beginFrame`, and returns a `frame-%06d.jpg` directory (the exact pattern
 * the trusted side's encoder expects).
 */
export class BeginFrameBackend implements SimCaptureBackend {
  readonly name = 'begin-frame';

  constructor(private readonly opts: BeginFrameBackendOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    if (this.opts.launch) return true; // transport injected (tests) — always runnable
    const platform = this.opts.platform ?? process.platform;
    const exe = this.opts.executablePath ?? process.env.CHROME_HEADLESS_SHELL_PATH;
    if (platform === 'darwin' || !exe) return false;
    try {
      await access(exe, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async captureSection(spec: CaptureSpec): Promise<CaptureResult> {
    const log = this.opts.log ?? (() => {});
    const executablePath =
      this.opts.launch ? (this.opts.executablePath ?? 'injected-transport')
      : assertBeginFrameRunnable(this.opts.platform ?? process.platform, this.opts.executablePath ?? process.env.CHROME_HEADLESS_SHELL_PATH);

    const base = this.opts.workDir ?? tmpdir();
    const jobDir = await mkdtemp(join(base, `beginframe-${spec.sectionId.slice(0, 8)}-`));
    const framesDir = join(jobDir, 'frames');
    const profileDir = join(jobDir, 'profile');
    await mkdir(framesDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    // Policy: the pinned flag set (validated against the forbidden list) + the profile location.
    //
    // FROM THE SPEC, and required. This used to fall back to EXPORT_CAPTURE_RENDERER read inside
    // the container — the untrusted side deciding what the trusted side believed it was buying —
    // and empty defaulted to software, which is the silent fallback the hardware profile exists to
    // make loud. The spec is authored by the trusted side and verified against the frozen plan, so
    // it is the only acceptable source; anything else fails before a browser is launched.
    const rendererProfile = spec.rendererProfile;
    if (rendererProfile !== 'swiftshader' && rendererProfile !== 'hardware') {
      throw new CaptureStageError(
        'backend_load',
        `capture spec names no valid renderer profile (got ${JSON.stringify(String(rendererProfile ?? '')).slice(0, 34)}); ` +
          'the trusted side must decide the renderer — the container environment does not',
      );
    }
    const flags = assembleBeginFrameFlags({
      width: spec.width,
      height: spec.height,
      profile: rendererProfile,
      extra: [`--user-data-dir=${profileDir}`, '--no-first-run'],
    });

    const launch = this.opts.launch ?? launchHeadlessShell;
    let handle: HeadlessShellHandle;
    try {
      handle = launch({ executablePath, flags, log });
    } catch (err) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});
      throw err instanceof CaptureStageError
        ? err
        : new CaptureStageError('chrome_launch', err instanceof Error ? err.message : String(err));
    }
    const cdp = handle.connection;

    const stage = async <T>(name: CaptureStage, work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (err) {
        if (err instanceof CaptureStageError || err instanceof CaptureUnavailable) throw err;
        throw new CaptureStageError(name, err instanceof Error ? err.message : String(err));
      }
    };

    try {
      // ── CDP bootstrap: target with beginFrame control, page session, document-start injection ──
      const sessionId = await stage('cdp_connect', async () => {
        const target = buildCreateTargetParams('about:blank', spec.width, spec.height);
        const created = await cdp.send(target.method, { ...target.params });
        const attached = await cdp.send('Target.attachToTarget', {
          targetId: created.targetId as string,
          flatten: true,
        });
        const sid = attached.sessionId as string;
        await cdp.send('Page.enable', {}, sid);
        await cdp.send('Runtime.enable', {}, sid);
        const init = buildAddInitScriptParams(
          buildInitScript({ fps: spec.fps, configHash: spec.configHash, epochMs: DEFAULT_FRAME_EPOCH_MS }),
        );
        await cdp.send(init.method, { ...init.params }, sid);
        return sid;
      });

      // Where the capture loop's wall clock actually goes. Measured because the answer decides an
      // infrastructure question and could not be inferred: a cost dominated by `sim` is the
      // simulation's own JS on the CPU, which a GPU would barely improve, while a cost dominated by
      // `raster` is SwiftShader software rendering, which is exactly what a GPU replaces. Four
      // buckets, monotonic clock, no allocation per frame.
      const cost = { sim: 0, flush: 0, raster: 0, write: 0 };
      const timed = async <T>(bucket: keyof typeof cost, fn: () => Promise<T>): Promise<T> => {
        const t0 = performance.now();
        try {
          return await fn();
        } finally {
          cost[bucket] += performance.now() - t0;
        }
      };

      // Runtime.evaluate wrapper: an in-page exception is a real failure at the calling stage.
      const evalInPage = async (
        expression: string,
        opts: { awaitPromise?: boolean; stage: CaptureStage },
      ): Promise<unknown> => {
        return stage(opts.stage, async () => {
          const res = await cdp.send(
            'Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: opts.awaitPromise ?? false },
            sessionId,
          );
          const exception = res.exceptionDetails as { text?: string } | undefined;
          if (exception) throw new Error(`in-page exception: ${exception.text ?? 'unknown'}`);
          return (res.result as { value?: unknown } | undefined)?.value;
        });
      };

      // ── beginFrame pump: ONE compositor frame per virtual frame, the schedule's exact shape ─────
      // The compositor clock must advance in LOCKSTEP with the JS virtual clock (the schedule pins
      // exactly `totalFrames` beginFrames at `interval` apart). So a `stepFrame` DEFERS its
      // beginFrame: a captured frame's single beginFrame is the screenshot one; an uncaptured
      // frame's (handshake/warmup) is flushed — without display churn, the schedule's warmup
      // semantics — right before the next step. Never two compositor frames per virtual frame.
      const interval = 1000 / spec.fps;
      let ticks = DEFAULT_FRAME_EPOCH_MS;
      let pendingStepFlush = false;
      const beginFrame = async (withScreenshot: boolean): Promise<string | null> => {
        return stage(withScreenshot ? 'screenshot' : 'begin_frame', async () => {
          const params: Record<string, unknown> = {
            frameTimeTicks: ticks,
            interval,
            noDisplayUpdates: !withScreenshot,
            ...(withScreenshot ? { screenshot: buildScreenshotParams() } : {}),
          };
          ticks += interval;
          const res = await cdp.send('HeadlessExperimental.beginFrame', params, sessionId);
          return typeof res.screenshotData === 'string' ? res.screenshotData : null;
        });
      };

      const samples: FrameSample[] = [];
      const captureFrames = frameCountFor(spec.durationSec, spec.fps);
      const toSample = sampleIndices(captureFrames, this.opts.sampleCount ?? 6);
      const gridN = this.opts.gridN ?? 24;
      let msgCursor = 0;

      const deps: DriverDeps = {
        navigate: async (url) => {
          await stage('navigation', async () => {
            const dom = cdp.waitForEvent('Page.domContentEventFired', sessionId, NAV_TIMEOUT_MS);
            let settled = false;
            const raced = dom.then(
              (event: CdpEvent) => { settled = true; return event; },
              (err: unknown) => { settled = true; throw err; },
            );
            // Deterministic mode: renderer progress can be frame-gated, so pump while waiting. The
            // pump's own failure (e.g. Chrome died — its sends reject the instant the pipe shuts
            // down) must NEVER become an orphaned rejection: both promises are settled together,
            // and the FIRST classified error wins. The waitForEvent side fails fast too —
            // CdpConnection.shutdown() rejects event waiters with the "chrome exited …" reason.
            let pumpError: unknown = null;
            const pump = (async () => {
              try {
                while (!settled) {
                  await beginFrame(false);
                  await new Promise((resolve) => setTimeout(resolve, NAV_PUMP_INTERVAL_MS));
                }
              } catch (err) {
                pumpError = err;
              }
            })();
            try {
              const nav = await cdp.send('Page.navigate', { url }, sessionId);
              if (typeof nav.errorText === 'string' && nav.errorText) {
                throw new Error(`Page.navigate: ${nav.errorText}`);
              }
              await raced;
            } finally {
              settled = true;
              raced.catch(() => {}); // never leave the dom promise orphaned on an early throw
              await pump;
            }
            if (pumpError) throw pumpError;
          });
        },
        postToSim: async (message) => {
          await evalInPage(`window.postMessage(${JSON.stringify(message)}, '*')`, { stage: 'start_script' });
        },
        drainMessages: async () => {
          const raw = await evalInPage(
            `JSON.stringify((((globalThis.__SIM_CAPTURE__ || {}).messages) || []).slice(${msgCursor}))`,
            { stage: 'bridge_ready' },
          );
          const batch = JSON.parse(String(raw ?? '[]')) as Array<Record<string, unknown>>;
          msgCursor += batch.length;
          return batch;
        },
        stepFrame: async (virtualFrame) => {
          if (pendingStepFlush) await timed('flush', () => beginFrame(false)); // the PREVIOUS uncaptured frame
          pendingStepFlush = false;
          await timed('sim', () =>
            evalInPage(
              `globalThis.__SIM_CLOCK__ && globalThis.__SIM_CLOCK__.advanceToFrame(${virtualFrame})`,
              { stage: 'begin_frame' },
            ),
          );
          pendingStepFlush = true;
        },
        captureFrame: async (captureIndex) => {
          pendingStepFlush = false; // THIS frame's single beginFrame is the screenshot one
          const data = await timed('raster', () => beginFrame(true));
          if (!data) {
            throw new CaptureStageError('screenshot', `beginFrame returned no screenshotData at frame ${captureIndex}`);
          }
          const name = `frame-${String(captureIndex).padStart(6, '0')}.jpg`;
          await timed('write', () => writeFile(join(framesDir, name), Buffer.from(data, 'base64')));
          if (toSample.has(captureIndex)) {
            const raw = await evalInPage(compositedSamplerExpression(gridN, data), {
              awaitPromise: true,
              stage: 'sanity_gate',
            });
            const parsed = JSON.parse(String(raw ?? 'null')) as FrameSample | null;
            if (parsed) samples.push(parsed);
          }
        },
        now: () => Date.now(),
        yieldToEventLoop: async () => {
          await evalInPage(
            'new Promise((resolve) => { const c = globalThis.__SIM_CLOCK__; (c && c.realSetTimeout ? c.realSetTimeout : setTimeout)(resolve, 0); })',
            { awaitPromise: true, stage: 'bridge_ready' },
          );
        },
        log,
      };

      let run;
      try {
        run = await runCaptureHandshake(deps, {
          url: spec.servedSimUrl,
          sectionId: spec.sectionId,
          simpleUi: spec.simpleUi,
          autoScript: spec.autoScript,
          uiHide: spec.uiHide,
          fps: spec.fps,
          durationSec: spec.durationSec,
          // Passed through VERBATIM, including 0 and including undefined. `runCaptureHandshake`
          // owns the single default; applying one here too meant two places could disagree, and a
          // deliberate 0 had to survive both of them to mean anything.
          warmupFrames: spec.warmupFrames,
        });
      } catch (err) {
        if (err instanceof CaptureTimeoutError) {
          const timeoutStage: CaptureStage = err.message.startsWith('SIM_READY')
            ? 'bridge_ready'
            : err.message.startsWith('SIM_PAINTED')
              ? 'paint_ready'
              : 'start_script';
          throw new CaptureStageError(timeoutStage, err.message);
        }
        throw err;
      }

      // RENDERER IDENTITY, read where the page cannot reach it.
      //
      // This used to read `globalThis.__SIM_CAPTURE__.webgl`, which the simulation's own code can
      // overwrite — the object lives in the page's world, so any package could have reported
      // "NVIDIA RTX" while SwiftShader did the work, and `assertRendererMatchesProfile` would have
      // been satisfied by a string the untrusted side chose. That is not a hypothetical for the
      // hardware profile: its entire purpose is to catch a silent fall back to software, and the
      // check was reading the one field the fallback's beneficiary controls.
      //
      // An ISOLATED WORLD has its own JS globals and prototypes while sharing the DOM, so a context
      // created here is not reachable by page script: `getContext('webgl')` and
      // `WEBGL_debug_renderer_info` resolve to the browser's real implementations. The page probe is
      // still consulted for `attempted` — whether the SIMULATION tried to make a context is a fact
      // about the page and belongs to the page — but never for identity.
      const webgl = await stage('sanity_gate', async () => {
        const tree = await cdp.send('Page.getFrameTree', {}, sessionId);
        const frameId = ((tree.frameTree as { frame?: { id?: string } } | undefined)?.frame?.id) ?? '';
        // `grantUniveralAccess` is spelled that way in the CDP protocol itself; false is the point —
        // the probe world must not be handed access back into the page's.
        const world = await cdp.send('Page.createIsolatedWorld',
          { frameId, worldName: 'flowvid-capture-probe', grantUniveralAccess: false },
          sessionId);
        const trusted = await cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify((() => {
            try {
              const c = document.createElement('canvas');
              const gl = c.getContext('webgl2') || c.getContext('webgl');
              if (!gl) return { ok: false, renderer: '' };
              const ext = gl.getExtension('WEBGL_debug_renderer_info');
              const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
              return { ok: true, renderer: String(renderer || '') };
            } catch { return { ok: false, renderer: '' }; }
          })())`,
          contextId: world.executionContextId as number,
          returnByValue: true,
        }, sessionId);
        const identity = JSON.parse(
          String((trusted.result as { value?: unknown } | undefined)?.value ?? '{"ok":false,"renderer":""}'),
        ) as { ok: boolean; renderer: string };

        // Page-sourced, and used ONLY for "did the simulation ask for a context" — advisory, never
        // identity, and coerced to a boolean so a hostile value cannot carry anything else.
        const raw = await evalInPage(
          `JSON.stringify((() => { const c = globalThis.__SIM_CAPTURE__; const r = c && c.webgl;
             return { attempted: !!(r && r.attempted) }; })())`,
          { stage: 'sanity_gate' },
        );
        const page = JSON.parse(String(raw)) as { attempted: boolean };
        return { attempted: !!page.attempted, ok: identity.ok, renderer: identity.renderer };
      });

      const kept = Math.max(1, run.frameCount);
      const ms = (v: number) => Math.round(v);
      // Returned as DATA on the result, so it survives an exit-0 run and reaches the trusted side
      // through the same validated channel as everything else. It is also logged, but the log is a
      // convenience — stderr is untrusted text here, never a channel anything reads back.
      const costBreakdown = {
        simMs: ms(cost.sim / kept),
        flushMs: ms(cost.flush / kept),
        rasterMs: ms(cost.raster / kept),
        writeMs: ms(cost.write / kept),
        frames: kept,
      };
      log(
        `cost/frame ${costBreakdown.simMs + costBreakdown.flushMs + costBreakdown.rasterMs + costBreakdown.writeMs}ms ` +
          `= sim ${costBreakdown.simMs} + flush ${costBreakdown.flushMs} ` +
          `+ raster ${costBreakdown.rasterMs} + write ${costBreakdown.writeMs} (over ${kept} frames)`,
      );

      // Fail closed BEFORE the gate: if hardware was asked for and SwiftShader answered, the
      // capture is correct and the machine is wasted, which no gate would ever notice.
      assertRendererMatchesProfile(rendererProfile, webgl.renderer);

      const gate = evaluateSanityGate({ simPainted: run.sawPainted, webgl, frames: samples });
      log(`gate ${gate.gate}${gate.reason ? `: ${gate.reason}` : ''} (renderer="${webgl.renderer}")`);

      return {
        framesDir,
        frameCount: run.frameCount,
        rendererString: webgl.renderer,
        gate: gate.gate,
        reason: gate.reason,
        cost: costBreakdown,
      };
    } catch (err) {
      // Partial frames from a FAILED capture are worthless and must not linger on the tmpfs.
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      await handle.kill().catch(() => {});
      // On success the frames dir must OUTLIVE this call (the adapter relocates it); the profile
      // must not. (On failure the whole jobDir is already gone — this rm is a no-op.)
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * The plugin-contract factory `isolation/main.ts` loads via `EXPORT_CAPTURE_BACKEND_MODULE` —
 * the export whose ABSENCE was the v0.1.22 incident ("exports neither createBackend() nor a
 * default backend", every capture container exiting 1 before any capture code ran).
 */
export function createBackend(): SimCaptureBackend {
  // With no `log`, the backend's diagnostics — including the per-frame cost breakdown that decides
  // the renderer-hardware question — are discarded, which is exactly what happened: the constructor
  // took no options, so every stage line and every measurement written by this file went nowhere.
  //
  // stderr is the right channel and the only one available: the container writes its result to a
  // file, and the trusted side already treats this stream as UNTRUSTED diagnostic text (it is
  // sanitised and length-capped, never parsed as a control signal). So this is observable without
  // becoming an input.
  return new BeginFrameBackend({
    log: (message) => {
      process.stderr.write(`[capture] ${message}\n`);
    },
  });
}
