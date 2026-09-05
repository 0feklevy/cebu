// Build the WELCOME experience on the LOCAL stack, through the product's real APIs — v3,
// LAYOUT-DRIVEN. seeding/layout-v3.json is the spec: it names the projects (demo · tutorial as
// its OWN project · three niche films), the master film of each, and the MID-ROLL live windows
// — a sim section placed INSIDE the film at a narrative beat, presented over the still-playing
// video and auto-exited at its end. No post-roll stacks anywhere (owner: embed, don't capture).
//
// What this builds (the artifact the seeding service in DESIGN.md clones per user):
//   demo      film1  windows from layout.demo      + library extras (Galton, 5 Species) +
//                    image + sting in the LIBRARY only (no sections) + choice doors at the END
//                    + permalink /welcome-flow-video + podcast edition
//   tutorial  film2  windows from layout.tutorial  (public + share only, no doors)
//   heavy/powers/doors  film3/4/5 windows from layout.niche (public + share only)
//   playlist  demo, tutorial, heavy, powers, doors — 5 items in that order
//
// IDEMPOTENT-BY-RECREATION: every run deletes the previous run's projects/playlist (ids read
// from the TEMPLATE.json this script wrote last time) and creates fresh ones; all new ids are
// written to seeding/TEMPLATE.json as the run progresses, so a crash still leaves evidence.
// Re-run whenever the films in ../assembly/out or the layout change.
//
//   node build-template.mjs                 full build + verification
//   node build-template.mjs --verify-only   re-run ONLY the verification (public-config asserts +
//                                           headless mid-roll pass) against the run in TEMPLATE.json
//                                           — no LLM spend, no uploads.
//   node build-template.mjs --repair-only   for the run in TEMPLATE.json: gate every window's served
//                                           bridge body, repair the broken ones through a refinement
//                                           turn (LLM spend only for those), re-capture their posters,
//                                           then verify (with the runtime repair round).
//
// Never points anywhere but 127.0.0.1/localhost. LLM spend (This-moment generation) was
// authorized by the owner for this build.
//
// Route intel verified against backend-api/src/controllers/v1/* on 2026-09-05 — see `notes` in
// TEMPLATE.json for the discrepancies vs the original intel.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT  = dirname(HERE);                              // tutorial-kit/
const API  = 'http://127.0.0.1:8080';
const EMU  = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
// Playwright is resolved from a checkout that has it installed (client-web first, then the
// kinesin checkout the first builds used).
const PLAYWRIGHT_HOMES = [
  join(KIT, '..', 'client-web', 'package.json'),
  '/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json',
];
// The kinesin package (owner-approved for the LOCAL review build — see layout.kinesin_note).
const KINESIN_ZIP = '/private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/kinesin-upload.zip';

for (const base of [API, EMU]) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(base)) {
    console.error(`FATAL: non-local base URL refused: ${base}`);
    process.exit(1);
  }
}

const VERIFY_ONLY = process.argv.includes('--verify-only');
const REPAIR_ONLY = process.argv.includes('--repair-only');
// Template helper names the generation prompt promises but the wrappers never declare (see §2b).
const TEMPLATE_HELPERS = ['_hidden', '_hide', '_restoreAll', '_ivs', '_listeners', '_injected'];
const MAX_STATIC_REPAIRS = 2;
// The builder's refinement prompt is recognisable by this prefix — the row sync restores the
// owner's prompt ONLY over this text, never over a prompt someone else typed.
const FIX_PROMPT_PREFIX = 'Your previous body throws at runtime';
const isBuilderFixPrompt = (p) => typeof p === 'string' && p.startsWith(FIX_PROMPT_PREFIX);

// ── The spec ─────────────────────────────────────────────────────────────────
const LAYOUT_PATH = join(HERE, 'layout-v3.json');
const LAYOUT = JSON.parse(readFileSync(LAYOUT_PATH, 'utf8'));

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
  version: 3,
  builtAt: new Date().toISOString(),
  finishedAt: null,
  api: API,
  appUrl: null,               // learned from the first share response
  layoutFile: 'seeding/layout-v3.json',
  layoutComment: LAYOUT.comment ?? null,
  kinesin_note: LAYOUT.kinesin_note ?? null,
  steps: [],                  // [{id, title, status: done|skipped|failed|partial, detail}]
  previousRunCleanup: null,
  createdProjectIds: [],      // every project this run created, in order — the cleanup ledger
  demo: {},
  tutorial: {},
  niche: [],
  playlist: {},
  verification: { asserts: [], posters: [], midroll: [] },
  notes: [
    'POST /api/v1/projects validates via shared CreateProjectSchema (shared/src/types/project.ts:38): only {topic,...}; a "name" key is silently stripped — the project title is set with PATCH /api/v1/projects/:id {title} (projects.controller.ts:200).',
    'The podcast edition route is /api/v1/projects/:id/audio-edition (audioEdition.controller.ts:71,129), not .../audio; POST returns 202 and the same GET is the status poll.',
    'Sim-section posters are CLIENT-captured: POST /api/v1/projects/:id/sections/:sid/poster with PNG renditions of exactly POSTER_SIZES[aspect] (simulations.controller.ts:221, shared/src/sim/posterIdentity.ts:52) — this builder captures them with headless Chrome from the section\'s served sim URL.',
    'MID-ROLL sim sections (start_sec < host duration) are entered from the timeupdate tick when the playhead crosses start_sec, the video KEEPS PLAYING underneath the revealed frame (client-web/components/viewer/useProjectPlayer.ts:2119), and the section auto-exits through deactivateSim({exitToVideo:true}) when the playhead leaves [start_sec,end_sec) (useProjectPlayer.ts:1930-1944). Only a section with start_sec >= duration-0.05 is post-roll (pauses the video, shows Back-to-video) — this build creates none.',
    'A mid-roll frame is revealed only once the pool document has PAINTED (bounded hold SIM_PAINT_DEADLINE_MS=1200 then the stored poster covers while waiting) — so a window that opens a few seconds into a cold film races the package boot; the verification below records the measured first-visible time per window.',
    'Branching IS creatable headlessly (branch.controller.ts: sequences/choice-points/edges). The image + A2 sting live in the demo LIBRARY only (owner: keep the timeline clean) — no image/audio sections are created, so the branching viewer\'s flat-overlay limitation is moot for this build.',
    'Section rows are validated by timelineSectionViolations (shared/src/timeline/sectionShape.ts:260): 0 <= start_sec < end_sec <= MAX_TIMELINE_SEC; a main-track row is positioned by its host video + start_sec and carries no anchor. Nothing rejects a window that overruns the film, so this builder clamps end_sec <= duration-0.5 itself and refuses a window that starts past the film.',
    'SHARED STACK: the template projects can be edited from the editor while a build/repair runs (2026-09-05: demo/kinesin was refined twice from outside the builder, mid-repair). The row sync therefore restores ONLY the builder\'s own fix prompt; any other divergence from the layout is recorded on the window as `externalRefinement` and left live. A FULL re-run recreates every project (PREV_RUN cleanup) and would discard such edits — check `externalRefinement` in this file before re-running.',
    'BACKEND DEFECT (found by the v3 verification, 2026-09-05): the generation prompt (SimulationService.ts BRIDGE_GENERATION_SYSTEM_PROMPT, template + rule 25 "Use _hide()") promises a SCRIPTS.main prelude declaring _hidden/_hide/_restoreAll/_ivs/_listeners/_injected, but wrapBridgeMainBody and buildSectionEntry splice the LLM body in bare — nothing declares them. A body that relies on the prelude throws "ReferenceError: _hidden is not defined" on activation (SimRuntimeClient posts script-error) and the viewer plays the film through the whole window. 2 of 6 first-pass bodies did. Mitigation in this builder only: GATE-* checks the served bridge entry statically, repairs through a refinement turn of the real generate endpoint (an unchanged prompt is canReuse\'d — sections.controller.ts:1065), restores the owner\'s prompt on the row, re-captures the poster; the viewer pass records the runtime\'s own telemetry (?simdebug=1) per window. The fix belongs in the backend wrapper or prompt, not here.',
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
const uniq = (xs) => [...new Set(xs)];

/** Bounded-concurrency map that never rejects: every slot is a settled record. */
async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const k = next++;
      if (k >= items.length) return;
      try { out[k] = { status: 'fulfilled', value: await fn(items[k], k) }; }
      catch (e) { out[k] = { status: 'rejected', reason: e }; }
    }
  }));
  return out;
}

// ── Auth (emulator pattern from captures/stage-capture-prop.mjs) ─────────────
const cred = { email: 'kinesin-test@example.com', password: 'kinesin-test-pass-1', returnSecureToken: true };
const H = {};
async function signIn() {
  let sign = await (await fetch(`${EMU}/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cred),
  })).json();
  if (!sign.idToken) {
    sign = await (await fetch(`${EMU}/accounts:signInWithPassword?key=fake`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cred),
    })).json();
  }
  if (!sign.idToken) throw new Error(`emulator sign-in failed: ${JSON.stringify(sign).slice(0, 200)}`);
  H.authorization = `Bearer ${sign.idToken}`;
}
try { await signIn(); } catch (e) { console.error('FATAL:', e.message); process.exit(1); }
log('signed in as', cred.email);

// ── HTTP helpers ─────────────────────────────────────────────────────────────
const MAX_BUSY_RETRIES = 6;
async function j(method, path, body, opts = {}) {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        ...(opts.noAuth ? {} : H),
        ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    // An emulator token lives an hour; a long build (two 30 MB sim uploads + six generations) can
    // outlive it. One re-sign-in per call, then the real answer.
    if (res.status === 401 && !opts.noAuth && !refreshed) {
      log('  401 — refreshing the emulator token and retrying once');
      await res.text().catch(() => {});
      await signIn();
      refreshed = true;
      continue;
    }
    // Busy answers (503 from the API while a publication/transcode saturates the local process,
    // 429) are refused BEFORE the handler runs, so retrying is safe for every method. Bounded
    // exponential backoff, Retry-After honoured when present.
    if ((res.status === 503 || res.status === 429) && attempt < MAX_BUSY_RETRIES) {
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(30_000, ra * 1000) : Math.min(8000, 1000 * 2 ** attempt);
      log(`  ${res.status} on ${method} ${path} — retrying in ${wait}ms (${attempt + 1}/${MAX_BUSY_RETRIES})`);
      await res.text().catch(() => {});
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 400); }
    return { status: res.status, data };
  }
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
for (const home of PLAYWRIGHT_HOMES) {
  try { chromium = createRequire(home)('playwright').chromium; break; } catch { /* next */ }
}
if (!chromium) log('WARN: playwright unavailable from', PLAYWRIGHT_HOMES.join(' | '));

async function withBrowser(fn) {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--mute-audio'],
  });
  try { return await fn(browser); } finally { await browser.close(); }
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
const FILMS = { film1: filmPath(1), film2: filmPath(2), film3: filmPath(3), film4: filmPath(4), film5: filmPath(5) };
const LIBRARY = {
  wavesDiagram: join(PROPS, 'waves-diagram.png'),
  sting: join(KIT, 'music/sting-ambient.wav'),
};

// solar-system.zip normally sits in captures/props; if it is missing, zip sims/solar-system the
// way the first builds did (files at zip root), into a temp dir.
async function resolveSolarZip() {
  const prop = join(PROPS, 'solar-system.zip');
  if (existsSync(prop)) return prop;
  const dir = join(KIT, 'sims/solar-system');
  if (!existsSync(join(dir, 'index.html'))) return null;
  const tmp = await mkdtemp(join(tmpdir(), 'flowvid-solar-'));
  const out = join(tmp, 'solar-system.zip');
  const z = spawnSync('zip', ['-qr', out, '.', '-x', '.*'], { cwd: dir });
  if (z.status !== 0) throw new Error(`zipping sims/solar-system failed: ${z.stderr?.toString()}`);
  log('zipped sims/solar-system ->', out);
  return out;
}

/**
 * The sim catalogue the layout's `sim` keys resolve through. `settleMs` is how long the poster
 * capture lets the scene run before the screenshot (kinesin streams a 30 MB motor first);
 * `readyDeadlineMs` bounds the wait for the upload to reach status=ready.
 */
const SIMS = {
  kinesin:     { name: 'Kinesin / Dynein motors', zip: KINESIN_ZIP, settleMs: 15_000, readyDeadlineMs: 5 * 60_000 },
  solarSystem: { name: 'Solar System', zip: (VERIFY_ONLY || REPAIR_ONLY) ? null : await resolveSolarZip(), settleMs: 6000, readyDeadlineMs: 3 * 60_000 },
  murmuration: { name: 'Murmuration', zip: join(PROPS, 'murmuration.zip'), settleMs: 6000, readyDeadlineMs: 3 * 60_000 },
  orbitLab:    { name: 'Orbit Lab', zip: join(PROPS, 'orbit-lab.zip'), settleMs: 6000, readyDeadlineMs: 3 * 60_000 },
  galtonBoard: { name: 'Galton Board', zip: join(PROPS, 'galton-board.zip'), settleMs: 6000, readyDeadlineMs: 3 * 60_000 },
  fiveSpecies: { name: '5 Species Battle', zip: join(PROPS, 'five-species.zip'), settleMs: 6000, readyDeadlineMs: 3 * 60_000 },
};
const simAvailable = (key) => !!SIMS[key] && !!SIMS[key].zip && existsSync(SIMS[key].zip);

// ── Project specs, straight from the layout ──────────────────────────────────
const SPECS = [
  {
    kind: 'demo', key: 'demo', title: LAYOUT.demo.title, master: LAYOUT.demo.master,
    topic: 'Touch this video. Steer a flock, fly to a planet, scrub a molecular motor — live, inside the film.',
    windows: LAYOUT.demo.windows ?? [],
    extraSims: LAYOUT.library_extras ?? [],
    doors: !!LAYOUT.demo.choiceDoorsAtEnd,
    filename: 'welcome-to-flow-video.mp4',
  },
  {
    kind: 'tutorial', key: 'tutorial', title: LAYOUT.tutorial.title, master: LAYOUT.tutorial.master,
    topic: 'Make yours: upload footage, drop a simulation into the library, describe the moment, generate — the basics, with the result live in the film.',
    windows: LAYOUT.tutorial.windows ?? [],
    // The tutorial says "or one already in your Library" (F2 beat 3): the extras make that true
    // on camera in the creator's own project, not only in the demo.
    extraSims: LAYOUT.library_extras ?? [], doors: false, filename: 'make-yours-the-basics.mp4',
  },
  ...LAYOUT.niche.map((n) => ({
    kind: 'niche', key: n.key, title: n.title, master: `film${n.film}`, topic: n.topic,
    windows: n.windows ?? [], extraSims: [], doors: false, filename: `${n.key}.mp4`,
  })),
];
// WINDOWS FOLLOW THE CUT. Once a master film has been assembled, assembly/work/<film>/timeline.json
// carries its LIVE-WINDOW beats at their REAL (VO-derived) times; those replace the layout's requested
// [start,end] so the section opens on the beat the narration speaks, not on the script's estimate.
// The layout stays the fallback for a film that has not been assembled yet.
const cutWindowsFor = (master) => {
  const p = join(KIT, 'assembly/work', master, 'timeline.json');
  if (!existsSync(p)) return null;
  let t;
  try { t = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  if (!t.windows) return null;
  // THE TIMELINE MUST DESCRIBE THE FILM BEING UPLOADED. Nothing used to tie them together: an old
  // timeline next to a freshly re-cut film seeded window times belonging to a different edit, and
  // every assert downstream passed because they all read the same stale numbers. A film with no
  // timeline is a legitimate state (never assembled) and falls back to the layout; a timeline that
  // disagrees with the bytes is not.
  const filmFile = FILMS[master]?.path;
  if (!filmFile || !t.sha256) return t.windows;
  const sha = createHash('sha256').update(readFileSync(filmFile)).digest('hex');
  if (sha !== t.sha256) {
    console.error(`FATAL: ${master}: ${basename(filmFile)} does not match assembly/work/${master}/timeline.json ` +
      `(film ${sha.slice(0, 12)} vs timeline ${String(t.sha256).slice(0, 12)}). Re-run assembly/assemble-film.mjs ` +
      `${master.replace('film', '')} so the seeded window times belong to the cut being uploaded.`);
    process.exit(1);
  }
  return t.windows;
};
for (const spec of SPECS) {
  const cut = cutWindowsFor(spec.master);
  if (!cut) continue;
  spec.windows = spec.windows.map((w) => {
    const c = cut.find((x) => x.sim === w.sim);
    return c ? { ...w, window: [c.start, c.end], layoutWindow: w.window, fromCut: true } : w;
  });
}
if (LAYOUT.tutorial?.ownProject === false) {
  console.error('FATAL: layout.tutorial.ownProject=false is not supported by v3 (the tutorial is its own project)');
  process.exit(1);
}

// ── Verification (shared by the full build and --verify-only) ────────────────
const A = (name, ok, detail) => {
  T.verification.asserts.push({ name, ok: !!ok, detail: detail ?? null });
  log(ok ? '  ✓' : '  ✗', name, detail ? `— ${detail}` : '');
  saveT();
  return !!ok;
};
const allProjects = () => [T.demo, T.tutorial, ...(T.niche ?? [])].filter((p) => p && p.projectId);
const placedWindows = (rec) => (rec.windows ?? []).filter((w) => w.sectionId);

/** D1 — layout-derived asserts against every project's PUBLIC player config. */
async function verifyConfigs() {
  for (const rec of allProjects()) {
    const pub = rec.shareToken ? await j('GET', `/api/v1/share/${rec.shareToken}`, undefined, { noAuth: true }) : { status: 0, data: {} };
    A(`${rec.key}: public share config responds 200`, pub.status === 200, `status=${pub.status}${rec.shareToken ? '' : ' (no share token)'}`);
    const cfg = pub.status === 200 ? pub.data : {};
    const seg0 = cfg.segments?.[0];
    if (rec.video) {
      A(`${rec.key}: video HLS url present`, !!seg0?.hls_url, seg0?.hls_url ?? 'none');
      const dur = seg0?.duration_sec ?? rec.video.duration_sec;
      const simSecs = (seg0?.simulations ?? []).filter((s) => s.type === 'simulation');
      A(`${rec.key}: no post-roll sim sections (all start before the film ends)`,
        simSecs.every((s) => s.start_sec < dur - 0.05),
        simSecs.map((s) => `${s.label ?? s.id}[${s.start_sec}-${s.end_sec}]`).join(', ') || 'no sim sections');
      A(`${rec.key}: sim section count matches the layout's placed windows`,
        simSecs.length === placedWindows(rec).length, `config=${simSecs.length} layout=${placedWindows(rec).length}`);
      for (const w of placedWindows(rec)) {
        const s = simSecs.find((x) => x.id === w.sectionId);
        A(`${rec.key} · ${w.sim} [${w.start_sec}-${w.end_sec}]: section present in public config`, !!s, s ? `${s.id} [${s.start_sec}-${s.end_sec}]` : `section ${w.sectionId} missing`);
        A(`${rec.key} · ${w.sim}: window matches [${w.start_sec}-${w.end_sec}]`,
          !!s && Math.abs(s.start_sec - w.start_sec) < 0.01 && Math.abs(s.end_sec - w.end_sec) < 0.01,
          s ? `[${s.start_sec}-${s.end_sec}]` : 'n/a');
        A(`${rec.key} · ${w.sim}: simulation_url present (generated)`, !!s?.simulation_url, s?.simulation_url ?? 'NULL');
        A(`${rec.key} · ${w.sim}: poster_url stored`, !!s?.poster_url, s?.poster_url ?? 'NULL');
        // A section marked simple_ui with an empty hide list hides nothing — the flag alone is not
        // Minimal UI, and the viewer sees the package's full authoring panel. Assert the list the
        // player is actually handed, not the intention.
        const layoutHide = (spec.windows.find((x) => x.sim === w.sim)?.uiHide) ?? [];
        if (layoutHide.length) {
          A(`${rec.key} · ${w.sim}: Simple UI has a hide list to act on`,
            Array.isArray(s?.ui_hide) && s.ui_hide.length === layoutHide.length,
            `ui_hide=${JSON.stringify(s?.ui_hide ?? null)} (layout asks for ${layoutHide.length})`);
        }
      }
    }
    if (rec.kind === 'demo') {
      A('demo: branching block present with a choice point', !!cfg.branching?.sequences?.[0]?.choice_point,
        `edges=${cfg.branching?.sequences?.[0]?.choice_point?.edges?.length}`);
      const edges = cfg.branching?.sequences?.[0]?.choice_point?.edges ?? [];
      const enabled = edges.filter((e) => !e.disabled);
      A('demo: exactly three choice doors enabled, no replay card', enabled.length === 3 && !edges.some((e) => e.destination_type === 'restart'),
        edges.map((e) => `${e.label}:${e.disabled ? `disabled(${e.disabled_reason})` : 'ok'}`).join(', '));
      // The PUBLIC config does not carry destination project ids — deliberately, since a share page
      // must not leak the ids of projects the viewer has no link to. What it exposes is the label
      // and the order, which is exactly what the viewer reads, so that is what is asserted here.
      // (The id-level wiring is asserted against the authoring API in T.demo.branching.edges below.)
      const doorOrder = [...edges].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      const labels = doorOrder.map((e) => e.label);
      A('demo: the first door a viewer sees is "Make yours"', labels[0] === 'Make yours', labels.join(' | '));
      A('demo: the other two doors are Viewer Superpowers and Drop In Anything',
        ['Viewer Superpowers', 'Drop In Anything'].every((l) => labels.includes(l)), labels.join(' | '));
      const authored = T.demo.branching?.edges ?? [];
      A('demo: "Make yours" is wired to the tutorial project (authoring API)',
        authored.find((e) => e.label === 'Make yours')?.dest_project_id === T.tutorial?.projectId,
        authored.map((e) => `${e.label}->${String(e.dest_project_id ?? e.destination_type).slice(0, 8)}`).join(', '));
      if (T.demo.permalinkSlug) {
        const pc = await j('GET', `/api/v1/public/permalink/${T.demo.permalinkSlug}/config`, undefined, { noAuth: true });
        A(`demo: permalink /${T.demo.permalinkSlug} config responds 200`, pc.status === 200, `-> ${pc.status}`);
      }
    }
  }
  if (T.playlist?.shareToken) {
    const plc = await j('GET', `/api/v1/playlist-share/${T.playlist.shareToken}`, undefined, { noAuth: true });
    const want = allProjects().map((p) => p.projectId);
    const got = (plc.data?.items ?? []).map((i) => i.project_id);
    A('playlist: share config has 5 items', plc.status === 200 && got.length === 5, `status=${plc.status} items=${got.length}`);
    A('playlist: order is demo, tutorial, heavy, powers, doors', JSON.stringify(got) === JSON.stringify(want),
      got.map((id) => allProjects().find((p) => p.projectId === id)?.key ?? id).join(' > '));
  } else {
    A('playlist: share config has 5 items', false, 'no playlist share token recorded');
  }
}

/**
 * D2 — the REAL public viewer, headless Chrome. For every window of a project: seek the primary
 * video to start-1, play, sample at +4s (the owner's criterion: exactly one sim iframe at
 * opacity 1 while the video keeps playing), keep sampling until the frame is visible so the
 * first-visible latency is recorded, then wait past end_sec and assert every iframe is hidden.
 *
 * The share URL is used AS ISSUED (localhost) — dev CORS allows only http://localhost:3000
 * (backend-api/src/config/publicOrigins.ts browserOrigins()), so rewriting the host to
 * 127.0.0.1 makes every API fetch fail from the page ("Failed to fetch").
 */
const PROBE = () => {
  // The primary video: the VideoLayer pair sits under the "Play or pause video" surface; the
  // one on top (zIndex 2, swapped imperatively on segment change) is the active element.
  const surface = document.querySelector('[aria-label="Play or pause video"]');
  const vids = [...(surface ?? document).querySelectorAll('video')];
  vids.sort((a, b) => (parseInt(getComputedStyle(b).zIndex, 10) || 0) - (parseInt(getComputedStyle(a).zIndex, 10) || 0));
  const v = vids[0] ?? document.querySelector('video');
  // Effective opacity: the element's own computed opacity times every ancestor's — the pool
  // hides frames on the iframe (inline) AND on `.sim-overlay` (class), both must read 1.
  const eff = (el) => {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      o *= parseFloat(cs.opacity || '1');
    }
    return o;
  };
  const iframes = [...document.querySelectorAll('iframe')];
  const rows = iframes.map((f) => ({
    own: parseFloat(getComputedStyle(f).opacity || '1'),
    effective: +eff(f).toFixed(3),
    w: Math.round(f.getBoundingClientRect().width),
    src: (f.getAttribute('src') ?? '').slice(0, 140),
  }));
  const visible = rows.filter((r) => r.own === 1 && r.effective >= 0.99 && r.w > 50);
  return {
    videoTime: v ? +v.currentTime.toFixed(2) : null,
    paused: v ? v.paused : null,
    ended: v ? v.ended : null,
    readyState: v ? v.readyState : null,
    totalIframes: iframes.length,
    visibleIframes: visible.length,
    visibleSrcs: visible.map((r) => r.src),
    iframes: rows,
  };
};

async function verifyMidroll(browser, rec) {
  const windows = placedWindows(rec);
  if (!windows.length || !rec.shareUrl) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));
  try {
    // ?simdebug=1 turns on the viewer's own sim-lifecycle telemetry (client-web/lib/simTelemetry.ts):
    // activate / apply-hold / script-error / reveal / hold / stall per window — the evidence that
    // separates "the window never opened" from "it opened and the script threw".
    await page.goto(rec.shareUrl + (rec.shareUrl.includes('?') ? '&' : '?') + 'simdebug=1', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4000);
    const play = page.locator('[aria-label="Play video"]');
    if (await play.count()) await play.first().click({ timeout: 5000 }).catch(() => {});
    else await page.mouse.click(640, 400);
    await page.waitForTimeout(2500);               // the film is playing; the pool arms + boots

    for (const w of windows) {
      const tag = rec.kind === 'demo' ? w.sim : `${rec.key}-${w.sim}`;
      const seekTo = Math.max(0, w.start_sec - 1);
      const row = { project: rec.key, sim: w.sim, sectionId: w.sectionId, window: [w.start_sec, w.end_sec], seekTo, sampleAt4s: null, firstVisible: null, afterEnd: null, scriptError: null, telemetry: null, proof: null, proofExit: null, pageErrors: null };
      const teleFrom = await page.evaluate(() => window.__SIM_TELEMETRY__?.events.length ?? 0);
      await page.evaluate((t) => {
        const surface = document.querySelector('[aria-label="Play or pause video"]');
        const vids = [...(surface ?? document).querySelectorAll('video')];
        vids.sort((a, b) => (parseInt(getComputedStyle(b).zIndex, 10) || 0) - (parseInt(getComputedStyle(a).zIndex, 10) || 0));
        const v = vids[0] ?? document.querySelector('video');
        if (v) { v.currentTime = t; v.play?.(); }
      }, seekTo);
      await page.waitForTimeout(4000);
      const at4 = await page.evaluate(PROBE);
      row.sampleAt4s = at4;
      // Keep sampling until the frame is up (or the window is nearly over) so the latency is known.
      let first = at4.visibleIframes >= 1 ? at4 : null;
      const giveUpAt = Date.now() + Math.max(2000, (w.end_sec - seekTo - 4) * 1000 + 1500);
      while (!first && Date.now() < giveUpAt) {
        await page.waitForTimeout(250);
        const p = await page.evaluate(PROBE);
        if (p.visibleIframes >= 1) first = p;
        else if (p.videoTime !== null && p.videoTime >= w.end_sec - 0.5) break;
      }
      row.firstVisible = first;
      const proof = join(PROOF_DIR, `midroll-${tag}.png`);
      await page.screenshot({ path: proof });
      row.proof = `proof/midroll-${tag}.png`;
      const okAt4 = at4.visibleIframes === 1 && at4.paused === false && at4.ended === false
        && at4.videoTime !== null && at4.videoTime >= w.start_sec && at4.videoTime < w.end_sec;
      A(`${rec.key} · ${w.sim} [${w.start_sec}-${w.end_sec}]: presented MID-ROLL at +4s (exactly one sim iframe at opacity 1, video playing)`, okAt4,
        `t=${at4.videoTime}s paused=${at4.paused} visibleIframes=${at4.visibleIframes}/${at4.totalIframes}` +
        (first && !okAt4 ? ` — first visible at t=${first.videoTime}s (${first.visibleIframes} iframe)` : '') +
        (!first ? ' — never presented inside the window' : ''));
      // Auto-exit: wait until the playhead is past end_sec (+ the 200 ms fade), then everything hidden.
      const exitDeadline = Date.now() + Math.max(3000, (w.end_sec - (first?.videoTime ?? at4.videoTime ?? seekTo) + 6) * 1000);
      let after = null;
      while (Date.now() < exitDeadline) {
        const p = await page.evaluate(PROBE);
        if (p.videoTime !== null && p.videoTime >= w.end_sec + 1.0) { after = p; break; }
        if (p.ended) { after = p; break; }
        await page.waitForTimeout(250);
      }
      if (!after) after = await page.evaluate(PROBE);
      await page.waitForTimeout(600);                 // let the 200 ms fade settle
      after = await page.evaluate(PROBE);
      row.afterEnd = after;
      const proofExit = join(PROOF_DIR, `midroll-${tag}-exit.png`);
      await page.screenshot({ path: proofExit });
      row.proofExit = `proof/midroll-${tag}-exit.png`;
      A(`${rec.key} · ${w.sim}: auto-exit past ${w.end_sec}s (all sim iframes at opacity 0, video still playing)`,
        after.visibleIframes === 0 && after.paused === false && after.videoTime !== null && after.videoTime >= w.end_sec,
        `t=${after.videoTime}s paused=${after.paused} visibleIframes=${after.visibleIframes}/${after.totalIframes}`);
      // The viewer's own account of the window: everything the runtime recorded since the seek.
      const events = await page.evaluate((from) => (window.__SIM_TELEMETRY__?.events ?? []).slice(from), teleFrom);
      row.telemetry = events
        .filter((e) => !/^(pool-init|frame-register|frame-load|frame-load-routed|pool-armed|warm-|boundary-)/.test(e.event))
        .slice(0, 80)
        .map(({ t, event, key, ...rest }) => ({ t, event, ...rest }));
      const bad = events.find((e) => e.event === 'script-error' || e.event === 'script-missing');
      row.scriptError = bad ? `${bad.event}: ${bad.message ?? bad.script ?? ''}` : null;
      A(`${rec.key} · ${w.sim}: no script-error/script-missing reported by the sim runtime`, !bad,
        bad ? row.scriptError : `${events.length} telemetry events, activate=${events.some((e) => e.event === 'activate')} reveal=${events.some((e) => e.event === 'reveal')}`);
      row.pageErrors = pageErrors.splice(0);
      T.verification.midroll.push(row);
      saveT();
    }
  } finally {
    await ctx.close();
  }
}

async function runVerification() {
  T.verification.asserts = [];
  T.verification.midroll = [];
  await verifyConfigs();
  // nudge the thumbnail backfill for playlist cards (fire-and-forget on the API side)
  await j('GET', '/api/v1/projects');
  if (!chromium) { step('D2', 'Mid-roll viewer verification', 'failed', 'playwright not resolvable'); return; }
  try {
    await withBrowser(async (browser) => {
      for (const rec of allProjects()) await verifyMidroll(browser, rec);
    });
    const rows = T.verification.midroll;
    const bad = rows.filter((r) => !(r.sampleAt4s?.visibleIframes === 1 && r.afterEnd?.visibleIframes === 0));
    step('D2', `Mid-roll viewer verification (${rows.length} windows across ${allProjects().filter((p) => placedWindows(p).length).length} projects)`,
      bad.length ? 'partial' : 'done',
      rows.map((r) => `${r.project}/${r.sim}: +4s=${r.sampleAt4s?.visibleIframes ?? '?'}vis@${r.sampleAt4s?.videoTime}s first@${r.firstVisible?.videoTime ?? 'never'}s exit=${r.afterEnd?.visibleIframes ?? '?'}vis@${r.afterEnd?.videoTime}s → ${r.proof}`).join('; '));
  } catch (e) {
    step('D2', 'Mid-roll viewer verification', 'failed', e.message);
  }
}

function finish() {
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
}

// ── --verify-only: re-run the verification for the run in TEMPLATE.json ─────
if (VERIFY_ONLY) {
  if (!PREV_RUN?.demo?.projectId) { console.error('FATAL: TEMPLATE.json has no run to verify — run a full build first'); process.exit(1); }
  const keep = { steps: T.steps, notes: T.notes };
  Object.assign(T, PREV_RUN, { notes: keep.notes, kinesin_note: LAYOUT.kinesin_note ?? PREV_RUN.kinesin_note ?? null });
  T.verifiedAt = new Date().toISOString();
  await runVerification();
  finish();
}

// ── --repair-only: gate + refinement repairs + posters + verification for the run in TEMPLATE.json ──
if (REPAIR_ONLY) {
  if (!PREV_RUN?.demo?.projectId) { console.error('FATAL: TEMPLATE.json has no run to repair — run a full build first'); process.exit(1); }
  if (!chromium) { console.error('FATAL: playwright unavailable'); process.exit(1); }
  const keep = { notes: T.notes };
  Object.assign(T, PREV_RUN, { notes: keep.notes, kinesin_note: LAYOUT.kinesin_note ?? PREV_RUN.kinesin_note ?? null });
  T.repairedAt = new Date().toISOString();
  const jobs = allProjects().flatMap((rec) => placedWindows(rec).filter((w) => w.generated).map((w) => ({ rec, w })));
  await runGate(jobs);
  const needPoster = jobs.filter(({ w }) => !w.poster);
  if (needPoster.length) {
    await withBrowser(async (browser) => {
      for (const { rec, w } of needPoster) {
        const id = `POSTER-${rec.key}-${w.sim}`;
        try { const p = await capturePoster(browser, rec, w); step(id, `Poster captured+stored (${rec.key} · ${w.sim}, after repair)`, 'done', p.outcome); }
        catch (e) { step(id, `Poster (${rec.key} · ${w.sim}, after repair)`, 'failed', e.message); }
      }
    });
  }
  await runVerification();
  await runtimeRepairRound();
  finish();
}

// ── Preflight ────────────────────────────────────────────────────────────────
{
  const h = await j('GET', '/health', undefined, { noAuth: true });
  if (h.status >= 500) { console.error('FATAL: API /health failed', h); process.exit(1); }
  for (const p of [LIBRARY.wavesDiagram, LIBRARY.sting]) {
    if (!existsSync(p)) { console.error(`FATAL: required asset missing: ${p}`); process.exit(1); }
  }
  if (!FILMS.film1) { console.error('FATAL: no film1(.SCRATCH).mp4 in assembly/out — nothing to build the demo on'); process.exit(1); }
  const neededSims = uniq(SPECS.flatMap((s) => [...s.windows.map((w) => w.sim), ...s.extraSims]));
  const missingSims = neededSims.filter((k) => !simAvailable(k));
  step('preflight', 'API + emulator reachable, layout read, assets present', missingSims.length ? 'partial' : 'done',
    `layout=${basename(LAYOUT_PATH)} projects=${SPECS.map((s) => `${s.key}(${s.master}=${FILMS[s.master]?.source ?? 'MISSING'},${s.windows.length}w)`).join(' ')}; ` +
    `sims=${neededSims.map((k) => `${k}:${simAvailable(k) ? 'ok' : 'MISSING'}`).join(',')}`);
}

// ── 0. Recreate: delete the previous run's rows ──────────────────────────────
{
  const prev = PREV_RUN;
  const cleaned = { playlists: [], projects: [], failures: [] };
  if (prev) {
    if (prev.playlist?.id) {
      const r = await j('DELETE', `/api/v1/playlists/${prev.playlist.id}`);
      (r.status < 400 || r.status === 404 ? cleaned.playlists : cleaned.failures).push(prev.playlist.id);
    }
    // Every project the previous run created: the named records AND the creation ledger (a run
    // that crashed before attaching a record still wrote its id to createdProjectIds).
    const ids = uniq([
      prev.demo?.projectId, prev.tutorial?.projectId,
      ...(prev.niche ?? []).map((n) => n.projectId),
      ...(prev.createdProjectIds ?? []),
    ].filter(Boolean));
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
  T.createdProjectIds.push(id); saveT();
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
/** Upload one catalogue sim into a project's library and wait for status=ready. */
async function uploadSim(projectId, key) {
  const cat = SIMS[key];
  if (!cat) throw new Error(`layout names unknown sim "${key}" — add it to the SIMS catalogue`);
  if (!simAvailable(key)) return { key, missing: true, zip: cat.zip };
  const t0 = Date.now();
  const row = await jOk('POST', `/api/v1/projects/${projectId}/simulations/upload`,
    fd({ name: cat.name }, cat.zip, basename(cat.zip), 'application/zip'), `upload sim ${cat.name}`);
  const ready = await poll(`sim ${cat.name} ready`, async () => {
    const r = await j('GET', `/api/v1/projects/${projectId}/simulations`);
    if (r.status >= 400) throw new Error(`list sims -> ${r.status}`);
    const s = (Array.isArray(r.data) ? r.data : []).find((x) => x.id === row.id);
    if (!s) return undefined;
    if (s.status === 'ready') return s;
    if (s.status === 'failed') throw new Error(`sim ${cat.name} processing failed: ${s.error}`);
    return undefined;
  }, { every: 2000, deadlineMs: cat.readyDeadlineMs });
  return { key, id: row.id, name: cat.name, entry_file: ready.entry_file, ready_after_ms: Date.now() - t0 };
}
async function publishProject(rec) {
  await jOk('PATCH', `/api/v1/projects/${rec.projectId}`, { visibility: 'public' }, `${rec.title} public`);
  const share = await jOk('POST', `/api/v1/projects/${rec.projectId}/share`, undefined, `${rec.title} share`);
  rec.shareToken = share.shareToken; rec.shareUrl = share.shareUrl;
  if (!T.appUrl && share.shareUrl) T.appUrl = new URL(share.shareUrl).origin;
  saveT();
}

/** Fit a layout window to the master film: clamp end <= duration-0.5, refuse one that starts past it. */
function fitWindow(w, duration) {
  const [s0, e0] = w.window;
  const maxEnd = +(duration - 0.5).toFixed(2);
  const warnings = [];
  if (s0 >= maxEnd - 1) {
    return { ok: false, reason: `window [${s0},${e0}] does not fit: film is ${duration}s (usable end ${maxEnd}s) — the layout needs a longer film or an earlier beat` };
  }
  let end = e0;
  if (end > maxEnd) { end = maxEnd; warnings.push(`end clamped ${e0}->${end} (film ${duration}s)`); }
  if (end - s0 < 1) return { ok: false, reason: `window [${s0},${e0}] collapses to <1s after clamping to the ${duration}s film` };
  return { ok: true, start: s0, end, warnings, clamped: end !== e0 };
}

/** Build one project from its spec: create · master film · sims · MID-ROLL window sections · publish. */
async function buildProject(rec, spec) {
  rec.projectId = await createProject(spec.title, spec.topic);
  saveT();
  step(`P-${spec.key}-create`, `${spec.title}: project created`, 'done', rec.projectId);

  const film = FILMS[spec.master];
  const simKeys = uniq([...spec.windows.map((w) => w.sim), ...spec.extraSims]);
  const videoP = (async () => {
    if (!film) return null;
    const vid = await uploadVideo(rec.projectId, film.path, spec.filename);
    log(`${spec.key}: ${film.source} uploaded (${vid}) — waiting for HLS`);
    const hls = await waitHls(rec.projectId, vid, `${spec.key} ${film.source}`);
    if (!(typeof hls.duration_sec === 'number' && hls.duration_sec > 0)) throw new Error(`${spec.key}: duration unknown after transcode: ${JSON.stringify(hls)}`);
    return { id: vid, source: film.source, hls_url: hls.hls_url, duration_sec: hls.duration_sec };
  })();
  const simsP = mapWithLimit(simKeys, 2, (k) => uploadSim(rec.projectId, k));
  const [videoRes, simsRes] = await Promise.allSettled([videoP, simsP]);

  // master video
  if (videoRes.status === 'rejected') {
    rec.video = null; rec.videoError = String(videoRes.reason?.message ?? videoRes.reason);
    step(`P-${spec.key}-video`, `${spec.title}: master ${spec.master}`, 'failed', rec.videoError);
  } else if (!videoRes.value) {
    rec.video = null;
    step(`P-${spec.key}-video`, `${spec.title}: master ${spec.master}`, 'partial',
      `${spec.master}(.SCRATCH).mp4 MISSING in assembly/out — project created without a video; re-run adds it and its windows`);
  } else {
    rec.video = videoRes.value;
    step(`P-${spec.key}-video`, `${spec.title}: master ${spec.master} uploaded, HLS ready`, 'done',
      `${rec.video.source} · ${rec.video.duration_sec}s · ${rec.video.hls_url ? 'hls ok' : 'NO HLS URL'}`);
  }

  // sims (only the ones this project's windows/extras need)
  const simDetail = [];
  let simsStatus = 'done';
  (simsRes.value ?? []).forEach((res, i) => {
    const k = simKeys[i];
    if (res.status === 'rejected') { rec.simErrors = { ...(rec.simErrors ?? {}), [k]: String(res.reason?.message ?? res.reason) }; simDetail.push(`${k}: FAILED ${rec.simErrors[k].slice(0, 120)}`); simsStatus = 'failed'; return; }
    if (res.value.missing) { simDetail.push(`${k}: MISSING ${res.value.zip}`); if (simsStatus !== 'failed') simsStatus = 'partial'; return; }
    rec.sims[k] = res.value;
    simDetail.push(`${k}=${res.value.id} (${Math.round(res.value.ready_after_ms / 1000)}s)`);
  });
  if (simKeys.length) step(`P-${spec.key}-sims`, `${spec.title}: ${simKeys.length} sim(s) in the library`, simsStatus, simDetail.join('; '));
  saveT();

  // MID-ROLL windows — inside the film, clamped to it
  rec.windows = [];
  const wDetail = [];
  let wStatus = 'done';
  const sorted = [...spec.windows].sort((a, b) => a.window[0] - b.window[0]);
  for (const [i, w] of sorted.entries()) {
    const row = { sim: w.sim, label: w.label, prompt: w.prompt, simpleUI: w.simpleUI !== false, requested: w.window, start_sec: null, end_sec: null, clamped: false, warnings: [], sectionId: null, simulation_id: null, generated: null };
    rec.windows.push(row);
    if (!rec.video) { row.skipped = 'no master video'; wDetail.push(`${w.sim}[${w.window}]: no master video`); if (wStatus === 'done') wStatus = 'partial'; continue; }
    if (!rec.sims[w.sim]) { row.skipped = `sim ${w.sim} not in library`; wDetail.push(`${w.sim}[${w.window}]: sim unavailable`); if (wStatus === 'done') wStatus = 'partial'; continue; }
    const fit = fitWindow(w, rec.video.duration_sec);
    if (!fit.ok) { row.skipped = fit.reason; wDetail.push(`${w.sim}: ${fit.reason}`); wStatus = 'failed'; log('  WARN', spec.key, fit.reason); continue; }
    const prev = sorted[i - 1];
    if (prev && fit.start < prev.window[1]) { fit.warnings.push(`overlaps the previous window [${prev.window}] — the viewer presents the earlier section`); }
    for (const msg of fit.warnings) log('  WARN', spec.key, w.sim, msg);
    row.warnings = fit.warnings; row.clamped = fit.clamped;
    try {
      const sec = await jOk('POST', `/api/v1/projects/${rec.projectId}/sections`, {
        video_file_id: rec.video.id, track: 'main', type: 'simulation',
        start_sec: fit.start, end_sec: fit.end, sort_order: (i + 1) * 10,
        simulation_id: rec.sims[w.sim].id, label: w.label,
        simple_ui: row.simpleUI, auto_script: true,
        // THE HIDE LIST IS WHAT SIMPLE UI ACTUALLY ACTS ON. `simple_ui: true` with no selectors
        // cloaks nothing: the player only builds its `__simHideUi` style from `ui_hide`, which
        // buildPlayerConfig reads out of `sim_meta.uiControls.hide`. Seeding used to set the flag
        // and the prompt and leave the list empty, so a viewer opening the demo's kinesin window
        // got the package's whole authoring panel — "ASSET PROOF" heading, motor picker, teaching
        // playback — on a section whose prompt asks for the cycle slider and Pause.
        ...(w.uiHide?.length ? { sim_meta: { uiControls: { hide: w.uiHide } } } : {}),
      }, `${spec.key}: create window section ${w.label}`);
      row.sectionId = sec.id; row.simulation_id = rec.sims[w.sim].id;
      row.start_sec = sec.start_sec; row.end_sec = sec.end_sec;
      wDetail.push(`${w.sim} "${w.label}" [${sec.start_sec}-${sec.end_sec}] ${sec.id}${fit.clamped ? ' CLAMPED' : ''}`);
    } catch (e) {
      row.error = e.message; wDetail.push(`${w.sim}: ${e.message}`); wStatus = 'failed';
    }
    saveT();
  }
  if (spec.windows.length) {
    step(`P-${spec.key}-windows`, `${spec.title}: ${spec.windows.length} MID-ROLL window(s) on ${spec.master}${rec.video ? ` (${rec.video.duration_sec}s)` : ''}`, wStatus, wDetail.join('; '));
  } else {
    step(`P-${spec.key}-windows`, `${spec.title}: no windows in the layout (film only)`, 'done', 'timeline is clean by design');
  }

  await publishProject(rec);
  step(`P-${spec.key}-publish`, `${spec.title}: public + share link`, 'done', rec.shareUrl);
}

// ── 1. Projects, in playlist order ───────────────────────────────────────────
for (const spec of SPECS) {
  const rec = { kind: spec.kind, key: spec.key, title: spec.title, topic: spec.topic, master: spec.master, projectId: null, video: null, sims: {}, windows: [], shareToken: null, shareUrl: null };
  if (spec.kind === 'demo') T.demo = rec;
  else if (spec.kind === 'tutorial') T.tutorial = rec;
  else T.niche.push(rec);
  saveT();
  try {
    await buildProject(rec, spec);
  } catch (e) {
    rec.buildError = e.message;
    step(`P-${spec.key}-build`, `${spec.title}: build`, 'failed', e.message);
  }
}

// ── 2. This-moment generation for every window (real ✦ SSE endpoint) ─────────
async function generateSection(projectId, sectionId, prompt, simpleUi, what) {
  const ac = new AbortController();
  const cap = setTimeout(() => ac.abort(), 17 * 60_000);
  try {
    const res = await fetch(`${API}/api/v1/projects/${projectId}/sections/${sectionId}/generate-sim-script/stream`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ prompt, simple_ui: simpleUi, auto_script: true }),
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
async function generateWithRetry(projectId, sectionId, prompt, simpleUi, what) {
  try { return await generateSection(projectId, sectionId, prompt, simpleUi, what); }
  catch (e) {
    log(`  [gen ${what}] first attempt failed: ${e.message} — retrying once in 20s`);
    await sleep(20_000);
    return generateSection(projectId, sectionId, prompt, simpleUi, what);
  }
}

const genJobs = [];
for (const rec of allProjects()) for (const w of placedWindows(rec)) genJobs.push({ rec, w });
log(`This-moment generation starting for ${genJobs.length} window(s) (LLM; minutes per section; 4 in flight)…`);
const genRes = await mapWithLimit(genJobs, 4, ({ rec, w }) =>
  generateWithRetry(rec.projectId, w.sectionId, w.prompt, w.simpleUI, `${rec.key}/${w.sim}`));
genRes.forEach((res, i) => {
  const { rec, w } = genJobs[i];
  const id = `G-${rec.key}-${w.sim}`;
  if (res.status === 'fulfilled') {
    const s = res.value;
    const ownUrl = !!s.simulation_url?.includes(`section=${w.sectionId}`);
    w.simulation_url = s.simulation_url; w.generated = true; w.url_carries_section_param = ownUrl;
    step(id, `This-moment generated (${rec.key} · ${w.sim} "${w.label}")`, ownUrl ? 'done' : 'partial',
      ownUrl ? s.simulation_url : `simulation_url does not carry section=${w.sectionId}: ${s.simulation_url}`);
  } else {
    w.generated = false; w.generation_error = String(res.reason?.message ?? res.reason);
    step(id, `This-moment generated (${rec.key} · ${w.sim} "${w.label}")`, 'failed', w.generation_error);
  }
});
saveT();

function absolutize(u) {
  if (!u) return null;
  if (/^https?:\/\//.test(u)) return u;
  return API + (u.startsWith('/') ? u : `/${u}`);
}

// ── 2b. Runtime-contract GATE on the served bridge + bounded refinement repair ──
// The generation prompt (SimulationService.ts BRIDGE_GENERATION_SYSTEM_PROMPT) shows the model a
// SCRIPTS.main prelude — `_hidden`, `_hide()`, `_restoreAll()`, `_ivs`, `_listeners`, `_injected`
// — and rule 25 tells it to use `_hide()`. But both real wrappers (wrapBridgeMainBody,
// buildSectionEntry) splice the body in BARE: nothing declares those helpers. A body that trusts
// the prelude throws `ReferenceError: _hidden is not defined` on its first activation, the
// runtime posts script-error, and the viewer plays the film through the whole window (2 of 6
// windows in the first v3 run). Until the backend fixes the contract, the builder detects the
// defect statically from the served bridge.js and repairs it the way a user would: a refinement
// turn through the same generate endpoint (a changed prompt is what makes it regenerate — an
// identical prompt is `canReuse`d), then the owner's prompt is restored on the section row.
async function fetchServedEntry(w) {
  const indexUrl = absolutize(w.simulation_url);
  const html = await (await fetch(indexUrl)).text();
  const m = html.match(/<script[^>]+src="([^"]*bridge[^"]*)"/i);
  if (!m) return { error: 'served index has no bridge <script>' };
  const base = indexUrl.split('?')[0].replace(/index\.html$/, '');
  const src = m[1].replace(/^\.\//, '');
  const bridge = await (await fetch(/^https?:/.test(src) ? src : base + src)).text();
  const open = `/* @@SIM_BRIDGE:${w.sectionId}@@ */`, close = `/* @@/SIM_BRIDGE:${w.sectionId}@@ */`;
  const i = bridge.indexOf(open), k = bridge.indexOf(close);
  if (i < 0 || k < 0) return { error: `section entry ${w.sectionId} not found in bridge.js (${bridge.length} bytes)` };
  return { body: bridge.slice(i + open.length, k), bridgeBytes: bridge.length };
}
/** Template helper names the body USES (not as a property) but never declares. */
function undeclaredHelpers(body) {
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return TEMPLATE_HELPERS.filter((name) => {
    if (!new RegExp(`(^|[^\\w$.])${name}\\b`).test(code)) return false;
    const declared = new RegExp(`\\b(var|let|const|function)\\s+${name}\\b`).test(code)
      || new RegExp(`\\b(var|let|const)\\s+[^;]*\\b${name}\\s*=`).test(code);     // var a = [], _ivs = []
    return !declared;
  });
}
async function gateWindow(w) {
  const entry = await fetchServedEntry(w);
  if (entry.error) return { ok: false, missing: [], reason: entry.error };
  const missing = undeclaredHelpers(entry.body);
  return { ok: missing.length === 0, missing, bodyLen: entry.body.length, reason: missing.length ? `references undeclared ${missing.join(', ')}` : null };
}
function fixPrompt(missing, runtimeMessage) {
  const names = missing.length ? missing.join(', ') : '_hidden, _hide, _ivs, _listeners, _injected';
  return `${FIX_PROMPT_PREFIX} (${runtimeMessage ?? `ReferenceError: ${missing[0] ?? '_hidden'} is not defined`}): the template helpers (${names}) are NOT available inside the section body — nothing declares them. Rewrite the SAME body with identical behaviour and controls, but declare everything yourself at the top: var _hidden = [], _ivs = [], _listeners = [], _injected = []; function _hide(el) { if (!el) return; _hidden.push([el, el.style.getPropertyValue('display') || '']); el.style.setProperty('display', 'none'); } and a cleanup that restores _hidden, clears _ivs, removes _listeners and _injected. Reference no identifier you did not declare.`.slice(0, 1000);
}
/**
 * The refinement text is not this section's description — put the owner's prompt back on the row
 * (sim_prompt + sim_meta.prompt; everything else in sim_meta, incl. conversationHistory and
 * bridgeHash, is kept). PATCH leaves simulation_url alone when simulation_id is not sent.
 * Non-fatal: a failed restore is recorded on the window and retried by the next sync.
 */
async function restorePrompt(rec, w, row, info) {
  const meta = row?.sim_meta && typeof row.sim_meta === 'object' ? row.sim_meta : {};
  try {
    await jOk('PATCH', `/api/v1/projects/${rec.projectId}/sections/${w.sectionId}`, {
      sim_prompt: w.prompt,
      sim_meta: { ...meta, prompt: w.prompt, builderRepair: { ...(meta.builderRepair ?? {}), ...info, restoredAt: new Date().toISOString() } },
    }, `${rec.key}/${w.sim}: restore the owner's prompt`);
    w.promptRestored = true; delete w.promptRestoreError;
    return true;
  } catch (e) {
    w.promptRestored = false; w.promptRestoreError = e.message;
    log(`  WARN ${rec.key}/${w.sim}: could not restore the owner's prompt on the row: ${e.message}`);
    return false;
  } finally { saveT(); }
}
async function repairWindow(rec, w, missing, runtimeMessage) {
  const attempt = (w.repairs?.length ?? 0) + 1;
  const what = `${rec.key}/${w.sim} repair#${attempt}`;
  const s = await generateWithRetry(rec.projectId, w.sectionId, fixPrompt(missing, runtimeMessage), w.simpleUI, what);
  // Record the new publication FIRST — nothing below may lose the fact that the body changed.
  w.simulation_url = s.simulation_url;
  w.poster = null;                                        // new revision → poster must be re-captured
  w.repairs = [...(w.repairs ?? []), { attempt, missing, runtimeMessage: runtimeMessage ?? null, simulation_url: s.simulation_url, at: new Date().toISOString() }];
  saveT();
  const rows = await jOk('GET', `/api/v1/projects/${rec.projectId}/sections`, undefined, 'list sections');
  await restorePrompt(rec, w, rows.find((x) => x.id === w.sectionId), { attempt, missing, runtimeMessage: runtimeMessage ?? null });
  return s;
}
/**
 * Reconcile each window with its LIVE row before gating: a refinement that landed but whose
 * bookkeeping did not (crash, busy API) leaves a new served URL — and possibly the fix prompt —
 * on the row. Idempotent, so --repair-only can be re-run until everything agrees.
 */
async function syncWindowsFromRows(jobs) {
  const rowsByProject = new Map();
  for (const { rec, w } of jobs) {
    if (!rowsByProject.has(rec.projectId)) {
      rowsByProject.set(rec.projectId, await jOk('GET', `/api/v1/projects/${rec.projectId}/sections`, undefined, 'list sections'));
    }
    const row = rowsByProject.get(rec.projectId).find((x) => x.id === w.sectionId);
    if (!row) continue;
    if (row.simulation_url && row.simulation_url !== w.simulation_url) {
      log(`  [sync ${rec.key}/${w.sim}] served url changed since the ledger was written — poster will be re-captured`);
      w.simulation_url = row.simulation_url; w.poster = null; saveT();
    }
    const rowPrompt = row.sim_prompt ?? '';
    if (isBuilderFixPrompt(rowPrompt)) {
      // Our own refinement text is still on the row (the restore after a repair did not land).
      await restorePrompt(rec, w, row, { reason: 'row carried the builder\'s fix prompt' });
    } else if (rowPrompt !== w.prompt) {
      // Someone else (the editor, another session) refined this window since the layout was
      // applied. Their work is live and stays — the builder RECORDS the divergence, never
      // overwrites it. (Observed 2026-09-05: demo/kinesin was refined twice from outside the
      // builder while a repair run was in flight.)
      const meta = row.sim_meta && typeof row.sim_meta === 'object' ? row.sim_meta : {};
      w.externalRefinement = { prompt: rowPrompt, generatedAt: meta.generatedAt ?? null, turns: (meta.conversationHistory ?? []).length / 2 };
      log(`  WARN [sync ${rec.key}/${w.sim}] the row's prompt differs from the layout — refined OUTSIDE the builder (${meta.generatedAt ?? 'unknown time'}): "${rowPrompt.slice(0, 80)}" — left as is`);
      saveT();
    } else if (w.externalRefinement) {
      delete w.externalRefinement; saveT();
    }
  }
}
async function runGate(jobs) {
  await syncWindowsFromRows(jobs);
  await mapWithLimit(jobs, 3, async ({ rec, w }) => {
    const id = `GATE-${rec.key}-${w.sim}`;
    for (let round = 0; ; round++) {
      let g;
      try { g = await gateWindow(w); } catch (e) { g = { ok: false, missing: [], reason: e.message }; }
      w.gate = g;
      if (g.ok) {
        step(id, `Served bridge body declares what it uses (${rec.key} · ${w.sim})`, w.promptRestoreError ? 'partial' : 'done',
          `${g.bodyLen} chars${w.repairs?.length ? ` after ${w.repairs.length} refinement repair(s)` : ''}` +
          (w.promptRestoreError ? ` — owner's prompt NOT restored on the row: ${w.promptRestoreError}` : ''));
        return;
      }
      if (!g.missing.length || round >= MAX_STATIC_REPAIRS) {
        step(id, `Served bridge body (${rec.key} · ${w.sim})`, 'failed', `${g.reason} after ${round} repair(s)`);
        return;
      }
      log(`  [gate ${rec.key}/${w.sim}] ${g.reason} — refinement repair ${round + 1}/${MAX_STATIC_REPAIRS}`);
      try { await repairWindow(rec, w, g.missing, null); }
      catch (e) { step(id, `Served bridge body (${rec.key} · ${w.sim})`, 'failed', `repair ${round + 1}: ${e.message}`); return; }
    }
  });
}
await runGate(genJobs.filter(({ w }) => w.generated));

// ── 3. Posters: headless Chrome frame of each generated section's SERVED sim url ──
async function captureRendition(browser, url, width, height, settleMs, outPng) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(settleMs);          // let the scene animate past its first frames
  const buf = await page.screenshot({ type: 'png' });
  if (outPng) writeFileSync(outPng, buf);
  await ctx.close();
  return `data:image/png;base64,${buf.toString('base64')}`;
}
async function capturePoster(browser, rec, w) {
  const rows = await jOk('GET', `/api/v1/projects/${rec.projectId}/sections`, undefined, 'list sections');
  const row = rows.find((s) => s.id === w.sectionId);
  const url = absolutize(row?.simulation_served_url ?? row?.simulation_url);
  if (!url) throw new Error(`section ${w.sectionId} has no simulation url to capture`);
  const tag = `${rec.key}-${w.sim}`;
  const settle = SIMS[w.sim]?.settleMs ?? 6000;
  const std = await captureRendition(browser, url, 1280, 720, settle, join(PROOF_DIR, `poster-${tag}.png`));
  const cmp = await captureRendition(browser, url, 640, 360, settle, null);
  const res = await j('POST', `/api/v1/projects/${rec.projectId}/sections/${w.sectionId}/poster`, {
    renditions: [
      { size: 'standard', format: 'png', dataUrl: std },
      { size: 'compact', format: 'png', dataUrl: cmp },
    ],
  });
  if (res.status >= 400) throw new Error(`poster POST ${tag} -> ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
  w.poster = { outcome: res.data.outcome, identity: res.data.identity, proof: `proof/poster-${tag}.png`, captured_from: url };
  T.verification.posters.push({ project: rec.key, sim: w.sim, sectionId: w.sectionId, ...w.poster });
  saveT();
  return res.data;
}
if (!chromium) step('D-playwright', 'Playwright resolution', 'failed', `playwright not resolvable from ${PLAYWRIGHT_HOMES.join(' | ')}`);
else {
  await withBrowser(async (browser) => {
    for (const { rec, w } of genJobs) {
      const id = `POSTER-${rec.key}-${w.sim}`;
      if (!w.generated) { step(id, `Poster (${rec.key} · ${w.sim})`, 'skipped', 'generation failed'); continue; }
      try { const p = await capturePoster(browser, rec, w); step(id, `Poster captured+stored (${rec.key} · ${w.sim})`, 'done', p.outcome); }
      catch (e) { step(id, `Poster (${rec.key} · ${w.sim})`, 'failed', e.message); }
    }
  });
}

// ── 4. Demo extras: image + sting in the LIBRARY only, choice doors, permalink, podcast ──
if (T.demo.projectId) {
  const demoId = T.demo.projectId;
  { // library cards — no sections (owner: keep the timeline clean)
    try {
      const img = await jOk('POST', `/api/v1/projects/${demoId}/images`,
        fd({}, LIBRARY.wavesDiagram, 'waves-diagram.png', 'image/png'), 'upload waves-diagram');
      T.demo.imageId = img.id;
      const aud = await jOk('POST', `/api/v1/projects/${demoId}/audio`,
        fd({}, LIBRARY.sting, 'sting-ambient.wav', 'audio/wav'), 'upload sting-ambient');
      T.demo.audioId = aud.id; T.demo.audioDurationSec = aud.duration_sec ?? null;
      const extras = (LAYOUT.library_extras ?? []).map((k) => `${k}=${T.demo.sims[k]?.id ?? 'MISSING'}`).join(', ');
      step('A4', 'Demo LIBRARY: image (waves-diagram) + audio (sting-ambient) + sim extras — no sections', 'done',
        `image=${img.id} audio=${aud.id} (${aud.duration_sec}s); extras: ${extras}`);
    } catch (e) {
      step('A4', 'Demo LIBRARY: image + audio', 'failed', e.message);
    }
  }

  if (LAYOUT.demo.choiceDoorsAtEnd && T.demo.video) { // A7 — one branching choice ("What next?" doors) at the sequence END
    try {
      const seq = await jOk('POST', `/api/v1/projects/${demoId}/branch/sequences`,
        { label: 'Main', is_entry: true }, 'create branch sequence');
      await jOk('POST', `/api/v1/projects/${demoId}/branch/assign`,
        { video_file_id: T.demo.video.id, sequence_id: seq.id, sequence_order: 0 }, 'assign master to sequence');
      const cp = await jOk('POST', `/api/v1/projects/${demoId}/branch/choice-points`,
        { sequence_id: seq.id, lead_in_sec: 6, behavior: 'pause', prompt: 'What next?', layout: 'cards' },
        'create choice point');
      // THREE doors, the tutorial FIRST. The teaser's last line hands the viewer the decision
      // ("Now you pick what's next"); the one door a cold viewer must be able to find is "Make
      // yours" (the basics film), then the two persuasion films. No "Watch again": a fourth card
      // that replays the ad is the one choice nobody who just watched it wants, and it pushed the
      // real doors off a phone screen. The share film stays in the playlist, not on a door.
      const doorTargets = [
        T.tutorial?.projectId ? { label: 'Make yours', projectId: T.tutorial.projectId } : null,
        ...['powers', 'heavy'].map((key) => {
          const n = (T.niche ?? []).find((x) => x.key === key);
          return n?.projectId ? { label: n.title, projectId: n.projectId } : null;
        }),
      ].filter(Boolean);
      const edges = [];
      for (const [i, d] of doorTargets.entries()) {
        edges.push(await jOk('POST', `/api/v1/projects/${demoId}/branch/edges`, {
          choice_point_id: cp.id, sort_order: i, label: d.label,
          destination_type: 'project', dest_project_id: d.projectId,
        }, `edge -> ${d.label}`));
      }
      const validation = await jOk('GET', `/api/v1/projects/${demoId}/branch/validate`, undefined, 'validate graph');
      T.demo.branching = {
        sequence_id: seq.id, choice_point_id: cp.id,
        edges: edges.map((e) => ({ id: e.id, label: e.label, destination_type: e.destination_type, dest_project_id: e.dest_project_id ?? null })),
        validation_issues: validation.issues,
      };
      step('A7', 'Demo choice doors at the END (What next? -> Make yours + Viewer Superpowers + Drop In Anything)',
        validation.issues.some((i) => i.level === 'error') ? 'partial' : 'done',
        `cp=${cp.id}; edges=${edges.length}; issues=${JSON.stringify(validation.issues)}`);
    } catch (e) {
      step('A7', 'Demo choice doors', 'failed', e.message);
    }
  } else if (LAYOUT.demo.choiceDoorsAtEnd) {
    step('A7', 'Demo choice doors', 'partial', 'no master video to attach the sequence to');
  }

  { // permalink 'welcome-flow-video'
    const SLUG = 'welcome-flow-video';
    const r = await j('PUT', `/api/v1/projects/${demoId}/permalink`, { slug: SLUG });
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
}

// ── 5. Playlist: demo, tutorial, heavy, powers, doors ────────────────────────
{
  try {
    const pl = await jOk('POST', '/api/v1/playlists', {
      title: 'Welcome to Flow Video',
      description: 'Start here: a film you can touch, then how to make yours, then the three doors — drop in anything, viewer superpowers, one link.',
    }, 'create playlist');
    const order = allProjects();
    const items = order.map((p) => ({ project_id: p.projectId }));
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
    step('C', `Playlist "Welcome to Flow Video" (${order.map((p) => p.key).join(', ')})`,
      withItems.items.length === 5 && perma.status < 400 ? 'done' : 'partial',
      `${pl.id} · items=${withItems.items.length} · ${share.shareUrl} · permalink=${perma.status < 400 ? T.playlist.permalinkUrl : `FAILED ${perma.status}`}`);
  } catch (e) {
    step('C', 'Playlist', 'failed', e.message);
  }
}

// ── 6. Verification: layout-derived asserts + the real viewer mid-roll ───────
await runVerification();

// ── 6b. One runtime repair round: a window whose script threw in the REAL viewer gets a
// refinement turn carrying the runtime message, a fresh poster, and the verification re-runs.
await runtimeRepairRound();
finish();

async function runtimeRepairRound() {
  const broken = T.verification.midroll.filter((r) => r.scriptError);
  if (broken.length && chromium) {
    log(`runtime script errors in ${broken.length} window(s) — refinement repair with the runtime message, then re-verify`);
    const fixed = [];
    for (const r of broken) {
      const rec = allProjects().find((p) => p.key === r.project);
      const w = rec?.windows.find((x) => x.sectionId === r.sectionId);
      if (!rec || !w) continue;
      const id = `RUNTIME-REPAIR-${rec.key}-${w.sim}`;
      try {
        await repairWindow(rec, w, w.gate?.missing ?? [], r.scriptError);
        const g = await gateWindow(w); w.gate = g;
        step(id, `Runtime repair (${rec.key} · ${w.sim})`, g.ok ? 'done' : 'partial', `${r.scriptError} → refined; gate: ${g.ok ? 'ok' : g.reason}`);
        fixed.push({ rec, w });
      } catch (e) {
        step(id, `Runtime repair (${rec.key} · ${w.sim})`, 'failed', e.message);
      }
    }
    if (fixed.length) {
      await withBrowser(async (browser) => {
        for (const { rec, w } of fixed) {
          const id = `POSTER-${rec.key}-${w.sim}`;
          try { const p = await capturePoster(browser, rec, w); step(id, `Poster captured+stored (${rec.key} · ${w.sim}, after repair)`, 'done', p.outcome); }
          catch (e) { step(id, `Poster (${rec.key} · ${w.sim}, after repair)`, 'failed', e.message); }
        }
      });
      await runVerification();
    }
  }
}
