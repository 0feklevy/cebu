// Read-only probe: staged project server state (videos / sections / sims) AS THE CAPTURE
// PROFILE'S OWN USER — the anonymous identity in chrome-profile/ owns the staged projects,
// so we sniff its Bearer token off the app's own API traffic, then query directly.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const API = 'http://127.0.0.1:8080';
const ctx = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), {
  channel: 'chrome', viewport: { width: 1920, height: 1080 },
});
const p = ctx.pages()[0] ?? await ctx.newPage();
const tokenP = new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 30000);
  p.on('request', (r) => {
    const h = r.headers()['authorization'];
    if (h?.startsWith('Bearer ')) { clearTimeout(timer); resolve(h.slice(7)); }
  });
});
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
const tok = await tokenP;
await ctx.close();
if (!tok) { console.error('no token sniffed'); process.exit(1); }

const get = async (path) => {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text.slice(0, 200) }; }
};

for (const [name, id] of [
  ['standing-waves', '2b2b4b74-0100-44fe-bb2c-33812b308295'],
  ['kinesin', '02d892ff-dea3-4a88-a8a7-2498dbafda1f'],
]) {
  console.log(`\n=== ${name} (${id}) ===`);
  for (const sub of ['videos', 'sections', 'simulations']) {
    const { status, body } = await get(`/api/v1/projects/${id}/${sub}`);
    const rows = Array.isArray(body) ? body : (body?.sections ?? body?.videos ?? body?.simulations ?? null);
    if (Array.isArray(rows)) {
      console.log(`${sub} (${status}): ${rows.length}`);
      for (const row of rows.slice(0, 8)) {
        console.log('  -', JSON.stringify({
          id: row.id, name: row.name ?? row.filename ?? row.title,
          type: row.type, status: row.status ?? row.hls_status,
          start: row.start_sec, end: row.end_sec, sim_id: row.sim_id ?? row.simulation_id,
          prompt: (row.sim_prompt ?? row.prompt ?? '').slice(0, 90) || undefined,
          simple_ui: row.simple_ui, auto_script: row.auto_script,
        }));
      }
    } else {
      console.log(`${sub} (${status}):`, JSON.stringify(body)?.slice(0, 300));
    }
  }
}
