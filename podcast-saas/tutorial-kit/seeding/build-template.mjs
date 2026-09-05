// Build the DEMO/TEMPLATE PROJECT + niche projects + the "Welcome to Flow Video" playlist
// on the LOCAL stack, through the product's real APIs — the artifact the seeding service
// (DESIGN.md) will later clone per user.
//
// IDEMPOTENT-BY-RECREATION: every run deletes the previous run's projects/playlist (ids read
// from the TEMPLATE.json this script wrote last time) and creates fresh ones; all new ids are
// written to seeding/TEMPLATE.json as the run progresses, so a crash still leaves evidence.
// Re-run whenever the films in ../assembly/out change.
//
// Never points anywhere but 127.0.0.1/localhost. LLM spend (This-moment generation) was
// authorized by the owner for this build.
//
// Route intel verified against backend-api/src/controllers/v1/* on 2026-09-05 — discrepancies
// vs the original intel are recorded in TEMPLATE.json `notes`.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT  = dirname(HERE);                              // tutorial-kit/
const API  = 'http://127.0.0.1:8080';
const EMU  = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const PLAYWRIGHT_HOME = '/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json';

for (const base of [API, EMU]) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(base)) {
    console.error(`FATAL: non-local base URL refused: ${base}`);
    process.exit(1);
  }
}

const TEMPLATE_PATH = join(HERE, 'TEMPLATE.json');
// Captured BEFORE the first saveT clobbers the file — the cleanup step reads THIS, not the
// path (the 10:30 run deleted 0 rows because preflight's step() had already overwritten the
// previous run's ids; the stale demo then squatted the permalink slug → 409).
let PREV_RUN = null;
try { PREV_RUN = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')); } catch { /* first run */ }
const PROOF_DIR = join(HERE, 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

// ── The run record ────────────────────────────────────────────────────────────
const T = {
  builtAt: new Date().toISOString(),
  finishedAt: null,
  api: API,
  appUrl: null,               // learned from the first share response
  steps: [],                  // [{id, title, status: done|skipped|failed|partial, detail}]
  previousRunCleanup: null,
  demo: {},
  niche: [],
  playlist: {},
  verification: { asserts: [], screenshots: [], posters: [] },
  notes: [
    'POST /api/v1/projects validates via shared CreateProjectSchema (shared/src/types/project.ts:38): only {topic,...}; a "name" key is silently stripped — the project title is set with PATCH /api/v1/projects/:id {title} (projects.controller.ts:200).',
    'The podcast edition route is /api/v1/projects/:id/audio-edition (audioEdition.controller.ts:71,129), not .../audio; POST returns 202 and the same GET is the status poll.',
    'Sim-section posters are CLIENT-captured: POST /api/v1/projects/:id/sections/:sid/poster with PNG renditions of exactly POSTER_SIZES[aspect] (simulations.controller.ts:221, shared/src/sim/posterIdentity.ts:52) — this builder captures them with headless Chrome from the section\'s served sim URL.',
    'Branching IS creatable headlessly (branch.controller.ts: sequences/choice-points/edges), BUT the current viewer disables flat overlays (image/b-roll/audio cutaways) whenever a branching block exists — client-web/components/viewer/useProjectPlayer.ts:2467,2517,2559 ("flat overlays disabled in branching mode (Phase 2)"). The image section + A2 sting are therefore present in the config/editor but not rendered by the branching viewer today; keep or drop the choice graph at capture time.',
    'A post-roll sim section (start_sec >= host duration - 0.05) is entered from onEnded (useProjectPlayer.ts:3233-3247); "Back to video" from it returns to the START of the same segment (useProjectPlayer.ts:2070). With film2 absent, section 2 sits at [end+30,end+60] on the teaser and is reachable by scrubbing; a re-run with film2 re-anchors the layout.',
  ],
};
const saveT = () => writeFileSync(TEMPLATE_PATH, JSON.stringify(T, null, 2) + '\n');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function step(id, title, status, detail) {
  const row = { id, title, status, detail: detail ?? null };
  const i = T.steps.findIndex((s) => s.id === id);
  if (i >= 0) T.steps[i] = row; else T.steps.push(row);
  log(`[${status.toUpperCase()}] ${id} — ${title}${detail ? ` :: ${detail}` : ''}`);
  saveT();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Auth (emulator pattern from captures/stage-capture-prop.mjs) ─────────────
const cred = { email: 'kinesin-test@example.com', password: 'kinesin-test-pass-1', returnSecureToken: true };
let sign = await (await fetch(`${EMU}/accounts:signUp?key=fake`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cred),
})).json();
if (!sign.idToken) {
  sign = await (await fetch(`${EMU}/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cred),
  })).json();
}
if (!sign.idToken) { console.error('FATAL: emulator sign-in failed', sign); process.exit(1); }
const H = { authorization: `Bearer ${sign.idToken}` };
log('signed in as', cred.email);

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function j(method, path, body, opts = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(opts.noAuth ? {} : H),
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 400); }
  return { status: res.status, data };
}
async function jOk(method, path, body, what, opts) {
  const r = await j(method, path, body, opts);
  if (r.status >= 400) throw new Error(`${what}: ${method} ${path} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}
function fd(fields, filePath, filename, type, fileField = 'file') {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append(fileField, new Blob([readFileSync(filePath)], { type }), filename);
  return f;
}
async function poll(what, fn, { every = 3000, deadlineMs = 600_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > deadlineMs) throw new Error(`timeout waiting for ${what} (${Math.round(deadlineMs / 1000)}s)`);
    await sleep(every);
  }
}

// ── Headless Chrome (posters + viewer proofs) ────────────────────────────────
let chromium = null;
try { chromium = createRequire(PLAYWRIGHT_HOME)('playwright').chromium; }
catch (e) { log('WARN: playwright unavailable:', e.message); }

async function withBrowser(fn) {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--mute-audio'],
  });
  try { return await fn(browser); } finally { await browser.close(); }
}

/**
 * Two frames of the REAL public viewer into seeding/proof/.
 * The share URL is used AS ISSUED (localhost) — dev CORS allows only http://localhost:3000
 * (backend-api/src/config/publicOrigins.ts browserOrigins()), so rewriting the host to
 * 127.0.0.1 makes every API fetch fail from the page ("Failed to fetch").
 */
async function captureViewerScreenshots(shareUrl, durationSec) {
  T.verification.screenshots = [];
  await withBrowser(async (browser) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(5000);
    const play = page.locator('[aria-label="Play video"]');
    if (await play.count()) await play.first().click({ timeout: 5000 }).catch(() => {});
    else await page.mouse.click(640, 400);
    await page.waitForTimeout(5000);      // teaser playing
    await page.screenshot({ path: join(PROOF_DIR, 'viewer-1-teaser.png') });
    T.verification.screenshots.push({ what: 't=teaser playing', path: 'proof/viewer-1-teaser.png', url: shareUrl });

    // jump to just before the teaser's end so the post-roll sim section engages
    await page.evaluate((d) => {
      const v = document.querySelector('video');
      if (v) { v.currentTime = Math.max(0, d - 0.8); v.play?.(); }
    }, durationSec);
    await page.waitForTimeout(9000);      // end -> sim section mount/cover
    await page.screenshot({ path: join(PROOF_DIR, 'viewer-2-sim-section.png') });
    T.verification.screenshots.push({ what: 'post-roll sim section engaged', path: 'proof/viewer-2-sim-section.png', url: shareUrl });
    await ctx.close();
  });
}

// ── --screenshots-only: redo the viewer proofs for the run in TEMPLATE.json ──
if (process.argv.includes('--screenshots-only')) {
  const prev = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
  Object.assign(T, prev);
  if (!chromium) { console.error('FATAL: playwright unavailable'); process.exit(1); }
  if (!T.demo?.shareUrl || !T.demo?.videos?.film1?.duration_sec) {
    console.error('FATAL: TEMPLATE.json has no demo shareUrl/duration — run a full build first');
    process.exit(1);
  }
  try {
    await captureViewerScreenshots(T.demo.shareUrl, T.demo.videos.film1.duration_sec);
    step('D2', 'Viewer screenshots captured', 'done', 'proof/viewer-1-teaser.png, proof/viewer-2-sim-section.png');
    saveT();
    process.exit(0);
  } catch (e) {
    step('D2', 'Viewer screenshots', 'failed', e.message);
    saveT();
    process.exit(1);
  }
}

// ── Assets on disk ───────────────────────────────────────────────────────────
/** Real film beats scratch: filmN.mp4 wins over filmN.SCRATCH.mp4. */
function filmPath(n) {
  const real = join(KIT, 'assembly/out', `film${n}.mp4`);
  const scratch = join(KIT, 'assembly/out', `film${n}.SCRATCH.mp4`);
  if (existsSync(real)) return { path: real, source: `film${n}.mp4` };
  if (existsSync(scratch)) return { path: scratch, source: `film${n}.SCRATCH.mp4` };
  return null;
}
const PROPS = join(KIT, 'captures/props');
const ASSETS = {
  film1: filmPath(1), film2: filmPath(2), film3: filmPath(3), film4: filmPath(4), film5: filmPath(5),
  murmurationZip: join(PROPS, 'murmuration.zip'),
  orbitLabZip: join(PROPS, 'orbit-lab.zip'),
  // Owner-GitHub sims (their own work → seed-clean), added for VISUAL VARIETY (owner steer
  // 2026-09-05 morning): Galton Board is bright/light-ground, 5 Species is vivid color — both
  // the opposite of the dark-space trio.
  galtonZip: join(PROPS, 'galton-board.zip'),
  speciesZip: join(PROPS, 'five-species.zip'),
  solarSystemDir: join(KIT, 'sims/solar-system'),
  wavesDiagram: join(PROPS, 'waves-diagram.png'),
  sting: join(KIT, 'music/sting-ambient.wav'),
};
for (const p of [ASSETS.murmurationZip, ASSETS.orbitLabZip, ASSETS.wavesDiagram, ASSETS.sting]) {
  if (!existsSync(p)) { console.error(`FATAL: required asset missing: ${p}`); process.exit(1); }
}
if (!ASSETS.film1) { console.error('FATAL: no film1(.SCRATCH).mp4 in assembly/out — nothing to build the demo on'); process.exit(1); }

// Zip the solar-system sim like the other props (files at zip root), into a temp dir.
let solarZip = null;
if (existsSync(join(ASSETS.solarSystemDir, 'index.html'))) {
  const tmp = await mkdtemp(join(tmpdir(), 'flowvid-solar-'));
  solarZip = join(tmp, 'solar-system.zip');
  const z = spawnSync('zip', ['-qr', solarZip, '.', '-x', '.*'], { cwd: ASSETS.solarSystemDir });
  if (z.status !== 0) { console.error('FATAL: zipping solar-system failed', z.stderr?.toString()); process.exit(1); }
  log('zipped solar-system ->', solarZip);
}

// ── Preflight ────────────────────────────────────────────────────────────────
{
  const h = await j('GET', '/health', undefined, { noAuth: true });
  if (h.status >= 500) { console.error('FATAL: API /health failed', h); process.exit(1); }
  step('preflight', 'API + emulator reachable, assets present', 'done',
    `film1=${ASSETS.film1.source}; film2=${ASSETS.film2?.source ?? 'MISSING'}; films3-5=${[3, 4, 5].map((n) => ASSETS[`film${n}`]?.source ?? 'MISSING').join(',')}; solar-system=${solarZip ? 'zipped' : 'MISSING'}`);
}

// ── 0. Recreate: delete the previous run's rows ──────────────────────────────
{
  const prev = PREV_RUN;
  const cleaned = { playlists: [], projects: [], failures: [] };
  if (prev && (prev.playlist?.id || prev.demo?.projectId)) {
    if (prev.playlist?.id) {
      const r = await j('DELETE', `/api/v1/playlists/${prev.playlist.id}`);
      (r.status < 400 || r.status === 404 ? cleaned.playlists : cleaned.failures).push(prev.playlist.id);
    }
    const ids = [prev.demo?.projectId, ...(prev.niche ?? []).map((n) => n.projectId)].filter(Boolean);
    for (const id of ids) {
      const r = await j('DELETE', `/api/v1/projects/${id}`);
      (r.status < 400 || r.status === 404 ? cleaned.projects : cleaned.failures).push(id);
    }
  }
  T.previousRunCleanup = cleaned;
  step('cleanup', 'Previous run deleted (recreation)', cleaned.failures.length ? 'partial' : 'done',
    `playlists=${cleaned.playlists.length} projects=${cleaned.projects.length} failures=${cleaned.failures.length}`);
}

// ── Shared builders ──────────────────────────────────────────────────────────
async function createProject(title, topic) {
  const created = await jOk('POST', '/api/v1/projects', { topic }, `create project "${title}"`);
  const id = created.id ?? created.project?.id;
  if (!id) throw new Error(`create project "${title}": no id in ${JSON.stringify(created).slice(0, 200)}`);
  await jOk('PATCH', `/api/v1/projects/${id}`, { title }, `title "${title}"`);
  return id;
}
async function uploadVideo(projectId, filmPathStr, filename) {
  const bytes = readFileSync(filmPathStr);
  const f = new FormData();
  f.append('file_size', String(bytes.length));
  f.append('file', new Blob([bytes], { type: 'video/mp4' }), filename);
  const row = await jOk('POST', `/api/v1/projects/${projectId}/videos/upload`, f, `upload ${filename}`);
  return row.id;
}
async function waitHls(projectId, videoId, what) {
  return poll(`${what} HLS`, async () => {
    const r = await j('GET', `/api/v1/projects/${projectId}/videos/${videoId}/hls-status`);
    if (r.status >= 400) throw new Error(`hls-status ${what} -> ${r.status}`);
    if (r.data.hls_status === 'ready') return r.data;
    if (r.data.hls_status === 'failed') throw new Error(`${what} HLS failed: ${r.data.hls_error}`);
    return undefined;
  }, { every: 3000, deadlineMs: 12 * 60_000 });
}

// ── A. Demo project ──────────────────────────────────────────────────────────
const DEMO_TITLE = 'Welcome to Flow Video';
const demoId = await createProject(DEMO_TITLE,
  'Touch this video. Steer a flock, launch planets, and see exactly how this project was built.');
T.demo = { projectId: demoId, title: DEMO_TITLE, videos: {}, sims: {}, sections: {}, branching: null };
step('A0', 'Demo project created', 'done', demoId);

// A1 — master video (teaser)
const teaserId = await uploadVideo(demoId, ASSETS.film1.path, 'teaser-touch-this-video.mp4');
T.demo.videos.film1 = { id: teaserId, source: ASSETS.film1.source };
saveT();
log('teaser uploaded', teaserId, '— waiting for HLS');
const teaserHls = await waitHls(demoId, teaserId, 'teaser');
const D1 = teaserHls.duration_sec;
if (!(typeof D1 === 'number' && D1 > 0)) throw new Error(`teaser duration unknown after transcode: ${JSON.stringify(teaserHls)}`);
T.demo.videos.film1.hls_url = teaserHls.hls_url;
T.demo.videos.film1.duration_sec = D1;
step('A1', 'Teaser (film1) uploaded, HLS ready', 'done', `${ASSETS.film1.source} · ${D1}s · ${teaserHls.hls_url ? 'hls ok' : 'NO HLS URL'}`);

// A2 — second video (film2) if the assembly output exists
let film2Id = null;
if (ASSETS.film2) {
  film2Id = await uploadVideo(demoId, ASSETS.film2.path, 'tutorial-the-basics.mp4');
  const f2 = await waitHls(demoId, film2Id, 'film2');
  T.demo.videos.film2 = { id: film2Id, source: ASSETS.film2.source, hls_url: f2.hls_url, duration_sec: f2.duration_sec };
  step('A2', 'Second timeline video (film2) uploaded, HLS ready', 'done', ASSETS.film2.source);
} else {
  T.demo.videos.film2 = null;
  step('A2', 'Second timeline video (film2)', 'skipped',
    'no film2(.SCRATCH).mp4 in assembly/out yet — re-run this builder when the tutorial film lands; sim section 2 is placed on the teaser timeline until then');
}

// A3 — simulations: Murmuration, Orbit Lab, Solar System (if built)
async function uploadSim(name, zipPath) {
  const row = await jOk('POST', `/api/v1/projects/${demoId}/simulations/upload`,
    fd({ name }, zipPath, basename(zipPath), 'application/zip'), `upload sim ${name}`);
  const ready = await poll(`sim ${name} ready`, async () => {
    const r = await j('GET', `/api/v1/projects/${demoId}/simulations`);
    if (r.status >= 400) throw new Error(`list sims -> ${r.status}`);
    const s = (Array.isArray(r.data) ? r.data : []).find((x) => x.id === row.id);
    if (!s) return undefined;
    if (s.status === 'ready') return s;
    if (s.status === 'failed') throw new Error(`sim ${name} processing failed: ${s.error}`);
    return undefined;
  }, { every: 2000, deadlineMs: 180_000 });
  return { id: row.id, name, entry_file: ready.entry_file };
}
const murm = await uploadSim('Murmuration', ASSETS.murmurationZip);
T.demo.sims.murmuration = murm; saveT();
const orbit = await uploadSim('Orbit Lab', ASSETS.orbitLabZip);
T.demo.sims.orbitLab = orbit; saveT();
// Owner-GitHub variety pair: Galton gets its own SECTION (bright, instantly graspable);
// 5 Species stays library-only (visible richness without overwhelming the timeline).
const galton = existsSync(ASSETS.galtonZip) ? await uploadSim('Galton Board', ASSETS.galtonZip) : null;
if (galton) { T.demo.sims.galtonBoard = galton; saveT(); }
const species = existsSync(ASSETS.speciesZip) ? await uploadSim('5 Species Battle', ASSETS.speciesZip) : null;
if (species) { T.demo.sims.fiveSpecies = species; saveT(); }
let solar = null;
if (solarZip) { solar = await uploadSim('Solar System', solarZip); T.demo.sims.solarSystem = solar; saveT(); }
step('A3', 'Sims uploaded to the project library', 'done',
  `Murmuration ${murm.id}; Orbit Lab ${orbit.id}; Solar System ${solar ? solar.id : 'SKIPPED (sims/solar-system missing)'}`);

// A4 — image + audio library cards
const img = await jOk('POST', `/api/v1/projects/${demoId}/images`,
  fd({}, ASSETS.wavesDiagram, 'waves-diagram.png', 'image/png'), 'upload waves-diagram');
T.demo.imageId = img.id;
const aud = await jOk('POST', `/api/v1/projects/${demoId}/audio`,
  fd({}, ASSETS.sting, 'sting-ambient.wav', 'audio/wav'), 'upload sting-ambient');
T.demo.audioId = aud.id;
T.demo.audioDurationSec = aud.duration_sec ?? 8;
step('A4', 'Image (waves-diagram) + audio (sting-ambient) uploaded', 'done', `image=${img.id} audio=${aud.id} (${aud.duration_sec}s)`);

// A5 — SIM sections on the teaser timeline + This-moment generation + posters
// Section 1: Murmuration, right after the teaser's end region (post-roll: start == duration).
// Section 2: Solar System when built (SCRIPT-2 S4's sim), else Orbit Lab; stacked after section 1.
const sim2 = solar ?? orbit;
const sim2Name = solar ? 'Solar System' : 'Orbit Lab';
const PROMPTS = {
  murmuration: 'Let viewers steer the flock — cohesion, speed, and a scatter button',
  // Per-sim prompts (a launch prompt on the solar system was the original taste bug):
  sim2: solar
    ? 'Give viewers the planets — let them speed up time and fly to any world'
    : 'Let viewers launch planets and watch the forces pull them into orbit',
  orbit: 'Let viewers launch planets and watch the forces pull them into orbit',
  galton: 'Let viewers drop balls and watch the bell curve build itself',
};
async function createSimSection(label, simId, startSec, endSec, sortOrder) {
  return jOk('POST', `/api/v1/projects/${demoId}/sections`, {
    video_file_id: teaserId, track: 'main', type: 'simulation',
    start_sec: startSec, end_sec: endSec, sort_order: sortOrder,
    simulation_id: simId, label,
  }, `create sim section ${label}`);
}
// Layout: murmuration plays BETWEEN the films (teaser post-roll). The rest anchor to film2's
// post-roll when the tutorial exists (teaser→touch→tutorial→touch touch touch), else they stack
// on the teaser as before. createSimSection anchors to the teaser video row; a film2-anchored
// section needs its own helper.
async function createSimSectionOn(videoId, label, simId, startSec, endSec, sortOrder) {
  return jOk('POST', `/api/v1/projects/${demoId}/sections`, {
    video_file_id: videoId, track: 'main', type: 'simulation',
    start_sec: startSec, end_sec: endSec, sort_order: sortOrder,
    simulation_id: simId, label,
  }, `create sim section ${label}`);
}
const D2 = T.demo.videos.film2?.duration_sec ?? null;
const tailAnchor = film2Id ?? teaserId;
const tailBase = film2Id ? D2 : D1 + 30;
const sec1 = await createSimSection('Steer the flock', murm.id, D1, D1 + 30, 10);
const sec2 = await createSimSectionOn(tailAnchor, solar ? 'Tour the solar system' : 'Launch a planet', sim2.id, tailBase, tailBase + 30, 20);
const sec3 = solar ? await createSimSectionOn(tailAnchor, 'Launch a planet', orbit.id, tailBase + 30, tailBase + 55, 22) : null;
const sec4 = galton ? await createSimSectionOn(tailAnchor, 'Drop the balls', galton.id, tailBase + (solar ? 55 : 30), tailBase + (solar ? 80 : 55), 24) : null;
T.demo.sections.murmuration = { id: sec1.id, simulation_id: murm.id, start_sec: sec1.start_sec, end_sec: sec1.end_sec, prompt: PROMPTS.murmuration };
T.demo.sections.sim2 = { id: sec2.id, sim: sim2Name, simulation_id: sim2.id, start_sec: sec2.start_sec, end_sec: sec2.end_sec, prompt: PROMPTS.sim2, anchored_to: film2Id ? 'film2' : 'teaser' };
if (sec3) T.demo.sections.orbit = { id: sec3.id, simulation_id: orbit.id, start_sec: sec3.start_sec, end_sec: sec3.end_sec, prompt: PROMPTS.orbit, anchored_to: film2Id ? 'film2' : 'teaser' };
if (sec4) T.demo.sections.galton = { id: sec4.id, simulation_id: galton.id, start_sec: sec4.start_sec, end_sec: sec4.end_sec, prompt: PROMPTS.galton, anchored_to: film2Id ? 'film2' : 'teaser' };
step('A5a', 'Sim sections created', 'done',
  `#1 Murmuration [${sec1.start_sec}-${sec1.end_sec}] ${sec1.id} (teaser post-roll); ` +
  `#2 ${sim2Name} [${sec2.start_sec}-${sec2.end_sec}] ${sec2.id}` +
  (sec3 ? `; #3 Orbit Lab [${sec3.start_sec}-${sec3.end_sec}] ${sec3.id}` : '') +
  (sec4 ? `; #4 Galton Board [${sec4.start_sec}-${sec4.end_sec}] ${sec4.id}` : '') +
  ` — tail anchored to ${film2Id ? 'film2 post-roll' : 'teaser (film2 missing)'}`);

/** Drive the REAL ✦ generation endpoint (SSE POST) and wait for its `done`/`error` frame. */
async function generateSection(sectionId, prompt, what) {
  const ac = new AbortController();
  const cap = setTimeout(() => ac.abort(), 17 * 60_000);
  try {
    const res = await fetch(`${API}/api/v1/projects/${demoId}/sections/${sectionId}/generate-sim-script/stream`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ prompt, simple_ui: true, auto_script: true }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      throw new Error(`${what}: generate stream -> ${res.status} ${t.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done = null;
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let event = 'message'; let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let payload; try { payload = JSON.parse(data); } catch { continue; }
        if (event === 'status' && payload.status) log(`  [gen ${what}]`, String(payload.status).slice(0, 110));
        if (event === 'error') throw new Error(`${what}: generation error: ${payload.error} (${payload.errorType})`);
        if (event === 'done') done = payload.section;
      }
      if (done) break;
    }
    if (!done) throw new Error(`${what}: SSE stream ended without a done frame`);
    return done;
  } finally { clearTimeout(cap); }
}
async function generateWithRetry(sectionId, prompt, what) {
  try { return await generateSection(sectionId, prompt, what); }
  catch (e) {
    log(`  [gen ${what}] first attempt failed: ${e.message} — retrying once in 20s`);
    await sleep(20_000);
    return generateSection(sectionId, prompt, what);
  }
}
log('This-moment generation starting (LLM; can take several minutes per section; run in parallel)…');
const [g1, g2, g3, g4] = await Promise.allSettled([
  generateWithRetry(sec1.id, PROMPTS.murmuration, 'murmuration'),
  generateWithRetry(sec2.id, PROMPTS.sim2, sim2Name),
  sec3 ? generateWithRetry(sec3.id, PROMPTS.orbit, 'Orbit Lab') : Promise.reject(new Error('no solar → orbit is sim2')),
  sec4 ? generateWithRetry(sec4.id, PROMPTS.galton, 'Galton Board') : Promise.reject(new Error('galton zip missing')),
]);
function recordGen(key, res, sectionId) {
  if (res.status === 'fulfilled') {
    const s = res.value;
    const ownUrl = !!s.simulation_url?.includes(`section=${sectionId}`);
    T.demo.sections[key].simulation_url = s.simulation_url;
    T.demo.sections[key].generated = true;
    T.demo.sections[key].url_carries_section_param = ownUrl;
    step(`A5-gen-${key}`, `This-moment generated (${key})`, ownUrl ? 'done' : 'partial',
      ownUrl ? s.simulation_url : `simulation_url does not carry section=${sectionId}: ${s.simulation_url}`);
    return true;
  }
  T.demo.sections[key].generated = false;
  T.demo.sections[key].generation_error = String(res.reason?.message ?? res.reason);
  step(`A5-gen-${key}`, `This-moment generated (${key})`, 'failed', T.demo.sections[key].generation_error);
  return false;
}
const gen1ok = recordGen('murmuration', g1, sec1.id);
const gen2ok = recordGen('sim2', g2, sec2.id);
const gen3ok = sec3 ? recordGen('orbit', g3, sec3.id) : false;
const gen4ok = sec4 ? recordGen('galton', g4, sec4.id) : false;

// A6 — image section (camera movement) + ambient sting on the audio track
const IMG_AT = Math.min(30, Math.max(5, D1 - 20));
const imgSec = await jOk('POST', `/api/v1/projects/${demoId}/sections`, {
  video_file_id: teaserId, track: 'main', type: 'clip',
  start_sec: 0, end_sec: 6, sort_order: 30,
  clip_source_image_id: img.id, global_offset_sec: IMG_AT,
  camera_movement: 'drift', label: 'Anatomy of an interactive video',
}, 'create image section');
T.demo.sections.image = { id: imgSec.id, image_id: img.id, global_offset_sec: IMG_AT, duration_sec: 6, camera_movement: 'drift' };
const stingLen = Math.min(8, Math.max(0.5, T.demo.audioDurationSec || 8));
const stingAt = Math.max(0, D1 - stingLen);
const stingSec = await jOk('POST', `/api/v1/projects/${demoId}/audio/insert-cutaway`, {
  audio_file_id: aud.id, global_offset_sec: stingAt, duration_sec: stingLen, video_file_id: teaserId,
}, 'insert audio cutaway');
T.demo.sections.sting = { id: stingSec.id, audio_id: aud.id, global_offset_sec: stingAt, duration_sec: stingLen, track: 'audio' };
step('A6', 'Image section (drift) + A2 ambient sting placed', 'done',
  `image@${IMG_AT}s for 6s (${imgSec.id}); sting@${stingAt}s for ${stingLen}s (${stingSec.id}) — audio.controller insert-cutaway`);

// ── B. Niche projects (before branching, so choice edges can point at them) ──
const NICHE = [
  { key: 'heavy', film: 3, title: 'The Heavy Simulation',
    topic: 'Embed a heavy WebGL simulation: drop the package in, minimize its UI, auto-script the demo, get a poster.' },
  { key: 'powers', film: 4, title: 'Viewer Superpowers',
    topic: 'What viewers can do inside a film: ask at any moment, branch the story, smart crop, dubbing.' },
  { key: 'doors', film: 5, title: 'One Link, Three Doors',
    topic: 'Share, collaborate, price: one permalink, invited collaborators, and access control for a film.' },
];
for (const n of NICHE) {
  const pid = await createProject(n.title, n.topic);
  const rec = { key: n.key, projectId: pid, title: n.title, video: null, shareUrl: null };
  const film = ASSETS[`film${n.film}`];
  if (film) {
    const vid = await uploadVideo(pid, film.path, `${n.key}.mp4`);
    const hls = await waitHls(pid, vid, n.title);
    rec.video = { id: vid, source: film.source, hls_url: hls.hls_url, duration_sec: hls.duration_sec };
  }
  await jOk('PATCH', `/api/v1/projects/${pid}`, { visibility: 'public' }, `${n.title} public`);
  const share = await jOk('POST', `/api/v1/projects/${pid}/share`, undefined, `${n.title} share`);
  rec.shareToken = share.shareToken; rec.shareUrl = share.shareUrl;
  if (!T.appUrl && share.shareUrl) T.appUrl = new URL(share.shareUrl).origin;
  T.niche.push(rec); saveT();
  step(`B-${n.key}`, `Niche project "${n.title}"`, film ? 'done' : 'partial',
    film ? `${pid} · ${film.source}` : `${pid} · film${n.film}(.SCRATCH).mp4 MISSING — project created public+shared with no master video; re-run adds it`);
}

// ── A7. One branching choice ("What next?" doors) — headless via branch API ──
{
  const seq = await jOk('POST', `/api/v1/projects/${demoId}/branch/sequences`,
    { label: 'Main', is_entry: true }, 'create branch sequence');
  await jOk('POST', `/api/v1/projects/${demoId}/branch/assign`,
    { video_file_id: teaserId, sequence_id: seq.id, sequence_order: 0 }, 'assign teaser to sequence');
  if (film2Id) {
    await jOk('POST', `/api/v1/projects/${demoId}/branch/assign`,
      { video_file_id: film2Id, sequence_id: seq.id, sequence_order: 1 }, 'assign film2 to sequence');
  }
  const cp = await jOk('POST', `/api/v1/projects/${demoId}/branch/choice-points`,
    { sequence_id: seq.id, lead_in_sec: 6, behavior: 'pause', prompt: 'What next?', layout: 'cards' },
    'create choice point');
  const edges = [];
  for (const [i, n] of T.niche.entries()) {
    edges.push(await jOk('POST', `/api/v1/projects/${demoId}/branch/edges`, {
      choice_point_id: cp.id, sort_order: i, label: n.title,
      destination_type: 'project', dest_project_id: n.projectId,
    }, `edge -> ${n.title}`));
  }
  edges.push(await jOk('POST', `/api/v1/projects/${demoId}/branch/edges`, {
    choice_point_id: cp.id, sort_order: 3, label: 'Watch again', destination_type: 'restart',
  }, 'edge -> restart'));
  const validation = await jOk('GET', `/api/v1/projects/${demoId}/branch/validate`, undefined, 'validate graph');
  T.demo.branching = {
    sequence_id: seq.id, choice_point_id: cp.id,
    edges: edges.map((e) => ({ id: e.id, label: e.label, destination_type: e.destination_type })),
    validation_issues: validation.issues,
    viewer_caveat: 'flat overlays (image/sting) are not rendered by the branching viewer today — see notes[]',
  };
  step('A7', 'Branching choice created headlessly (What next? -> 3 doors + replay)',
    validation.issues.some((i) => i.level === 'error') ? 'partial' : 'done',
    `cp=${cp.id}; issues=${JSON.stringify(validation.issues)}`);
}

// ── A8. Public + share + permalink + podcast edition ─────────────────────────
await jOk('PATCH', `/api/v1/projects/${demoId}`, { visibility: 'public' }, 'demo public');
const demoShare = await jOk('POST', `/api/v1/projects/${demoId}/share`, undefined, 'demo share');
T.demo.shareToken = demoShare.shareToken; T.demo.shareUrl = demoShare.shareUrl;
if (!T.appUrl && demoShare.shareUrl) T.appUrl = new URL(demoShare.shareUrl).origin;
step('A8-share', 'Demo public + share link', 'done', demoShare.shareUrl);

{ // permalink 'welcome-flow-video' — steal back from a survivor of an older run if needed
  const SLUG = 'welcome-flow-video';
  let r = await j('PUT', `/api/v1/projects/${demoId}/permalink`, { slug: SLUG });
  if (r.status === 409) {
    const avail = await j('GET', `/api/v1/permalink-availability?slug=${SLUG}&exclude_type=project&exclude_id=${demoId}`);
    step('A8-permalink', `Demo permalink /${SLUG}`, 'partial',
      `slug taken (${JSON.stringify(avail.data).slice(0, 120)}) — left unset; clear the older holder and re-run`);
  } else if (r.status >= 400) {
    step('A8-permalink', `Demo permalink /${SLUG}`, 'failed', JSON.stringify(r.data).slice(0, 200));
  } else {
    T.demo.permalink = r.data.permalinkUrl ?? `${T.appUrl}/${SLUG}`;
    T.demo.permalinkSlug = SLUG;
    step('A8-permalink', `Demo permalink /${SLUG}`, 'done', T.demo.permalink);
  }
}

{ // podcast (audio) edition — best-effort
  const start = await j('POST', `/api/v1/projects/${demoId}/audio-edition`, {});
  if (start.status === 202) {
    try {
      const done = await poll('audio edition', async () => {
        const r = await j('GET', `/api/v1/projects/${demoId}/audio-edition`);
        if (r.status >= 400) throw new Error(`audio-edition poll -> ${r.status}`);
        if (r.data.status === 'ready') return r.data;
        if (r.data.status === 'failed') throw new Error(`edition failed: ${r.data.error}`);
        return undefined;
      }, { every: 5000, deadlineMs: 5 * 60_000 });
      T.demo.audioEdition = { status: 'ready', duration_ms: done.duration_ms };
      step('A8-podcast', 'Podcast (audio) edition built', 'done', `duration_ms=${done.duration_ms}`);
    } catch (e) {
      T.demo.audioEdition = { status: 'pending-or-failed', detail: e.message };
      step('A8-podcast', 'Podcast (audio) edition', 'partial', e.message);
    }
  } else {
    T.demo.audioEdition = { status: 'refused', detail: `${start.status} ${JSON.stringify(start.data).slice(0, 200)}` };
    step('A8-podcast', 'Podcast (audio) edition', 'skipped',
      `POST /audio-edition -> ${start.status}: ${JSON.stringify(start.data).slice(0, 160)}`);
  }
}

// ── C. Playlist ──────────────────────────────────────────────────────────────
{
  const pl = await jOk('POST', '/api/v1/playlists', {
    title: 'Welcome to Flow Video',
    description: 'Start here: a teaser you can touch, then the fastest paths from footage to an interactive film.',
  }, 'create playlist');
  const items = [demoId, ...T.niche.map((n) => n.projectId)].map((project_id) => ({ project_id }));
  const withItems = await jOk('PUT', `/api/v1/playlists/${pl.id}/items`, { items }, 'playlist items');
  const share = await jOk('POST', `/api/v1/playlists/${pl.id}/share`, undefined, 'playlist share');
  T.playlist = {
    id: pl.id, title: pl.title,
    items: withItems.items.map((i) => ({ position: i.position, project_id: i.project_id, title: i.title })),
    shareToken: share.shareToken, shareUrl: share.shareUrl,
  };
  const SLUG = 'welcome-to-flow-video';
  const perma = await j('PUT', `/api/v1/playlists/${pl.id}/permalink`, { slug: SLUG });
  if (perma.status < 400) { T.playlist.permalinkUrl = perma.data.permalinkUrl; T.playlist.slug = SLUG; }
  step('C', 'Playlist "Welcome to Flow Video" (4 items, shared, public via slug)',
    withItems.items.length === 4 && perma.status < 400 ? 'done' : 'partial',
    `${pl.id} · items=${withItems.items.length} · ${share.shareUrl} · permalink=${perma.status < 400 ? T.playlist.permalinkUrl : `FAILED ${perma.status}`}`);
}

// ── D. Verification ──────────────────────────────────────────────────────────
const A = (name, ok, detail) => {
  T.verification.asserts.push({ name, ok: !!ok, detail: detail ?? null });
  log(ok ? '  ✓' : '  ✗', name, detail ? `— ${detail}` : '');
  saveT();
  return !!ok;
};

// D0 — posters: captured with headless Chrome from each generated section's SERVED sim url,
// then POSTed to the real poster endpoint; verified through the public player config below.
if (!chromium) step('D-playwright', 'Playwright resolution', 'failed', 'playwright not resolvable from the kinesin checkout');
function absolutize(u) {
  if (!u) return null;
  if (/^https?:\/\//.test(u)) return u;
  return API + (u.startsWith('/') ? u : `/${u}`);
}
async function captureRendition(browser, url, width, height, outPng) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(6000);          // let the scene animate past its first frames
  const buf = await page.screenshot({ type: 'png' });
  if (outPng) writeFileSync(outPng, buf);
  await ctx.close();
  return `data:image/png;base64,${buf.toString('base64')}`;
}
async function capturePoster(browser, key, sectionId) {
  const rows = await jOk('GET', `/api/v1/projects/${demoId}/sections`, undefined, 'list sections');
  const row = rows.find((s) => s.id === sectionId);
  const url = absolutize(row?.simulation_served_url ?? row?.simulation_url);
  if (!url) throw new Error(`section ${sectionId} has no simulation url to capture`);
  const std = await captureRendition(browser, url, 1280, 720, join(PROOF_DIR, `poster-${key}.png`));
  const cmp = await captureRendition(browser, url, 640, 360, null);
  const res = await j('POST', `/api/v1/projects/${demoId}/sections/${sectionId}/poster`, {
    renditions: [
      { size: 'standard', format: 'png', dataUrl: std },
      { size: 'compact', format: 'png', dataUrl: cmp },
    ],
  });
  if (res.status >= 400) throw new Error(`poster POST ${key} -> ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
  T.verification.posters.push({ key, sectionId, outcome: res.data.outcome, identity: res.data.identity, proof: `proof/poster-${key}.png`, captured_from: url });
  saveT();
  return res.data;
}
if (chromium) {
  await withBrowser(async (browser) => {
    if (gen1ok) {
      try { const p = await capturePoster(browser, 'murmuration', sec1.id); step('A5-poster-murmuration', 'Poster captured+stored (murmuration)', 'done', p.outcome); }
      catch (e) { step('A5-poster-murmuration', 'Poster (murmuration)', 'failed', e.message); }
    } else step('A5-poster-murmuration', 'Poster (murmuration)', 'skipped', 'generation failed');
    if (gen2ok) {
      try { const p = await capturePoster(browser, 'sim2', sec2.id); step('A5-poster-sim2', `Poster captured+stored (${sim2Name})`, 'done', p.outcome); }
      catch (e) { step('A5-poster-sim2', `Poster (${sim2Name})`, 'failed', e.message); }
    } else step('A5-poster-sim2', `Poster (${sim2Name})`, 'skipped', 'generation failed');
    if (sec3) {
      if (gen3ok) {
        try { const p = await capturePoster(browser, 'orbit', sec3.id); step('A5-poster-orbit', 'Poster captured+stored (Orbit Lab)', 'done', p.outcome); }
        catch (e) { step('A5-poster-orbit', 'Poster (Orbit Lab)', 'failed', e.message); }
      } else step('A5-poster-orbit', 'Poster (Orbit Lab)', 'skipped', 'generation failed');
    }
    if (sec4) {
      if (gen4ok) {
        try { const p = await capturePoster(browser, 'galton', sec4.id); step('A5-poster-galton', 'Poster captured+stored (Galton Board)', 'done', p.outcome); }
        catch (e) { step('A5-poster-galton', 'Poster (Galton Board)', 'failed', e.message); }
      } else step('A5-poster-galton', 'Poster (Galton Board)', 'skipped', 'generation failed');
    }
  });
}

// D1 — the PUBLIC player config (buildPlayerConfig via GET /api/v1/share/:token — share.controller.ts:22)
const pub = await j('GET', `/api/v1/share/${T.demo.shareToken}`, undefined, { noAuth: true });
A('public share config responds 200', pub.status === 200, `status=${pub.status}`);
const cfg = pub.status === 200 ? pub.data : {};
const seg0 = cfg.segments?.[0];
A('video HLS url present', !!seg0?.hls_url, seg0?.hls_url);
const simSecs = (seg0?.simulations ?? []).filter((s) => s.type === 'simulation');
A('two sim sections present', simSecs.length === 2, `found ${simSecs.length}`);
A('sim sections carry simulation_url', simSecs.length === 2 && simSecs.every((s) => !!s.simulation_url),
  simSecs.map((s) => s.simulation_url).join(' | '));
A('sim sections carry poster_url', simSecs.length === 2 && simSecs.every((s) => !!s.poster_url),
  simSecs.map((s) => s.poster_url ?? 'NULL').join(' | '));
A('image section present (image_overlays)', (cfg.image_overlays ?? []).length >= 1,
  JSON.stringify(cfg.image_overlays?.[0] ?? null)?.slice(0, 160));
A('audio cutaway present (audio_cutaways)', (cfg.audio_cutaways ?? []).length >= 1,
  JSON.stringify(cfg.audio_cutaways?.[0] ?? null)?.slice(0, 160));
A('branching block present with a choice point', !!cfg.branching?.sequences?.[0]?.choice_point,
  `edges=${cfg.branching?.sequences?.[0]?.choice_point?.edges?.length}`);
const enabledEdges = cfg.branching?.sequences?.[0]?.choice_point?.edges?.filter((e) => !e.disabled) ?? [];
A('choice edges enabled (3 doors + replay)', enabledEdges.length === 4,
  (cfg.branching?.sequences?.[0]?.choice_point?.edges ?? []).map((e) => `${e.label}:${e.disabled ? `disabled(${e.disabled_reason})` : 'ok'}`).join(', '));

// permalink config route (public path of PermalinkEditor's backend)
if (T.demo.permalinkSlug) {
  const pc = await j('GET', `/api/v1/public/permalink/${T.demo.permalinkSlug}/config`, undefined, { noAuth: true });
  A('permalink /config responds 200', pc.status === 200, `GET /api/v1/public/permalink/${T.demo.permalinkSlug}/config -> ${pc.status}`);
}
// playlist public config
const plc = await j('GET', `/api/v1/playlist-share/${T.playlist.shareToken}`, undefined, { noAuth: true });
A('playlist share config has 4 items', plc.status === 200 && plc.data.items?.length === 4,
  `status=${plc.status} items=${plc.data.items?.length}`);

// nudge the thumbnail backfill for playlist cards (fire-and-forget on the API side)
await j('GET', '/api/v1/projects');

// D2 — the real viewer, headless Chrome, two frames into seeding/proof/
if (chromium && T.demo.shareUrl) {
  try {
    await captureViewerScreenshots(T.demo.shareUrl, D1);
    step('D2', 'Viewer screenshots captured', 'done', 'proof/viewer-1-teaser.png, proof/viewer-2-sim-section.png');
  } catch (e) {
    step('D2', 'Viewer screenshots', 'failed', e.message);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
T.finishedAt = new Date().toISOString();
const failedAsserts = T.verification.asserts.filter((a) => !a.ok);
const failedSteps = T.steps.filter((s) => s.status === 'failed');
saveT();
log('—'.repeat(60));
log(`TEMPLATE.json written: ${TEMPLATE_PATH}`);
log(`asserts: ${T.verification.asserts.length - failedAsserts.length}/${T.verification.asserts.length} green; steps failed: ${failedSteps.length}`);
for (const a of failedAsserts) log('  ASSERT FAILED:', a.name, '—', a.detail);
for (const s of failedSteps) log('  STEP FAILED:', s.id, '—', s.detail);
process.exit(failedAsserts.length || failedSteps.length ? 1 : 0);
