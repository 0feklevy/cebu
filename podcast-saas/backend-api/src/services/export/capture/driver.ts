/**
 * The v2 handshake driver (plan §4 "Navigate directly to the simulation" + "Time virtualisation").
 *
 * It navigates TOP-LEVEL to the served sim URL (so `window.parent === window` and the child's
 * `postMessage(…, '*')` lands on the same window we listen on), then runs the v2 protocol:
 *
 *     navigate → SIM_READY → startScript{simpleUi,autoScript,hideSelectors} → SCRIPT_APPLIED
 *              → SIM_PAINTED → ~30 warmup frames discarded → exactly round(dur×fps) frames captured
 *
 * v3 is deliberately NOT used: `simRuntimeChild.ts` guards its MessagePort handshake with
 * `if (win.parent && win.parent !== win)`, so loaded top-level it never initiates — v2 is what every
 * stored package speaks anyway (plan §4 "⚠️ The v3 protocol will NOT initiate top-level").
 *
 * Because the clock is virtual, NOTHING advances unless we step frames — so the waits PUMP frames
 * while polling for each signal. Every wait is bounded by BOTH a wall-clock timeout (a real hang)
 * and a virtual-frame budget (deterministic, and where "sim never signals painted, capture hangs"
 * (§4 failure mode 5) is turned into a loud, typed failure instead of an infinite loop).
 *
 * This module is PURE orchestration: it talks to an injected `DriverDeps`, never to Playwright or
 * CDP, so the whole handshake — including the timeout-fails-loudly behaviour — is unit-tested with a
 * fake page and a fake postMessage.
 */

import { DEFAULT_WARMUP_FRAMES, frameCountFor } from './captureTypes.js';

/** Bounded-wait failure. Never a hang — every wait resolves or throws this. */
export class CaptureTimeoutError extends Error {
  readonly code = 'CAPTURE_TIMEOUT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CaptureTimeoutError';
  }
}

/** The moves the driver needs from a page. The real backends implement these over a browser. */
export interface DriverDeps {
  /** Navigate the top-level document to `url` (verbatim — query and fragment preserved) and wait DOM. */
  navigate(url: string): Promise<void>;
  /** Post a message to the sim window (top-level ⇒ `window.postMessage(msg, '*')`). */
  postToSim(message: Record<string, unknown>): Promise<void>;
  /** Messages the sim posted since the previous drain (the injected collector buffers them). */
  drainMessages(): Promise<ReadonlyArray<Record<string, unknown>>>;
  /** Advance the virtual clock to `virtualFrame` and run that frame's timers + rAF callbacks. */
  stepFrame(virtualFrame: number): Promise<void>;
  /** Capture the current (already-stepped) frame; `captureIndex` is 0-based over the kept frames. */
  captureFrame(captureIndex: number): Promise<void>;
  /** Real wall-clock now (ms) — for timeouts only, never for the sim's clock. */
  now(): number;
  /** Yield one real event-loop turn so an in-page `postMessage` gets delivered before the next drain. */
  yieldToEventLoop(): Promise<void>;
  log?(message: string): void;
}

export interface DriverOptions {
  /** The served top-level URL, already carrying `?section=&v=` and `#simboot=`. */
  url: string;
  /** Section id — the v2 `startScript` script name. */
  sectionId: string;
  simpleUi: boolean;
  autoScript: boolean;
  uiHide: readonly string[];
  fps: number;
  durationSec: number;
  /** Frames discarded after the handshake before the first kept frame. Default 30. */
  warmupFrames?: number;
  /** Wall-clock ceilings per wait phase. */
  readyTimeoutMs?: number;
  appliedTimeoutMs?: number;
  paintTimeoutMs?: number;
  /** Virtual-frame budget per wait phase — the deterministic loud-fail bound. */
  maxHandshakeFrames?: number;
  /** Send `clearBootHide` after the script applies (matches the viewer). Default true. */
  clearBootHide?: boolean;
  /** Pin the startScript token (tests). Otherwise a fresh one is generated. */
  token?: number;
}

export interface DriverResult {
  readonly frameCount: number;
  readonly warmupFrames: number;
  readonly totalFramesStepped: number;
  readonly sawReady: boolean;
  readonly sawApplied: boolean;
  readonly sawPainted: boolean;
  readonly token: number;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_APPLIED_TIMEOUT_MS = 10_000;
const DEFAULT_PAINT_TIMEOUT_MS = 15_000;

/** Parts of a served sim URL the top-level navigation MUST preserve (plan §4). */
export interface SimUrlParts {
  readonly section: string | null;
  readonly v: string | null;
  readonly hasSimboot: boolean;
}

/** Extract the dispatch query + boot-cloak fragment, for validation and logging. Never mutates. */
export function parseSimUrl(url: string): SimUrlParts {
  try {
    const u = new URL(url);
    return {
      section: u.searchParams.get('section'),
      v: u.searchParams.get('v'),
      hasSimboot: /(?:^|[#&])simboot=/.test(u.hash),
    };
  } catch {
    // Best-effort on a non-absolute string: still detect the fragment/query textually.
    const hashIdx = url.indexOf('#');
    const hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
    const q = url.slice(0, hashIdx >= 0 ? hashIdx : undefined);
    const sm = /[?&]section=([^&]*)/.exec(q);
    const vm = /[?&]v=([^&]*)/.exec(q);
    return {
      section: sm ? decodeURIComponent(sm[1]) : null,
      v: vm ? decodeURIComponent(vm[1]) : null,
      hasSimboot: /(?:^|[#&])simboot=/.test(hash),
    };
  }
}

function generateToken(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

/**
 * Run the full capture handshake and frame loop. Resolves with what happened, or rejects with
 * `CaptureTimeoutError` if any signal never arrives within its wall-clock timeout or frame budget.
 */
export async function runCaptureHandshake(deps: DriverDeps, options: DriverOptions): Promise<DriverResult> {
  const fps = options.fps;
  const warmupFrames = options.warmupFrames ?? DEFAULT_WARMUP_FRAMES;
  const captureFrames = frameCountFor(options.durationSec, fps);
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const appliedTimeoutMs = options.appliedTimeoutMs ?? DEFAULT_APPLIED_TIMEOUT_MS;
  const paintTimeoutMs = options.paintTimeoutMs ?? DEFAULT_PAINT_TIMEOUT_MS;
  // ~30 virtual seconds of frames is a generous per-phase budget; the handshake normally takes ≤3.
  const maxHandshakeFrames = options.maxHandshakeFrames ?? Math.max(600, fps * 30);
  const token = options.token ?? generateToken();
  const log = deps.log ?? (() => {});

  let virtualFrame = 0;
  const seen = { ready: false, applied: false, painted: false };

  const observe = (messages: ReadonlyArray<Record<string, unknown>>): void => {
    for (const m of messages) {
      const type = m.type;
      if (type === 'SIM_READY') seen.ready = true;
      else if (type === 'SCRIPT_APPLIED') {
        // A bridge that echoes the token must echo OURS; one that omits it (older bridge) still counts.
        if (m.token === undefined || m.token === token) seen.applied = true;
      } else if (type === 'SIM_PAINTED') seen.painted = true;
    }
  };

  const pumpUntil = async (predicate: () => boolean, label: string, timeoutMs: number): Promise<void> => {
    const start = deps.now();
    let framesThisPhase = 0;
    observe(await deps.drainMessages()); // a signal may already be buffered (SIM_READY at load)
    while (!predicate()) {
      if (deps.now() - start > timeoutMs) {
        throw new CaptureTimeoutError(
          `${label}: no signal within ${timeoutMs}ms (stepped ${framesThisPhase} frames)`,
        );
      }
      if (framesThisPhase >= maxHandshakeFrames) {
        throw new CaptureTimeoutError(`${label}: no signal within ${maxHandshakeFrames} virtual frames`);
      }
      virtualFrame += 1;
      framesThisPhase += 1;
      await deps.stepFrame(virtualFrame);
      await deps.yieldToEventLoop();
      observe(await deps.drainMessages());
    }
  };

  const parts = parseSimUrl(options.url);
  log(`navigate top-level: section=${parts.section ?? '(none)'} v=${parts.v ?? '(none)'} simboot=${parts.hasSimboot}`);
  await deps.navigate(options.url);

  await pumpUntil(() => seen.ready, 'SIM_READY', readyTimeoutMs);
  log('SIM_READY');

  const params: Record<string, unknown> = { simpleUi: options.simpleUi, autoScript: options.autoScript };
  if (options.uiHide.length > 0) params.hideSelectors = [...options.uiHide];
  await deps.postToSim({ type: 'startScript', script: options.sectionId, params, token });
  await deps.yieldToEventLoop();

  await pumpUntil(() => seen.applied, 'SCRIPT_APPLIED', appliedTimeoutMs);
  log('SCRIPT_APPLIED');

  if (options.clearBootHide !== false) {
    await deps.postToSim({ type: 'clearBootHide' });
    await deps.yieldToEventLoop();
  }

  await pumpUntil(() => seen.painted, 'SIM_PAINTED', paintTimeoutMs);
  log('SIM_PAINTED');

  // Warmup: several beginFrames may pass before the compositor answers (plan §4 mode 4). Discarded.
  for (let i = 0; i < warmupFrames; i++) {
    virtualFrame += 1;
    await deps.stepFrame(virtualFrame);
  }
  log(`discarded ${warmupFrames} warmup frames`);

  // Exactly round(dur×fps) kept frames — counted, so a missing one cannot silently shorten the clip.
  for (let c = 0; c < captureFrames; c++) {
    virtualFrame += 1;
    await deps.stepFrame(virtualFrame);
    await deps.captureFrame(c);
  }
  log(`captured ${captureFrames} frames`);

  return {
    frameCount: captureFrames,
    warmupFrames,
    totalFramesStepped: virtualFrame,
    sawReady: seen.ready,
    sawApplied: seen.applied,
    sawPainted: seen.painted,
    token,
  };
}
