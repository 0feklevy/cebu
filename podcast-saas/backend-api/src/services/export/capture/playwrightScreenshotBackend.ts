/**
 * The Playwright screenshot backend (plan §4 — the tooling-accident branch: "Playwright
 * unconditionally passes `--enable-unsafe-swiftshader` … Playwright users are accidentally immune to
 * the Chrome 144 breakage"). Real Chrome + the JS virtual clock + a `page.screenshot` per virtual
 * frame. It RUNS ON macOS, which is why this is the backend verified end-to-end locally — the
 * beginFrame path cannot run on a Mac at all.
 *
 * Trade-off vs beginFrame (documented, not hidden): a screenshot backend drives the JS clock but NOT
 * the compositor, so CSS/Web Animations run on the real clock (plan's `timecut` row: "CSS animations
 * drift"). This product's sim animation is rAF/`setInterval`-driven (both virtualised here), which is
 * why this backend is correct for sim capture; CSS-keyframe overlays (image Ken Burns) are a Phase 3+
 * concern handled elsewhere and are not captured through this path.
 *
 * GATE SAMPLING CAVEAT: the canvas-region sample uses in-page `drawImage → getImageData`, which for a
 * WebGL canvas requires `preserveDrawingBuffer: true` (a spec-level constraint — plan §4
 * "`preserveDrawingBuffer` is a spec-level constraint"). Sims that render WebGL without it may sample
 * blank here even though the compositor screenshot is correct; the deterministic beginFrame path
 * (compositor readback) is the production capture path. The gate's FAILURE is still trustworthy.
 *
 * Playwright is NOT a dependency of backend-api (it lives in client-web). This backend therefore
 * imports it LAZILY and, when it cannot be resolved, `isAvailable()` is false and `captureSection`
 * throws `CaptureUnavailable` — the export service's signal to use the poster fallback. A launcher
 * can also be injected (the real E2E test does this, resolving Playwright from the workspace).
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildInitScript } from './injection.js';
import { runCaptureHandshake, type DriverDeps } from './driver.js';
import { evaluateSanityGate, type FrameSample } from './sanityGate.js';
import {
  CaptureUnavailable,
  DEFAULT_FRAME_EPOCH_MS,
  type CaptureResult,
  type CaptureSpec,
  type SimCaptureBackend,
} from './captureTypes.js';

// ── The minimal structural slice of Playwright this backend uses (Playwright is not resolvable in
//    backend-api, so we cannot import its types — we depend only on the shape we call). ───────────

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PwPage {
  addInitScript(script: string | { content: string }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate<T = unknown>(fn: any, arg?: any): Promise<T>;
  screenshot(opts?: any): Promise<Buffer>;
  close(): Promise<void>;
}
export interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
export interface PwBrowser {
  newContext(opts?: any): Promise<PwContext>;
  close(): Promise<void>;
}
export interface ChromiumLike {
  launch(opts?: any): Promise<PwBrowser>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface PlaywrightBackendOptions {
  /** Base dir for frame output. Default: a fresh temp dir. */
  workDir?: string;
  /** Inject a resolved `chromium` launcher (tests). Otherwise Playwright is lazily imported. */
  launcher?: ChromiumLike;
  /** Override the Chrome executable (e.g. an installed Chrome-for-Testing revision). */
  executablePath?: string;
  /** Headless launch. Default true. */
  headless?: boolean;
  /** Extra Chrome launch args. */
  launchArgs?: readonly string[];
  /** Canvas-region gate sample grid (gridN × gridN). Default 24. */
  gridN?: number;
  /** How many frames across the capture to sample for the gate. Default 6 (min 2). */
  sampleCount?: number;
  /** Keep the frames dir on success (default true — the caller consumes it). */
  keepFrames?: boolean;
  log?: (message: string) => void;
}

const NAV_TIMEOUT_MS = 30_000;

/** Try to resolve a `chromium` launcher: injected first, then a lazy import of Playwright. */
async function resolveChromium(opts: PlaywrightBackendOptions): Promise<ChromiumLike | null> {
  if (opts.launcher) return opts.launcher;
  const candidates = ['playwright', 'playwright-core', '@playwright/test'];
  for (const spec of candidates) {
    try {
      // Variable specifier ⇒ no static resolution; a missing package just rejects and we move on.
      const mod: Record<string, unknown> = await import(spec);
      const chromium =
        (mod.chromium as ChromiumLike | undefined) ??
        ((mod.default as { chromium?: ChromiumLike } | undefined)?.chromium);
      if (chromium && typeof chromium.launch === 'function') return chromium;
    } catch {
      /* not installed here — try the next specifier */
    }
  }
  return null;
}

/** Even sample indices across [0, frameCount), always including the first and last. Length ≥ 2. */
function sampleIndices(frameCount: number, sampleCount: number): Set<number> {
  const n = Math.max(2, Math.min(sampleCount, frameCount));
  const out = new Set<number>();
  if (frameCount <= 0) return out;
  if (frameCount === 1) return new Set([0]);
  for (let i = 0; i < n; i++) {
    out.add(Math.round((i * (frameCount - 1)) / (n - 1)));
  }
  return out;
}

export class PlaywrightScreenshotBackend implements SimCaptureBackend {
  readonly name = 'playwright-screenshot';
  private readonly opts: PlaywrightBackendOptions;

  constructor(opts: PlaywrightBackendOptions = {}) {
    this.opts = opts;
  }

  async isAvailable(): Promise<boolean> {
    return (await resolveChromium(this.opts)) !== null;
  }

  async captureSection(spec: CaptureSpec): Promise<CaptureResult> {
    const log = this.opts.log ?? (() => {});
    const chromium = await resolveChromium(this.opts);
    if (!chromium) {
      throw new CaptureUnavailable(
        'Playwright/Chromium is not available here (not a dependency of backend-api). ' +
          'Inject a launcher or run in an environment where Playwright resolves; export uses the poster fallback.',
      );
    }

    const gridN = this.opts.gridN ?? 24;
    const sampleCount = this.opts.sampleCount ?? 6;
    const base = this.opts.workDir ?? tmpdir();
    const framesDir = join(base, `sim-capture-${spec.sectionId}-${Date.now()}`);
    await mkdir(framesDir, { recursive: true });

    const browser = await chromium.launch({
      headless: this.opts.headless ?? true,
      executablePath: this.opts.executablePath,
      args: [
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--force-color-profile=srgb',
        '--mute-audio',
        '--disable-background-timer-throttling',
        ...(this.opts.launchArgs ?? []),
      ],
    });

    const samples: FrameSample[] = [];
    try {
      const context = await browser.newContext({
        viewport: { width: spec.width, height: spec.height },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();

      // Document-start injection — BEFORE any page script, so the clock's rAF is in place before the
      // bridge's __SIM_RAF_GATE__ wraps it (the ordering hazard, plan §4).
      await page.addInitScript(
        buildInitScript({ fps: spec.fps, configHash: spec.configHash, epochMs: DEFAULT_FRAME_EPOCH_MS }),
      );

      const captureFrames = Math.round(spec.durationSec * spec.fps);
      const toSample = sampleIndices(captureFrames, sampleCount);

      const samplePage = async (): Promise<FrameSample | null> =>
        page.evaluate<FrameSample | null>((n: number) => {
          // Runs in the browser; `document` etc. exist there but not in the Node type lib, so reach
          // them through an untyped global handle.
          const w: any = globalThis; // eslint-disable-line @typescript-eslint/no-explicit-any
          const canvases: any[] = Array.from(w.document.querySelectorAll('canvas')); // eslint-disable-line @typescript-eslint/no-explicit-any
          if (canvases.length === 0) return null;
          let best = canvases[0];
          let bestArea = 0;
          for (const c of canvases) {
            const area = (c.width || 0) * (c.height || 0);
            if (area > bestArea) {
              bestArea = area;
              best = c;
            }
          }
          const off = w.document.createElement('canvas');
          off.width = n;
          off.height = n;
          const g = off.getContext('2d');
          if (!g) return null;
          try {
            g.drawImage(best, 0, 0, n, n);
          } catch {
            return null;
          }
          const data = g.getImageData(0, 0, n, n).data;
          return { width: n, height: n, rgba: Array.from(data) as number[] };
        }, gridN);

      let msgCursor = 0;
      const deps: DriverDeps = {
        navigate: async (url) => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        },
        postToSim: async (message) => {
          await page.evaluate((m: Record<string, unknown>) => {
            const w: any = globalThis; // eslint-disable-line @typescript-eslint/no-explicit-any
            w.postMessage(m, '*');
          }, message);
        },
        drainMessages: async () => {
          const batch = await page.evaluate<Array<Record<string, unknown>>>((cur: number) => {
            const w: any = globalThis; // eslint-disable-line @typescript-eslint/no-explicit-any
            const cap = w.__SIM_CAPTURE__;
            const arr: Array<Record<string, unknown>> = (cap && cap.messages) || [];
            return arr.slice(cur);
          }, msgCursor);
          msgCursor += batch.length;
          return batch;
        },
        stepFrame: async (virtualFrame) => {
          await page.evaluate((f: number) => {
            const w: any = globalThis; // eslint-disable-line @typescript-eslint/no-explicit-any
            const clock = w.__SIM_CLOCK__;
            if (clock) clock.advanceToFrame(f);
          }, virtualFrame);
        },
        captureFrame: async (captureIndex) => {
          const buf = await page.screenshot({
            clip: { x: 0, y: 0, width: spec.width, height: spec.height },
          });
          const name = `frame_${String(captureIndex).padStart(6, '0')}.png`;
          await writeFile(join(framesDir, name), buf);
          if (toSample.has(captureIndex)) {
            const s = await samplePage();
            if (s) samples.push(s);
          }
        },
        now: () => Date.now(),
        yieldToEventLoop: async () => {
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                const w: any = globalThis; // eslint-disable-line @typescript-eslint/no-explicit-any
                const clock = w.__SIM_CLOCK__;
                if (clock && clock.realSetTimeout) clock.realSetTimeout(() => resolve(), 0);
                else resolve();
              }),
          );
        },
        log,
      };

      const run = await runCaptureHandshake(deps, {
        url: spec.servedSimUrl,
        sectionId: spec.sectionId,
        simpleUi: spec.simpleUi,
        autoScript: spec.autoScript,
        uiHide: spec.uiHide,
        fps: spec.fps,
        durationSec: spec.durationSec,
      });

      const webgl = await page.evaluate<{ attempted: boolean; ok: boolean; renderer: string }>(() => {
        const w: any = globalThis; // eslint-disable-line @typescript-eslint/no-explicit-any
        const cap = w.__SIM_CAPTURE__;
        const rec = cap && cap.webgl;
        return rec
          ? { attempted: !!rec.attempted, ok: !!rec.ok, renderer: String(rec.renderer || '') }
          : { attempted: false, ok: false, renderer: '' };
      });
      const rendererString = webgl.renderer;

      const gate = evaluateSanityGate({ simPainted: run.sawPainted, webgl, frames: samples });
      log(`gate ${gate.gate}${gate.reason ? `: ${gate.reason}` : ''} (renderer="${rendererString}")`);

      return {
        framesDir,
        frameCount: run.frameCount,
        rendererString,
        gate: gate.gate,
        reason: gate.reason,
      };
    } finally {
      await browser.close().catch(() => {});
      if (this.opts.keepFrames === false) {
        await rm(framesDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

/** Convenience factory mirroring the other backends' construction. */
export function createPlaywrightScreenshotBackend(opts: PlaywrightBackendOptions = {}): PlaywrightScreenshotBackend {
  return new PlaywrightScreenshotBackend(opts);
}
