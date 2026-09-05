// Shared helpers for the shots in shots/. Lives OUTSIDE shots/ on purpose: capture-all.mjs
// imports every shots/*.mjs as a shot module, so a helper in there would crash the driver.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAPTURES = dirname(fileURLToPath(import.meta.url));
const STAGE2 = join(CAPTURES, 'STAGE2.json');
const BEATS_DIR = join(CAPTURES, 'out', 'beats');

export const readStage2 = () =>
  existsSync(STAGE2) ? JSON.parse(readFileSync(STAGE2, 'utf8')) : {};

export const writeStage2 = (patch) => {
  const next = { ...readStage2(), ...patch };
  writeFileSync(STAGE2, JSON.stringify(next, null, 2));
  return next;
};

export const settle = (page, ms = 1500) => page.waitForTimeout(ms);

/** Beat clock: seconds since run() start ≈ seconds into the shot's webm. Used to cut proof frames. */
export function beatClock(shotId) {
  const t0 = Date.now();
  const marks = [];
  return {
    mark(name) { marks.push({ name, sec: Math.round((Date.now() - t0) / 100) / 10 }); },
    flush() {
      mkdirSync(BEATS_DIR, { recursive: true });
      writeFileSync(join(BEATS_DIR, `${shotId}.json`), JSON.stringify(marks, null, 2));
    },
  };
}

/**
 * Dismiss the onboarding tour popup ("Skip" / final "Got it!") if it is up. The editor tour
 * auto-opens 900ms AFTER mount (VideoEditor.tsx:944), so the first check waits long enough to
 * catch the late arrival rather than sailing past it.
 */
export async function dismissTour(page) {
  for (let i = 0; i < 3; i++) {
    let clicked = false;
    for (const name of ['Skip', 'Got it!']) {
      const btn = page.getByRole('button', { name, exact: true }).first();
      try {
        // NOT isVisible({timeout}) — that returns immediately and ignores the timeout.
        await btn.waitFor({ state: 'visible', timeout: i === 0 && name === 'Skip' ? 2600 : 400 });
        await btn.click();
        await page.waitForTimeout(400);
        clicked = true;
        break;
      } catch { /* not present */ }
    }
    if (!clicked) break;
  }
}

/** Start sniffing the profile's own Bearer token. MUST be called before the first goto. */
export function tokenSniffer(page) {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  const timer = setTimeout(() => resolve(null), 45000);
  page.on('request', (r) => {
    const h = r.headers()['authorization'];
    if (h?.startsWith('Bearer ')) { clearTimeout(timer); resolve(h.slice(7)); }
  });
  return () => p;
}

/** Navigate to a project's editor and get past the tour. */
export async function openEditor(page, api, projectId) {
  await page.goto(`${api.APP}/projects/${projectId}/editor`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
  await dismissTour(page);
}

/** Home → "New project" → title → "Create project" → editor. Returns the new project id. */
export async function createProject(page, api, title) {
  await page.goto(api.APP, { waitUntil: 'domcontentloaded' });
  const newBtn = page.getByRole('button', { name: 'New project', exact: true }).first();
  await newBtn.waitFor({ timeout: 30000 });
  await dismissTour(page);
  await settle(page);
  await newBtn.click();
  const input = page.getByPlaceholder(/Product demo, lecture/);
  await input.waitFor({ timeout: 10000 });
  await input.click();
  await api.typeSlow(page, title);
  await settle(page, 800);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+\/editor/, { timeout: 30000 });
  const id = page.url().match(/\/projects\/([0-9a-f-]+)\/editor/)[1];
  await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
  await dismissTour(page);
  return id;
}

/**
 * Timeline track geometry. Tracks carry no ids/classes; they are told apart by the inline
 * styles TimelinePanel gives them: V1 = crosshair cursor, 52px; V2 = 44px + #ecfeff family;
 * A2 = copy cursor, 44px (TimelinePanel.tsx:2174/1997/2092).
 */
export async function trackRects(page) {
  return page.evaluate(() => {
    const timeline = document.querySelector('[data-tour="timeline"]');
    if (!timeline) return null;
    const divs = [...timeline.querySelectorAll('div')];
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const v1 = divs.find((d) => d.style.cursor === 'crosshair' && d.style.height === '52px');
    const a2 = divs.find((d) => d.style.cursor === 'copy' && d.style.height === '44px');
    const v2 = divs.find((d) => d.style.height === '44px' && d.style.cursor !== 'copy'
      && (d.style.backgroundColor.includes('236, 254, 255') || d.style.backgroundColor.includes('247, 254, 255')
        || d.style.backgroundColor === 'rgb(236, 254, 255)' || d.style.backgroundColor === 'rgb(247, 254, 255)'));
    let clip = null;
    if (v1) {
      const c = [...v1.children].find((d) => d.className.includes('absolute') && d.getBoundingClientRect().width > 40);
      if (c) clip = rect(c);
    }
    return {
      v1: v1 ? rect(v1) : null,
      v2: v2 ? rect(v2) : null,
      a2: a2 ? rect(a2) : null,
      clip,
    };
  });
}

/** Human-speed pointer drag with stepped moves so the create-preview shows on camera. */
export async function dragMouse(page, x1, y1, x2, y2, steps = 14, msPerStep = 70) {
  await page.mouse.move(x1, y1);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.waitForTimeout(120);
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
    await page.waitForTimeout(msPerStep);
  }
  await page.waitForTimeout(150);
  await page.mouse.up();
}

/**
 * Click the first V1 section block whose badge matches one of the prefixes (SIM / VIDEO / …)
 * and open its editor. Tries the prefixes in order — a section flips VIDEO→SIM once configured.
 */
export async function openSectionEditor(page, badgePrefix = ['SIM', 'VIDEO']) {
  const prefixes = Array.isArray(badgePrefix) ? badgePrefix : [badgePrefix];
  let block = null;
  const deadline = Date.now() + 30000;
  while (!block && Date.now() < deadline) {
    for (const p of prefixes) {
      const cand = page.locator(`[data-tour="timeline"] [role="group"][aria-label^="${p}"]`).first();
      if (await cand.count() > 0) { block = cand; break; }
    }
    if (!block) await page.waitForTimeout(500);
  }
  if (!block) throw new Error(`no section block matching ${prefixes.join('/')} on the timeline`);
  await block.click();
  await page.getByText('Edit Section', { exact: true }).waitFor({ timeout: 10000 });
}

/**
 * Keep the project's display title what the creator typed. CreateProjectDialog sends the typed
 * name as `topic` only, and generateVideoMetadata.ts:129 fills the EMPTY `title` from the video
 * content after upload — renaming the header out from under the film. This is the product's own
 * rename call (PATCH /projects/:id {title}); run it off-camera before a beat.
 */
export async function ensureTitle(api, tok, projectId, title) {
  await fetch(`${api.API}/api/v1/projects/${projectId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).catch(() => {});
}

/** Delete every section on the project — makes a marking shot idempotent across re-runs. */
export async function clearSections(api, tok, projectId) {
  const res = await fetch(`${api.API}/api/v1/projects/${projectId}/sections`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) return;
  const body = await res.json();
  const rows = Array.isArray(body) ? body : body.sections ?? [];
  for (const s of rows) {
    await fetch(`${api.API}/api/v1/projects/${projectId}/sections/${s.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${tok}` },
    }).catch(() => {});
  }
}

/** Poll until fn() is truthy (fn re-evaluated every intervalMs), else throw. */
export async function pollUntil(fn, { timeoutMs = 120000, intervalMs = 4000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * The ✦ Generate with AI button: click it, wait for the BUSY state to appear (the button flips
 * to a status like "Generating bridge script…" and disables), then wait for it to return to
 * idle. Accepting idle without having seen busy is the race that ended a real 30s generation
 * 0.1s after the click.
 */
export async function generateAndWait(page, { timeoutMs = 120000 } = {}) {
  const btn = page.locator('[data-tour="sec-sim-generate"]');
  const isBusy = () => page.evaluate(() => {
    const b = document.querySelector('[data-tour="sec-sim-generate"]');
    return !!b && (b.disabled || !/Generate with AI|Apply|Nothing to apply/.test(b.textContent ?? ''));
  });

  await btn.click();
  let sawBusy = false;
  for (let i = 0; i < 40 && !sawBusy; i++) { // up to ~8s for React to flip state
    sawBusy = await isBusy();
    if (!sawBusy) await page.waitForTimeout(200);
  }
  if (!sawBusy) { // click may not have landed — one retry
    await btn.click();
    for (let i = 0; i < 40 && !sawBusy; i++) {
      sawBusy = await isBusy();
      if (!sawBusy) await page.waitForTimeout(200);
    }
  }
  if (!sawBusy) throw new Error('Generate never entered its busy state after two clicks');

  await page.waitForFunction(() => {
    const b = document.querySelector('[data-tour="sec-sim-generate"]');
    return b && !b.disabled && /Generate with AI|Apply|Nothing to apply/.test(b.textContent ?? '');
  }, undefined, { timeout: timeoutMs });

  // Surface a generation error instead of silently recording one.
  const err = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('p')].map((p) => p.textContent ?? '');
    const bad = boxes.find((t) => /generation failed|could not|failed to generate/i.test(t));
    return bad ?? null;
  });
  if (err) throw new Error(`generation reported an error: ${err.slice(0, 160)}`);
}

// ───────────────────────────── v3 reshoot helpers (2026-09-05) ─────────────────────────────

/** Center of a locator's box (throws if it has none). */
export async function centerOf(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no box: ' + String(locator));
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}

/**
 * Eased pointer travel (ease-in-out), `steps` real mouse moves spread over `ms`. Playwright's own
 * mouse.move(steps) fires the steps back-to-back; the camera needs them spread in time. Last
 * position is remembered on the page so consecutive moves chain.
 */
export async function easeMove(page, x, y, { steps = 28, ms = 700 } = {}) {
  const from = page.__fvMouse ?? { x: 40, y: 40 };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await page.waitForTimeout(ms / steps);
  }
  page.__fvMouse = { x, y };
}

/** Glide onto an element and pause on it (the narration names it) — returns its center. */
export async function glideTo(page, locator, { pause = 500, ms = 700, dx = 0, dy = 0 } = {}) {
  const c = await centerOf(locator);
  await easeMove(page, c.x + dx, c.y + dy, { ms });
  await page.waitForTimeout(pause);
  return c;
}

/** Glide onto an element, pause, press (down/up so the drawn cursor dips), pause. */
export async function glideClick(page, locator, { pauseBefore = 450, pauseAfter = 500, ms = 700, dx = 0, dy = 0 } = {}) {
  await glideTo(page, locator, { pause: pauseBefore, ms, dx, dy });
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
  await page.waitForTimeout(pauseAfter);
}

/** Slow aimless drift between a few points (the "cursor drifts" beat). */
export async function drift(page, points, { ms = 1400, pause = 300 } = {}) {
  for (const [x, y] of points) { await easeMove(page, x, y, { ms, steps: 40 }); await page.waitForTimeout(pause); }
}

/**
 * Camera zoom on the whole page: transform on <body> (fixed portals — modals, sheets — live in
 * body, so they scale with everything else). The framing keeps the region center at the viewport
 * center where the page allows it, clamped so no blank margin ever shows.
 */
function zoomTransformScript() {
  return `(() => {
    const W = innerWidth, H = innerHeight;
    window.__fvZoom = (s, cx, cy) => {
      const b = document.body;
      if (s <= 1.0001) { b.style.transform = ''; b.style.transformOrigin = ''; return; }
      let tx = W / 2 - cx * s, ty = H / 2 - cy * s;
      tx = Math.min(0, Math.max(W - W * s, tx));
      ty = Math.min(0, Math.max(H - H * s, ty));
      b.style.transformOrigin = '0 0';
      b.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    };
  })();`;
}
export async function setZoom(page, scale, cx, cy) {
  await page.evaluate(zoomTransformScript());
  await page.evaluate(([s, x, y]) => { window.__fvZoom(s, x, y); }, [scale, cx, cy]);
}
/** Animated pull-back from `from` to `to` (ease-out cubic) around (cx, cy), over `ms`. */
export async function pullBack(page, { from, to = 1, cx, cy, ms = 5000 }) {
  await page.evaluate(zoomTransformScript());
  await page.evaluate(([a, b, x, y, dur]) => new Promise((done) => {
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      window.__fvZoom(a + (b - a) * ease(t), x, y);
      if (t < 1) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  }), [from, to, cx, cy, ms]);
}

// ── Public share page (viewer) helpers, ported from record-viewer-shots.mjs v2 ──

export async function muteAll(page) {
  await page.evaluate(() => { for (const v of document.querySelectorAll('video')) v.muted = true; });
}

/**
 * Start playback the way a viewer safely can: the CONTROLS-BAR play button.
 *
 * Not a click on the frame. If a live window happens to be presented, a click on the frame lands on
 * the simulation — which pauses the film and hands control to the viewer (the product then offers
 * "Resume video →"), leaving a paused ▶ overlay with the window still on screen. That is how an
 * ask-surface take came back frozen at 0:19 with the kinesin panel up, and how f2-s1 first framed
 * the wrong window. The frame click stays only as a fallback, aimed away from any presented sim.
 */
export const isPlaying = (page) =>
  page.evaluate(() => [...document.querySelectorAll('video')].some((v) => !v.paused && v.duration));

/**
 * Roll the film using the product's own controls, in the order that actually works here
 * (probe-play-control.mjs, 2026-09-05):
 *
 *   1. SPACE — the player's keyboard shortcut. This is the one that works.
 *   2. a FORCED click on the controls-bar play button. A normal Playwright click on it TIMES OUT:
 *      the button is visible, enabled, pointer-events:auto and topmost, but the controls bar never
 *      satisfies the stability check, so the click waits forever and the film silently stays
 *      paused. Several takes were lost to that — a still frame with a ▶ overlay.
 *   3. a click on the frame, aimed away from any presented sim (a click ON the sim pauses the film
 *      and hands control to the viewer).
 */
export async function startPlayback(page) {
  await muteAll(page);
  const settleCheck = async (ms = 1500) => { for (let i = 0; i < ms / 100; i++) { if (await isPlaying(page)) return true; await page.waitForTimeout(100); } return false; };

  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});   // focus the document
  await page.keyboard.press('Space');
  if (await settleCheck()) { await page.waitForTimeout(500); return true; }

  await page.getByRole('button', { name: 'Play or pause' }).first().click({ timeout: 4000, force: true }).catch(() => {});
  if (await settleCheck()) { await page.waitForTimeout(500); return true; }

  const sim = await presentedSim(page);
  const pos = sim ? { x: Math.max(20, sim.x - 40), y: sim.y + 20 } : { x: 480, y: 300 };
  await page.locator('video').first().click({ timeout: 4000, position: pos, force: true }).catch(() => {});
  const ok = await settleCheck();
  await page.waitForTimeout(500);
  return ok;
}

/** The "m:ss / m:ss" readout → total seconds of the viewer's (virtual) timeline. */
export async function totalOf(page) {
  return page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')].map(e => e.textContent?.trim() ?? '');
    const i = spans.findIndex(t => t === '/');
    const tot = i > 0 ? spans[i + 1] : null;
    if (!tot || !/^\d+:\d\d$/.test(tot)) return null;
    const [mm, ss] = tot.split(':').map(Number);
    return mm * 60 + ss;
  });
}

/** Geometry of the product's progress bar (the widest thin element in the bottom quarter). */
export async function progressBar(page) {
  return page.evaluate(() => {
    const cands = [...document.querySelectorAll('div,input')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > innerWidth * 0.5 && r.height >= 2 && r.height < 30 && r.y > innerHeight * 0.75;
    });
    const el = cands.at(-1);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y + r.height / 2, w: r.width };
  });
}

/** Scrub via the product's progress bar to a GLOBAL second. Wakes the controls first. */
export async function scrubTo(page, globalSec, totalSec) {
  const bar = await progressBar(page);
  if (!bar) throw new Error('no progress bar found');
  await page.mouse.move(bar.x + bar.w * 0.5, bar.y - 30);
  await page.waitForTimeout(400);
  await page.mouse.click(bar.x + bar.w * (globalSec / totalSec), bar.y);
  page.__fvMouse = { x: bar.x + bar.w * (globalSec / totalSec), y: bar.y };
  await page.waitForTimeout(600);
}

/** Current time of the playing (or first) video. */
export async function videoTime(page) {
  return page.evaluate(() => {
    const vids = [...document.querySelectorAll('video')];
    const v = vids.find(x => !x.paused && x.duration) ?? vids.find(x => x.duration) ?? vids[0];
    return v ? v.currentTime : null;
  });
}

/**
 * The presented sim iframe, or null.
 *
 * EFFECTIVE visibility, not the iframe's own opacity. The viewer fades a PARENT layer
 * (SimPresentationLayers), so every sim iframe keeps `opacity: 1` on itself for the life of the
 * page — a check on the element's own computed opacity reports "a window is up" forever once the
 * first one has played, which is what hung both return shots for their full timeout and let an
 * earlier f2-s1 take frame the kinesin motor during the solar window. `checkVisibility` walks the
 * ancestors, so a faded-out layer reads as not visible.
 */
const PRESENTED_FN = `(minWidth) => {
  const vis = (el) => (el.checkVisibility
    ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
    : getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0.95);
  // Belt and braces for browsers whose checkVisibility ignores ancestor opacity: multiply up.
  const effOpacity = (el) => { let o = 1, n = el; while (n && n.nodeType === 1) { o *= Number(getComputedStyle(n).opacity || 1); n = n.parentElement; } return o; };
  const f = [...document.querySelectorAll('iframe')].find((x) => {
    const r = x.getBoundingClientRect();
    return r.width > minWidth && vis(x) && effOpacity(x) > 0.9;
  });
  const r = f?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height, src: f.src } : null;
}`;

export async function presentedSim(page, minWidth = 300) {
  return page.evaluate(`(${PRESENTED_FN})(${minWidth})`);
}
/**
 * The presented sim, but ONLY if its package matches `idOrRe` (a simulation id from TEMPLATE.json,
 * or a RegExp on the iframe src). Seeking into a window does not always swap the presented layer,
 * so "a sim is up" is not the same as "the sim this shot names is up" — an earlier f2-s1 take
 * recorded the kinesin motor at 0:26 while the script called for the solar system.
 */
export async function presentedSimMatching(page, id, minWidth = 300) {
  const s = await presentedSim(page, minWidth);
  return s && String(s.src ?? '').includes(id) ? s : null;
}

/** Wait until the named package is the presented one AND the film is still rolling. */
export async function waitSimPresentedMatching(page, id, { timeoutMs = 30000, mustPlay = true } = {}) {
  const t0 = Date.now();
  for (;;) {
    const s = await presentedSimMatching(page, id);
    if (s) {
      if (!mustPlay) return s;
      const playing = await page.evaluate(() => [...document.querySelectorAll('video')].some((v) => !v.paused && v.duration));
      if (playing) return s;
    }
    if (Date.now() - t0 > timeoutMs) {
      const up = await presentedSim(page);
      throw new Error(`the named window never presented while playing (a different layer was up: ${up ? up.src?.slice(-60) : 'none'})`);
    }
    await page.waitForTimeout(150);
  }
}

/**
 * A live window does NOT auto-exit while the film is paused — and touching a presented sim pauses
 * it (the product then offers "Resume video →"). Both return shots hung on this: the window sat up
 * for the full 30 s wait while the shot waited for an exit that could not come. This puts the film
 * back in motion the way the product asks, then falls back to the play control.
 */
export async function resumeIfPaused(page) {
  const paused = await page.evaluate(() => {
    const vs = [...document.querySelectorAll('video')].filter((v) => v.duration);
    return vs.length > 0 && vs.every((v) => v.paused);
  });
  if (!paused) return false;
  const resume = page.getByRole('button', { name: /resume video|go back to video/i }).first();
  if (await resume.isVisible().catch(() => false)) { await resume.click({ force: true }).catch(() => {}); return true; }
  await ensurePlaying(page);
  return true;
}

/** Wait for the presented window to close, keeping the film rolling so it actually can. */
export async function waitWindowExit(page, timeoutMs = 45000) {
  const t0 = Date.now();
  for (;;) {
    if (!(await presentedSim(page))) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`the live window never closed in ${timeoutMs}ms (film kept rolling)`);
    await resumeIfPaused(page);
    await page.waitForTimeout(250);
  }
}

/** Make sure the film is rolling; press the product's own play control if it is not. */
export async function ensurePlaying(page) {
  if (await isPlaying(page)) return true;
  return startPlayback(page);
}

export async function waitSimPresented(page, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const s = await presentedSim(page);
    if (s) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error('no sim presented within ' + timeoutMs + 'ms');
    await page.waitForTimeout(150);
  }
}
export async function waitSimGone(page, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const s = await presentedSim(page);
    if (!s) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('sim still presented after ' + timeoutMs + 'ms');
    await page.waitForTimeout(150);
  }
}

/** Open the public share page and wait for the player config (the "m:ss / m:ss" readout). */
export async function openShare(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await pollUntil(() => totalOf(page), { timeoutMs: 30000, intervalMs: 500, label: 'viewer time readout' });
  await page.waitForTimeout(800);
}

// ── Section editor ("Edit Section" modal) helpers ──

/** Click a specific timeline block by the start of its aria-label ("SIM Tour the solar system"). */
export async function openBlock(page, ariaPrefix, { glide = true } = {}) {
  const block = page.locator(`[data-tour="timeline"] [role="group"][aria-label^="${ariaPrefix}"]`).first();
  await block.waitFor({ timeout: 30000 });
  if (glide) await glideClick(page, block, { pauseBefore: 500, pauseAfter: 300 });
  else await block.click();
  await page.getByText('Edit Section', { exact: true }).waitFor({ timeout: 10000 });
}

/** The two behaviour switches; the product's labels are matched loosely (renames in flight). */
export function behaviourSwitch(page, which) {
  const re = which === 'simple' ? /Simple UI|Minimal UI/ : /Auto Script|Auto script/;
  return page.locator('button[role="switch"]').filter({ hasText: re }).first();
}
export async function setSwitch(page, which, on, { glide = false } = {}) {
  const sw = behaviourSwitch(page, which);
  await sw.waitFor({ timeout: 10000 });
  if (((await sw.getAttribute('aria-checked')) === 'true') === on) return;
  if (glide) await glideClick(page, sw, { pauseBefore: 350, pauseAfter: 650 });
  else { await sw.click(); await page.waitForTimeout(250); }
  if (((await sw.getAttribute('aria-checked')) === 'true') !== on) throw new Error(`${which} switch did not end ${on ? 'ON' : 'OFF'}`);
}

/** Scroll the modal's left column so the Generate mini model card starts at the top. */
export async function revealCard(page) {
  const title = page.getByText('Generate mini model', { exact: true }).first();
  await title.waitFor({ timeout: 15000 });
  await title.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    // breathing room above the card: nudge the nearest scroller back up a little
    let p = el.parentElement;
    while (p && !/auto|scroll/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
    if (p) p.scrollTop = Math.max(0, p.scrollTop - 28);
  });
  await page.waitForTimeout(400);
  return title;
}

/** Save the open section editor (persists prompt/switch state) and wait for it to close. */
export async function saveSection(page) {
  const save = page.getByRole('button', { name: 'Save', exact: true }).last();
  await save.click();
  await page.getByText('Edit Section', { exact: true }).waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
}

/** Clear the prompt textarea (select-all + delete). */
export async function clearPrompt(page) {
  const ta = page.locator('textarea[id^="sim-prompt-"]');
  await ta.waitFor({ timeout: 10000 });
  await ta.click();
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  return ta;
}

/** Load seeding/TEMPLATE.json (the v3 template's public share URLs). */
export function readTemplate() {
  return JSON.parse(readFileSync(join(CAPTURES, '../seeding/TEMPLATE.json'), 'utf8'));
}

export const V3_VIEWPORT = { width: 1600, height: 900 };
export const PLATE_VIEWPORT = { width: 1920, height: 1080 };

/**
 * Mean luma of the page right now (0-255), via a real screenshot — the only way to read a WebGL
 * canvas that was not created with preserveDrawingBuffer.
 */
export async function meanLuma(page) {
  const tmp = join(tmpdir(), `fv-luma-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await page.screenshot({ path: tmp });
  try {
    // ffmpeg's metadata=print writes to STDERR, and execFileSync returns only stdout — reading the
    // return value alone made every measurement `null`, so the brightness gate could never pass.
    const r = spawnSync('ffmpeg', ['-v', 'info', '-i', tmp, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /YAVG=([\d.]+)/.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    return m ? Number(m[1]) : null;
  } finally { rmSync(tmp, { force: true }); }
}

/**
 * Wait until the page is actually SHOWING something — a plate whose first second is black defeats
 * its own purpose, and a WebGL sim can hold a black frame for seconds after its canvas exists.
 */
export async function waitUntilBright(page, { min = 8, timeoutMs = 40000 } = {}) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    last = await meanLuma(page);
    if (last != null && last >= min) return last;
    if (Date.now() - t0 > timeoutMs) throw new Error(`page still dark after ${timeoutMs}ms (mean luma ${last})`);
    await page.waitForTimeout(500);
  }
}

/**
 * Editor's pacing for every "Generate mini model" beat (critique 2026-09-05): package picked →
 * HOLD 4 s on the card → type at ~12 chars/s → 1.5 s → flip Minimal UI → 2.0 s → flip Auto script
 * → 2.5 s → ✦ Generate → hold ≥2 s on the generating state. typeMs is the sleep per key; the CDP
 * round trip adds ~55 ms, so 13 + ~15 (jitter) + 55 ≈ 83 ms/char ≈ 12 chars/s.
 */
export const CARD_PACING = { holdCard: 4000, typeMs: 13, afterType: 1500, afterSimple: 2000, afterAuto: 2500, holdGenerating: 3000 };

/**
 * The card beat, paced as above, from a revealed card whose switches are OFF and prompt empty.
 * Marks: card, typing, typed, minimal-ui, auto-script, generate, generating, held. Returns the
 * generation outcome after letting it finish (off camera — the shot is cut at `held`).
 */
export async function cardBeat(page, api, prompt, { followUp = false, hold = CARD_PACING.holdCard } = {}) {
  api.mark('card');
  await settle(page, hold);
  const ta = page.locator('textarea[id^="sim-prompt-"]');
  await glideClick(page, ta, { pauseBefore: 400, pauseAfter: 250 });
  if (followUp) {                                   // replace the previous prompt on camera
    await page.keyboard.press('Meta+A'); await settle(page, 350);
    await page.keyboard.press('Backspace'); await settle(page, 300);
  }
  api.mark('typing');
  await typeSlowKeys(page, prompt, CARD_PACING.typeMs);
  api.mark('typed');
  await settle(page, CARD_PACING.afterType);
  if (!followUp) {
    await setSwitch(page, 'simple', true, { glide: true });        // glideClick pauses 650 ms after
    api.mark('minimal-ui');
    await settle(page, CARD_PACING.afterSimple - 650);
    await setSwitch(page, 'auto', true, { glide: true });
    api.mark('auto-script');
    await settle(page, CARD_PACING.afterAuto - 650);
  }
  api.mark('generate');
  await clickGenerate(page);
  api.mark('generating');
  await settle(page, CARD_PACING.holdGenerating);
  api.mark('held');
  const gen = await awaitGeneration(page, 180000);
  api.mark('generated');
  await saveSection(page).catch(() => {});
  return gen;
}

/** Same as the driver's typeSlow (kept here so cardBeat needs no api handle). */
export async function typeSlowKeys(page, text, msPerChar = 45) {
  for (const ch of text) { await page.keyboard.type(ch); await page.waitForTimeout(msPerChar + Math.random() * 30); }
}
/** The capture profile's own seeded "Welcome to Flow Video" clone (probe-welcome.mjs, 2026-09-05). */
export const WELCOME_CLONE = '9a49f896-d7fb-4fd6-b190-381952e8067d';
/** The staged kinesin project owned by the capture profile (has a ready kinesin sim + SIM section). */
export const KINESIN_PROJECT = '02d892ff-dea3-4a88-a8a7-2498dbafda1f';

/** Click ✦ Generate with AI (gliding), confirm the BUSY state appeared, return once busy. */
export async function clickGenerate(page) {
  const btn = page.locator('[data-tour="sec-sim-generate"]');
  await glideClick(page, btn, { pauseBefore: 550, pauseAfter: 0 });
  const isBusy = () => page.evaluate(() => {
    const b = document.querySelector('[data-tour="sec-sim-generate"]');
    return !!b && (b.disabled || !/Generate with AI|Apply|Nothing to apply/.test(b.textContent ?? ''));
  });
  for (let i = 0; i < 40; i++) { if (await isBusy()) return true; await page.waitForTimeout(200); }
  await btn.click();
  for (let i = 0; i < 40; i++) { if (await isBusy()) return true; await page.waitForTimeout(200); }
  throw new Error('Generate never entered its busy state after two clicks');
}

/** Wait for a running generation to finish; returns { ok, error } instead of throwing. */
export async function awaitGeneration(page, timeoutMs = 150000) {
  try {
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-tour="sec-sim-generate"]');
      return b && !b.disabled && /Generate with AI|Apply|Nothing to apply/.test(b.textContent ?? '');
    }, undefined, { timeout: timeoutMs });
  } catch { return { ok: false, error: 'timed out' }; }
  const err = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('p')].map((p) => p.textContent ?? '');
    return boxes.find((t) => /generation failed|could not|failed to generate/i.test(t)) ?? null;
  });
  return err ? { ok: false, error: err.slice(0, 160) } : { ok: true };
}
