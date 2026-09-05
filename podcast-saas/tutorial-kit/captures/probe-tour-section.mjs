// One-off: dump the tour project's sections (sim_meta provenance included) as the profile user.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const { tourProjectId } = JSON.parse(readFileSync(join(HERE, 'STAGE2.json'), 'utf8'));
const ctx = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), { channel: 'chrome' });
const p = ctx.pages()[0] ?? await ctx.newPage();
const tokenP = new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), 30000);
  p.on('request', (r) => { const h = r.headers()['authorization']; if (h?.startsWith('Bearer ')) { clearTimeout(t); resolve(h.slice(7)); } });
});
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
const tok = await tokenP;
await ctx.close();

const res = await fetch(`http://127.0.0.1:8080/api/v1/projects/${tourProjectId}/sections`, {
  headers: { Authorization: `Bearer ${tok}` },
});
const body = await res.json();
const rows = Array.isArray(body) ? body : body.sections ?? [];
for (const s of rows) {
  console.log(JSON.stringify({
    id: s.id, type: s.type, start: s.start_sec, end: s.end_sec,
    sim_id: s.sim_id ?? s.simulation_id, prompt: s.sim_prompt ?? null,
    simple_ui: s.simple_ui, auto_script: s.auto_script,
    has_script: !!(s.sim_script ?? s.script), sim_meta: s.sim_meta ?? null,
  }, null, 2));
}
