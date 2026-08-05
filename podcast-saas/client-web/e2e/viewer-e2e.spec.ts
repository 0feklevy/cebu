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
import { fixtureIsFresh } from './fixtureSources';
import { SIM_FADE_MS } from '../lib/sim/protocol';

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
  // ── delayedack-ONLY sections (FIXTURE_DELAYED_SECTIONS in gen-sim-fixture.ts) ──────────────
  // They exist in NO other package, and their identity IS their acknowledgement behaviour — the
  // player dispatches on the URL's ?section= param, so a test selects a stale/mis-tokened ack
  // deterministically by putting the section on the timeline. No timing race, no URL surgery.
  /** Acknowledges 2400ms after the request: a supersede or a teardown always wins that race. */
  LATE: '11111111-6666-4666-8666-111111111111',
  /** Acknowledges after 400ms echoing token + BAD_TOKEN_DELTA — matchesPending must reject it. */
  BADTOKEN: '22222222-7777-4777-8777-222222222222',
} as const;

/**
 * The corruption the BADTOKEN section applies to the token it echoes (gen-sim-fixture.ts). Kept in
 * sync by assertion, not by hope: S5 below asserts the acknowledged token IS request + this.
 */
const BAD_TOKEN_DELTA = 7777;

function ensureFixture(): void {
  const stamp = join(FIXTURE_DIR, 'modern', 'index.html');
  if (existsSync(stamp) && !process.env.SIM_FIXTURE_FORCE) {
    // The source list is SHARED (e2e/fixtureSources.ts). When each spec kept its own, they drifted:
    // three of them never stat'd simRuntimeChild.ts, so a child-runtime change left the fixture
    // "fresh" and the suite exercised the previous runtime.
    if (fixtureIsFresh(BACKEND, stamp)) return;
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const r = spawnSync('npx', ['tsx', 'src/scripts/gen-sim-fixture.ts', FIXTURE_DIR], { cwd: BACKEND, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture generation failed: ${r.stderr || r.stdout}`);
}

// ── local asset server: the sim packages + a tiny real video ───────────────────────────────
let server: Server;
let assetBase = '';
/** Where the fixture bytes really live; never handed to the page. */
let localOrigin = '';

/**
 * A REAL, decodable 40s H.264 clip, generated once by ffmpeg and cached beside the fixtures.
 * It must genuinely decode: the viewer gates sim pooling on an actual play attempt, and a
 * synthetic byte blob makes video.play() never settle — the whole suite then hangs rather than
 * failing, which is the worst possible outcome for a test.
 */
const MEDIA_DIR = join(FIXTURE_DIR, 'media');
const HLS_PATH = join(MEDIA_DIR, 'index.m3u8');
const MEDIA_PATH = join(MEDIA_DIR, 'clip.mp4');
/**
 * A REAL 40 s H.264 source, published BOTH as HLS and as a progressive mp4.
 *
 * HLS is not optional here. The viewer attaches hls.js whenever the browser supports it and feeds
 * it `hls_url ?? fallback_url`, so a progressive mp4 in that slot is handed to hls.js and never
 * decodes: `duration` stays NaN, every `currentTime` assignment is a silent no-op, the `playing`
 * event never fires — and the simulation pool, which arms on `playing`, never mounts a single
 * iframe. That is precisely how an earlier version of this suite "passed" while driving nothing.
 */
function ensureMedia(): void {
  if (existsSync(HLS_PATH) && existsSync(MEDIA_PATH)) return;
  mkdirSync(MEDIA_DIR, { recursive: true });
  const hls = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:d=40',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', join(MEDIA_DIR, 'seg%03d.ts'),
    '-y', HLS_PATH,
  ], { encoding: 'utf8' });
  if (hls.status !== 0 || !existsSync(HLS_PATH)) {
    throw new Error(`viewer-e2e: could not generate HLS test media with ffmpeg: ${hls.stderr || hls.stdout}`);
  }
  const mp4 = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:d=40',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-y', MEDIA_PATH,
  ], { encoding: 'utf8' });
  if (mp4.status !== 0 || !existsSync(MEDIA_PATH)) {
    throw new Error(`viewer-e2e: could not generate mp4 test media with ffmpeg: ${mp4.stderr || mp4.stdout}`);
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

/**
 * Injected into every fixture entry document. The sim runs cross-origin (as in production), so the
 * test cannot read its DOM — the document reports its own truth instead, every animation frame:
 * which section body is applied, and whether the sim's Full-UI control panel is displayed.
 * This is evidence FROM the rendered document, not an inference from messages the parent sent.
 */
const REPORTER = `<script>(function(){
  function tick(){
    try {
      var m = document.getElementById('marker');
      var c = document.querySelector('.controls');
      parent.postMessage({
        type: 'E2E_STATE',
        section: m ? m.getAttribute('data-section') : null,
        controls: !!c && getComputedStyle(c).display !== 'none',
        at: Date.now()
      }, '*');
    } catch (e) {}
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})()</script>`;

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
  localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Fixtures are addressed on the APPLICATION's own origin and fulfilled by route interception
  // below. Serving them from a second origin looks harmless and is not: the app ships a CSP whose
  // frame-src/media-src allow only 'self' and the API origin, so a foreign fixture origin has its
  // iframe AND its video refused — and, being cross-origin, iframe.contentDocument reads null, so
  // every per-frame section assertion silently degrades to a no-op and the suite passes while
  // proving nothing (audited).
  // The API origin with a /sim-public/ path — the EXACT shape production uses. This matters for
  // three independent reasons, each of which silently broke an earlier version:
  //   • the app's CSP allows frame-src/media-src only for 'self' and the API origin;
  //   • resolveAssetUrl rewrites any loopback URL onto the API origin, so a fixture addressed at
  //     the app origin is rebased anyway and a route registered on the app origin never matches;
  //   • resolveSimUrl's rebase is a no-op only for /sim-public/ paths.
  // Production sims are therefore genuinely CROSS-ORIGIN, so iframe.contentDocument is null by
  // design. Per-frame section evidence comes from inside the sim instead (see REPORTER).
  assetBase = `${API_ORIGIN}/sim-public/__e2e`;

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
      hls_url: `${assetBase}/media/index.m3u8`,
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

/**
 * Stub ONLY the data layer; every component and hook below it is the real one.
 *
 * `opts.simdebug` ARMS lib/simTelemetry, which is inert without `?simdebug=1` in the URL — it is
 * the shipped breadcrumb trail (SimRuntimeClient's own conclusions plus the player's reveal
 * decisions) that the stale-acknowledgement scenarios read. Opt-in on purpose: every existing
 * scenario boots on exactly the URL it always did, so none of them change behaviour here.
 */
async function bootViewer(page: Page, config: object, opts?: { simdebug?: boolean }): Promise<void> {
  // Serve the fixture on the API origin under /sim-public/, exactly as production does.
  await page.route(`${API_ORIGIN}/sim-public/__e2e/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace('/sim-public/__e2e/', '');
    const rangeHeader = route.request().headers()['range'];
    const upstream = await fetch(`${localOrigin}/${path}`, {
      headers: rangeHeader ? { range: rangeHeader } : {},
    });
    let body = Buffer.from(await upstream.arrayBuffer());
    const headers = Object.fromEntries(upstream.headers.entries());
    if (path.endsWith('.html')) {
      // The reporter is the evidence channel; without it a cross-origin sim is unobservable.
      body = Buffer.from(body.toString('utf-8').replace('</body>', `${REPORTER}</body>`), 'utf-8');
      delete headers['content-length'];
    }
    await route.fulfill({ status: upstream.status, headers, body });
  });
  // Firebase anonymous auth is a real network call to Google on every scenario. Its 400 surfaces
  // as a bare "Failed to load resource" with no Firebase token in the text, so the (correctly)
  // narrowed IGNORABLE filter does not match it — and ten scenarios assert realErrors(). The suite
  // was flipping red/green on Google's response rather than on the viewer (audited). Stub it.
  await page.route('https://identitytoolkit.googleapis.com/**', (route: Route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ idToken: 'e2e', refreshToken: 'e2e', expiresIn: '3600', localId: 'e2e-user' }),
    }));
  await page.route('https://securetoken.googleapis.com/**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id_token: 'e2e', expires_in: '3600' }) }));
  // ABORT, do not fake. WebKit's Firebase build preloads the gapi iframe shim; fulfilling it
  // with an empty script broke the SDK's init on that path, auth never resolved, and the viewer —
  // correctly — rendered nothing while authLoading was true, which took WebKit from 25/25 to 0/25
  // (audited: removing the stub alone made it boot again). A clean network failure is the case
  // every SDK's fallback path is built for, and it is deterministic and hermetic.
  await page.route('https://apis.google.com/**', (route: Route) => route.abort('failed'));
  await page.route('https://www.googleapis.com/**', (route: Route) => route.abort('failed'));

  await page.route(`${API_ORIGIN}/api/v1/projects/**/player-config*`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  // Everything else the page may ask the API for is irrelevant here; answer benignly so a missing
  // endpoint can never be mistaken for a viewer defect.
  await page.route(`${API_ORIGIN}/api/v1/**`, (route: Route) => {
    if (route.request().url().includes('player-config')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Bind each E2E_STATE report to the iframe that sent it. contentWindow IS reachable
  // cross-origin (contentDocument is not), so identity comparison works.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __CHILD?: Map<Window, unknown>;
      __PROTO_LOG?: unknown[];
      __PAINTED_SRCS?: string[];
    };
    w.__CHILD = new Map();
    // WHICH document claimed a paint, not merely that one did. A package the viewer classifies
    // paint-INCAPABLE (canEmitPaint === false) must never appear here; without recording the
    // source, a future gate leak that made such a package ack would be invisible and the
    // scenario that exists to cover the !canEmitPaint branch would quietly stop covering it.
    w.__PAINTED_SRCS = [];
    window.addEventListener('message', (e) => {
      const d = e.data as { type?: string } | null;
      const anyW = w as unknown as { __PROTO_LOG?: unknown[] };
      if (!anyW.__PROTO_LOG) anyW.__PROTO_LOG = [];
      if (d?.type === 'PROTO') anyW.__PROTO_LOG.push((d as { entry: unknown }).entry);
      if (d?.type === 'SIM_PAINTED' && e.source) {
        const own = ([...document.querySelectorAll('iframe')] as HTMLIFrameElement[])
          .find((el) => el.contentWindow === e.source);
        if (own) w.__PAINTED_SRCS!.push(own.src);
      }
      if (d?.type === 'E2E_STATE' && e.source) {
        w.__CHILD!.set(e.source as Window, { ...(d as object), recvAt: Date.now() });
      }
    });
  });

  // ── external-request gate ────────────────────────────────────────────────────────────────
  // Every request must resolve to the app, the API origin, or an explicitly stubbed dependency.
  // An unstubbed third party makes the suite's verdict depend on someone else's uptime: a Firebase
  // 400 from identitytoolkit.googleapis.com was deciding red/green on ten scenarios (audited).
  const external: string[] = [];
  (page as Page & { __external?: string[] }).__external = external;
  // OBSERVE, do not intercept. A catch-all page.route('**/*') that merely falls through still
  // routes every request through the driver, and WebKit could not boot the app under it at all —
  // all 20 of its scenarios timed out waiting for the <video> element. Observation cannot change
  // loading behaviour, which is exactly what a hermeticity check must not do.
  page.on('request', (req) => {
    const url = req.url();
    const allowed = url.startsWith(BASE) || url.startsWith(API_ORIGIN)
      || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')
      // Explicitly STUBBED third parties are approved — they never reach the network. Anything
      // else here means the suite's verdict depends on someone else's uptime.
      || STUBBED_HOSTS.some((h) => url.startsWith(h));
    if (!allowed) external.push(url);
  });

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  (page as Page & { __errors?: string[] }).__errors = errors;

  await page.goto(
    `${BASE}/projects/e2e-project/view${opts?.simdebug ? '?simdebug=1' : ''}`,
    { waitUntil: 'domcontentloaded' },
  );
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


/**
 * Wait until the sim actually shows `section` at a real opacity, instead of guessing with a fixed
 * timeout. A fixed wait is a silent flake source under load: when the machine is busy the
 * transition simply has not happened yet, and the test then samples the PREVIOUS state and fails
 * for a reason that has nothing to do with the code. This waits for the condition the test is
 * about to assert on — it never weakens the assertion, it only stops sampling too early.
 */
/** Samples at or after `abs` — anchored to a real event, never to an arbitrary fraction. */
const since = (samples: Sample[], abs: number): Sample[] => samples.filter((s) => s.abs >= abs);

/** The wall-clock instant a switch is requested, read from the page's own clock. */
const now = (page: Page): Promise<number> => page.evaluate(() => Date.now());

async function waitForSection(page: Page, section: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction((want) => {
    const map = (window as unknown as { __CHILD?: Map<Window, { section: string | null }> }).__CHILD;
    if (!map) return false;
    const frames = [...document.querySelectorAll('iframe')] as HTMLIFrameElement[];
    return frames.some((el) => {
      if (!/index\.html/.test(el.src)) return false;
      let op = parseFloat(getComputedStyle(el).opacity) || 0;
      let n: HTMLElement | null = el.parentElement;
      for (let i = 0; n && i < 4; i++, n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity) || 0;
      return op > 0.5 && map.get(el.contentWindow as Window)?.section === want;
    });
  }, section, { timeout });
}

interface Sample { t: number; abs: number; frames: { op: number; section: string | null; controls: boolean; stale: boolean; src: string }[] }

/**
 * Sample every animation frame from inside the page: for each sim iframe, its LIVE animated
 * opacity, which section its marker says is applied, and whether the sim's own Full-UI control
 * panel is displayed. Same-origin (the asset server) so the iframe document is readable.
 */
/**
 * Start sampling and resolve only once the in-page rAF loop has actually begun, so a caller that
 * immediately seeks cannot race past the first sample and lose the transition it meant to observe.
 */
async function startSampling(page: Page, ms: number): Promise<Promise<Sample[]>> {
  const p = sampleFrames(page, ms);
  await page.waitForTimeout(80);
  return p;
}

async function sampleFrames(page: Page, ms: number): Promise<Sample[]> {
  return page.evaluate((duration) => new Promise<Sample[]>((resolve) => {
    const out: Sample[] = [];
    const t0 = performance.now();
    const tick = () => {
      const frames: Sample['frames'] = [];
      document.querySelectorAll('iframe').forEach((f) => {
        const el = f as HTMLIFrameElement;
        if (!/index\.html/.test(el.src)) return;
        // Cross-origin by design: read the document's OWN report rather than its DOM.
        const rep = (window as unknown as {
          __CHILD?: Map<Window, { section: string | null; controls: boolean; recvAt: number }>;
        }).__CHILD?.get(el.contentWindow as Window);
        // A report older than a few frames is STALE: the sim's rAF loop is starved (a
        // synchronously-blocking body does exactly that), so it still names the PREVIOUS section
        // whether the code is right or wrong. Trusting it is what let a dead apply gate pass.
        const fresh = !!rep && (Date.now() - rep.recvAt) < 120;
        const section: string | null = fresh ? (rep!.section ?? null) : null;
        const controls = fresh ? rep!.controls : false;
        const stale = !!rep && !fresh;
        // The animated opacity may live on the iframe or on a wrapper; take the effective product.
        let op = parseFloat(getComputedStyle(el).opacity) || 0;
        let node: HTMLElement | null = el.parentElement;
        for (let i = 0; node && i < 4; i++, node = node.parentElement) {
          op *= parseFloat(getComputedStyle(node).opacity) || 0;
        }
        frames.push({ op, section, controls, stale, src: el.src });
      });
      out.push({ t: Math.round(performance.now() - t0), abs: Date.now(), frames });
      if (performance.now() - t0 < duration) requestAnimationFrame(tick);
      else resolve(out);
    };
    requestAnimationFrame(tick);
    // Hard stop: a throttled or backgrounded page stops firing rAF, and a sampler that can hang
    // turns a real failure into a timeout with no evidence.
    setTimeout(() => resolve(out), duration + 2000);
  }), ms);
}

/**
 * The core invariant: nothing visible may show the wrong section or forbidden Full UI.
 *
 * `requirePresented` (default true) is what stops this from passing vacuously. If no sim frame was
 * ever sampled — the pool never armed, the URL shape changed, the fixture failed to load — there
 * are no frames to violate anything and an empty violation list reads as success (audited).
 */
function assertVisibleFramesAreCorrect(
  samples: Sample[],
  opts: { expect: string; forbidPrevious?: string; minimalUi?: boolean; requirePresented?: boolean },
): void {
  if (opts.requirePresented !== false) {
    const shown = samples.some((s) => s.frames.some((f) => f.op > 0.5));
    expect(shown, 'no simulation frame was ever presented — the assertions below would be vacuous').toBe(true);
    const readable = samples.some((s) => s.frames.some((f) => f.section !== null));
    expect(readable, 'no iframe document was readable — section evidence is unavailable, so this test proves nothing').toBe(true);
    // A presented frame whose evidence went stale for a long stretch is not a pass: it is an
    // unobserved window, and an unobserved window is exactly where a wrong section hides.
    const staleVisible = samples.filter((s) => s.frames.some((f) => f.op > 0.5 && f.stale)).length;
    expect(staleVisible, `${staleVisible}/${samples.length} presented samples had STALE evidence`)
      .toBeLessThan(Math.max(4, samples.length * 0.5));
  }
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
// Deliberately NARROW. An earlier version matched bare `media` and `Failed to load resource`,
// which in a video player swallows MediaError, matchMedia, HTMLMediaElement crashes and every
// failed subresource — and since realErrors is often the last surviving assertion, that filter
// was load-bearing and leaked (audited).
/** Third parties this suite stubs. Requests to these are fulfilled locally, never sent. */
const STUBBED_HOSTS = [
  'https://identitytoolkit.googleapis.com/',
  'https://securetoken.googleapis.com/',
  // WebKit's Firebase auth path additionally loads the gapi iframe shim. ABORTED, not faked:
  // fulfilling it with an empty script broke the SDK's init on WebKit's path (audited).
  'https://apis.google.com/',
  'https://www.googleapis.com/',
];

const IGNORABLE = /Firebase|auth\/(invalid|api-key)|play\(\) request|NotAllowedError|AbortError|X-Frame-Options|Refused to display/i;
const realErrors = (page: Page): string[] => errorsOf(page).filter((e) => !IGNORABLE.test(e));

// ── protocol + telemetry evidence ─────────────────────────────────────────────────────────

/**
 * One record from the `delayedack` bridge's protocol log (gen-sim-fixture.ts). The child is
 * cross-origin, so it POSTS every record; the init script above collects them on __PROTO_LOG.
 *
 * `token` is what went ON THE WIRE. `requestToken` is what the activation carried. They differ
 * exactly when a mis-tokened acknowledgement is being exercised (the BADTOKEN section), which is
 * what makes "this ack answers THIS request, but with the wrong token" expressible at all.
 */
interface ProtoRecord {
  type: 'startScript' | 'stopScript' | 'SCRIPT_APPLIED' | 'SCRIPT_MISSING' | 'SCRIPT_ERROR';
  script: string | null;
  token: number | null;
  requestToken: number | null;
  receivedAt: number;
  applyStart: number | null;
  applyComplete: number | null;
  ackAt: number | null;
}

async function protoLog(page: Page): Promise<ProtoRecord[]> {
  const raw = await page.evaluate(() => (window as unknown as { __PROTO_LOG?: unknown[] }).__PROTO_LOG ?? []);
  return raw as ProtoRecord[];
}

/**
 * One record from lib/simTelemetry — VERIFIED against the real module rather than assumed:
 * `window.__SIM_TELEMETRY__` is `{ events, export(), clear() }`, and `events` IS the live array of
 * `{ t: Math.round(performance.now()), event, ...detail }` records. `export()` is only a JSON
 * serialisation of that same array, so reading `.events` is both the direct and the cheaper path
 * (and is what e2e/sim-pool.spec.ts already does).
 *
 * `abs` does not exist in the module — it is computed HERE, inside the page, so a telemetry event
 * can be correlated with the child's Date.now()-based PROTO timestamps and with the sampler's
 * `abs`. Without it the three evidence streams cannot be ordered against each other at all.
 */
interface TelemetryEvent { t: number; abs: number; event: string; [key: string]: unknown }

async function telemetry(page: Page): Promise<TelemetryEvent[]> {
  const raw = await page.evaluate(() => {
    const api = (window as unknown as {
      __SIM_TELEMETRY__?: { events: Array<{ t: number; event: string }> };
    }).__SIM_TELEMETRY__;
    const origin = performance.timeOrigin;
    return (api?.events ?? []).map((e) => ({ ...e, abs: Math.round(origin + e.t) }));
  });
  return raw as TelemetryEvent[];
}

/** Just the event names, in order — for `toContain` assertions. */
const events = (log: TelemetryEvent[]): string[] => log.map((e) => e.event);

/**
 * Wait until the child has recorded a matching protocol entry. A hidden cross-origin iframe has
 * its timers CLAMPED by the browser, so a fixture's nominal 2400ms ack can land much later — a
 * fixed sampling window silently turns "the ack was slow" into "the ack never came" and asserts
 * on an empty log. Poll for the fact instead of guessing at a duration.
 */
/**
 * Section-identity evidence lag. The child's E2E_STATE report travels child-rAF → postMessage →
 * parent map, and the sampler accepts reports up to 120ms old (the freshness bound) — so a report
 * GENERATED before an event can be read as "current" for up to ~120ms plus a frame after it.
 * Windows that assert WHICH section is shown must start this far after their anchoring event.
 * Windows that assert only opacity need no lag: opacity is read directly from the parent DOM.
 */
const EVIDENCE_LAG_MS = 150;

async function waitForProto(
  page: Page, type: string, script: string | null, timeout = 30_000,
): Promise<void> {
  await page.waitForFunction(([t, sc]) => {
    const log = (window as unknown as { __PROTO_LOG?: { type: string; script: string | null }[] }).__PROTO_LOG ?? [];
    return log.some((e) => e.type === t && (sc === null || e.script === sc));
  }, [type, script] as [string, string | null], { timeout });
}

/** Which iframe DOCUMENTS claimed a SIM_PAINTED (see the init script above). */
const paintedSrcs = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __PAINTED_SRCS?: string[] }).__PAINTED_SRCS ?? []);

/** Unapproved external requests — a suite that talks to third parties does not have a verdict. */
const externalRequests = (page: Page): string[] => (page as Page & { __external?: string[] }).__external ?? [];

// ── the suite ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────────────────
// HISTORY — why this file is shaped the way it is. It is committed deliberately, marked, and
// must be finished before it is cited as evidence for anything.
//
// The first version of it PASSED 15/18 while proving nothing. Two independent faults combined:
//   1. the fixture was served from a second origin (127.0.0.1:<ephemeral>), so
//      iframe.contentDocument read null and every per-frame section/controls assertion silently
//      degraded to a no-op; and
//   2. the app's own CSP (frame-src/media-src allow only 'self' and the API origin) refused both
//      the fixture iframe and the test video — so the media never loaded, video.duration stayed
//      NaN, and every seekTo() was a silent no-op on a timeline that never moved.
// Together those made a green suite that asserted nothing about a viewer it never drove.
//
// Fixed since: fixtures are addressed on the application's own origin and fulfilled by route
// interception (satisfies CSP, keeps contentDocument readable); requirePresented asserts a frame
// was actually shown AND that its document was readable, so the vacuous path now fails loudly;
// the ignorable-error filter no longer swallows `media` or `Failed to load resource`.
//
// ROOT CAUSE, since established and fixed: the fixture published a progressive mp4 as the
// segment source. The viewer attaches hls.js whenever the browser supports it and feeds it
// `hls_url ?? fallback_url`, so the mp4 went to hls.js and never decoded — duration NaN, every
// seek a no-op, no `playing` event, and the pool (which arms on `playing`) never mounted an
// iframe. The fixture now publishes real HLS. Separately, sims are cross-origin in production,
// so per-frame section/controls evidence now comes from a reporter inside the sim document.
test.describe('real React viewer — simulation transitions', () => {
  test('1. cold video → simulation: the sim is never presented blank or unapplied', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 5, end: 15, section: S.A }]));
    await startPlayback(page);
    await seekTo(page, 6);
    await waitForSection(page, 'A');
    const samples = await sampleFrames(page, 1200);
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
    await waitForSection(page, 'A');
    const move = sampleFrames(page, 1600);
    const at = await now(page);
    await seekTo(page, 9);
    const samples = await move;
    // Anchored to the SEEK, not to a fraction of the window. Slicing the first third away
    // discarded the transition itself — the switch completes ~12ms in while the slice began
    // ~537ms in — and a DEAD apply gate passed unchanged (audited mutation). Anchoring keeps the
    // transition under assertion while excluding the time before B was ever requested, when A is
    // legitimately on screen.
    // Anchored one FADE past the request: the outgoing frame is legitimately still
    // descending for SIM_FADE_MS, and the rigorous pre-acknowledgement invariant is owned by
    // the dedicated gate acceptance test, which correlates against the child's real ack
    // timestamp instead of a constant.
    const win = since(samples, at + SIM_FADE_MS);
    expect(win.length, 'no post-fade samples — vacuous').toBeGreaterThan(5);
    assertVisibleFramesAreCorrect(win, { expect: 'B', forbidPrevious: 'A' });
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
    await waitForSection(page, 'A');
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
    await waitForSection(page, 'A');
    const samples = await sampleFrames(page, 1200);
    assertVisibleFramesAreCorrect(samples, { expect: 'A', minimalUi: true });
    expect(realErrors(page)).toEqual([]);
  });

  test('5. Minimal UI → video: the exit fade never restores Full UI on screen', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.A, simpleUi: true, hide: ['.controls'] },
    ]));
    await startPlayback(page);
    await seekTo(page, 4);
    await waitForSection(page, 'A');
    const exiting = await startSampling(page, 1200);
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
    // The correct outcome is the video playing on, so requirePresented is deliberately OFF here:
    // demanding a presented frame would demand the very defect this test rejects. What must hold
    // is that A's body is never shown standing in for the missing section.
    expect(late.length, 'no post-transition samples — the assertions below would be vacuous').toBeGreaterThan(5);
    assertVisibleFramesAreCorrect(late, { expect: 'none', forbidPrevious: 'A', requirePresented: false });
    // …and the missing section must never have been silently substituted by another body.
    const wrong = late.flatMap((s) => s.frames).filter((f) => f.op > 0.01 && f.section === 'A');
    expect(wrong.length, 'the previous section was shown in place of the missing one').toBe(0);
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
    await waitForSection(page, 'B');
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
    const at = await now(page);
    await seekTo(page, 10);
    const samples = await move;
    // Anchored for the same reason: the violating frame lands ~450ms after the seek and the old
    // half-slice started ~1224ms in, discarding it.
    // Anchored one FADE past the request: the outgoing frame is legitimately still
    // descending for SIM_FADE_MS, and the rigorous pre-acknowledgement invariant is owned by
    // the dedicated gate acceptance test, which correlates against the child's real ack
    // timestamp instead of a constant.
    const win = since(samples, at + SIM_FADE_MS);
    expect(win.length, 'no post-fade samples — vacuous').toBeGreaterThan(5);
    assertVisibleFramesAreCorrect(win, { expect: 'SLOW', forbidPrevious: 'A' });
  });

  test('9. direct seek INTO a simulation (no warm-up) still applies the right section', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 10, end: 20, section: S.B }]));
    await startPlayback(page);
    await seekTo(page, 12);                       // straight in, no lead-in
    await waitForSection(page, 'B');
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
    const during = await sampling;
    // The rapid-seek window is the point of this test; the old version discarded it entirely and
    // asserted only on a fresh settled sample afterwards (audited).
    expect(during.length, 'no samples were taken during rapid seeking — vacuous').toBeGreaterThan(10);
    const wrongDuring = during.flatMap((s) => s.frames)
      .filter((f) => f.op > 0.5 && !f.stale && f.section !== null && f.section !== 'none'
                     && f.section !== 'A' && f.section !== 'B');
    expect(wrongDuring.length, 'a section outside the timeline was presented during rapid seeking').toBe(0);
    await seekTo(page, 4);
    await waitForSection(page, 'A');
    const settled = await sampleFrames(page, 500);
    assertVisibleFramesAreCorrect(settled, { expect: 'A' });
    expect(realErrors(page)).toEqual([]);
  });

  test('11. sim-first project (timeline OPENS on a simulation)', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 0, end: 10, section: S.A }]));
    await startPlayback(page);
    await waitForSection(page, 'A');
    const samples = await sampleFrames(page, 700);
    assertVisibleFramesAreCorrect(samples, { expect: 'A' });
    expect(realErrors(page)).toEqual([]);
  });

  test('12. post-roll simulation (runs past the end of the video)', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 25, end: 30, section: S.B }], { segDuration: 30 }));
    await startPlayback(page);
    await seekTo(page, 26);
    await waitForSection(page, 'B');
    const samples = await sampleFrames(page, 700);
    // A post-roll sim must not be able to hold a parked spinner: either it is applied and shown,
    // or the underlying content stays. Never a wrong section.
    assertVisibleFramesAreCorrect(samples, { expect: 'B' });
  });

  test('12b. a sim that OUTLIVES the video is still shown after `ended`', async ({ page }) => {
    // Test 12 uses end_sec === segDuration, so `seg.duration < s.end_sec` is FALSE and onEnded's
    // post-roll branch never runs — the real case (a section that continues past the last frame)
    // had no coverage at all.
    //
    // NOTE ON DURATIONS: the fixture media is 40s of ffmpeg colour, while `segDuration` only sets
    // what the CONFIG claims. So end_sec has to clear the MEDIA length, not the config's — a sim
    // ending at 40 ends exactly when the video does and is not a post-roll at all. (Diagnosed the
    // hard way: the first version of this test asserted against duration 40 and failed for that
    // reason rather than for the behaviour under test.)
    await bootViewer(page, makeConfig([{ id: 's1', start: 25, end: 60, section: S.B }], { segDuration: 30 }));
    await startPlayback(page);
    await seekTo(page, 26);
    await waitForSection(page, 'B');

    // Drive the video to its end and let `ended` fire.
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) v.currentTime = Math.max(0, (v.duration || 30) - 0.05);
    });
    await page.waitForTimeout(2500);

    const samples = await sampleFrames(page, 700);
    const everShown = samples.some((s) => s.frames.some((f) => f.op > 0.5));
    expect(everShown, 'the post-roll sim was not on screen after the video ended').toBe(true);
    assertVisibleFramesAreCorrect(samples, { expect: 'B' });
  });

  test('13. a LEGACY package (no ack support) is still displayed, never held on silence', async ({ page }) => {
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

  test('14. a package that can never ack a paint stays displayable (no permanent spinner)', async ({ page }) => {
    // `nopaint`, NOT `noraf`. Verified in the fixture generator: `noraf` still carries the real v4
    // rAF gate and still advertises `dispatch: 'dynamic'`, so learnCanEmitPaint() folds it into
    // canEmitPaint === true and the gate (helped by this suite's own rAF reporter) makes it PAINT.
    // The viewer's `!m.canEmitPaint` bounded-hold force-reveal branch therefore had zero coverage.
    // `nopaint` is the one package that is honestly incapable: bare `{type:'SIM_READY'}` (no
    // dispatch advertisement → dynamic stays null → canEmitPaint stays false) AND emitted with no
    // rAF gate at all, so nothing in its bytes can post SIM_PAINTED.
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 12, pkg: 'nopaint', section: S.A },
    ]), { simdebug: true });
    await startPlayback(page);
    await seekTo(page, 4);
    await page.waitForTimeout(3000);
    const samples = await sampleFrames(page, 700);
    const everShown = samples.some((s) => s.frames.some((f) => f.op > 0.5));
    expect(everShown, 'the bounded ceiling must terminally release a sim that can never ack a paint').toBe(true);
    // …and it must have been released WITHOUT a paint acknowledgement. If a future change injects
    // the gate into this package — or lets anything else stand in for it — this fails loudly
    // instead of quietly turning the scenario back into a duplicate of the modern one.
    const leaked = (await paintedSrcs(page)).filter((s) => /\/nopaint\//.test(s));
    expect(leaked,
      'a nopaint document claimed SIM_PAINTED — the package is no longer paint-incapable, so the '
      + 'canEmitPaint === false branch this scenario exists for is not being exercised').toEqual([]);
    // The reveal came from the viewer's OWN bounded-hold force-reveal branch. This is the event
    // useProjectPlayer really emits there (`!m.canEmitPaint` → markPaintedByPolicy('bounded-hold')
    // → revealSim({ force: true })) — the name is read from the code, not assumed.
    expect(events(await telemetry(page)),
      'the bounded-hold force-reveal branch never ran — something else released the hold')
      .toContain('hold-expired-legacy-reveal');
    expect(externalRequests(page), 'unapproved external requests on the nopaint path').toEqual([]);
  });

  test('15. hidden simulation frames are muted, inert and untabbable', async ({ page }) => {
    // DIFFERENT packages on purpose: two sections of the SAME package share one pooled iframe, so
    // there is never a hidden frame and the assertions below iterate an empty list and pass
    // vacuously (audited — the loop body never executed).
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, section: S.A },
      { id: 's2', start: 8, end: 14, pkg: 'legacy', section: S.A },
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
    expect(state.length, 'no sim frames were found — the hidden-frame checks would be vacuous').toBeGreaterThan(0);
    const hidden = state.filter((x) => !x.visible);
    expect(hidden.length, 'no HIDDEN frame existed, so nothing about hidden frames was asserted').toBeGreaterThan(0);
    for (const f of hidden) {
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
    await waitForSection(page, 'A');
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
    await waitForSection(page, 'A');
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

/**
 * THE APPLY-GATE ACCEPTANCE TEST — the one scenario that proves the gate from visible behaviour.
 *
 * Every other scenario in this file is blind to the gate, and that is not a flaw in them: with an
 * instantly-applying body the gate genuinely changes nothing observable (measured — the clean and
 * dead-gate opacity/section trajectories are identical), and the blocking SLOW body freezes the
 * parent's own sampler because the sim shares its process.
 *
 * The `delayedack` package closes that hole, and it now does so with PRODUCTION PARITY: the
 * section body is applied SYNCHRONOUSLY on receipt — exactly as the shipping bridge does — and
 * ONLY the SCRIPT_APPLIED is deferred (~500ms by default), scheduled outside any cancellable
 * scope just as production's `_sysRaf(_ack)` sits outside `_trackTimers`. The event loop keeps
 * running, the parent keeps sampling, and there is a real window in which the frame MUST be hidden
 * because the acknowledgement has not arrived.
 *
 * The parity matters beyond this test: because the ack is uncancellable, a SUPERSEDED or
 * TORN-DOWN activation still acknowledges — late, and stale. An earlier fixture deferred the apply
 * too and dropped its pending ack on stopScript, which is precisely the politeness that left
 * matchesPending() — the rule that decides whether a stale ack may present a frame — with no
 * fixture at all. The stale-acknowledgement suite at the bottom of this file drives that path.
 *
 * The assertion is anchored to the CHILD's own recorded acknowledgement timestamp — not a slice,
 * not a settle delay, not a fade exemption, not an allowance of wrong frames, not telemetry.
 */
test.describe('apply gate — proven against the acknowledgement boundary', () => {
  test('the frame is never presented before the matching SCRIPT_APPLIED(B, token)', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8, pkg: 'delayedack', section: S.A },
      { id: 's2', start: 8, end: 20, pkg: 'delayedack', section: S.B },
    ]));
    await startPlayback(page);

    await seekTo(page, 4);
    await waitForSection(page, 'A');                 // A genuinely presented first

    const sampling = await startSampling(page, 5000);
    await seekTo(page, 9);                           // request B; its ack is ~500ms away
    const samples = await sampling;

    // ── the child's own protocol record ────────────────────────────────────────────────────
    const proto = await page.evaluate(
      () => (window as unknown as { __PROTO_LOG?: unknown[] }).__PROTO_LOG ?? [],
    ) as { type: string; script: string; token: number; receivedAt: number; ackAt: number | null }[];

    const startB = proto.find((e) => e.type === 'startScript' && e.script === S.B);
    const ackB = proto.find((e) => e.type === 'SCRIPT_APPLIED' && e.script === S.B);
    expect(startB, 'the child never received startScript(B) — nothing was exercised').toBeTruthy();
    expect(ackB, 'the child never acknowledged B — the gate window cannot be evaluated').toBeTruthy();
    expect(ackB!.token, 'the acknowledgement carried a different token than the request')
      .toBe(startB!.token);

    const requestedAt = startB!.receivedAt;
    const acknowledgedAt = ackB!.ackAt!;
    // The delay must be real, or there is no window in which the gate could be observed.
    expect(acknowledgedAt - requestedAt,
      'the fixture applied instantly — this scenario would prove nothing').toBeGreaterThan(200);

    // ── the parent's continuously recorded opacity, correlated to that boundary ─────────────
    const inWindow = samples.filter((s) => s.abs > requestedAt && s.abs < acknowledgedAt);
    expect(inWindow.length,
      'no opacity samples fell between the request and the acknowledgement — vacuous').toBeGreaterThan(5);

    // The exit fade may legitimately still be descending immediately after the request, so the
    // pre-ack window is evaluated after one fade duration — a bound derived from the product
    // constant, not a tolerance chosen to make this pass.
    const preAck = inWindow.filter((s) => s.abs > requestedAt + SIM_FADE_MS);
    expect(preAck.length, 'no post-fade pre-ack samples — vacuous').toBeGreaterThan(3);

    // Without this, `presentedEarly` is a filter over an empty frame list whenever the sampler
    // failed to find the iframe — it yields 0 and the gate assertion passes having observed
    // nothing (audited: proved vacuous by blinding the sampler's src filter).
    expect(preAck.some((s) => s.frames.length > 0),
      'no simulation frame was observed in the pre-ack window — the gate assertion would be vacuous').toBe(true);

    const presentedEarly = preAck
      .flatMap((s) => s.frames.map((f) => ({ t: s.abs - requestedAt, op: f.op, section: f.section })))
      .filter((f) => f.op > 0.05);
    expect(
      presentedEarly.length,
      `the iframe was PRESENTED BEFORE the matching SCRIPT_APPLIED(B, token=${startB!.token}): `
      + `${presentedEarly.slice(0, 6).map((f) => `t=+${f.t}ms op=${f.op.toFixed(2)} section=${f.section}`).join('; ')}`,
    ).toBe(0);

    // ── and after the acknowledgement, B is actually revealed ───────────────────────────────
    await waitForSection(page, 'B');
    const after = await sampleFrames(page, 400);
    assertVisibleFramesAreCorrect(after, { expect: 'B' });
  });
});

test.describe('hermeticity', () => {
  test('the suite makes no unapproved external network request', async ({ page }) => {
    await bootViewer(page, makeConfig([{ id: 's1', start: 3, end: 12, section: S.A }]));
    await startPlayback(page);
    await seekTo(page, 4);
    await waitForSection(page, 'A');
    const ext = externalRequests(page);
    expect(ext, `unapproved external requests: ${[...new Set(ext)].slice(0, 8).join(', ')}`).toEqual([]);
  });
});

/**
 * STALE / SUPERSEDED ACKNOWLEDGEMENTS — the inputs SimRuntimeClient.matchesPending exists to reject.
 *
 * The real bridge applies a section SYNCHRONOUSLY and then schedules its SCRIPT_APPLIED via
 * `_sysRaf(_ack)` — a call made OUTSIDE `_trackTimers`. Neither `_clearTimers` nor `stopScript` can
 * reach that callback, so in production a late acknowledgement genuinely survives a supersede and a
 * teardown. The delayedack fixture now reproduces exactly that (it previously cancelled pending
 * acks, i.e. it was politer than production and this whole class went untested).
 *
 * `LATE` (acks 2400ms after the request) and `BADTOKEN` (acks after 400ms echoing token+7777) select
 * the behaviour by SECTION ID, so none of these depend on winning a race.
 */
test.describe('stale acknowledgements — supersede, teardown and token mismatch', () => {
  /** A (proves the document acknowledges) → LATE (2400ms away) → superseded by B. */
  async function driveSupersede(page: Page): Promise<Sample[]> {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3,  end: 8,  pkg: 'delayedack', section: S.A },
      { id: 's2', start: 8,  end: 14, pkg: 'delayedack', section: S.LATE },
      { id: 's3', start: 14, end: 28, pkg: 'delayedack', section: S.B },
    ]), { simdebug: true });
    await startPlayback(page);
    await seekTo(page, 4);
    await waitForSection(page, 'A');
    const sampling = await startSampling(page, 30_000);
    // Synchronise on the CHILD's evidence at every step. LATE retains its acknowledgement until
    // the next real lifecycle event, so the supersede itself is what releases it — no parent
    // command, and no dependence on the viewer reaching B within a guessed number of ms
    // (measured: it took ~5.8s, which is why a fixed 2400ms delay never produced a stale window).
    await seekTo(page, 9);
    await waitForProto(page, 'startScript', S.LATE);    // activation A was issued …
    await seekTo(page, 15);
    await waitForProto(page, 'startScript', S.B);       // … the SUPERSEDING activation was issued …
    await waitForProto(page, 'SCRIPT_APPLIED', S.B);    // … and applied …
    await waitForProto(page, 'SCRIPT_APPLIED', S.LATE); // … only then does A's stale ack land
    return sampling;
  }

  /** A → LATE, then leave every simulation before LATE acknowledges. */
  async function driveAbandon(page: Page): Promise<Sample[]> {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8,  pkg: 'delayedack', section: S.A },
      { id: 's2', start: 8, end: 14, pkg: 'delayedack', section: S.LATE },
    ]), { simdebug: true });
    await startPlayback(page);
    await seekTo(page, 4);
    await waitForSection(page, 'A');
    const sampling = await startSampling(page, 30_000);
    await seekTo(page, 9);
    await waitForProto(page, 'startScript', S.LATE);    // activation A was issued …
    await seekTo(page, 20);                             // … the viewer left every simulation …
    await waitForProto(page, 'stopScript', null);       // … and really tore it down …
    await waitForProto(page, 'SCRIPT_APPLIED', S.LATE); // … only then does A's ack land
    return sampling;
  }

  test('S1. a SUPERSEDED activation still acknowledges — late, and carrying the stale token', async ({ page }) => {
    const samples = await driveSupersede(page);
    const proto = await protoLog(page);
    const startLate = proto.find((e) => e.type === 'startScript' && e.script === S.LATE);
    const startB    = proto.find((e) => e.type === 'startScript' && e.script === S.B);
    const ackLate   = proto.find((e) => e.type === 'SCRIPT_APPLIED' && e.script === S.LATE);
    expect(startLate, 'LATE was never requested — nothing was exercised').toBeTruthy();
    expect(startB, 'B was never requested — nothing was superseded').toBeTruthy();
    // BOTH acks arrive: production schedules them outside every cancellable scope.
    expect(ackLate, 'the superseded activation was never acknowledged — the fixture is politer than production').toBeTruthy();
    const ackB = proto.find((e) => e.type === 'SCRIPT_APPLIED' && e.script === S.B);
    expect(ackB, 'B never acknowledged — its applyComplete is unavailable').toBeTruthy();
    expect(ackB!.applyComplete, 'B has no applyComplete timestamp').toBeTruthy();
    // THE ORDERING UNDER TEST, entirely from the child's own clock:
    //   startScript(A) < startScript(B) <= B applyComplete < A ackAt
    expect(startLate!.receivedAt, 'A was not requested before B').toBeLessThan(startB!.receivedAt);
    expect(startB!.receivedAt, 'B applied before it was requested')
      .toBeLessThanOrEqual(ackB!.applyComplete!);
    expect(ackB!.applyComplete!, 'A acknowledged before B had finished applying — not stale')
      .toBeLessThan(ackLate!.ackAt!);
    expect(ackLate!.token, 'the late acknowledgement must carry the SUPERSEDED token').toBe(startLate!.token);
    expect(ackLate!.token).not.toBe(startB!.token);
    {
      // Anchored to the ack's own timestamp (like S4) so an unrelated stale ack elsewhere in the
      // run can never satisfy this vacuously.
      const tl = await telemetry(page);
      expect(tl.filter((e) => e.event === 'stale-ack-ignored' && e.abs >= ackLate!.ackAt! - 50).length,
        'the stale acknowledgement was accepted as live').toBeGreaterThan(0);
    }
    // Bounded on BOTH ends by the child's own timestamps. An open-ended window would extend into
    // the video looping back through the timeline (which legitimately re-presents sections) and
    // fail on behaviour unrelated to the stale acknowledgement.
    const after = samples.filter((x) => x.abs >= startB!.receivedAt + SIM_FADE_MS
                                     && x.abs <= ackB!.ackAt! + 2000);
    expect(after.length, 'no samples after the switch — vacuous').toBeGreaterThan(5);
    const stranded = after.flatMap((x) => x.frames).filter((f) => f.op > 0.05 && f.section === 'LATE');
    expect(stranded.length, 'the stale acknowledgement presented the superseded section').toBe(0);
  });

  test('S2. leaving the section does NOT cancel the pending acknowledgement', async ({ page }) => {
    const samples = await driveAbandon(page);
    const proto = await protoLog(page);
    const startLate = proto.find((e) => e.type === 'startScript' && e.script === S.LATE);
    expect(startLate, 'LATE was never requested — nothing was exercised').toBeTruthy();
    const stop    = proto.find((e) => e.type === 'stopScript' && e.receivedAt > startLate!.receivedAt);
    const ackLate = proto.find((e) => e.type === 'SCRIPT_APPLIED' && e.script === S.LATE);
    expect(stop, 'the exit never tore the section down — nothing was exercised').toBeTruthy();
    expect(ackLate, 'the teardown cancelled the pending acknowledgement — production does not').toBeTruthy();
    // startScript(A) < stopScript < A ack. Order comes from the child's single-threaded record
    // sequence (the ground truth); clock values may tie at millisecond resolution when the
    // release fires via setTimeout(0) in the same tick.
    expect(startLate!.receivedAt, 'the teardown preceded the activation').toBeLessThan(stop!.receivedAt);
    expect(proto.indexOf(stop!), 'the acknowledgement was recorded before the teardown')
      .toBeLessThan(proto.indexOf(ackLate!));
    expect(stop!.receivedAt, 'the ack timestamp precedes the teardown timestamp')
      .toBeLessThanOrEqual(ackLate!.ackAt!);
    // Bounded by the ack itself: the claim is that THIS acknowledgement re-presents nothing —
    // not a claim about the rest of playback (the video looping back into a sim section later is
    // legitimate and unrelated).
    const afterExit = samples.filter((x) => x.abs >= stop!.receivedAt + SIM_FADE_MS
                                         && x.abs <= ackLate!.ackAt! + 800);
    expect(afterExit.length, 'no samples between the teardown and past the ack — vacuous').toBeGreaterThan(5);
    const shown = afterExit.flatMap((x) => x.frames).filter((f) => f.op > 0.05);
    expect(shown.length, 'a post-teardown acknowledgement re-presented the simulation').toBe(0);
  });

  test('S3. a stale acknowledgement landing after the switch never disturbs the current section', async ({ page }) => {
    const samples = await driveSupersede(page);
    const proto = await protoLog(page);
    const ackLate = proto.find((e) => e.type === 'SCRIPT_APPLIED' && e.script === S.LATE);
    expect(ackLate, 'the superseded activation never acknowledged — nothing to be stale').toBeTruthy();
    // Straddle the exact instant it arrives, using the CHILD's own clock.
    const ackB = proto.find((e) => e.type === 'SCRIPT_APPLIED' && e.script === S.B);
    expect(ackB, 'B never applied — it cannot be the current section').toBeTruthy();
    // B applies synchronously on receipt; the retained LATE ack releases just after; B's OWN ack
    // arrives ~500ms later by fixture policy. The full chain, all from the child's clock:
    expect(ackB!.applyComplete!, 'B had not applied when the stale acknowledgement arrived')
      .toBeLessThan(ackLate!.ackAt!);
    expect(ackLate!.ackAt!, 'B acknowledged before the stale ack — there is no hold window to test')
      .toBeLessThan(ackB!.ackAt!);

    // THE DISCRIMINATOR. Between the stale ack and B's own ack, B's apply-hold is in force. A
    // runtime that ACCEPTED the stale acknowledgement would release that hold and present the
    // frame early — so any presented frame in this window is the defect. Opacity is read directly
    // from the parent DOM (no evidence lag); the window starts one fade after the stale ack
    // because the OUTGOING frame is legitimately still fading when it lands.
    const holdWindow = samples.filter((x) => x.abs >= ackLate!.ackAt! + SIM_FADE_MS
                                          && x.abs <= ackB!.ackAt!);
    expect(holdWindow.length, 'no samples inside the hold window — vacuous').toBeGreaterThan(5);
    const heldBroken = holdWindow.flatMap((x) => x.frames).filter((f) => f.op > 0.05);
    expect(heldBroken.length,
      "the stale acknowledgement released B's hold — the frame was presented before B's own ack")
      .toBe(0);

    // And after B's own acknowledgement, B — and only B — is presented. The window starts one
    // evidence lag after the ack: a section report GENERATED before it can arrive up to ~150ms
    // later and must not be misread as current evidence.
    const afterB = samples.filter((x) => x.abs >= ackB!.ackAt! + EVIDENCE_LAG_MS
                                      && x.abs <= ackB!.ackAt! + 1200);
    expect(afterB.length, 'no samples after B acknowledged — vacuous').toBeGreaterThan(5);
    expect(afterB.some((x) => x.frames.some((f) => f.op > 0.5)),
      "B was never presented after its acknowledgement").toBe(true);
    const wrongAfter = afterB.flatMap((x) => x.frames)
      .filter((f) => f.op > 0.05 && !f.stale && f.section !== null && f.section !== 'none' && f.section !== 'B');
    expect(wrongAfter.length, 'a section other than B was presented after B became current').toBe(0);
  });

  test('S4. an acknowledgement arriving after deactivation is ignored and reveals nothing', async ({ page }) => {
    const samples = await driveAbandon(page);
    const proto = await protoLog(page);
    const startLate = proto.find((e) => e.type === 'startScript' && e.script === S.LATE);
    const stop = proto.find((e) => e.type === 'stopScript' && e.receivedAt > startLate!.receivedAt);
    const ackLate = proto.find((e) => e.type === 'SCRIPT_APPLIED' && e.script === S.LATE);
    expect(startLate, 'LATE was never requested — nothing was exercised').toBeTruthy();
    expect(stop, 'the viewer never tore the section down — nothing was exercised').toBeTruthy();
    expect(ackLate, 'the acknowledgement never arrived — nothing was exercised').toBeTruthy();
    // deactivation/stop precedes the acknowledgement. ORDER comes from the child's own
    // single-threaded record sequence — the ground truth; a millisecond clock can tie when the
    // release fires via setTimeout(0) in the same tick, and a tie is not a violation of order.
    expect(proto.indexOf(stop!), 'the acknowledgement was recorded before the teardown')
      .toBeLessThan(proto.indexOf(ackLate!));
    expect(stop!.receivedAt, 'the ack timestamp precedes the teardown timestamp')
      .toBeLessThanOrEqual(ackLate!.ackAt!);

    // BEHAVIOUR FIRST: the overlay stays hidden through and past the stale acknowledgement.
    // Bounded on both ends by child timestamps — the video looping back into a sim section
    // MUCH later is legitimate and unrelated, so an open-ended window would lie.
    const window_ = samples.filter((x) => x.abs >= stop!.receivedAt + SIM_FADE_MS
                                       && x.abs <= ackLate!.ackAt! + 800);
    expect(window_.length, 'no samples cover the teardown→ack window — vacuous').toBeGreaterThan(5);
    const presented = window_.flatMap((x) => x.frames).filter((f) => f.op > 0.05);
    expect(presented.length, 'the post-deactivation acknowledgement re-presented the frame').toBe(0);

    // TELEMETRY SECOND, anchored by TIMESTAMP rather than by event index: an index anchored on
    // lastIndexOf('deactivate') picked up a deactivate from the video looping back into section A
    // ~20s later and asserted about the wrong event entirely (audited — that made this test fail
    // while the product behaved correctly). Small negative slack covers the two clock reads.
    const log = await telemetry(page);
    const staleEvents = log.filter((e) => e.event === 'stale-ack-ignored' && e.abs >= stop!.receivedAt - 50);
    expect(staleEvents.length,
      'the runtime never classified the post-deactivation acknowledgement as stale').toBeGreaterThan(0);
    // Nothing may be re-created BY the acknowledgement: no activation, reveal, forced reveal,
    // policy paint, or unmute in a bounded window around its arrival.
    const nearAck = log.filter((e) => e.abs >= ackLate!.ackAt! - 50 && e.abs <= ackLate!.ackAt! + 800);
    for (const forbidden of ['activate', 'reveal', 'reveal-forced', 'painted-by-policy', 'sim-unmute']) {
      expect(nearAck.filter((e) => e.event === forbidden).map((e) => e.event),
        `the stale acknowledgement caused "${forbidden}"`).toEqual([]);
    }
  });

  test('S5. an acknowledgement whose TOKEN does not match the activation is rejected', async ({ page }) => {
    await bootViewer(page, makeConfig([
      { id: 's1', start: 3, end: 8,  pkg: 'delayedack', section: S.A },
      { id: 's2', start: 8, end: 28, pkg: 'delayedack', section: S.BADTOKEN },
    ]), { simdebug: true });
    await startPlayback(page);
    await seekTo(page, 4);
    await waitForSection(page, 'A');

    const sampling = await startSampling(page, 12_000);
    await seekTo(page, 9);                      // BADTOKEN acks in 400ms — with token+7777
    await waitForProto(page, 'SCRIPT_APPLIED', S.BADTOKEN);
    const samples = await sampling;

    const proto = await protoLog(page);
    const startBad = proto.find((e) => e.type === 'startScript' && e.script === S.BADTOKEN);
    const ackBad   = proto.find((e) => e.type === 'SCRIPT_APPLIED' && e.script === S.BADTOKEN);
    expect(startBad, 'BADTOKEN was never requested — nothing was exercised').toBeTruthy();
    expect(ackBad, 'BADTOKEN never acknowledged — the mismatch cannot be evaluated').toBeTruthy();
    expect(ackBad!.token, 'the fixture echoed a MATCHING token — nothing was exercised')
      .toBe(startBad!.token! + BAD_TOKEN_DELTA);

    {
      const tl = await telemetry(page);
      expect(tl.filter((e) => e.event === 'stale-ack-ignored' && e.abs >= ackBad!.ackAt! - 50).length,
        'the mis-tokened acknowledgement was accepted as live').toBeGreaterThan(0);
    }
    // Because it was rejected, the hold SURVIVES its arrival: nothing may be presented between the
    // request and, at the earliest, the runtime's terminal bound.
    const held = samples.filter((s) => s.abs > startBad!.receivedAt + SIM_FADE_MS
                                    && s.abs < startBad!.receivedAt + 2500);
    expect(held.some((s) => s.frames.length > 0),
      'no frame was observed while the hold should have been in force — vacuous').toBe(true);
    const presented = held.flatMap((s) => s.frames).filter((f) => f.op > 0.05);
    expect(presented.length, 'a mis-tokened acknowledgement released the apply hold').toBe(0);
  });
});
