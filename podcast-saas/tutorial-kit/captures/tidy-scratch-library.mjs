// Housekeeping for the SCRATCH tour project's library: repeated montage takes each upload another
// copy of solar-system.zip, and four near-identical cards in the sidebar read as test data on
// camera. Deletes the extra copies, keeping the OLDEST card of each duplicated name and never
// touching a simulation that a section references.
//
//   node tidy-scratch-library.mjs            # dry run, prints what it would delete
//   node tidy-scratch-library.mjs --apply
//
// Scratch project only (STAGE2.tourProjectId). It never touches the template projects or the
// capture user's Welcome clone.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const API = 'http://127.0.0.1:8080';
const APP = 'http://localhost:3000';
const apply = process.argv.includes('--apply');
const { tourProjectId } = JSON.parse(readFileSync(join(HERE, 'STAGE2.json'), 'utf8'));

const ctx = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), { channel: 'chrome', viewport: { width: 1600, height: 900 } });
const p = ctx.pages()[0] ?? await ctx.newPage();
const tokP = new Promise((r) => { const t = setTimeout(() => r(null), 30000); p.on('request', (q) => { const h = q.headers()['authorization']; if (h?.startsWith('Bearer ')) { clearTimeout(t); r(h.slice(7)); } }); });
await p.goto(APP, { waitUntil: 'domcontentloaded' });
const tok = await tokP;
await ctx.close();
if (!tok) { console.error('no token sniffed'); process.exit(1); }

const get = async (path) => (await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tok}` } })).json();
const sims = await get(`/api/v1/projects/${tourProjectId}/simulations`).then((b) => (Array.isArray(b) ? b : b.simulations ?? []));
const sections = await get(`/api/v1/projects/${tourProjectId}/sections`).then((b) => (Array.isArray(b) ? b : b.sections ?? []));
const inUse = new Set(sections.map((s) => s.simulation_id).filter(Boolean));

// Group by normalised name; keep the oldest of each group (and anything a section uses).
const byName = new Map();
for (const s of sims) {
  const key = (s.name ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push(s);
}
const doomed = [];
for (const [, group] of byName) {
  if (group.length < 2) continue;
  group.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  for (const s of group.slice(1)) { if (!inUse.has(s.id)) doomed.push(s); }
}

console.log(`project ${tourProjectId}: ${sims.length} simulations, ${inUse.size} referenced by sections`);
for (const s of sims) console.log(`  ${inUse.has(s.id) ? 'KEEP*' : doomed.some((d) => d.id === s.id) ? 'DROP ' : 'keep '} ${s.id}  ${s.name}`);
if (!doomed.length) { console.log('nothing to tidy'); process.exit(0); }
if (!apply) { console.log(`\ndry run — ${doomed.length} would be deleted; re-run with --apply`); process.exit(0); }

for (const s of doomed) {
  const res = await fetch(`${API}/api/v1/projects/${tourProjectId}/simulations/${s.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
  console.log(`deleted ${s.id} (${s.name}): ${res.status}`);
}
