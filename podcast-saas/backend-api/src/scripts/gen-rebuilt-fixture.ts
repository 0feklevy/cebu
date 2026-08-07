/**
 * SYNTHETIC rebuilt-package dump — the input e2e/rebuilt-packages.spec.ts needs, produced without a
 * database, a storage adapter or a network.
 *
 * WHY THIS EXISTS. rebuilt-packages.spec.ts is the only gate that answers "does the REBUILT bridge
 * still boot, dispatch and acknowledge in a real browser". Its input was a dump that only
 * prove-sim-rebuild.ts --dump-dir could produce, and producing that requires reading the live
 * simulations table and every stored package out of shared storage. So the gate did what an
 * unfeedable gate always does: it skipped — twelve skipped tests reported as a clean run, which is
 * the most expensive false signal a release gate can give. Worse, the only way to un-skip it was to
 * point a developer machine at the shared preview/production database.
 *
 * WHAT MAKES IT A REAL TEST AND NOT A MOCK. Only the STORED bytes are synthetic. Everything that
 * turns them into a rebuilt package is the shipping code, unmodified:
 *
 *   • the section blocks are cut by the real `buildSectionEntry`, so the markers the proof parses
 *     and the suite discovers are the production format rather than an imitation of it;
 *   • the rebuild itself runs through `proveAll` from prove-sim-rebuild.ts — the SAME function,
 *     with the SAME real transforms (parseSectionEntries → wrapBridgeCombined → injectRafGate →
 *     injectBridgeScriptTag) and the SAME writeDump sink the real `--dump-dir` run uses;
 *   • the dump is gated by the real `gateProofRun` + `expectedRebuildableFromInventory`, so a
 *     generator that quietly emitted nothing fails here instead of producing an empty directory
 *     that the browser suite would then report as "no packages found".
 *
 * A regression in any of those transforms therefore breaks THIS fixture, which is the property that
 * makes the browser assertions meaningful.
 *
 * WHAT THE PACKAGES DELIBERATELY COVER. Three, because the shapes differ where the transform does:
 *   flat    — 2 sections, entry at the package root (`./bridge.js`), stored entry with NO rAF gate
 *             and no bridge tag: the pre-gate upload.
 *   nested  — 2 sections, entry one directory down (`../bridge.js`), stored entry that ALREADY
 *             carries a v4 gate and a bridge tag with a STALE hash: re-injection must replace, not
 *             duplicate, and the rebuilt tag must name the rebuilt bytes.
 *   solo    — 1 section, and a LEGACY full-URL `entry_file` so deriveEntryRelPath's second branch
 *             is exercised rather than assumed.
 * Two of them are multi-section on purpose: the suite's A → B → A test used to skip whenever a dump
 * happened to contain none, and a control that is always present makes that skip unreachable.
 *
 *   npx tsx src/scripts/gen-rebuilt-fixture.ts <outDir>
 *
 * EXIT CODES: 0 every synthetic package was rebuilt AND proven and the written bytes read back
 * intact; 1 anything else. This is a TEST TOOL — it is never imported by the server, writes only
 * under <outDir>, and touches neither storage nor the database.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildSectionEntry,
  computeBridgeHash,
  deriveEntryRelPath,
  injectBridgeScriptTag,
  injectRafGate,
  parseSectionEntries,
  wrapBridgeCombined,
} from '../services/simulation/SimulationService.js';
import {
  expectedRebuildableFromInventory,
  gateProofRun,
  proveAll,
  type InventoryLike,
  type ProveSimRow,
  type ProveStorage,
  type SimTransforms,
} from './prove-sim-rebuild.js';

/** Marker file written at the dump root. Also the freshness stamp the e2e spec stats. */
export const FIXTURE_MANIFEST = 'rebuilt-fixture.json';

/**
 * Section ids, fixed and hex-and-dash ON PURPOSE: rebuilt-packages.spec.ts discovers a package's
 * sections with /@@SIM_BRIDGE:([0-9a-f-]+)@@/, so an id outside that character class would be
 * silently invisible to the very suite this fixture exists to feed — the package would be
 * discovered with zero sections and every per-section assertion would vacuously pass.
 */
export const REBUILT_FIXTURE_SECTIONS = {
  FLAT_A: 'a0000000-0000-4000-8000-000000000001',
  FLAT_B: 'a0000000-0000-4000-8000-000000000002',
  NESTED_A: 'b0000000-0000-4000-8000-000000000001',
  NESTED_B: 'b0000000-0000-4000-8000-000000000002',
  SOLO: 'c0000000-0000-4000-8000-000000000001',
} as const;

/**
 * A section body: marks the DOM with its OWN id, paints its own colour, and keeps a scene loop
 * running.
 *
 * The interval is deliberately NOT registered via simDemoTimer. The suite's pauseScript test
 * asserts that pausing is a no-op for bodies that registered no automation — a fixture that opted
 * in would change what that test is looking at, and a frozen scene is strictly worse than the
 * automation a pause meant to stop. It also keeps the string `simDemoTimer` out of the STORED
 * bytes, so the proof's capability scan reports demoTimer as genuinely GAINED by the rebuild
 * rather than as something the old bridge already had.
 */
const sectionBody = (label: string, colour: string): string => `
var el = document.getElementById('marker');
el.style.background = ${JSON.stringify(colour)};
el.setAttribute('data-section', ${JSON.stringify(label)});
window.__APPLIED__ = (window.__APPLIED__ || []);
window.__APPLIED__.push(${JSON.stringify(label)});
var canvas = document.getElementById('scene');
var g = canvas.getContext('2d');
var frames = 0;
function draw() {
  g.fillStyle = ${JSON.stringify(colour)};
  g.fillRect(0, 0, canvas.width, canvas.height);
  window.__FRAMES__ = ++frames;
}
requestAnimationFrame(draw);
var engine = setInterval(draw, 50);
return function cleanup() {
  clearInterval(engine);
  el.setAttribute('data-section', 'none');
};`;

/**
 * The entry document, self-contained by construction.
 *
 * NOT ONE EXTERNAL REFERENCE — no image, no font, no module. The suite's asset server proxies
 * anything it cannot serve from disk to a running backend, and a fixture that leaned on that proxy
 * would reintroduce exactly the dependency this generator removes: the browser gate must run with
 * no backend, no storage and no network.
 */
const ENTRY_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>rebuilt fixture sim</title>
  <style>
    html, body { margin: 0; height: 100%; background: #101010; }
    .controls { position: fixed; right: 0; bottom: 0; background: #ff0000; z-index: 5; }
    #marker { position: fixed; left: 0; top: 0; width: 100%; height: 40%; background: #808080; z-index: 9; }
    #scene { position: fixed; left: 0; bottom: 0; }
  </style>
</head>
<body>
  <div id="marker" data-section="none"></div>
  <div class="controls">FULL UI</div>
  <canvas id="scene" width="64" height="64"></canvas>
  <script>
    // A real sim paints its scene inside its OWN rAF at load, before any section is dispatched.
    // The injected gate wraps that call, which is what makes SIM_PAINTED honest here.
    requestAnimationFrame(function () {
      var c = document.getElementById('scene').getContext('2d');
      c.fillStyle = '#000'; c.fillRect(0, 0, 64, 64);
      window.__SIM_PAINTED_SELF__ = true;
    });
  </script>
</body>
</html>`;

/** A bridge tag hash the rebuild must REPLACE — never a hash of anything that exists. */
export const STALE_BRIDGE_HASH = '0000deadbeef';

/**
 * The PRE-rebuild stored bridge: production's marker blocks inside the pre-hardening envelope.
 *
 * The envelope is the old one on purpose — unguarded teardown, silent wrong-section fallback, no
 * acknowledgements at all. It must contain none of the needles prove-sim-rebuild's CAPABILITIES
 * table scans for (SCRIPT_APPLIED / SCRIPT_MISSING / SCRIPT_ERROR / pauseScript / simDemoTimer /
 * _sysRaf), because "no capability gained" is a FAILURE in the pre-apply proof: a fixture whose
 * stored bytes already looked hardened would make the proof reject its own input.
 *
 * The section blocks themselves come from the REAL `buildSectionEntry`, so the bodies round-trip
 * through the real `parseSectionEntries` exactly as a stored package's do.
 */
export function legacyStoredBridge(entries: Map<string, string>): string {
  const blocks = [...entries.entries()].map(([id, body]) => buildSectionEntry(id, body)).join('\n');
  return [
    '(function () {',
    "  'use strict';",
    '',
    '  var __SECTIONS__ = {',
    blocks,
    '  };',
    '',
    '  var _ready = false;',
    '  function _fireReady() {',
    '    if (_ready) return; _ready = true; window._simReadyFired = true;',
    '    var ids = []; for (var k in __SECTIONS__) { if (Object.prototype.hasOwnProperty.call(__SECTIONS__, k)) ids.push(k); }',
    "    window.parent && window.parent.postMessage({ type: 'SIM_READY', dispatch: 'dynamic', sections: ids }, '*');",
    '  }',
    "  if (document.readyState === 'loading')",
    "    document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(_fireReady); });",
    '  else requestAnimationFrame(_fireReady);',
    '',
    "  var _defaultSectionId = new URLSearchParams(location.search).get('section');",
    '  var _cancelFn = null;',
    '  function _sectionBody(name) {',
    '    return (name && Object.prototype.hasOwnProperty.call(__SECTIONS__, name)) ? __SECTIONS__[name] : null;',
    '  }',
    '  var SCRIPTS = {',
    '    main: function (params) { var b = _sectionBody(_defaultSectionId); return b ? b(params) : null; },',
    '  };',
    '  function stopScript() {',
    '    if (_cancelFn) { _cancelFn(); _cancelFn = null; }   /* UNGUARDED — a throwing cleanup wedges dispatch */',
    '  }',
    '  function startScript(name, params) {',
    '    stopScript();',
    '    var fn = SCRIPTS[name] || _sectionBody(name) || SCRIPTS.main;   /* silent wrong-section fallback */',
    '    if (fn) _cancelFn = fn(params || {}) || null;',
    '  }',
    "  window.addEventListener('message', function (e) {",
    '    var d = e.data || {};',
    "    if (d.type === 'startScript') startScript(d.script || 'main', d.params);",
    "    if (d.type === 'stopScript') stopScript();",
    '  });',
    '})();',
  ].join('\n');
}

// ── The synthetic inventory ───────────────────────────────────────────────────

export interface SyntheticPackage {
  projectId: string;
  simulationId: string;
  name: string;
  /** Path of the entry HTML relative to the storage prefix. */
  entryRel: string;
  /** What the simulations row's `entry_file` column holds — storage key or legacy public URL. */
  entryFile: (storagePrefix: string) => string;
  /** sectionId → raw body, in dispatch order. */
  sections: Record<string, string>;
  /** The stored entry HTML, before the rebuild touches it. */
  storedEntry: (entryRel: string) => string;
}

const BASE_PUBLIC_URL = 'https://fixture.invalid/storage/v1/object/public/sims';

export const SYNTHETIC_PACKAGES: SyntheticPackage[] = [
  {
    projectId: 'f1a70000-0000-4000-8000-000000000001',
    simulationId: 'f1a75e0c-0000-4000-8000-000000000001',
    name: 'fixture flat (2 sections, entry at root)',
    entryRel: 'index.html',
    entryFile: (prefix) => `${prefix}/index.html`,
    sections: {
      [REBUILT_FIXTURE_SECTIONS.FLAT_A]: sectionBody('FLAT_A', '#0000ff'),
      [REBUILT_FIXTURE_SECTIONS.FLAT_B]: sectionBody('FLAT_B', '#ffff00'),
    },
    // The pre-gate upload: no rAF gate, no bridge tag. The rebuild must add both.
    storedEntry: () => ENTRY_HTML,
  },
  {
    projectId: 'de5700ed-0000-4000-8000-000000000002',
    simulationId: 'de57cafe-0000-4000-8000-000000000002',
    name: 'fixture nested (2 sections, entry one directory down)',
    entryRel: 'pkg/index.html',
    entryFile: (prefix) => `${prefix}/pkg/index.html`,
    sections: {
      [REBUILT_FIXTURE_SECTIONS.NESTED_A]: sectionBody('NESTED_A', '#00c000'),
      [REBUILT_FIXTURE_SECTIONS.NESTED_B]: sectionBody('NESTED_B', '#ff00ff'),
    },
    // Already gated and already tagged — with a hash that names nothing. Built with the real
    // injectors so the "before" bytes are a package the platform could actually have served.
    storedEntry: () => injectBridgeScriptTag(injectRafGate(ENTRY_HTML), '../bridge.js', STALE_BRIDGE_HASH),
  },
  {
    projectId: '501e0000-0000-4000-8000-000000000003',
    simulationId: '501edad0-0000-4000-8000-000000000003',
    name: 'fixture solo (1 section, legacy full-URL entry_file)',
    entryRel: 'index.html',
    // The legacy column shape: a full public URL rather than a storage key. deriveEntryRelPath has
    // a branch for it, and a fixture that only ever fed it storage keys never reaches that branch.
    entryFile: (prefix) => `${BASE_PUBLIC_URL}/${prefix}/index.html?download=1`,
    sections: { [REBUILT_FIXTURE_SECTIONS.SOLO]: sectionBody('SOLO', '#00ffff') },
    storedEntry: () => ENTRY_HTML,
  },
];

export const storagePrefixOf = (p: SyntheticPackage): string =>
  `simulations/${p.projectId}/${p.simulationId}`;

/** The `simulations` rows proveAll would have read from the database. */
export function syntheticRows(): ProveSimRow[] {
  return SYNTHETIC_PACKAGES.map((p) => ({
    id: p.simulationId,
    name: p.name,
    storage_prefix: storagePrefixOf(p),
    entry_file: p.entryFile(storagePrefixOf(p)),
  }));
}

/** The stored objects — keyed exactly as the storage adapter keys them. */
export function syntheticObjects(): Map<string, string> {
  const objects = new Map<string, string>();
  for (const p of SYNTHETIC_PACKAGES) {
    const prefix = storagePrefixOf(p);
    objects.set(`${prefix}/bridge.js`, legacyStoredBridge(new Map(Object.entries(p.sections))));
    objects.set(`${prefix}/${p.entryRel}`, p.storedEntry(p.entryRel));
  }
  return objects;
}

/** The inventory the proof cross-checks itself against: every synthetic package is rebuildable. */
export function syntheticInventory(): InventoryLike[] {
  return SYNTHETIC_PACKAGES.map((p) => ({
    simulationId: p.simulationId,
    name: p.name,
    storagePrefix: storagePrefixOf(p),
    bridge: { combined: true },
    files: { entry: { present: true } },
  }));
}

/** The REAL transforms — the whole point of the fixture is that these are not stand-ins. */
export const REAL_TRANSFORMS: SimTransforms = {
  deriveEntryRelPath,
  parseSectionEntries,
  wrapBridgeCombined,
  computeBridgeHash,
  injectBridgeScriptTag,
  injectRafGate,
};

/**
 * In-memory stand-in for the storage adapter. Its public-URL fallback is a URL nothing can fetch,
 * and `fetchImpl` below refuses outright: a generator that silently reached the network would be
 * reintroducing the dependency it exists to remove, and a loud failure is the only honest report.
 */
export function memoryStorage(objects: Map<string, string>): ProveStorage {
  return {
    async readObject(key) {
      const v = objects.get(key);
      if (v === undefined) throw new Error(`synthetic storage has no object: ${key}`);
      return Buffer.from(v, 'utf-8');
    },
    getSimPublicUrl: (key) => `https://fixture.invalid/sim-public/${key}`,
  };
}

export interface FixtureFile { relPath: string; contents: string }

export interface FixtureResult {
  files: FixtureFile[];
  /** simulationId → the section ids the rebuilt bridge carries, in order. */
  sectionsBySim: Record<string, string[]>;
  problems: string[];
  proven: number;
  discovered: number;
}

/**
 * Run the REAL pre-apply proof over the synthetic packages and collect the rebuilt bytes.
 *
 * Nothing is written here — the caller decides where the files go, which is what lets the unit test
 * assert on the exact bytes without a temp directory.
 */
export async function buildRebuiltFixture(): Promise<FixtureResult> {
  const objects = syntheticObjects();
  const files: FixtureFile[] = [];

  const run = await proveAll({
    rows: syntheticRows(),
    storage: memoryStorage(objects),
    transforms: REAL_TRANSFORMS,
    // Reached only if readObject threw, which for an in-memory map means the fixture itself is
    // inconsistent. Failing here beats a quiet fall-through to a network the tool must never use.
    fetchImpl: async (url) => {
      throw new Error(`gen-rebuilt-fixture must never reach the network (attempted ${url})`);
    },
    writeDump: (relPath, contents) => files.push({ relPath, contents }),
  });

  const gate = gateProofRun(run, expectedRebuildableFromInventory(syntheticInventory()), null);
  const sectionsBySim: Record<string, string[]> = {};
  for (const r of run.results) sectionsBySim[r.simulationId] = r.sections.after;

  return {
    files,
    sectionsBySim,
    problems: gate.problems,
    proven: gate.proven,
    discovered: gate.discovered,
  };
}

// ── Writing and reading back ──────────────────────────────────────────────────

/**
 * Refuse to clear a directory this generator did not create.
 *
 * <outDir> comes from the command line, and the obvious `rmSync(outDir)` would happily delete a
 * real `--dump-dir` (or a source tree) if someone reused the path. A previous run's marker file is
 * the only evidence that a NON-EMPTY directory is ours to overwrite; without it, the directory is
 * left completely alone and the run fails. An empty directory has nothing to lose, so it is
 * accepted — that is the ordinary case (mkdir -p, mkdtemp, a fresh checkout).
 */
function prepareOutDir(outDir: string): void {
  if (existsSync(outDir)) {
    const contents = readdirSync(outDir);
    if (contents.length > 0 && !contents.includes(FIXTURE_MANIFEST)) {
      throw new Error(
        `refusing to write into ${outDir}: it is not empty and carries no ${FIXTURE_MANIFEST} marker, ` +
        'so it was not created by this generator. Point outDir somewhere else or delete it by hand.',
      );
    }
    // Stale sections from an earlier run would still be DISCOVERED by the browser suite (it reads
    // whatever bridge.js it finds), so a partial overwrite is not enough.
    rmSync(join(outDir, 'simulations'), { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
}

/**
 * Read the dump back off disk and re-derive what the browser suite will derive from it.
 *
 * Not a duplicate of the proof: the proof reasoned about strings in memory, this reads the FILES.
 * A truncated write, a path that escaped its package, or an entry whose tag names bytes other than
 * the ones next to it are all invisible to the former and fatal to the latter.
 */
export function verifyDump(outDir: string, expected: Record<string, string[]>): string[] {
  const problems: string[] = [];
  for (const p of SYNTHETIC_PACKAGES) {
    const prefix = storagePrefixOf(p);
    const bridgePath = join(outDir, prefix, 'bridge.js');
    const entryPath = join(outDir, prefix, p.entryRel);
    if (!existsSync(bridgePath)) { problems.push(`missing ${bridgePath}`); continue; }
    if (!existsSync(entryPath)) { problems.push(`missing ${entryPath}`); continue; }

    const bridge = readFileSync(bridgePath, 'utf-8');
    const entry = readFileSync(entryPath, 'utf-8');

    // The suite's own discovery regex, deliberately re-run here: it is stricter than
    // parseSectionEntries about the id character class, and a mismatch would show up as a
    // package with zero sections whose per-section assertions all pass vacuously.
    const discovered = [...new Set([...bridge.matchAll(/@@SIM_BRIDGE:([0-9a-f-]+)@@/gi)].map((m) => m[1]))];
    const want = expected[p.simulationId] ?? [];
    if (discovered.join(',') !== want.join(',')) {
      problems.push(`${prefix}: browser discovery finds [${discovered.join(', ')}], proof wrote [${want.join(', ')}]`);
    }
    const tag = /bridge\.js\?v=([a-z0-9]+)/i.exec(entry);
    if (!tag) problems.push(`${prefix}: entry has no bridge.js script tag`);
    else if (!computeBridgeHash(bridge).startsWith(tag[1])) {
      problems.push(`${prefix}: entry tag ?v=${tag[1]} does not name the bridge.js written beside it`);
    }
    if (!/sim-raf-gate v\d+/i.test(entry)) problems.push(`${prefix}: entry carries no rAF gate`);
  }
  return problems;
}

export interface GenerateResult {
  outDir: string;
  packages: { simulationId: string; storagePrefix: string; entryRel: string; sections: string[] }[];
  problems: string[];
}

export async function generateRebuiltFixture(outDir: string): Promise<GenerateResult> {
  const built = await buildRebuiltFixture();
  const problems = [...built.problems];

  if (problems.length === 0) {
    prepareOutDir(outDir);
    for (const f of built.files) {
      const abs = join(outDir, f.relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.contents, 'utf-8');
    }
    problems.push(...verifyDump(outDir, built.sectionsBySim));
  }

  const result: GenerateResult = {
    outDir,
    packages: SYNTHETIC_PACKAGES.map((p) => ({
      simulationId: p.simulationId,
      storagePrefix: storagePrefixOf(p),
      entryRel: p.entryRel,
      sections: built.sectionsBySim[p.simulationId] ?? [],
    })),
    problems,
  };

  if (problems.length === 0) {
    // Written LAST: the browser suite treats this file's mtime as the freshness stamp, so it must
    // not exist for a dump that failed halfway through being written.
    writeFileSync(
      join(outDir, FIXTURE_MANIFEST),
      JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2) + '\n',
      'utf-8',
    );
  }
  return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: gen-rebuilt-fixture.ts <outDir>');
    return 1;
  }
  const result = await generateRebuiltFixture(outDir);
  if (result.problems.length > 0) {
    console.error(`❌ rebuilt fixture NOT generated — ${result.problems.length} problem(s):`);
    for (const p of result.problems) console.error(`     ${p}`);
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && process.argv[1].includes('gen-rebuilt-fixture')) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { console.error(e); process.exit(1); });
}
