// Shared helpers for the shots in shots/. Lives OUTSIDE shots/ on purpose: capture-all.mjs
// imports every shots/*.mjs as a shot module, so a helper in there would crash the driver.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
