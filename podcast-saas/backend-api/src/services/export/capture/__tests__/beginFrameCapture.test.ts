/**
 * The REAL `BeginFrameBackend.captureSection`, driven end-to-end against a scripted fake CDP
 * transport (the injection seam) — no Chrome, runs on macOS. What this proves: the backend
 * composes the SHIPPED handshake (`runCaptureHandshake`), pumps beginFrame per the schedule's
 * shape, writes `frame-%06d.jpg` files (the exact pattern the trusted-side encoder expects),
 * samples the gate, and — adversarially — classifies failures by stage and ALWAYS reaps Chrome.
 * The real-Chrome behaviour of the same path is the smoke's Stage C on the Linux host.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BeginFrameBackend } from '../beginFrameBackend.js';
import { CaptureStageError, type CaptureSpec } from '../captureTypes.js';
import type { CdpEvent, HeadlessShellHandle, launchHeadlessShell } from '../cdpPipeTransport.js';

const SPEC: CaptureSpec = {
  servedSimUrl: 'http://127.0.0.1:39999/index.html?section=sec-1&v=abc',
  sectionId: 'sec-1',
  simpleUi: true,
  autoScript: true,
  uiHide: [],
  durationSec: 0.5,
  fps: 10, // 5 capture frames — small on purpose; warmup is the fixed 30
  width: 640,
  height: 360,
  configHash: 'cfg',
  posterKey: 'poster',
};

interface FakeOptions {
  /** Never emit SIM_READY (drives the handshake to its bounded failure). */
  silentBridge?: boolean;
  /** Emit SIM_READY but never SIM_PAINTED (the paint gate's own bounded failure). */
  neverPaints?: boolean;
  /** beginFrame screenshots come back without data. */
  noScreenshotData?: boolean;
  /** Reject every send after the Nth with a dead-chrome error. */
  dieAfterSends?: number;
  /** Chrome dies once `Page.navigate` has been acknowledged (the mid-navigation death). */
  dieAfterNavigate?: boolean;
  /** What the ISOLATED-WORLD renderer probe reports. Page script cannot influence this one. */
  rendererString?: string;
}

/** A scripted CDP endpoint speaking exactly the choreography the backend performs. */
function fakeLaunch(opts: FakeOptions = {}): {
  launch: typeof launchHeadlessShell;
  state: {
    kills: number;
    sends: number;
    screenshots: number;
    beginFrames: number;
    /** Every page-scoped send must carry the attached session — a real CDP requirement. */
    sendsMissingSession: string[];
    isolatedWorlds: number;
    dead: boolean;
  };
} {
  const state = {
    kills: 0, sends: 0, screenshots: 0, beginFrames: 0, isolatedWorlds: 0,
    sendsMissingSession: [] as string[], dead: false,
  };
  const messages: Array<Record<string, unknown>> = opts.silentBridge ? [] : [{ type: 'SIM_READY' }];
  let sampleCall = 0;
  /** Methods that are browser-scoped; everything else MUST be session-scoped once attached. */
  const BROWSER_SCOPED = new Set(['Target.createTarget', 'Target.attachToTarget']);
  let waiterReject: ((err: Error) => void) | null = null;

  const send = async (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> => {
    state.sends += 1;
    if (state.dead || (opts.dieAfterSends !== undefined && state.sends > opts.dieAfterSends)) {
      throw new CaptureStageError('chrome_launch', 'chrome exited 133 — stderr tail: boom');
    }
    if (!BROWSER_SCOPED.has(method) && sessionId !== 'S1') {
      state.sendsMissingSession.push(method);
    }
    if (method === 'HeadlessExperimental.beginFrame') state.beginFrames += 1;
    switch (method) {
      case 'Target.createTarget':
        return { targetId: 'T1' };
      case 'Target.attachToTarget':
        return { sessionId: 'S1' };
      // `Network.enable` is here because the page audit subscribes to Network events, so a failed
      // dependency request can be NAMED instead of surfacing only as "uniform canvas" (v0.1.26).
      case 'Page.enable':
      case 'Runtime.enable':
      case 'Network.enable':
      case 'Page.addScriptToEvaluateOnNewDocument':
        return {};
      // The renderer-identity probe runs in an ISOLATED WORLD, where page script cannot patch the
      // globals it reads. The fake answers the two calls that world needs.
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'F1' } } };
      case 'Page.createIsolatedWorld':
        state.isolatedWorlds += 1;
        return { executionContextId: 99 };
      case 'Page.navigate':
        if (opts.dieAfterNavigate) {
          // Chrome dies right after acking the navigation: the transport shuts down, which (per
          // the fix) REJECTS the pending domContentEventFired waiter instead of stranding it.
          state.dead = true;
          setImmediate(() =>
            waiterReject?.(new CaptureStageError('chrome_launch', 'chrome exited 133 — stderr tail: oom')),
          );
        }
        return {};
      case 'HeadlessExperimental.beginFrame': {
        if (!params.screenshot) return { hasDamage: true };
        state.screenshots += 1;
        if (opts.noScreenshotData) return { hasDamage: true };
        return { screenshotData: Buffer.from(`jpeg-${state.screenshots}`).toString('base64') };
      }
      case 'Runtime.evaluate': {
        const expr = String(params.expression);
        // Anything evaluated with a contextId is the trusted probe, not page script.
        if (params.contextId === 99) {
          return {
            result: {
              value: JSON.stringify({ ok: true, renderer: opts.rendererString ?? 'Google SwiftShader' }),
            },
          };
        }
        if (expr.includes('window.postMessage')) {
          // The startScript lands → the bridge paints. (simRelayout also passes through here.)
          if (expr.includes('startScript') && !opts.silentBridge && !opts.neverPaints) {
            messages.push({ type: 'SIM_PAINTED' });
          }
          return { result: { value: undefined } };
        }
        if (expr.includes('.messages')) {
          const cursor = Number(/slice\((\d+)\)/.exec(expr)?.[1] ?? '0');
          return { result: { value: JSON.stringify(messages.slice(cursor)) } };
        }
        if (expr.includes('advanceToFrame')) return { result: { value: undefined } };
        if (expr.includes('getImageData')) {
          sampleCall += 1;
          // Distinct ACROSS frames (byte-identical check) AND varied WITHIN the frame (uniform check).
          const rgba = Array.from({ length: 16 }, (_, j) => (sampleCall * 37 + j * 11) % 256);
          return { result: { value: JSON.stringify({ width: 2, height: 2, rgba }) } };
        }
        if (expr.includes('webgl')) {
          return {
            result: { value: JSON.stringify({ attempted: true, ok: true, renderer: 'ANGLE (NVIDIA GeForce RTX 4090)' }) },
          };
        }
        if (expr.includes('new Promise')) return { result: { value: undefined } };
        return { result: { value: undefined } };
      }
      default:
        throw new Error(`fake CDP: unexpected method ${method}`);
    }
  };

  const handle: HeadlessShellHandle = {
    connection: {
      send,
      waitForEvent: (_method: string, _sid: string | undefined, _timeout: number): Promise<CdpEvent> =>
        opts.dieAfterNavigate
          ? // Mirrors the real CdpConnection: shutdown() rejects the waiter with Chrome's reason.
            new Promise<CdpEvent>((_resolve, reject) => { waiterReject = reject; })
          : Promise.resolve({ method: 'Page.domContentEventFired', params: {} }),
      onEvent: () => () => {},
      shutdown: () => {},
    } as unknown as HeadlessShellHandle['connection'],
    kill: async () => {
      state.kills += 1;
    },
    exited: new Promise(() => {}),
  };
  return { launch: () => handle, state };
}

let scratch: string | null = null;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('BeginFrameBackend.captureSection over a scripted transport', () => {
  it('captures: handshake runs, frame-%06d.jpg files land, gate passes, chrome is reaped', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bf-capture-'));
    const { launch, state } = fakeLaunch();
    const backend = new BeginFrameBackend({ launch, workDir: scratch });

    const result = await backend.captureSection(SPEC);

    expect(result.gate).toBe('passed');
    expect(result.frameCount).toBe(5); // round(0.5 × 10)
    // Identity comes from the ISOLATED WORLD, not the page. The fake page probe above claims an
    // RTX 4090 — the exact spoof an untrusted package could perform, since `__SIM_CAPTURE__` lives
    // in its own world and it can write whatever it likes there. What lands in the result is what
    // the browser actually reported to a context the page cannot reach.
    expect(result.rendererString).toBe('Google SwiftShader');
    expect(result.rendererString).not.toContain('RTX');
    expect(result.framesDir).toBeTruthy();
    const files = (await readdir(result.framesDir as string)).sort();
    expect(files).toEqual([
      'frame-000000.jpg',
      'frame-000001.jpg',
      'frame-000002.jpg',
      'frame-000003.jpg',
      'frame-000004.jpg',
    ]);
    expect(state.screenshots).toBe(5);
    expect(state.kills).toBe(1);
    // Every page-scoped CDP command carries the attached session (a real-CDP requirement that a
    // fake accepting anything would hide).
    expect(state.sendsMissingSession).toEqual([]);
  });

  it('advances the compositor 1:1 with the virtual clock — never two beginFrames per virtual frame', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bf-capture-'));
    const { launch, state } = fakeLaunch();
    const backend = new BeginFrameBackend({ launch, workDir: scratch });

    await backend.captureSection(SPEC);

    // The handshake steps some frames, then 30 warmup, then 5 captured. The invariant under test:
    // beginFrames NEVER exceed the virtual frames stepped (+1 navigation pump turn). A regression
    // to "step + capture each emit their own beginFrame" doubles the compositor clock and fails.
    const warmupPlusCaptured = 30 + 5;
    expect(state.beginFrames).toBeGreaterThanOrEqual(warmupPlusCaptured);
    expect(state.beginFrames).toBeLessThanOrEqual(warmupPlusCaptured + 6);
    expect(state.screenshots).toBe(5);
  });

  it('pins the warmup policy end to end: 30 discarded frames precede the 5 kept ones', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bf-capture-'));
    const { launch, state } = fakeLaunch();
    await new BeginFrameBackend({ launch, workDir: scratch }).captureSection(SPEC);
    // 30 warmup beginFrames carry no screenshot; exactly the 5 kept frames do.
    expect(state.beginFrames - state.screenshots).toBeGreaterThanOrEqual(30);
  });

  /**
   * The warmup contract, proven at the level the operator actually sets it.
   *
   * `warmupFrames` crossed the boundary and was DROPPED twice over: `toBackendSpec` never copied it,
   * and the backend read `DEFAULT_WARMUP_FRAMES` unconditionally. So any value a controlled
   * experiment set was silently ignored, and a benchmark that believed it varied warmup measured the
   * default every time. Two defaults also disagreed — one here, one in the handshake — so a
   * deliberate 0 had to survive both to mean anything. There is one default now, and these prove the
   * spec's value reaches the compositor.
   */
  it.each([
    { warmupFrames: 0, label: 'no warmup at all' },
    { warmupFrames: 7, label: 'an arbitrary small warmup' },
  ])('honours warmupFrames=$warmupFrames from the spec ($label)', async ({ warmupFrames }) => {
    scratch = await mkdtemp(join(tmpdir(), 'bf-capture-'));
    const { launch, state } = fakeLaunch();
    const result = await new BeginFrameBackend({ launch, workDir: scratch })
      .captureSection({ ...SPEC, warmupFrames });

    // Kept frames are the ones that carry a screenshot; everything else is warmup or the flush.
    expect(result.frameCount).toBe(5);
    expect(state.screenshots).toBe(5);
    const discarded = state.beginFrames - state.screenshots;
    // 0 must mean 0 — the case a `??` default would have swallowed had it been applied twice.
    expect(discarded).toBeLessThan(warmupFrames + 5);
    expect(discarded).toBeGreaterThanOrEqual(warmupFrames);
  });

  it('reads renderer identity from an isolated world the page cannot patch', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bf-capture-'));
    // The page claims hardware; the browser reports software. Only one of them is a measurement.
    const { launch, state } = fakeLaunch({ rendererString: 'ANGLE (Google, Vulkan, SwiftShader driver)' });
    const result = await new BeginFrameBackend({ launch, workDir: scratch }).captureSection(SPEC);

    expect(state.isolatedWorlds).toBe(1);
    expect(result.rendererString).toContain('SwiftShader');
    expect(result.rendererString).not.toContain('RTX');
  });

  it('a bridge that signals READY but never PAINTS fails at paint_ready — not bridge_ready', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bf-capture-'));
    const { launch, state } = fakeLaunch({ neverPaints: true });
    const backend = new BeginFrameBackend({ launch, workDir: scratch });

    const err = await backend.captureSection(SPEC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureStageError);
    expect((err as CaptureStageError).stage).toBe('paint_ready');
    expect(state.kills).toBe(1);
  });

  it('Chrome dying MID-NAVIGATION fails fast with its own reason — no stall, no orphan rejection', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bf-capture-'));
    const { launch, state } = fakeLaunch({ dieAfterNavigate: true });
    const backend = new BeginFrameBackend({ launch, workDir: scratch });

    const orphans: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { orphans.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const started = Date.now();
      const err = await backend.captureSection(SPEC).catch((e: unknown) => e);
      // Fails in milliseconds (the waiter is rejected), NOT after the 30s navigation timeout.
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(err).toBeInstanceOf(CaptureStageError);
      expect((err as Error).message).toMatch(/chrome exited 133/);
      expect(state.kills).toBe(1);
      await new Promise((r) => setTimeout(r, 50)); // give any orphan a turn to surface
      expect(orphans).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a bridge that never signals fails BOUNDED at bridge_ready — and chrome is still reaped', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bf-capture-'));
    const { launch, state } = fakeLaunch({ silentBridge: true });
    const backend = new BeginFrameBackend({ launch, workDir: scratch });

    const err = await backend.captureSection(SPEC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureStageError);
    expect((err as CaptureStageError).stage).toBe('bridge_ready');
    expect(state.kills).toBe(1);
  });

  it('beginFrame without screenshotData is a classified screenshot failure, not a corrupt frame', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bf-capture-'));
    const { launch, state } = fakeLaunch({ noScreenshotData: true });
    const backend = new BeginFrameBackend({ launch, workDir: scratch });

    const err = await backend.captureSection(SPEC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureStageError);
    expect((err as CaptureStageError).stage).toBe('screenshot');
    expect(state.kills).toBe(1);
  });

  it('chrome dying mid-capture surfaces classified (with its stderr tail) and is reaped', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'bf-capture-'));
    const { launch, state } = fakeLaunch({ dieAfterSends: 10 });
    const backend = new BeginFrameBackend({ launch, workDir: scratch });

    const err = await backend.captureSection(SPEC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureStageError);
    expect((err as Error).message).toMatch(/chrome exited 133/);
    expect(state.kills).toBe(1);
  });
});

describe('BeginFrameBackend.isAvailable', () => {
  it('is false on macOS and false without CHROME_HEADLESS_SHELL_PATH; true with an injected transport', async () => {
    expect(await new BeginFrameBackend({ platform: 'darwin', executablePath: '/x' }).isAvailable()).toBe(false);
    expect(await new BeginFrameBackend({ platform: 'linux', executablePath: undefined }).isAvailable()).toBe(
      process.env.CHROME_HEADLESS_SHELL_PATH ? await new BeginFrameBackend({ platform: 'linux' }).isAvailable() : false,
    );
    expect(await new BeginFrameBackend({ launch: fakeLaunch().launch }).isAvailable()).toBe(true);
  });
});
