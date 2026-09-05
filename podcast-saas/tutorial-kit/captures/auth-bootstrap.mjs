// Mint the persistent CAPTURE browser profile. The client signs guests in anonymously on
// mount and Firebase parks the identity in indexedDB — which storageState does NOT carry —
// so every capture runs inside ONE persistent chrome profile dir (chrome-profile/). This
// script warms that profile and records its user by sniffing the Authorization header the
// app itself sends (no indexedDB poking, which can poison the store if we open it first).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const APP = 'http://localhost:3000';
const PROFILE = join(HERE, 'chrome-profile');

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  viewport: { width: 1920, height: 1080 },
});
const p = ctx.pages()[0] ?? await ctx.newPage();

const tokenP = new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 30000);
  p.on('request', (r) => {
    const h = r.headers()['authorization'];
    if (h?.startsWith('Bearer ')) { clearTimeout(timer); resolve(h.slice(7)); }
  });
});

await p.goto(APP, { waitUntil: 'domcontentloaded' });
const token = await tokenP;
if (!token) { console.error('no authorized API call observed in 30s'); await ctx.close(); process.exit(1); }

const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const me = await fetch('http://127.0.0.1:8080/api/v1/users/me', {
  headers: { authorization: `Bearer ${token}` },
}).then(r => r.json()).catch(() => null);

const user = {
  uid: payload.user_id ?? payload.sub,
  anonymous: payload.provider_id === 'anonymous' || !payload.email,
  backendUserId: me?.id ?? me?.user?.id ?? null,
};
writeFileSync(join(HERE, 'CAPTURE-USER.json'), JSON.stringify(user, null, 2));
console.log(JSON.stringify(user));
await ctx.close();
