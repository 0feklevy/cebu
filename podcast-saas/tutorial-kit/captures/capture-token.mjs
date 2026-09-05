// Prints a fresh idToken for the CAPTURE profile's anonymous user (sniffed from the app's own
// API calls inside the persistent chrome profile). Other scripts exec this to act as that user.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const ctx = await chromium.launchPersistentContext(join(HERE, 'chrome-profile'), {
  channel: 'chrome', viewport: { width: 800, height: 600 },
});
const p = ctx.pages()[0] ?? await ctx.newPage();
const tokenP = new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), 25000);
  p.on('request', (r) => {
    const h = r.headers()['authorization'];
    if (h?.startsWith('Bearer ')) { clearTimeout(t); resolve(h.slice(7)); }
  });
});
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
const token = await tokenP;
await ctx.close();
if (!token) { console.error('no token observed'); process.exit(1); }
console.log(token);
