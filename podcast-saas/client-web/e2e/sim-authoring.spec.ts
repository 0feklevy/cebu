/**
 * The picker's badges, in a real browser — the half jsdom structurally cannot prove.
 *
 * WHY THIS SPEC EXISTS AT ALL. `simAuthoringScript.test.ts` runs the same script against the same
 * fixture in jsdom and covers the handshake, the scan contract, and the observation boundaries.
 * Two things are beyond it, and both are the feature's core:
 *
 *   1. GEOMETRY. jsdom's `getBoundingClientRect()` returns zeros, so no badge ever renders there.
 *      Whether a pill actually sits on its control, follows a page scroll, follows a NESTED
 *      scroll, survives a resize, and re-anchors when the node is replaced can only be observed
 *      where layout exists.
 *   2. THE `isTrusted` FILTER. jsdom refuses to redefine `isTrusted` (non-configurable prototype
 *      getter), so deleting the filter leaves that suite green — a surviving mutation, recorded as
 *      such in its header. Playwright can produce a genuinely trusted click, which is the only way
 *      to assert that a REAL user gesture is not reported as script activity.
 *
 * The `controls` fixture is the one built for this: duplicate ids, CSS-illegal ids, a radio group,
 * a display:none Advanced panel, a node replaced every 120ms, and a button gated on isTrusted.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
const PACKAGE = 'controls';
const FIXTURE_DIR = resolve(__dirname, '../../.sim-fixture');
const BACKEND = resolve(__dirname, '../../backend-api');
const HARNESS_URL = `${API_ORIGIN}/__authoring/harness.html`;
const ENTRY_URL = `${API_ORIGIN}/sim-public/__e2e/${PACKAGE}/index.html`;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

let server: Server;
let localOrigin = '';

/** The authoring script's served bytes, injected by the harness the way the boot hook would. */
let authoringScript = '';

function ensureFixture(): void {
  const stamp = join(FIXTURE_DIR, PACKAGE, 'index.html');
  if (!existsSync(stamp)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const r = spawnSync('npx', ['tsx', 'src/scripts/gen-sim-fixture.ts', FIXTURE_DIR], {
      cwd: BACKEND, encoding: 'utf8',
    });
    if (r.status !== 0 && !existsSync(stamp)) {
      // FAIL, never skip: a geometry suite that did not run reads as a pass in every aggregate,
      // and this is the ONLY place the badge geometry is checked at all.
      throw new Error(`sim-authoring: fixture generation failed: ${r.stderr || r.stdout}`);
    }
  }
}

/**
 * The harness page. It plays the editor: it frames the simulation, performs the CONNECT handshake
 * with a real MessageChannel, and exposes what came back so a test can assert on it.
 *
 * It injects the authoring script into the frame directly rather than relying on the boot hook's
 * `<script src>` — the hook is covered by its own tests, and this suite is about what the script
 * DOES once it is running.
 */
const HARNESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>authoring harness</title>
<style>
  html,body{margin:0}
  /*
    Deliberately SHORTER than the fixture's control panel.
    The first run of this suite used 900x600 and the document's scrollHeight came back equal to
    its clientHeight — nothing could scroll, so the two scroll tests were asserting movement that
    no scroll had caused. A geometry test whose precondition never held is worse than no test.
  */
  #f{width:900px;height:320px;border:0;display:block}
</style>
</head><body>
<iframe id="f" src="${ENTRY_URL}"></iframe>
<script>
  window.__EVENTS__ = [];
  window.__READY__ = false;
  var port = null;
  var SID = 'e2e-sid';
  var NS = 'flowvid.sim-authoring';

  /**
   * Stand in for the boot hook, FAITHFULLY.
   *
   * The hook is what listens for CONNECT, records the port, and loads the script — the script
   * itself has no window-level listener, deliberately: the allowlist lives in the hook, and a
   * second listener in the script would mean a second copy of it. So the harness installs the same
   * three-line recorder the hook installs, in the same order, and only then loads the script.
   *
   * Getting this wrong is what the first run of this suite did: it evaluated the script and THEN
   * posted CONNECT, so nothing was listening and nothing was pending. All eleven tests timed out
   * on a handshake that could never happen — a harness bug wearing eleven product failures.
   */
  window.__CONNECT__ = function (scriptSource) {
    var frame = document.getElementById('f');
    var fw = frame.contentWindow;

    fw.addEventListener('message', function (e) {
      if (e.source !== fw.parent) return;
      var d = e.data || {};
      if (d.ns !== NS || d.type !== 'CONNECT') return;
      var p = e.ports && e.ports[0];
      if (!p) return;
      fw.__SIM_AUTHORING_PENDING__ = { port: p, origin: e.origin, sid: d.sid };
      if (fw.__SIM_AUTHORING_ADOPT__) fw.__SIM_AUTHORING_ADOPT__(fw.__SIM_AUTHORING_PENDING__);
    });

    var ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = function (e) { window.__EVENTS__.push(e.data); if (e.data && e.data.type === 'CONNECTED') window.__READY__ = true; };
    port.start();
    fw.postMessage({ ns: NS, v: 1, sid: SID, type: 'CONNECT' }, '*', [ch.port2]);

    // Loaded AFTER the CONNECT is pending — the ordinary production order, since the hook only
    // fetches the script once a CONNECT has arrived.
    fw.eval(scriptSource);
  };
  window.__SEND__ = function (type, extra) {
    var m = { ns: NS, v: 1, sid: SID, type: type };
    for (var k in extra) m[k] = extra[k];
    port.postMessage(m);
  };
  window.__LAST__ = function (type) {
    for (var i = window.__EVENTS__.length - 1; i >= 0; i--) {
      if (window.__EVENTS__[i].type === type) return window.__EVENTS__[i];
    }
    return null;
  };
</script>
</body></html>`;

function startAssetServer(): Promise<void> {
  server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0].split('#')[0];
    if (pathname === '/__authoring/harness.html') {
      const body = Buffer.from(HARNESS_HTML, 'utf-8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-cache' });
      res.end(body);
      return;
    }
    if (!pathname.startsWith('/sim-public/__e2e/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not served by this suite');
      return;
    }
    const file = join(FIXTURE_DIR, pathname.slice('/sim-public/__e2e/'.length));
    if (!file.startsWith(FIXTURE_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const buf = readFileSync(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': String(buf.length), 'cache-control': 'no-cache',
    });
    res.end(buf);
  });
  return new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', () => {
      localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      r();
    });
  });
}

/** Harness and package share ONE origin, which is what makes the child's origin rule meaningful. */
async function installRoute(page: Page): Promise<void> {
  await page.route(`${API_ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const upstream = await fetch(`${localOrigin}${url.pathname}${url.search}`);
    await route.fulfill({
      status: upstream.status,
      headers: Object.fromEntries(upstream.headers.entries()),
      body: Buffer.from(await upstream.arrayBuffer()),
    });
  });
}

test.beforeAll(async () => {
  ensureFixture();
  await startAssetServer();
  // Built exactly as the route serves it — a divergent copy here would certify the wrong bytes.
  const mod = await import(
    resolve(BACKEND, 'src/services/simulation/SimAuthoringBootstrap.ts') as string
  ) as { SIM_AUTHORING_SCRIPT: string };
  authoringScript = mod.SIM_AUTHORING_SCRIPT;
});

test.afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** Boot the harness, connect, and scan — the state every test below starts from. */
async function boot(page: Page): Promise<void> {
  await installRoute(page);
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const f = document.getElementById('f') as HTMLIFrameElement | null;
    return !!f?.contentWindow?.document?.getElementById('speed');
  });
  await page.evaluate((src) => (window as unknown as { __CONNECT__: (s: string) => void }).__CONNECT__(src), authoringScript);
  await page.waitForFunction(() => (window as unknown as { __READY__: boolean }).__READY__);
  await page.evaluate(() => (window as unknown as { __SEND__: (t: string, e?: unknown) => void }).__SEND__('SCAN_CONTROLS', { requestId: 'r1' }));
  await page.waitForFunction(() => !!(window as unknown as { __LAST__: (t: string) => unknown }).__LAST__('CONTROLS_LIST'));
}

/** Mark every scanned control, so a badge exists for each. */
async function markAll(page: Page, mark: 'keep' | 'hide' = 'keep'): Promise<void> {
  await page.evaluate((m) => {
    const w = window as unknown as { __LAST__: (t: string) => { controls: { selector: string }[] }; __SEND__: (t: string, e?: unknown) => void };
    const list = w.__LAST__('CONTROLS_LIST').controls;
    w.__SEND__('SET_MARKS', { marks: list.map((c) => ({ selector: c.selector, mark: m })) });
  }, mark);
}

/** The frame's own document, for reading badge and control geometry. */
const inFrame = (page: Page) => page.frameLocator('#f');

test.describe('badges are drawn where the controls are', () => {
  test('a pill sits on its control', async ({ page }) => {
    await boot(page);
    await markAll(page);
    const pill = inFrame(page).locator('[data-sim-authoring-overlay] span').first();
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(/✓ Keep/);
  });

  test('pills track a PAGE scroll, and stay put for a fixed control', async ({ page }) => {
    // TWO facts, and the second one is why the first version of this test failed for a reason
    // that was not a bug:
    //
    //   - a control that scrolls with the document must take its pill with it;
    //   - a control in a `position: fixed` panel — which is what the fixture's `.controls` is —
    //     does NOT move when the page scrolls, so its pill must not move either.
    //
    // Anchoring at raw client-rect coordinates gets both right without knowing which is which,
    // and that is the property worth pinning. Asserting only "everything moves" would have made
    // correct behaviour look like a failure.
    await boot(page);
    await markAll(page);

    // The document needs a control that actually flows with it. Every control the fixture ships
    // lives inside the `position: fixed` panel, and moving one out of it would not move it out of
    // its fixed ANCESTOR — measured, after doing exactly that and watching it stay put. So the
    // test adds one to the body itself, far enough down to require scrolling.
    await inFrame(page).locator('body').evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:2000px;position:relative';
      // 400px down: inside the viewport BEFORE the scroll and still inside it after a 300px
      // scroll. Off-viewport controls deliberately get no pill — the list is their path — so a
      // control parked below the fold would have had no badge to measure, which is correct
      // behaviour that the first version of this test mistook for a failure.
      spacer.innerHTML = '<input type="range" id="flowed" style="position:absolute;top:400px;left:20px">';
      document.body.appendChild(spacer);
    });
    await page.evaluate(() => (window as unknown as { __SEND__: (t: string, e?: unknown) => void }).__SEND__('SCAN_CONTROLS', { requestId: 'r2' }));
    await page.waitForTimeout(200);
    await markAll(page);
    await page.waitForTimeout(200);

    const fixedBefore = await pillTopFor(page, '#speed');
    const flowBefore = await pillTopFor(page, '#flowed');

    const scrolled = await inFrame(page).locator('body').evaluate(() => {
      window.scrollBy(0, 300);
      return window.scrollY;
    });
    expect(scrolled).toBeGreaterThan(20);

    // The in-flow control's pill followed it up the viewport…
    await expect.poll(() => pillTopFor(page, '#flowed').then((t) => Math.abs(t - flowBefore)))
      .toBeGreaterThan(20);
    // …and the fixed panel's pill correctly did not move.
    expect(Math.abs(await pillTopFor(page, '#speed') - fixedBefore)).toBeLessThan(5);
  });

  test('pills track a NESTED scroll', async ({ page }) => {
    // The fixture's `.controls` is its own scrolling container. This is the case `position:fixed`
    // at raw client-rect coordinates exists for — no ancestor offset walk can get it wrong.
    await boot(page);
    await markAll(page);
    // ONE named control, not "the first pill". Pills are rebuilt on every repaint and an
    // off-viewport one is dropped entirely, so DOM order is not stable across a scroll — reading
    // "the first pill" before and after could compare two DIFFERENT controls, and did: this test
    // failed on roughly one run in two until it named what it was measuring.
    // The target is CHOSEN FROM THE PAGE, not named in advance. Three earlier versions of this
    // test picked a control by hand and each was wrong for a different correct reason: `#speed`
    // scrolls off the viewport (and an off-screen control is deliberately given no pill), and
    // `#advanced-gain` lives in the fixture's display:none panel (which is deliberately list-only).
    // Every failure was the badge behaving exactly as designed while the test measured something
    // that was not on screen. So: scroll a little, and measure whatever is still visible after.
    const scrollBy = 40;
    const target = await inFrame(page).locator('body').evaluate((_b, by) => {
      const panel = document.querySelector('.controls') as HTMLElement;
      const inView = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.top > by + 20 && r.bottom < window.innerHeight - 20;
      };
      const el = Array.from(panel.querySelectorAll('input[id],select[id],button[id]')).find(inView);
      return el ? '#' + (el as HTMLElement).id : null;
    }, scrollBy);
    expect(target, 'no control is comfortably on screen — the fixture or the frame size changed').toBeTruthy();

    const startTop = await pillTopFor(page, target!);
    expect(startTop, `${target} must have a pill before the scroll`).toBeGreaterThan(0);

    const moved = await inFrame(page).locator('.controls').evaluate((el, by) => {
      const from = el.scrollTop;
      el.scrollTop += by;
      return el.scrollTop - from;
    }, scrollBy);
    expect(moved, 'the container did not scroll, so there is nothing to track').toBeGreaterThan(5);

    // The pill moves BY THE SCROLL — compared against what actually happened, never a constant.
    // Polled rather than slept: the repaint rides a rAF, and a fixed wait is a guess that is both
    // slower under load and flakier on a fast machine.
    await expect.poll(() => pillTopFor(page, target!).then((t) => Math.round(Math.abs(t - startTop))))
      .toBe(Math.round(moved));
  });

  test('pills survive a viewport resize', async ({ page }) => {
    await boot(page);
    await markAll(page);
    await page.setViewportSize({ width: 700, height: 500 });
    await page.waitForTimeout(250);
    await expect(inFrame(page).locator('[data-sim-authoring-overlay] span').first()).toBeVisible();
  });

  test('a pill re-anchors when its control node is REPLACED', async ({ page }) => {
    // The fixture's churn section swaps #rerender-target for a fresh node on a timer. A held
    // element reference would leave the badge anchored to something detached.
    await boot(page);
    await markAll(page);
    await inFrame(page).locator('body').evaluate(() => (window as unknown as { __START_CHURN__: (n: number) => void }).__START_CHURN__(120));
    await page.waitForTimeout(600);
    await expect(inFrame(page).locator('[data-sim-authoring-overlay] span').first()).toBeVisible();
  });
});

test.describe('the badge is the control', () => {
  test('clicking a pill reports the toggle to the editor', async ({ page }) => {
    await boot(page);
    await markAll(page);
    await inFrame(page).locator('[data-sim-authoring-overlay] span').first().click();
    await page.waitForFunction(() => !!(window as unknown as { __LAST__: (t: string) => unknown }).__LAST__('MARK_TOGGLED'));
  });

  test('SET_MARKS flips the pill', async ({ page }) => {
    await boot(page);
    await markAll(page, 'keep');
    await expect(inFrame(page).locator('[data-sim-authoring-overlay] span').first()).toHaveText(/Keep/);
    await markAll(page, 'hide');
    await expect(inFrame(page).locator('[data-sim-authoring-overlay] span').first()).toHaveText(/Hidden/);
  });

  test('the simulation underneath stays interactive', async ({ page }) => {
    // The overlay is pointer-events:none except on the pills themselves. A picker that swallows
    // every click would stop the author trying the simulation they are picking in.
    await boot(page);
    await markAll(page);
    await inFrame(page).locator('#count').fill('7');
    await expect(inFrame(page).locator('#count')).toHaveValue('7');
  });

  test('DISARM removes every overlay node', async ({ page }) => {
    await boot(page);
    await markAll(page);
    await page.evaluate(() => (window as unknown as { __SEND__: (t: string) => void }).__SEND__('DISARM'));
    await expect(inFrame(page).locator('[data-sim-authoring-overlay]')).toHaveCount(0);
  });
});

test.describe('script-touch observation tells trusted from synthetic', () => {
  test('a REAL user gesture is not reported as script activity', async ({ page }) => {
    // THE ASSERTION THIS WHOLE SPEC IS LOAD-BEARING FOR. jsdom cannot forge `isTrusted`, so
    // deleting `if (e.isTrusted) return;` leaves the unit suite green — that mutation survives
    // there and is documented as surviving. Here a real click is genuinely trusted, so the filter
    // is the only thing between it and a false "script?" chip.
    await boot(page);
    await page.evaluate(() => (window as unknown as { __SEND__: (t: string) => void }).__SEND__('OBSERVE_START'));
    await inFrame(page).locator('#enabled').click();
    await page.waitForTimeout(500);
    const touched = await page.evaluate(() => (window as unknown as { __LAST__: (t: string) => unknown }).__LAST__('SCRIPT_TOUCHED'));
    expect(touched).toBeNull();
  });

  test('a script-dispatched change IS reported', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as unknown as { __SEND__: (t: string) => void }).__SEND__('OBSERVE_START'));
    await inFrame(page).locator('body').evaluate(() => {
      const el = document.getElementById('speed') as HTMLInputElement;
      el.value = '80';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => !!(window as unknown as { __LAST__: (t: string) => unknown }).__LAST__('SCRIPT_TOUCHED'));
    const t = await page.evaluate(() => (window as unknown as { __LAST__: (t: string) => { selectors: string[]; heuristic: boolean } }).__LAST__('SCRIPT_TOUCHED'));
    expect(t.selectors).toContain('#speed');
    expect(t.heuristic).toBe(true);
  });
});

/** Viewport top of the first pill — the number most geometry assertions are about. */
async function firstPillTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const f = document.getElementById('f') as HTMLIFrameElement;
    const pill = f.contentWindow!.document.querySelector('[data-sim-authoring-overlay] span');
    return pill ? pill.getBoundingClientRect().top : -1;
  });
}

/**
 * Viewport top of the pill belonging to ONE control.
 *
 * Matched by position rather than by a marker attribute: the pills carry no identifying data, on
 * purpose — anything the scanner could key on is one more thing its candidate filter has to
 * exclude. So this finds the pill nearest the control's own rect, which is the same relationship a
 * reader's eye uses.
 */
async function pillTopFor(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const f = document.getElementById('f') as HTMLIFrameElement;
    const doc = f.contentWindow!.document;
    const el = doc.querySelector(sel);
    if (!el) return -1;
    const r = el.getBoundingClientRect();
    let best = -1;
    let bestD = Infinity;
    for (const p of Array.from(doc.querySelectorAll('[data-sim-authoring-overlay] span'))) {
      const pr = p.getBoundingClientRect();
      const d = Math.hypot(pr.left - r.left, pr.top - (r.top - 16));
      if (d < bestD) { bestD = d; best = pr.top; }
    }
    return best;
  }, selector);
}
