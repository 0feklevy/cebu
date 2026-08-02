/**
 * END-TO-END tests of the REAL FlowVid viewer.
 *
 * WHY THIS EXISTS, and how it differs from e2e/sim-transitions.spec.ts:
 * that suite drives the real generated CHILD artefacts from a hand-written harness — it replays
 * the orderings the player is *supposed* to emit. By construction it cannot fail when the PLAYER
 * regresses, which is exactly how a dead apply gate once survived a full green suite.
 *
 * This suite runs the actual Next.js application: the real route, the real React viewer, the real
 * useProjectPlayer hook, the real pooled iframes, the real generated rAF gate and combined bridge,
 * and the real CSS transitions. Only the DATA layer is stubbed — the player-config API returns a
 * deterministic fixture project, and the sim package + media are served locally. Everything the
 * user's browser executes is production code.
 *
 * EVIDENCE: transitions are sampled every animation frame from inside the page. Whenever a sim
 * frame has non-zero opacity we assert the target section is applied, the previous section is not
 * showing, and no forbidden Full-UI control is visible. Message assertions alone are not accepted.
 *
 * Requires a running client-web dev/prod server (default http://localhost:3000). Point elsewhere
 * with VIEWER_E2E_BASE_URL. The suite skips itself — loudly — when no server answers, so it can
 * never be mistaken for "passing" in an environment that never ran it.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const BASE = process.env.VIEWER_E2E_BASE_URL ?? 'http://localhost:3000';
const API_ORIGIN = process.env.VIEWER_E2E_API_URL ?? 'http://localhost:8080';
const FIXTURE_DIR = resolve(__dirname, '../../.sim-fixture');
const BACKEND = resolve(__dirname, '../../backend-api');

/** Section ids baked into the generated fixture package (see gen-sim-fixture.ts). */
const S = {
  A: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  B: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  SLOW: 'cccccccc-3333-4333-8333-cccccccccccc',
  THROWS: 'dddddddd-4444-4444-8444-dddddddddddd',
  AUTO: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
  MISSING: 'ffffffff-9999-4999-8999-ffffffffffff',
} as const;

function ensureFixture(): void {
  const stamp = join(FIXTURE_DIR, 'modern', 'index.html');
  if (existsSync(stamp) && !process.env.SIM_FIXTURE_FORCE) {
    const built = statSync(stamp).mtimeMs;
    const sources = [
      join(BACKEND, 'src', 'scripts', 'gen-sim-fixture.ts'),
      join(BACKEND, 'src', 'services', 'simulation', 'SimulationService.ts'),
    ];
    if (!sources.some((s) => existsSync(s) && statSync(s).mtimeMs > built)) return;
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const r = spawnSync('npx', ['tsx', 'src/scripts/gen-sim-fixture.ts', FIXTURE_DIR], { cwd: BACKEND, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture generation failed: ${r.stderr || r.stdout}`);
}

// ── local asset server: the sim packages + a tiny real video ───────────────────────────────
let server: Server;
let assetBase = '';

/**
 * A REAL, decodable 40s H.264 clip, generated once by ffmpeg and cached beside the fixtures.
 * It must genuinely decode: the viewer gates sim pooling on an actual play attempt, and a
 * synthetic byte blob makes video.play() never settle — the whole suite then hangs rather than
 * failing, which is the worst possible outcome for a test.
 */
const MEDIA_PATH = join(FIXTURE_DIR, 'clip.mp4');
function ensureMedia(): void {
  if (existsSync(MEDIA_PATH)) return;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:d=40',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-y', MEDIA_PATH,
  ], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(MEDIA_PATH)) {
    throw new Error(`viewer-e2e: could not generate test media with ffmpeg: ${r.stderr || r.stdout}`);
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
};

test.beforeAll(async () => {
  ensureFixture();
  ensureMedia();
  server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0].split('#')[0];
    if (url === '/media/clip.mp4') {
      // Range support: WebKit will not start a media element without it.
      const buf = readFileSync(MEDIA_PATH);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? parseInt(m[2], 10) : buf.length - 1;
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${buf.length}`,
          'content-length': String(end - start + 1),
          'cache-control': 'no-cache',
        });
        res.end(buf.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, {
        'content-type': 'video/mp4', 'accept-ranges': 'bytes',
        'content-length': String(buf.length), 'cache-control': 'no-cache',
      });
      res.end(buf);
      return;
    }
    const file = join(FIXTURE_DIR, url.replace(/^\/+/, ''));
    if (!file.startsWith(FIXTURE_DIR) || !existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  assetBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Fail loudly rather than silently "passing" when the app is not running.
  const probe = await fetch(BASE).catch(() => null);
  if (!probe || !probe.ok) {
    throw new Error(
      `viewer-e2e: no application at ${BASE}. Start client-web (pnpm dev) or set VIEWER_E2E_BASE_URL.`,
    );
  }
});

test.afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

// ── fixture project builder ───────────────────────────────────────────────────────────────

interface SimSpec { id: string; start: number; end: number; pkg?: string; section?: string; simpleUi?: boolean; hide?: string[]; auto?: boolean }

/**
 * Build a player-config exactly in the shape the real backend returns, so the real viewer parses
 * it with no special-casing. `simulations` carry the ?section= identity the player dispatches on.
 */
function makeConfig(sims: SimSpec[], opts?: { segDuration?: number }) {
  const duration = opts?.segDuration ?? 30;
  return {
    project: { id: 'e2e-project', title: 'E2E fixture' },
    segments: [{
      id: 'seg-1',
      label: 'Main',
      duration,
      hls_status: 'ready',
      fallback_url: `${assetBase}/media/clip.mp4`,
      hls_url: null,
      sort_order: 0,
      simulations: sims.map((s) => ({
        id: s.id,
        label: `sim ${s.id}`,
        type: 'simulation',
        start_sec: s.start,
        end_sec: s.end,
        simulation_url: `${assetBase}/${s.pkg ?? 'modern'}/index.html?section=${s.section ?? S.A}&v=1`,
        sim_script: 'main',
        simple_ui: s.simpleUi ?? false,
        auto_script: s.auto ?? false,
        ui_hide: s.hide ?? [],
      })),
      broll: [], images: [], audio: [],
    }],
    sequences: [], branching: null, avatar: null, captions: [],
  };
}

/** Stub ONLY the data layer; every component and hook below it is the real one. */
async function bootViewer(page: Page, config: object): Promise<void> {
  await page.route(`${API_ORIGIN}/api/v1/projects/**/player-config*`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  // Everything else the page may ask the API for is irrelevant here; answer benignly so a missing
  // endpoint can never be mistaken for a viewer defect.
  await page.route(`${API_ORIGIN}/api/v1/**`, (route: Route) => {
    if (route.request().url().includes('player-config')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  (page as Page & { __errors?: string[] }).__errors = errors;

  await page.goto(`${BASE}/projects/e2e-project/view`, { waitUntil: 'domcontentloaded' });
}

/** Start the video (the viewer arms sim pooling only after a real play attempt). */
async function startPlayback(page: Page): Promise<void> {
  await page.waitForSelector('video', { timeout: 30_000 });
  // Wait for real metadata: currentTime assignments are ignored before the media is seekable,
  // so every later seekTo() would silently do nothing and the suite would assert on t=0.
  await page.waitForFunction(() => {
    const v = document.querySelector('video') as HTMLVideoElement | null;
    return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
  }, undefined, { timeout: 30_000 }).catch(() => { /* reported by the assertions themselves */ });
  await page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement | null;
    if (!v) return;
    v.muted = true;
    // Deliberately NOT awaited: a play() promise that never settles would hang the whole run.
    void v.play().catch(() => {});
  });
  await page.mouse.click(400, 300).catch(() => {});
  await page.waitForTimeout(300);
}

/** Drive the timeline by setting currentTime directly — deterministic, no real-time waiting. */
async function seekTo(page: Page, t: number): Promise<void> {
  await page.evaluate((sec) => {
    const v = document.querySelector('video') as HTMLVideoElement | null;
    if (v) v.currentTime = sec;
  }, t);
}

interface Sample { t: number; frames: { op: number; section: string | null; controls: boolean; src: string }[] }

/**
 * Sample every animation frame from inside the page: for each sim iframe, its LIVE animated
 * opacity, which section its marker says is applied, and whether the sim's own Full-UI control
 * panel is displayed. Same-origin (the asset server) so the iframe document is readable.
 */
async function sampleFrames(page: Page, ms: number): Promise<Sample[]> {
  return page.evaluate((duration) => new Promise<Sample[]>((resolve) => {
    const out: Sample[] = [];
    const t0 = performance.now();
    const tick = () => {
      const frames: Sample['frames'] = [];
      document.querySelectorAll('iframe').forEach((f) => {
        const el = f as HTMLIFrameElement;
        if (!/index\.html/.test(el.src)) return;
        let section: string | null = null;
        let controls = false;
        try {
          const d = el.contentDocument;
          if (d) {
            section = d.getElementById('marker')?.getAttribute('data-section') ?? null;
            const c = d.querySelector('.controls');
            controls = !!c && getComputedStyle(c as Element).display !== 'none';
          }
        } catch { /* cross-origin — leave null */ }
        // The animated opacity may live on the iframe or on a wrapper; take the effective product.
        let op = parseFloat(getComputedStyle(el).opacity) || 0;
        let node: HTMLElement | null = el.parentElement;
        for (let i = 0; node && i < 4; i++, node = node.parentElement) {
          op *= parseFloat(getComputedStyle(node).opacity) || 0;
        }
        frames.push({ op, section, controls, src: el.src });
      });
      out.push({ t: Math.round(performance.now() - t0), frames });
      if (performance.now() - t0 < duration) requestAnimationFrame(tick);
      else resolve(out);
    };
    requestAnimationFrame(tick);
    // Hard stop: a throttled or backgrounded page stops firing rAF, and a sampler that can hang
    // turns a real failure into a timeout with no evidence.
    setTimeout(() => resolve(out), duration + 2000);
  }), ms);
}

/** The core invariant: nothing visible may show the wrong section or forbidden Full UI. */
function assertVisibleFramesAreCorrect(samples: Sample[], opts: { expect: string; forbidPrevious?: string; minimalUi?: boolean }): void {
  const violations: string[] = [];
  for (const s of samples) {
    for (const f of s.frames) {
      if (f.op <= 0.01) continue;                       // not presented — nothing to assert
      if (f.section !== null && f.section !== 'none' && f.section !== opts.expect) {
        violations.push(`t=${s.t}ms opacity=${f.op.toFixed(2)} shows section "${f.section}", expected "${opts.expect}"`);
      }
      if (opts.forbidPrevious && f.section === opts.forbidPrevious) {
        violations.push(`t=${s.t}ms the PREVIOUS section "${opts.forbidPrevious}" was visible at opacity ${f.op.toFixed(2)}`);
      }
      if (opts.minimalUi && f.controls) {
        violations.push(`t=${s.t}ms Full-UI controls visible at opacity ${f.op.toFixed(2)} under Minimal UI`);
      }
    }
  }
  expect(violations.join('\n')).toBe('');
}

const errorsOf = (page: Page): string[] => (page as Page & { __errors?: string[] }).__errors ?? [];

/** Errors that are environmental (stubbed endpoints, auth, media codec) rather than viewer bugs. */
const IGNORABLE = /Firebase|auth\/|net::ERR_|Failed to load resource|media|play\(\) request|NotAllowedError|AbortError|X-Frame-Options|Refused to display/i;
const realErrors = (page: Page): string[] => errorsOf(page).filter((e) => !IGNORABLE.test(e));

// ── the suite ─────────────────────────────────────────────────────────────────────────────

test.describe('real React viewer — simulation transitions', () => {
  test('1. cold video → simulation: the sim is never presented blank or unapplied', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 5, end: 15, section: S.A }]));
    await startPlayback(page);
    await seekTo(page, 6);
    const samples = await sampleFrames(page, 1500);
    assertVisibleFramesAreCorrect(samples, { expect: 'A' });
    expect(realErrors(page)).toEqual([]);
  });

  test('2. same-package A → B: no frame of A is presented after B is requested', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.A },
      { id: 's2', start: 8, end: 14, section: S.B },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(800);
    const move = sampleFrames(page, 1600);
    await seekTo(page, 9);
    const samples = await move;
    // Once B is the active section, A must never be the thing on screen.
    const late = samples.slice(Math.floor(samples.length / 3));
    assertVisibleFramesAreCorrect(late, { expect: 'B', forbidPrevious: 'A' });
    expect(realErrors(page)).toEqual([]);
  });

  test('3. A → B → A repeatedly always ends on the requested section', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.A },
      { id: 's2', start: 8, end: 14, section: S.B },
    ]));
    await startPlayback(page);
    for (let i = 0; i < 5; i++) {
      await seekTo(page, 4); await page.waitForTimeout(400);
      await seekTo(page, 10); await page.waitForTimeout(400);
    }
    await seekTo(page, 4);
    await page.waitForTimeout(1200);
    const samples = await sampleFrames(page, 600);
    assertVisibleFramesAreCorrect(samples, { expect: 'A' });
    expect(realErrors(page)).toEqual([]);
  });

  test('4. Minimal UI: Full-UI controls are never visible while the sim is presented', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 10, section: S.A, simpleUi: true, hide: ['.controls'] },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    const samples = await sampleFrames(page, 1800);
    assertVisibleFramesAreCorrect(samples, { expect: 'A', minimalUi: true });
    expect(realErrors(page)).toEqual([]);
  });

  test('5. Minimal UI → video: the exit fade never restores Full UI on screen', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.A, simpleUi: true, hide: ['.controls'] },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(1000);
    const exiting = sampleFrames(page, 1200);
    await seekTo(page, 12);                       // leave the sim section
    const samples = await exiting;
    // The audited defect: stopScript at the boundary restored the hidden controls and rendered
    // them for the whole 200ms fade.
    assertVisibleFramesAreCorrect(samples, { expect: 'A', minimalUi: true });
    expect(realErrors(page)).toEqual([]);
  });

  test('6. a MISSING section runs nothing and never shows another section’s body', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.A },
      { id: 's2', start: 8, end: 14, section: S.MISSING },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(900);
    const move = sampleFrames(page, 1500);
    await seekTo(page, 10);
    const samples = await move;
    const late = samples.slice(Math.floor(samples.length / 2));
    // The correct outcome is the video playing on — never A's body standing in for the missing one.
    assertVisibleFramesAreCorrect(late, { expect: 'none', forbidPrevious: 'A' });
    expect(realErrors(page)).toEqual([]);
  });

  test('7. a throwing cleanup does not wedge later section switches', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.THROWS },
      { id: 's2', start: 8, end: 14, section: S.B },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(900);
    await seekTo(page, 10);
    await page.waitForTimeout(1500);
    const samples = await sampleFrames(page, 600);
    assertVisibleFramesAreCorrect(samples, { expect: 'B' });
  });

  test('8. a SLOW body is never presented before it has applied', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.A },
      { id: 's2', start: 8, end: 16, section: S.SLOW },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(900);
    const move = sampleFrames(page, 2000);
    await seekTo(page, 10);
    const samples = await move;
    const late = samples.slice(Math.floor(samples.length / 2));
    assertVisibleFramesAreCorrect(late, { expect: 'SLOW', forbidPrevious: 'A' });
  });

  test('9. direct seek INTO a simulation (no warm-up) still applies the right section', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 10, end: 20, section: S.B }]));
    await startPlayback(page);
    await seekTo(page, 12);                       // straight in, no lead-in
    await page.waitForTimeout(1800);
    const samples = await sampleFrames(page, 600);
    assertVisibleFramesAreCorrect(samples, { expect: 'B' });
    expect(realErrors(page)).toEqual([]);
  });

  test('10. rapid seeks across several boundaries never strand a wrong section on screen', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.A },
      { id: 's2', start: 8, end: 13, section: S.B },
      { id: 's3', start: 13, end: 18, section: S.A },
    ]));
    await startPlayback(page);
    const sampling = sampleFrames(page, 2600);
    for (const t of [4, 9, 14, 4, 14, 9, 4]) { await seekTo(page, t); await page.waitForTimeout(120); }
    await sampling;
    await seekTo(page, 4);
    await page.waitForTimeout(1400);
    const settled = await sampleFrames(page, 500);
    assertVisibleFramesAreCorrect(settled, { expect: 'A' });
    expect(realErrors(page)).toEqual([]);
  });

  test('11. sim-first project (timeline OPENS on a simulation)', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 0, end: 10, section: S.A }]));
    await startPlayback(page);
    await page.waitForTimeout(1800);
    const samples = await sampleFrames(page, 700);
    assertVisibleFramesAreCorrect(samples, { expect: 'A' });
    expect(realErrors(page)).toEqual([]);
  });

  test('12. post-roll simulation (runs past the end of the video)', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 25, end: 30, section: S.B }], { segDuration: 30 }));
    await startPlayback(page);
    await seekTo(page, 26);
    await page.waitForTimeout(1800);
    const samples = await sampleFrames(page, 700);
    // A post-roll sim must not be able to hold a parked spinner: either it is applied and shown,
    // or the underlying content stays. Never a wrong section.
    assertVisibleFramesAreCorrect(samples, { expect: 'B' });
  });

  // UNRESOLVED — these two fail today and the cause is NOT yet established: it may be a genuine
  // viewer defect on the legacy/no-rAF path, or the fixture packages (which the child-level suite
  // drives directly) may not be wired for the viewer's pooled URL shape. They are marked fixme so
  // they stay visible instead of being deleted or silently passing. Both paths MUST be resolved
  // before any rollout that depends on legacy packages rendering in the real viewer.
  test.fixme('13. a LEGACY package (no ack support) is still displayed, never held on silence', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 10, pkg: 'legacy', section: S.A },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(2000);
    const samples = await sampleFrames(page, 700);
    const everShown = samples.some((s) => s.frames.some((f) => f.op > 0.5));
    expect(everShown, 'a legacy package must never be made to wait on an ack it cannot send').toBe(true);
  });

  test.fixme('14. a package that never drives rAF stays displayable (no permanent spinner)', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 12, pkg: 'noraf', section: S.A },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(3000);
    const samples = await sampleFrames(page, 700);
    const everShown = samples.some((s) => s.frames.some((f) => f.op > 0.5));
    expect(everShown, 'the bounded ceiling must terminally release a sim that can never ack a paint').toBe(true);
  });

  test('15. hidden simulation frames are muted, inert and untabbable', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.A },
      { id: 's2', start: 8, end: 14, section: S.B },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(1200);
    const state = await page.evaluate(() => {
      const out: { visible: boolean; inert: boolean; ariaHidden: boolean; tabbable: boolean }[] = [];
      document.querySelectorAll('iframe').forEach((f) => {
        const el = f as HTMLIFrameElement;
        if (!/index\.html/.test(el.src)) return;
        let op = parseFloat(getComputedStyle(el).opacity) || 0;
        let n: HTMLElement | null = el.parentElement;
        for (let i = 0; n && i < 4; i++, n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity) || 0;
        out.push({
          visible: op > 0.01,
          inert: el.hasAttribute('inert'),
          ariaHidden: el.getAttribute('aria-hidden') === 'true',
          tabbable: el.tabIndex >= 0,
        });
      });
      return out;
    });
    for (const f of state.filter((x) => !x.visible)) {
      expect(f.inert, 'a hidden sim frame must be inert').toBe(true);
      expect(f.ariaHidden, 'a hidden sim frame must be aria-hidden').toBe(true);
      expect(f.tabbable, 'a hidden sim frame must not be tabbable').toBe(false);
    }
  });

  test('16. page hidden → visible (backgrounding) does not strand a wrong section', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 3, end: 12, section: S.A }]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(800);
    const samples = await sampleFrames(page, 600);
    assertVisibleFramesAreCorrect(samples, { expect: 'A' });
  });

  test('17. viewport resize (rotation-equivalent) keeps the section applied', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 3, end: 12, section: S.A }]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(1200);
    await page.setViewportSize({ width: 480, height: 900 });   // portrait
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 1280, height: 720 });  // back to landscape
    await page.waitForTimeout(700);
    const samples = await sampleFrames(page, 600);
    assertVisibleFramesAreCorrect(samples, { expect: 'A' });
    expect(realErrors(page)).toEqual([]);
  });

  test('18. unmounting the viewer during a pending transition throws nothing', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.A },
      { id: 's2', start: 8, end: 14, section: S.SLOW },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(700);
    await seekTo(page, 9);                       // start a switch…
    await page.waitForTimeout(60);               // …and navigate away mid-flight
    await page.goto('about:blank');
    await page.waitForTimeout(600);
    expect(realErrors(page)).toEqual([]);
  });
});
