// The master capture driver: runs every shot in shots/, records 1920×1080 webm per shot,
// writes out/MANIFEST.json. Re-run a single shot: node capture-all.mjs --only f2-s2-library-drop
// Shots are small modules: export { id, film, scene, kind, duration, url?, run(page, api) }.
// When the UI changes, fix the one shot file the change broke and re-run it — nothing else moves.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const APP = process.env.CAPTURE_APP_URL ?? 'http://localhost:3000';
const API = 'http://127.0.0.1:8080';
const EMU = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const CRED = { email: 'kinesin-test@example.com', password: 'kinesin-test-pass-1', returnSecureToken: true };
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const only = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1] : null; })();
const stage = existsSync(join(HERE, 'STAGE.json')) ? JSON.parse(readFileSync(join(HERE, 'STAGE.json'), 'utf8')) : {};
const stageSolar = existsSync(join(HERE, 'STAGE-SOLAR.json')) ? JSON.parse(readFileSync(join(HERE, 'STAGE-SOLAR.json'), 'utf8')) : {};

/** Emulator idToken for API-side prep inside shots. */
async function apiToken() {
  let r = await (await fetch(`${EMU}/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CRED),
  })).json();
  if (!r.idToken) {
    r = await (await fetch(`${EMU}/accounts:signUp?key=fake`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CRED),
    })).json();
  }
  return r.idToken;
}

// ONE persistent profile for every shot: the client's anonymous Firebase identity lives in
// indexedDB (which storageState cannot carry), and the staged projects were flipped to this
// profile's user by run-flip.sh. recordVideo is context-level: every page records; a page's
// video finalizes when the page closes.
const PROFILE = join(HERE, 'chrome-profile');
const ctxOpts = {
  channel: 'chrome',
  args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
};
const browser = await chromium.launchPersistentContext(PROFILE, ctxOpts);

/** Drop real files onto a drop target via a synthesized DataTransfer (the product's own overlay). */
async function dropFiles(page, selector, files) {
  const payload = files.map(f => ({
    name: f.name, type: f.type,
    b64: readFileSync(f.path).toString('base64'),
  }));
  await page.evaluate(async ({ selector, payload }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('drop target not found: ' + selector);
    const dt = new DataTransfer();
    for (const f of payload) {
      const bytes = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, dataTransfer: dt };
    el.dispatchEvent(new DragEvent('dragenter', opts));
    el.dispatchEvent(new DragEvent('dragover', opts));
    await new Promise(r => setTimeout(r, 900));   // let the drop overlay render on camera
    el.dispatchEvent(new DragEvent('drop', opts));
  }, { selector, payload });
}

/** Human-feeling typing into a focused element. */
async function typeSlow(page, text, msPerChar = 45) {
  for (const ch of text) { await page.keyboard.type(ch); await page.waitForTimeout(msPerChar + Math.random() * 30); }
}

const api = { APP, API, apiToken, dropFiles, typeSlow, stage, stageSolar, propsDir: join(HERE, 'props') };

const shotFiles = readdirSync(join(HERE, 'shots')).filter(f => f.endsWith('.mjs')).sort();
const manifest = existsSync(join(OUT, 'MANIFEST.json')) ? JSON.parse(readFileSync(join(OUT, 'MANIFEST.json'), 'utf8')) : {};

for (const file of shotFiles) {
  const mod = await import(pathToFileURL(join(HERE, 'shots', file)));
  const shot = mod.default;
  if (only && shot.id !== only) continue;
  process.stdout.write(`● ${shot.id} … `);
  const page = await browser.newPage();
  page.on('pageerror', e => console.error(`\n  pageerror[${shot.id}]`, String(e).slice(0, 200)));
  try {
    await shot.run(page, api);
    const v = page.video();
    await page.close();
    const raw = await v.path();
    manifest[shot.id] = { file: raw, film: shot.film, scene: shot.scene, recordedAt: new Date().toISOString() };
    writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
    console.log('done');
  } catch (e) {
    await page.close().catch(() => {});
    console.log('FAILED:', String(e).slice(0, 300));
    manifest[shot.id] = { error: String(e).slice(0, 300), at: new Date().toISOString() };
    writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  }
}

await browser.close();
console.log('\nManifest:', join(OUT, 'MANIFEST.json'));
