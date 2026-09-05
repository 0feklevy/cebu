// The master capture driver: runs every shot in shots/, records a webm per shot, writes
// out/MANIFEST.json. Re-run a single shot: node capture-all.mjs --only f2-s2-library-drop
// Shots are small modules: export { id, film, scene, kind, duration, url?, run(page, api) }.
// When the UI changes, fix the one shot file the change broke and re-run it — nothing else moves.
//
// v3 additions (reshoot, 2026-09-05) — all opt-in per shot, legacy shots run exactly as before:
//   viewport        {width,height}  per-shot viewport + video size (legacy default 1920×1080)
//   videoSize       {width,height}  record at a different size than the viewport (phone @2x)
//   contextOptions  extra launchPersistentContext options (isMobile, hasTouch, deviceScaleFactor…)
//   cursor: true    draw an in-page pointer that follows the mouse (the screencast has no OS cursor)
//   run() may return { trim: { from, to, padBefore? } }  → out/<id>.webm, frame-accurate re-encode
//               or  { cuts: [{ id, from, to, film?, scene? }] } → one out/<cutId>.webm per cut
//   `from`/`to` are seconds since the page opened, or the name of a mark set with api.mark(name).
//   Every manifest entry now carries durationSec / width / height / fps and the marks that fall
//   inside the file, rebased to seconds-from-file-start (the edit cuts in with `in` offsets).
// The context is (re)launched per shot so a shot can own its viewport; still ONE profile, ONE
// session at a time — never run two drivers concurrently (pgrep -fl chrome-profile first).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const LEGACY_VIEWPORT = { width: 1920, height: 1080 };

function ctxOptsFor(shot) {
  const viewport = shot.viewport ?? LEGACY_VIEWPORT;
  return {
    channel: 'chrome',
    args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
    viewport,
    recordVideo: { dir: OUT, size: shot.videoSize ?? viewport },
    ...(shot.contextOptions ?? {}),
  };
}

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

// The Next.js dev indicator (<nextjs-portal>, the "N" badge bottom-left) was burned into every
// earlier take. Hidden on every page the driver opens; the product is untouched.
const HIDE_DEV_OVERLAY = `(() => {
  const add = () => {
    if (document.getElementById('__fv-hide-dev')) return;
    const s = document.createElement('style'); s.id = '__fv-hide-dev';
    s.textContent = 'nextjs-portal{display:none!important}';
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
})();`;

// Chromium's screencast never draws the OS pointer, so a shot whose narration follows the cursor
// needs one drawn in-page: a fixed div that tracks mousemove (Playwright's mouse.* dispatch real
// input events) and dips on mousedown. Presentation aid only — it is not part of the product.
const CURSOR_OVERLAY = `(() => {
  const make = () => {
    if (!document.body || document.getElementById('__fv-cursor')) return;
    const el = document.createElement('div');
    el.id = '__fv-cursor';
    el.innerHTML = '<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg"><path d="M2 2 L2 24 L8 18.5 L12.5 28 L16 26.4 L11.6 17 L20 17 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(el.style, { position: 'fixed', left: '0px', top: '0px', width: '22px', height: '30px',
      zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-2px,-2px)', transition: 'transform 80ms',
      opacity: '0', filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.45))' });
    document.body.appendChild(el);
    document.addEventListener('mousemove', (e) => { el.style.opacity = '1'; el.style.left = e.clientX + 'px'; el.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', () => { el.style.transform = 'translate(-2px,-2px) scale(0.82)'; }, true);
    document.addEventListener('mouseup', () => { el.style.transform = 'translate(-2px,-2px)'; }, true);
  };
  if (document.body) make(); else document.addEventListener('DOMContentLoaded', make);
})();`;

/** ffprobe: what the file really is (the manifest records it; QC reads it). */
function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-show_entries', 'format=duration', '-of', 'json', file]).toString());
  const s = j.streams?.[0] ?? {};
  return { width: s.width, height: s.height, fps: s.r_frame_rate, durationSec: Math.round(Number(j.format?.duration ?? 0) * 100) / 100 };
}

/** Frame-accurate trim of a raw take into out/<name>.webm (re-encoded; -ss on a VP8 copy would snap to keyframes). */
function cutFile(raw, name, from, to) {
  const dest = join(OUT, `${name}.webm`);
  const args = ['-y', '-v', 'error', '-ss', Math.max(0, from).toFixed(2), '-i', raw];
  if (to != null) args.push('-t', Math.max(0.2, to - from).toFixed(2));
  args.push('-an', '-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0', '-deadline', 'good', '-cpu-used', '3', '-row-mt', '1', '-pix_fmt', 'yuv420p', dest);
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  return dest;
}

const baseApi = { APP, API, apiToken, dropFiles, typeSlow, stage, stageSolar, propsDir: join(HERE, 'props') };

const shotFiles = readdirSync(join(HERE, 'shots')).filter(f => f.endsWith('.mjs')).sort();
const manifest = existsSync(join(OUT, 'MANIFEST.json')) ? JSON.parse(readFileSync(join(OUT, 'MANIFEST.json'), 'utf8')) : {};
const saveManifest = () => writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
/** out/beats/<id>.json — the legacy beat-clock format ([{name, sec}]), seconds from FILE start. */
function saveBeats(id, beats) {
  mkdirSync(join(OUT, 'beats'), { recursive: true });
  writeFileSync(join(OUT, 'beats', `${id}.json`), JSON.stringify(Object.entries(beats).map(([name, sec]) => ({ name, sec })), null, 2));
}

const shots = [];
for (const file of shotFiles) {
  try {
    const mod = await import(pathToFileURL(join(HERE, 'shots', file)));
    if (mod.default?.id) shots.push(mod.default);
  } catch (e) {
    // One broken shot file must not take the other shots down with it.
    console.error(`! shots/${file} failed to load: ${String(e).slice(0, 160)}`);
  }
}
const selected = only ? shots.filter(s => s.id === only) : shots;
if (only && selected.length === 0) { console.error(`no shot with id ${only}`); process.exit(1); }

for (const shot of selected) {
  process.stdout.write(`● ${shot.id} … `);
  const browser = await chromium.launchPersistentContext(PROFILE, ctxOptsFor(shot));
  // SESSION RESTORE IS A CAPTURE HAZARD, not just clutter. A persistent profile reopens the tabs
  // the previous shot left behind; they arrive ASYNCHRONOUSLY (after the first pages() read), each
  // records its own video, and the screencast of the page we drive can come back blended with a
  // restored tab's surface — f4-s1-public-page recorded the scratch editor ghosted under the
  // viewer, from a take whose own page had navigated correctly. So: sweep repeatedly until the
  // context stays empty, then bring our page to the front so it is the painted one.
  const sweep = async () => {
    for (const p of browser.pages()) { const v = p.video(); await p.close().catch(() => {}); await v?.delete().catch(() => {}); }
  };
  await sweep();
  for (let i = 0; i < 6; i++) {                     // ~1.2 s of settling; restores trickle in
    await new Promise((r) => setTimeout(r, 200));
    if (browser.pages().length) await sweep();
  }

  const page = await browser.newPage();
  await page.bringToFront().catch(() => {});
  const t0 = Date.now();
  const marks = {};
  const now = () => Math.round((Date.now() - t0) / 10) / 100;   // seconds since the page opened
  const api = { ...baseApi, marks, now, mark: (name) => { marks[name] = now(); return marks[name]; } };
  await page.addInitScript(HIDE_DEV_OVERLAY);
  if (shot.cursor) await page.addInitScript(CURSOR_OVERLAY);
  page.on('pageerror', e => console.error(`\n  pageerror[${shot.id}]`, String(e).slice(0, 200)));

  try {
    const result = (await shot.run(page, api)) ?? {};
    // A tab that opened mid-shot (restore, target=_blank) would have been the painted surface.
    const strays = browser.pages().filter((p) => p !== page);
    if (strays.length) console.log(`\n  ⚠ ${strays.length} stray page(s) during ${shot.id}: ${strays.map((p) => p.url().slice(0, 60)).join(' | ')}`);
    const wallSec = (Date.now() - t0) / 1000;
    const v = page.video();
    // Leave nothing for Chrome to restore next launch. A restored tab paints into the same window
    // surface the screencast captures, which is how takes came back with a previous shot's editor
    // ghosted under the viewer. Blank frames land after the last mark, so a trimmed shot loses
    // nothing; untrimmed legacy shots keep their tail and are left alone.
    if (result.trim || result.cuts) await page.goto('about:blank').catch(() => {});
    await page.close();
    const raw = await v.path();
    await browser.close();

    const rawInfo = probe(raw);
    // The recorder's clock starts at the first screencast frame, a little after the page opened;
    // the tail is aligned with close(). So a mark at wall-time m sits at m - (wall - duration).
    const offset = Math.max(0, wallSec - rawInfo.durationSec);
    const fileSec = (m) => Math.round((m - offset) * 100) / 100;
    const resolve = (v) => {
      if (v == null) return null;
      if (typeof v === 'number') return fileSec(v);
      if (!(v in marks)) throw new Error(`unknown mark "${v}" (have: ${Object.keys(marks).join(', ')})`);
      return fileSec(marks[v]);
    };
    const beatsWithin = (from, to) => Object.fromEntries(Object.entries(marks)
      .map(([k, m]) => [k, Math.round((fileSec(m) - from) * 100) / 100])
      .filter(([, s]) => s >= -0.05 && (to == null || s <= (to - from) + 0.05))
      .map(([k, s]) => [k, Math.max(0, s)]));
    const recordedAt = new Date().toISOString();
    // A validated recording clears any error left by an earlier attempt.
    const clearErrors = (id) => {
      for (const k of ['error', 'at', 'lastError', 'lastAttemptAt', 'lastAttemptMarks', 'staleAfterFailedReshoot', 'blocked']) delete manifest[id]?.[k];
    };

    if (result.cuts?.length) {
      for (const c of result.cuts) {
        const from = Math.max(0, resolve(c.from) - (c.padBefore ?? 0));
        const to = resolve(c.to);
        const file = cutFile(raw, c.id, from, to);
        manifest[c.id] = { file, film: c.film ?? shot.film, scene: c.scene ?? shot.scene, recordedAt, raw, ...probe(file), beats: beatsWithin(from, to), note: c.note };
        saveBeats(c.id, manifest[c.id].beats);
      }
      console.log(`done → ${result.cuts.map(c => c.id).join(', ')}  (raw ${rawInfo.durationSec}s, offset ${offset.toFixed(2)}s)`);
    } else if (result.trim) {
      const from = Math.max(0, resolve(result.trim.from) - (result.trim.padBefore ?? 0));
      const to = resolve(result.trim.to);
      const file = cutFile(raw, shot.id, from, to);
      manifest[shot.id] = { file, film: shot.film, scene: shot.scene, recordedAt, raw, ...probe(file), beats: beatsWithin(from, to), note: result.note };
      saveBeats(shot.id, manifest[shot.id].beats);
      console.log(`done → ${file}  (${manifest[shot.id].durationSec}s of raw ${rawInfo.durationSec}s, offset ${offset.toFixed(2)}s)`);
    } else {
      manifest[shot.id] = { file: raw, film: shot.film, scene: shot.scene, recordedAt, ...rawInfo, beats: beatsWithin(0, null) };
      if (Object.keys(marks).length) saveBeats(shot.id, manifest[shot.id].beats);
      console.log('done');
    }
    saveManifest();
  } catch (e) {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    console.log('FAILED:', String(e).slice(0, 300));
    // ADDITIVE ON FAILURE. A failed attempt must never erase the take it was trying to replace:
    // the entry used to be overwritten with a bare {error}, which silently unpublished a good file
    // that was still on disk — and because other shots list it as their fallback, one failed
    // re-shoot took three beats out of a film's assembly (2026-09-05). The previous recording's
    // file/recordedAt/beats survive; only the error fields are new.
    const prev = manifest[shot.id] ?? {};
    delete prev.error; delete prev.at;                       // legacy shape from older runs
    manifest[shot.id] = {
      ...prev,
      lastError: String(e).slice(0, 300),
      lastAttemptAt: new Date().toISOString(),
      lastAttemptMarks: marks,
      ...(prev.file ? { staleAfterFailedReshoot: true } : {}),
    };
    saveManifest();
  }
}

console.log('\nManifest:', join(OUT, 'MANIFEST.json'));
