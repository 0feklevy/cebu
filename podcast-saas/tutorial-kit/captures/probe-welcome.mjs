// Read-only probe (one profile session): does the capture profile's anonymous user have its
// seeded "Welcome" clone yet, what is on its timeline, and what do the editor header / share
// page actually expose for automation. Prints JSON; touches nothing.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissTour } from './shot-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const API = 'http://127.0.0.1:8080';
const APP = 'http://localhost:3000';
const T = JSON.parse(readFileSync(join(HERE, '../seeding/TEMPLATE.json'), 'utf8'));

// Optional first arg: a different profile dir (a brand-new dir = a brand-new anonymous user,
// which the seeded backend clones the CURRENT template for). Default is the capture profile.
const PROFILE = process.argv[2] ?? 'chrome-profile';
const ctx = await chromium.launchPersistentContext(join(HERE, PROFILE), {
  channel: 'chrome', viewport: { width: 1600, height: 900 },
});
const p = ctx.pages()[0] ?? await ctx.newPage();
const tokP = new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), 30000);
  p.on('request', (r) => { const h = r.headers()['authorization']; if (h?.startsWith('Bearer ')) { clearTimeout(t); resolve(h.slice(7)); } });
});
await p.goto(APP, { waitUntil: 'domcontentloaded' });
const tok = await tokP;
const out = { tok: !!tok };
if (!tok) { console.log(JSON.stringify(out)); await ctx.close(); process.exit(1); }

const get = async (path) => {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 300) }; }
};

// Welcome clone: wait up to ~25s for the seed (fires on the projects list).
let clone = null;
for (let i = 0; i < 6 && !clone; i++) {
  const r = await get('/api/v1/projects');
  const rows = Array.isArray(r.body) ? r.body : r.body?.projects ?? [];
  out.projects = rows.map((x) => ({ id: x.id, title: x.title, welcome: x.is_welcome_seed, vis: x.visibility, created: x.created_at, role: x.collab_role }));
  clone = rows.find((x) => x.is_welcome_seed) ?? rows.find((x) => /welcome/i.test(x.title ?? '') && x.id !== T.demo.projectId) ?? null;
  if (!clone) { await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForTimeout(4000); }
}
out.clone = clone ? { id: clone.id, title: clone.title, vis: clone.visibility } : null;
if (clone) {
  const s = await get(`/api/v1/projects/${clone.id}/sections`);
  const rows = Array.isArray(s.body) ? s.body : s.body?.sections ?? [];
  out.cloneSections = rows.map((x) => ({ id: x.id, type: x.type, start: x.start_sec, end: x.end_sec, label: x.label, sim: x.simulation_id, prompt: x.sim_prompt ?? x.sim_meta?.prompt, simple_ui: x.simple_ui }));
  const v = await get(`/api/v1/projects/${clone.id}/videos`);
  const vids = Array.isArray(v.body) ? v.body : v.body?.videos ?? [];
  out.cloneVideos = vids.map((x) => ({ id: x.id, name: x.filename ?? x.name, dur: x.duration_sec, hls: x.hls_status }));
  const sims = await get(`/api/v1/projects/${clone.id}/simulations`);
  const srows = Array.isArray(sims.body) ? sims.body : sims.body?.simulations ?? [];
  out.cloneSims = { status: sims.status, rows: srows.map((x) => ({ id: x.id, name: x.name, status: x.status })) };
  const pls = await get('/api/v1/playlists');
  const prow = Array.isArray(pls.body) ? pls.body : pls.body?.playlists ?? [];
  out.playlists = prow.map((x) => ({ id: x.id, title: x.title }));

  // Home page: what the projects list shows.
  out.homeTexts = await p.evaluate(() => [...document.querySelectorAll('h1,h2,h3,a,button')].map((e) => e.textContent?.trim()).filter(Boolean).slice(0, 60));

  // Editor of the clone: header buttons, timeline blocks, library card titles, dev portal.
  await p.goto(`${APP}/projects/${clone.id}/editor`, { waitUntil: 'domcontentloaded' });
  await p.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
  await dismissTour(p);
  await p.waitForTimeout(3000);
  out.editor = await p.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const header = document.querySelector('header');
    return {
      headerButtons: header ? [...header.querySelectorAll('button,a')].map((b) => ({ text: b.textContent?.trim().slice(0, 30), aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), rect: rect(b) })) : null,
      groups: [...document.querySelectorAll('[data-tour="timeline"] [role="group"]')].map((g) => ({ aria: g.getAttribute('aria-label'), rect: rect(g) })),
      timelineRect: (() => { const t = document.querySelector('[data-tour="timeline"]'); return t ? rect(t) : null; })(),
      libraryRect: (() => { const t = document.querySelector('[data-tour="library"]'); return t ? rect(t) : null; })(),
      libraryTitles: (() => { const t = document.querySelector('[data-tour="library"]'); return t ? [...t.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).slice(0, 30) : []; })(),
      tourAnchors: [...document.querySelectorAll('[data-tour]')].map((e) => e.getAttribute('data-tour')),
      devPortal: !!document.querySelector('nextjs-portal'),
      addSectionLike: [...document.querySelectorAll('button')].map((b) => (b.getAttribute('title') ?? '') + '|' + (b.getAttribute('aria-label') ?? '') + '|' + (b.textContent?.trim() ?? '')).filter((t) => /section|add|mark/i.test(t)).slice(0, 20),
    };
  });

  // Settings panel: Collaborators + Access present for the owner?
  try {
    await p.getByRole('button', { name: 'Settings', exact: true }).click();
    await p.waitForTimeout(2500);
    out.settings = await p.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const acc = document.querySelector('[data-tour="settings-access"]');
      const col = document.querySelector('[data-tour="settings-collab"]');
      const inv = document.querySelector('input[type="email"]');
      const sel = acc?.querySelector('select');
      return {
        access: acc ? rect(acc) : null, collab: col ? rect(col) : null, invite: inv ? rect(inv) : null,
        accessValue: sel?.value ?? null, collabText: col?.textContent?.trim().slice(0, 200) ?? null,
        dialogRect: (() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1); return d ? rect(d) : null; })(),
        scrollers: [...document.querySelectorAll('[role="dialog"] *')].filter((e) => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY)).slice(0, 3).map((e) => ({ cls: (e.className || '').toString().slice(0, 60), rect: rect(e), sh: e.scrollHeight })),
      };
    });
    await p.keyboard.press('Escape');
  } catch (e) { out.settingsErr = String(e).slice(0, 200); }
}

// Demo share page: bottom controls + Ask! + timing.
await p.goto(T.demo.shareUrl, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(5000);
out.share = await p.evaluate(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  return {
    buttons: [...document.querySelectorAll('button')].map((b) => ({ text: b.textContent?.trim().slice(0, 30), aria: b.getAttribute('aria-label'), disabled: b.disabled, rect: rect(b) })),
    videos: [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, t: v.currentTime, dur: v.duration, rect: rect(v) })),
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src.slice(0, 80), op: getComputedStyle(f).opacity, rect: rect(f) })),
    timeText: [...document.querySelectorAll('span')].map((e) => e.textContent?.trim()).filter((t) => /^\d+:\d\d$/.test(t ?? '')),
    devPortal: !!document.querySelector('nextjs-portal'),
    bodyScroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
  };
});
await ctx.close();
console.log(JSON.stringify(out, null, 2));
