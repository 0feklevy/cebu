// Read-only probe: what one project's editor actually shows the driver.
//   node probe-project.mjs <projectId>
// Dumps the server's sections/videos (as the capture profile's own user) and the timeline's
// rendered blocks, so a "no SIM block" failure can be told apart from "no section at all".
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissTour } from './shot-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const API = 'http://127.0.0.1:8080';
const APP = 'http://localhost:3000';
const projectId = process.argv[2];
if (!projectId) { console.error('usage: node probe-project.mjs <projectId>'); process.exit(1); }

const ctx = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), {
  channel: 'chrome', viewport: { width: 1600, height: 900 },
});
const p = ctx.pages()[0] ?? await ctx.newPage();
const tokP = new Promise((r) => { const t = setTimeout(() => r(null), 30000); p.on('request', (q) => { const h = q.headers()['authorization']; if (h?.startsWith('Bearer ')) { clearTimeout(t); r(h.slice(7)); } }); });
await p.goto(APP, { waitUntil: 'domcontentloaded' });
const tok = await tokP;
const get = async (path) => {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 200) }; }
};
const out = { projectId };
const proj = await get(`/api/v1/projects/${projectId}`);
out.project = { status: proj.status, title: proj.body?.title, visibility: proj.body?.visibility, owner: proj.body?.collab_role };
const s = await get(`/api/v1/projects/${projectId}/sections`);
const rows = Array.isArray(s.body) ? s.body : s.body?.sections ?? [];
out.sections = { status: s.status, rows: rows.map((x) => ({ id: x.id, type: x.type, start: x.start_sec, end: x.end_sec, label: x.label, sim: x.simulation_id, video: x.video_file_id })) };
const v = await get(`/api/v1/projects/${projectId}/videos`);
const vids = Array.isArray(v.body) ? v.body : v.body?.videos ?? [];
out.videos = vids.map((x) => ({ id: x.id, name: x.filename ?? x.name, dur: x.duration_sec, hls: x.hls_status, err: x.hls_error }));
const sims = await get(`/api/v1/projects/${projectId}/simulations`);
const srows = Array.isArray(sims.body) ? sims.body : sims.body?.simulations ?? [];
out.sims = srows.map((x) => ({ id: x.id, name: x.name, status: x.status }));

await p.goto(`${APP}/projects/${projectId}/editor`, { waitUntil: 'domcontentloaded' });
await p.locator('[data-tour="library"]').waitFor({ timeout: 30000 }).catch(() => {});
await dismissTour(p);
await p.waitForTimeout(6000);
out.editor = await p.evaluate(() => {
  const tl = document.querySelector('[data-tour="timeline"]');
  return {
    groups: [...(tl?.querySelectorAll('[role="group"]') ?? [])].map((g) => g.getAttribute('aria-label')),
    timelineText: tl?.innerText?.replace(/\s+/g, ' ').slice(0, 300) ?? null,
    bodyErrors: [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && /failed|error|unavailable|not found/i.test(e.textContent ?? '')).map((e) => e.textContent.trim().slice(0, 120)).slice(0, 8),
  };
});
await ctx.close();
console.log(JSON.stringify(out, null, 1));
