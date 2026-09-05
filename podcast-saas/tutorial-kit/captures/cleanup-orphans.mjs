// Delete the leftover trial projects created while iterating on f2-s2a (ONLY the ids passed on
// the command line), as the capture profile's own user. node cleanup-orphans.mjs <id> [<id>...]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const ids = process.argv.slice(2);
if (!ids.length) { console.error('pass project ids'); process.exit(1); }

const ctx = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), {
  channel: 'chrome', viewport: { width: 1920, height: 1080 },
});
const p = ctx.pages()[0] ?? await ctx.newPage();
const tokenP = new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), 30000);
  p.on('request', (r) => { const h = r.headers()['authorization']; if (h?.startsWith('Bearer ')) { clearTimeout(t); resolve(h.slice(7)); } });
});
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
const tok = await tokenP;
await ctx.close();
if (!tok) { console.error('no token'); process.exit(1); }

for (const id of ids) {
  const res = await fetch(`http://127.0.0.1:8080/api/v1/projects/${id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${tok}` },
  });
  console.log(id, res.status);
}
