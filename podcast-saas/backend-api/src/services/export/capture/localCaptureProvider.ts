/**
 * LOCAL, DEV-ONLY capture provider — makes `EXPORT_CAPTURE_LOCAL=1` produce a real rendered clip of
 * each scripted simulation section on a developer machine, so an export splices the LIVE sims into
 * the master instead of the poster fallback.
 *
 * WHY REAL-TIME, NOT THE SHIPPED SCREENSHOT BACKEND
 * The shipped macOS backend (`PlaywrightScreenshotBackend`) drives a VIRTUAL clock and steps rAF
 * callbacks synchronously, then screenshots. That is byte-reproducible but the browser COMPOSITOR
 * never ticks between the synchronous draw and the screenshot, so a WebGL sim's back-buffer reads
 * back blank/stale — the frames come out identical (the documented "drives the JS clock but not the
 * compositor" limitation; production uses the Linux beginFrame container instead). For a LOCAL
 * demo we don't need determinism, we need the sim to actually move — so this provider lets the sim
 * run in REAL time (native rAF, real compositor) and screenshots at the target frame interval. The
 * production capture path (driver + virtual clock + container backend) is untouched.
 *
 * DEFAULT-OFF. `resolveLocalCaptureProvider()` returns null unless `EXPORT_CAPTURE_LOCAL === '1'`.
 * This is a debugging seam, not a production backend.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { logger } from '../../../lib/logger.js';
import type { ChromiumLike, PwBrowser, PwPage } from './playwrightScreenshotBackend.js';
import {
  CaptureUnavailable,
  type CaptureResult,
  type CaptureSpec,
  type SimCaptureBackend,
} from './captureTypes.js';

/** Resolve Playwright's chromium launcher + an existing chromium binary, the way the E2E test does. */
async function resolveChromium(): Promise<{ launcher: ChromiumLike; executablePath: string } | null> {
  // Playwright is a client-web dependency, not backend-api's. Resolve it from client-web first,
  // then fall back to this package's own resolution paths.
  const bases = [
    join(process.cwd(), 'client-web', 'package.json'),
    join(process.cwd(), '..', 'client-web', 'package.json'),
    join(process.cwd(), 'package.json'),
  ];
  let pwPath = '';
  for (const base of bases) {
    if (!existsSync(base)) continue;
    try {
      const req = createRequire(base);
      try { pwPath = req.resolve('@playwright/test'); }
      catch { pwPath = req.resolve('playwright'); }
      if (pwPath) break;
    } catch { /* try the next base */ }
  }
  if (!pwPath) return null;
  let launcher: ChromiumLike | undefined;
  try {
    const pw = (await import(pathToFileURL(pwPath).href)) as {
      chromium?: ChromiumLike;
      default?: { chromium?: ChromiumLike };
    };
    launcher = pw.chromium ?? pw.default?.chromium;
  } catch {
    return null;
  }
  if (!launcher || typeof launcher.launch !== 'function') return null;

  let exe = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '';
  if (!exe || !existsSync(exe)) {
    const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
    if (existsSync(cache)) {
      for (const d of readdirSync(cache)) {
        if (!d.startsWith('chromium-') || d.includes('headless')) continue;
        const cand = join(
          cache, d, 'chrome-mac-arm64',
          'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing',
        );
        if (existsSync(cand)) { exe = cand; break; }
      }
    }
  }
  if (!exe || !existsSync(exe)) return null;
  return { launcher, executablePath: exe };
}

/**
 * Encode a directory of `frame_%06d.jpg` into an H.264 mp4 clip. Rejects on non-zero ffmpeg exit.
 * `-framerate` must precede `-i`: as an OUTPUT option image2 defaults the input to 25fps and the
 * clip plays at the wrong speed (the classic screencast speed bug).
 */
function encodeFramesToClip(
  framesDir: string, fps: number, clipPath: string, dims: { width: number; height: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-nostats', '-y',
      '-framerate', String(fps),
      '-start_number', '0',
      '-i', join(framesDir, 'frame_%06d.jpg'),
      // JPEG input is full-range (yuvj420p); the assembler's video-format gate requires plain
      // limited-range yuv420p, so force the range conversion explicitly.
      '-vf', `scale=${dims.width}:${dims.height}:out_range=tv,format=yuv420p`,
      '-color_range', 'tv',
      '-r', String(fps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      clipPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg frame-encode exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/** The slice of a Playwright CDPSession this provider drives the screencast with. */
interface CdpSessionLike {
  on(event: string, handler: (payload: ScreencastFrameEvent) => void): void;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
interface ScreencastFrameEvent {
  data: string;
  metadata: { timestamp?: number };
  sessionId: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pad6 = (n: number): string => String(n).padStart(6, '0');

/**
 * Replace the URL's `#simboot=` fragment with the viewer's Minimal-UI boot cloak. The `/sim-public/`
 * proxy parses this at serve time and injects `<style>sel{display:none!important}</style>` before
 * first paint. Keeping it (never sending `clearBootHide`) is what hides the controls for the whole
 * capture — bridge-version-independent, since the minimal bridge these packages ship has no runtime
 * `applyHideUi`. Empty list ⇒ nothing hidden (full UI), matching a non-minimal section.
 */
function withSimboot(url: string, hide: readonly string[]): string {
  const base = url.replace(/#.*$/, '');
  return `${base}#simboot=${encodeURIComponent(JSON.stringify({ hide: [...hide] }))}`;
}

/** Poll the in-page message buffer for a posted `type`, up to `timeoutMs`. Never throws. */
async function sawMessage(page: PwPage, type: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await page
      .evaluate((t: string) => {
        const w = globalThis as unknown as { __capMsgs?: string[] };
        return Array.isArray(w.__capMsgs) && w.__capMsgs.indexOf(t) !== -1;
      }, type)
      .catch(() => false);
    if (seen) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Real-time capture backend. `captureSection` returns a spliceable CLIP (`clipPath`); a host with no
 * Chromium simply throws `CaptureUnavailable` and the export degrades to the poster fallback.
 */
class LocalCaptureProvider implements SimCaptureBackend {
  readonly name = 'local-realtime-clip';
  private resolved: { launcher: ChromiumLike; executablePath: string } | null = null;
  private resolvedOnce = false;

  private async chromium(): Promise<{ launcher: ChromiumLike; executablePath: string } | null> {
    if (!this.resolvedOnce) {
      this.resolved = await resolveChromium();
      this.resolvedOnce = true;
      if (this.resolved) logger.info({ exe: this.resolved.executablePath }, 'export(local-capture): chromium resolved');
      else logger.warn('export(local-capture): no Playwright chromium resolvable — sim windows use the poster fallback');
    }
    return this.resolved;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.chromium()) !== null;
  }

  async captureSection(spec: CaptureSpec): Promise<CaptureResult> {
    const resolved = await this.chromium();
    if (!resolved) throw new CaptureUnavailable('Local capture: no Playwright/Chromium on this host.');

    const framesDir = await mkdtemp(join(tmpdir(), 'sim-rt-'));
    const outDir = await mkdtemp(join(tmpdir(), 'sim-clip-'));
    const clipPath = join(outDir, `${spec.sectionId}.mp4`);
    const frameCount = Math.max(1, Math.round(spec.durationSec * spec.fps));
    let browser: PwBrowser | null = null;
    let rendererString = '';

    try {
      browser = await resolved.launcher.launch({
        headless: true,
        executablePath: resolved.executablePath,
        args: [
          '--hide-scrollbars', '--force-device-scale-factor=1', '--force-color-profile=srgb', '--mute-audio',
          // Live (GPU) WebGL in new headless on macOS arm64 — without these some builds fall back to
          // software GL and canvases screencast black (research-verified pitfall #1).
          '--use-gl=angle', '--use-angle=metal',
        ],
      });
      const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: 1 });
      const page = await context.newPage();

      // Buffer the sim's postMessages so we can wait for SIM_READY / SIM_PAINTED (top-level ⇒ the
      // sim posts to its own window). NO virtual clock is injected — the sim runs in real time.
      await page.addInitScript(
        'window.__capMsgs=[];window.addEventListener("message",function(e){try{if(e&&e.data&&e.data.type)window.__capMsgs.push(e.data.type);}catch(_){}} );',
      );
      // Navigate WITH the Minimal-UI boot cloak in the fragment (the `/sim-public/` proxy turns it
      // into pre-paint hide CSS). Minimal UI hides `.uiHide` only when `simpleUi` is set — the same
      // `bootHideFor` rule the viewer uses.
      const bootHide = spec.simpleUi ? spec.uiHide : [];
      await page.goto(withSimboot(spec.servedSimUrl, bootHide), { waitUntil: 'domcontentloaded', timeout: 30_000 });

      await sawMessage(page, 'SIM_READY', 15_000);
      // The viewer's activate() sequence, minus audio: startScript (applies the section's script +,
      // on a full bridge, the steady-state hide CSS) then simRelayout (the gate fires a synthetic
      // `resize` so a canvas/WebGL sim sizes to the viewport instead of a stale internal resolution).
      // We deliberately do NOT send clearBootHide — the boot cloak IS our Minimal-UI mechanism here.
      const params = { simpleUi: spec.simpleUi, autoScript: spec.autoScript, hideSelectors: [...spec.uiHide] };
      await page.evaluate(
        (a: { sid: string; params: Record<string, unknown> }) =>
          (globalThis as unknown as { postMessage: (m: unknown, o: string) => void })
            .postMessage({ type: 'startScript', script: a.sid, params: a.params }, '*'),
        { sid: spec.sectionId, params },
      );
      await page.evaluate(() =>
        (globalThis as unknown as { postMessage: (m: unknown, o: string) => void }).postMessage({ type: 'simRelayout' }, '*'),
      );
      await sawMessage(page, 'SIM_PAINTED', 10_000);
      // A brief settle so the first captured frame is a real scene, not a half-initialised one.
      await sleep(300);

      rendererString = await page
        .evaluate<string>(() => {
          try {
            const c = (globalThis as unknown as { document: { createElement: (t: string) => unknown } }).document.createElement('canvas') as unknown as {
              getContext: (t: string) => { getExtension: (n: string) => { UNMASKED_RENDERER_WEBGL: number } | null; getParameter: (p: number) => string } | null;
            };
            const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
            if (!gl) return '';
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
          } catch { return ''; }
        })
        .catch(() => '');

      // ── CDP screencast: the COMPOSITOR pushes timestamped frames while the sim animates in real
      // time. A page.screenshot() loop cannot do this smoothly: each shot costs ~40ms of real
      // animation and the spacing jitters, which played back ~1.2-1.5x fast with visible stutter.
      // Screencast frames carry `metadata.timestamp` (SECONDS), which the hold-resample below maps
      // onto an even 1/fps grid — smooth and exactly 1x by construction.
      const shots: Array<{ t: number; buf: Buffer }> = [];
      const cdp = await (context as unknown as {
        newCDPSession(p: PwPage): Promise<CdpSessionLike>;
      }).newCDPSession(page);
      cdp.on('Page.screencastFrame', (e) => {
        // Handler stays cheap (decode + ack). EVERY frame must be acked or the stream halts —
        // that is the protocol's backpressure mechanism.
        shots.push({ t: e.metadata.timestamp ?? 0, buf: Buffer.from(e.data, 'base64') });
        void cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: 92, everyNthFrame: 1,
        // Device pixels; deviceScaleFactor is 1 so these equal the CSS viewport.
        maxWidth: spec.width, maxHeight: spec.height,
      });

      // The sim runs NATIVELY (its own rAF, real compositor) for the full window + a small tail so
      // a frame exists at/after the last sample instant.
      await sleep(spec.durationSec * 1000 + 300);
      await cdp.send('Page.stopScreencast').catch(() => {});
      await sleep(150); // drain in-flight screencastFrame events

      // Screencast fires ONLY on visual change — a fully static sim yields nothing. Its truthful
      // appearance is still a still: hold a single screenshot for the whole window.
      if (shots.length === 0) {
        const buf = await page.screenshot({ clip: { x: 0, y: 0, width: spec.width, height: spec.height } });
        shots.push({ t: 0, buf: buf as Buffer });
      }
      shots.sort((a, b) => a.t - b.t);

      // ── Zero-order-hold resample: output frame k = whatever was on screen at t0 + k/fps.
      // Consecutive output frames are exactly 1/fps of REAL time apart regardless of capture
      // jitter; dense bursts get subsampled, gaps get held. (Puppeteer's own ScreenRecorder uses
      // the same dup-count scheme.)
      const t0 = shots[0].t;
      let p = 0;
      for (let k = 0; k < frameCount; k++) {
        const target = t0 + k / spec.fps; // seconds — same unit as metadata.timestamp
        while (p + 1 < shots.length && shots[p + 1].t <= target) p++;
        await writeFile(join(framesDir, `frame_${pad6(k)}.jpg`), shots[p].buf);
      }
      const captureFps = shots.length > 1
        ? Math.round((shots.length - 1) / Math.max(0.001, shots[shots.length - 1].t - t0))
        : 0;
      const animated = shots.length > 3;

      await encodeFramesToClip(framesDir, spec.fps, clipPath, { width: spec.width, height: spec.height });
      logger.info(
        { section: spec.sectionId, outFrames: frameCount, compositorFrames: shots.length, captureFps, animated, renderer: rendererString },
        `export(local-capture): clip encoded${animated ? '' : ' (WARNING: compositor emitted almost no frames — the sim may need interaction)'}`,
      );
      return { clipPath, frameCount, rendererString, gate: 'passed' };
    } catch (err) {
      logger.warn({ err, section: spec.sectionId }, 'export(local-capture): real-time capture failed — degrading to poster');
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
      // No clipPath → the service falls back to the poster for this window, loudly.
      return { frameCount: 0, rendererString, gate: 'failed', reason: err instanceof Error ? err.message : String(err) };
    } finally {
      await browser?.close().catch(() => {});
      await rm(framesDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * The injected provider for a LOCAL export run, or null (the shipped default). Only a
 * `EXPORT_CAPTURE_LOCAL=1` dev run gets a real capture backend; everything else is unchanged.
 */
export function resolveLocalCaptureProvider(): SimCaptureBackend | null {
  if (process.env.EXPORT_CAPTURE_LOCAL !== '1') return null;
  logger.info('export: EXPORT_CAPTURE_LOCAL=1 — injecting the local real-time capture provider (dev only)');
  return new LocalCaptureProvider();
}
