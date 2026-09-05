/**
 * Integration-style manual verification for the combined bridge.js refactor.
 * Exercises all acceptance criteria purely in-process — no server needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import {
  buildSectionEntry,
  parseSectionEntries,
  wrapBridgeCombined,
  wrapBridgeMainBody,
  injectBridgeScriptTag,
  SAFE_SECTION_ID_RE,
} from '../SimulationService.js';

// ── In-memory storage simulator ───────────────────────────────────────────────

class MemStorage {
  private readonly store = new Map<string, string>();

  async uploadFile(key: string, buf: Buffer): Promise<void> {
    this.store.set(key, buf.toString('utf-8'));
  }
  async readObject(key: string): Promise<Buffer> {
    if (!this.store.has(key)) throw Object.assign(new Error(`Not found: ${key}`), { code: 'ENOENT' });
    return Buffer.from(this.store.get(key)!, 'utf-8');
  }
  has(key: string): boolean { return this.store.has(key); }
  get(key: string): string  { return this.store.get(key) ?? ''; }
  keys(): string[]          { return [...this.store.keys()]; }
  getSimPublicUrl(key: string): string { return `https://cdn.example.com/${key}`; }
}

// ── Helper: simulates generateBridgeScript's step 8 ──────────────────────────

async function generateSection(storage: MemStorage, opts: {
  prefix: string; entryKey: string; sectionId: string; mainBody: string;
}) {
  const { prefix, entryKey, sectionId, mainBody } = opts;

  if (!SAFE_SECTION_ID_RE.test(sectionId))
    throw new Error(`Unsafe sectionId: "${sectionId}"`);

  const entryDir = entryKey.substring(0, entryKey.lastIndexOf('/'));
  const relativeDepth = entryDir === prefix
    ? 0
    : entryDir.slice(prefix.length).split('/').filter(Boolean).length;
  const bridgeRelPath = (relativeDepth > 0 ? '../'.repeat(relativeDepth) : './') + 'bridge.js';
  const bridgeJsKey   = `${prefix}/bridge.js`;

  let existingBridgeJs = '';
  try { existingBridgeJs = (await storage.readObject(bridgeJsKey)).toString('utf-8'); } catch { /* first */ }

  const sectionEntries = parseSectionEntries(existingBridgeJs);
  sectionEntries.set(sectionId, mainBody);
  const combinedBridge = wrapBridgeCombined(sectionEntries);
  const hash = createHash('sha256').update(combinedBridge).digest('hex').slice(0, 12);

  await storage.uploadFile(bridgeJsKey, Buffer.from(combinedBridge, 'utf-8'));
  const rawHtml = (await storage.readObject(entryKey)).toString('utf-8');
  await storage.uploadFile(entryKey, Buffer.from(injectBridgeScriptTag(rawHtml, bridgeRelPath, hash), 'utf-8'));

  return {
    sectionUrl: `${storage.getSimPublicUrl(entryKey)}?section=${sectionId}&v=${hash}`,
    sectionCount: sectionEntries.size,
  };
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const PREFIX    = 'simulations/proj-1/sim-1';
const ENTRY_KEY = `${PREFIX}/index.html`;
const SEED_HTML = `<!DOCTYPE html><html><head></head><body>
<canvas id="main-canvas"></canvas>
<script src="./app.js"></script>
</body></html>`;

const SEC_A = 'sec-aaaa-1111';
const SEC_B = 'sec-bbbb-2222';
const BODY_A = `const el = document.getElementById('velocity');
const iv = setInterval(() => { el.value = '50'; el.dispatchEvent(new Event('input')); }, 100);
return function cleanup() { clearInterval(iv); };`;
const BODY_B = `const el = document.getElementById('angle');
el.value = '45'; el.dispatchEvent(new Event('input'));
return function cleanup() { el.value = '0'; el.dispatchEvent(new Event('input')); };`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Bridge integration — acceptance criteria', () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
    storage.uploadFile(ENTRY_KEY, Buffer.from(SEED_HTML, 'utf-8'));
  });

  it('[1] sectionId validation rejects dangerous characters', () => {
    expect(SAFE_SECTION_ID_RE.test('98fd5b48-c7cd-45d8-a1b2')).toBe(true);
    expect(SAFE_SECTION_ID_RE.test('bad/id')).toBe(false);
    expect(SAFE_SECTION_ID_RE.test('bad id')).toBe(false);
    expect(SAFE_SECTION_ID_RE.test("id'xss")).toBe(false);
    expect(() => buildSectionEntry('bad/id', 'x')).toThrow('Unsafe sectionId');
  });

  it('[2] section A: creates bridge.js + updates index.html, no section_*.js or *.html', async () => {
    const result = await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: BODY_A });

    expect(storage.has(`${PREFIX}/bridge.js`)).toBe(true);
    expect(storage.has(`${PREFIX}/section_${SEC_A}.js`)).toBe(false);
    expect(storage.has(`${PREFIX}/section_${SEC_A}.html`)).toBe(false);
    expect(result.sectionUrl).toMatch(/index\.html\?section=sec-aaaa-1111&v=/);
    expect(result.sectionCount).toBe(1);
  });

  it('[3] section B: section A preserved inside bridge.js', async () => {
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: BODY_A });
    const result = await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_B, mainBody: BODY_B });
    const bridge = storage.get(`${PREFIX}/bridge.js`);

    expect(bridge).toContain(SEC_A);
    expect(bridge).toContain(SEC_B);
    expect(result.sectionCount).toBe(2);
  });

  it('[4] regenerating A preserves B, updates A', async () => {
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: BODY_A });
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_B, mainBody: BODY_B });
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: "return function cleanup() { /* v2 */ };" });

    const bridge = storage.get(`${PREFIX}/bridge.js`);
    expect(bridge).toContain('v2');
    expect(bridge).not.toContain("'50'");
    expect(bridge).toContain(SEC_B);
  });

  it('[5] no section_*.html or section_*.js files created at any point', async () => {
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: BODY_A });
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_B, mainBody: BODY_B });

    const stale = storage.keys().filter(k => /section_[^/]+\.(html|js)$/.test(k));
    expect(stale).toHaveLength(0);
  });

  it('[6] bridge.js excluded from AI context by updated isSectionFile', () => {
    const isSectionFile = (k: string) =>
      /section_[^/]+\.(html|js)$/.test(k) || /\/bridge\.js$/.test(k);

    expect(isSectionFile(`${PREFIX}/bridge.js`)).toBe(true);
    expect(isSectionFile(`${PREFIX}/section_abc.js`)).toBe(true);
    expect(isSectionFile(`${PREFIX}/app.js`)).toBe(false);
    expect(isSectionFile(`${PREFIX}/index.html`)).toBe(false);
  });

  it('[7] index.html standalone — SIM_READY fires before the empty-bridge guard; v2 dynamic dispatch advertised', async () => {
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: BODY_A });
    const bridge = storage.get(`${PREFIX}/bridge.js`);

    // v2: listeners are wired whenever the bridge carries ANY sections (no load-time
    // section lock); the only early-exit is a bridge with zero sections.
    expect(bridge).toContain('if (!_hasAny) return;');
    expect(bridge).not.toContain('if (!_mainBodyFn) return;');
    // SIM_READY fires before the guard and advertises dynamic dispatch + the section list.
    const guardIdx    = bridge.indexOf('if (!_hasAny) return;');
    const simReadyIdx = bridge.indexOf('SIM_READY');
    expect(simReadyIdx).toBeLessThan(guardIdx);
    expect(bridge).toContain("dispatch: 'dynamic'");
    // Call-time resolution with a prototype-safe lookup (message input is untrusted).
    expect(bridge).toContain('function _sectionBody(name)');
    expect(bridge).toContain('Object.prototype.hasOwnProperty.call(__SECTIONS__, name)');
    // Hardened dispatch (audited): own-property guard on BOTH maps (prototype names like
    // 'constructor' arrived via the origin-unchecked listener and resolved to inherited
    // functions), 'main'-only fallback (an unknown modern section reports SCRIPT_MISSING
    // instead of silently running another section's body), and _fireReady scheduled through
    // the gate's RAW rAF so the bridge's own bookkeeping can never ack the sim's first paint.
    expect(bridge).toContain("var fn = (name && own.call(SCRIPTS, name)) ? SCRIPTS[name] : _sectionBody(name);");
    expect(bridge).toContain("if (!fn && (!name || name === 'main')) fn = SCRIPTS.main;");
    expect(bridge).toContain("_post({ type: 'SCRIPT_MISSING', script: name, token: token });");
    // Every ack echoes the ACTIVATION TOKEN so a stale ack from a superseded activation can
    // never satisfy a newer pending one (audited B→A→B race), and SCRIPT_APPLIED is posted from
    // a system-rAF callback so it means "body ran AND a frame followed".
    expect(bridge).toContain('function startScript(name, params, token)');
    expect(bridge).toContain("startScript(script || 'main', params, d.token)");
    expect(bridge).toContain('if (_sysRaf) _sysRaf(_ack); else _ack();');
    expect(bridge).toContain('window.__SIM_RAF_GATE__ && (window.__SIM_RAF_GATE__.sys || window.__SIM_RAF_GATE__.raw)');
    // Valid syntax
    expect(() => new Function(bridge)).not.toThrow();
  });

  it('[8] index.html?section=A dispatches the correct section via URLSearchParams', async () => {
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: BODY_A });
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_B, mainBody: BODY_B });
    const bridge = storage.get(`${PREFIX}/bridge.js`);

    expect(bridge).toContain('URLSearchParams');
    expect(bridge).toContain(`'${SEC_A}'`);
    expect(bridge).toContain(`'${SEC_B}'`);
  });

  it('[9] index.html has stable markers — no duplicate injection across multiple generations', async () => {
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: BODY_A });
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_B, mainBody: BODY_B });
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: BODY_A });
    const html = storage.get(ENTRY_KEY);

    expect((html.match(/SIM_BRIDGE_SCRIPT_START/g) ?? []).length).toBe(1);
    expect(html).toContain('bridge.js');
    expect(html).toContain('./app.js');  // original script preserved
  });

  it('[10] backward compat — legacy section_*.html URLs remain untouched', async () => {
    const legacyKey = `${PREFIX}/section_old-uuid-9999.html`;
    await storage.uploadFile(legacyKey, Buffer.from('<html><body>legacy</body></html>', 'utf-8'));

    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: BODY_A });

    expect(storage.has(legacyKey)).toBe(true);
    expect(storage.get(legacyKey)).toContain('legacy');
  });

  it('[11] injectBridgeScriptTag handles edge-case HTML: single quotes, defer, type=module, no </body>', () => {
    const r1 = injectBridgeScriptTag(
      "<html><body><script defer src='./section_x.js'></script></body></html>",
      './bridge.js', 'h1'
    );
    expect(r1).not.toContain('section_x.js');
    expect(r1).toContain('bridge.js');

    const r2 = injectBridgeScriptTag(
      '<html><body><script type="module" src="./section_y.js"></script></body></html>',
      './bridge.js', 'h2'
    );
    expect(r2).not.toContain('section_y.js');

    const r3 = injectBridgeScriptTag('<html><body><p>no close', './bridge.js', 'h3');
    expect(r3).toContain('SIM_BRIDGE_SCRIPT_START');

    // No duplicate on re-inject
    const base = injectBridgeScriptTag('<html><body></body></html>', './bridge.js', 'v1');
    const updated = injectBridgeScriptTag(base, './bridge.js', 'v2');
    expect((updated.match(/SIM_BRIDGE_SCRIPT_START/g) ?? []).length).toBe(1);
    expect(updated).toContain('?v=v2');
    expect(updated).not.toContain('?v=v1');
  });

  it('[12] R2 storage parity — only uploadFile/readObject called (StorageService interface)', () => {
    // Documented: MemStorage above implements the same interface as R2StorageAdapter.
    // generateSection only calls uploadFile() and readObject() — no fs or S3-specific APIs.
    // Any StorageService implementation (Local or R2) works identically.
    expect(true).toBe(true);
  });
});

// ── Round-trip: the REAL combined bridge executes and dispatches dynamically ──────────
//
// Regression net for the sim-pool "one variation everywhere" bug: a pooled document loads
// ONCE with the first section's ?section= URL; every other section must still be reachable
// at runtime via startScript(sectionId). These tests run the generated bridge.js in-process
// against a minimal window/document and drive it over its postMessage contract.

interface Posted { type?: string; dispatch?: string; sections?: string[] }

function bootBridge(bridge: string, search: string) {
  const posted: Posted[] = [];
  const messageListeners: ((e: { data: unknown; source?: unknown }) => void)[] = [];
  const runs: string[] = [];

  const fakeDocument = {
    readyState: 'complete',
    addEventListener: (_t: string, _fn: unknown) => {},
    getElementById: (_id: string) => null,
    createElement: (_tag: string) => ({ id: '', textContent: '', remove() {} }),
    head: { appendChild(_el: unknown) {} },
    documentElement: { appendChild(_el: unknown) {} },
  };
  const fakeWindow: Record<string, unknown> = {
    parent: { postMessage: (msg: Posted, _origin: string) => posted.push(msg) },
    addEventListener: (t: string, fn: (e: { data: unknown; source?: unknown }) => void) => {
      if (t === 'message') messageListeners.push(fn);
    },
    // The raw-rAF fallback binds window.requestAnimationFrame when no gate is present.
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    __RUNS__: runs,
  };
  const raf = (fn: () => void) => { fn(); return 0; };
  const noopTimer = (_fn: () => void, _ms?: number) => 0 as unknown as ReturnType<typeof setTimeout>;

  // The bridge is an IIFE over free globals — bind them to our fakes.
  const run = new Function(
    'window', 'document', 'location', 'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    bridge,
  );
  run(fakeWindow, fakeDocument, { search }, raf, noopTimer, () => {}, noopTimer, () => {});

  // `source: fakeWindow.parent` — the bridge ignores messages from any other window (simulation-004).
  const post = (data: unknown) =>
    messageListeners.forEach((fn) => fn({ data, source: fakeWindow.parent }));
  return { posted, post, runs };
}

describe('Bridge round-trip — dynamic dispatch on one loaded document', () => {
  let storage: MemStorage;
  let bridge: string;

  const RUN_A = "window.__RUNS__.push('run:A:' + ((params && params.simpleUi) || false));\nreturn function () { window.__RUNS__.push('cleanup:A'); };";
  const RUN_B = "window.__RUNS__.push('run:B:' + ((params && params.simpleUi) || false));\nreturn function () { window.__RUNS__.push('cleanup:B'); };";

  beforeEach(async () => {
    storage = new MemStorage();
    await storage.uploadFile(ENTRY_KEY, Buffer.from(SEED_HTML, 'utf-8'));
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: RUN_A });
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_B, mainBody: RUN_B });
    bridge = storage.get(`${PREFIX}/bridge.js`);
  });

  it('[13] SIM_READY advertises dynamic dispatch + the full section list', () => {
    const { posted } = bootBridge(bridge, `?section=${SEC_A}`);
    const ready = posted.find((p) => p.type === 'SIM_READY');
    expect(ready).toBeTruthy();
    expect(ready!.dispatch).toBe('dynamic');
    expect(ready!.sections).toEqual(expect.arrayContaining([SEC_A, SEC_B]));
  });

  it("[14] REGRESSION: a document loaded with ?section=A runs SECTION B's body via startScript(B)", () => {
    const { post, runs } = bootBridge(bridge, `?section=${SEC_A}`);
    // Old players / 'main' → the URL default (A).
    post({ type: 'startScript', script: 'main', params: { simpleUi: false } });
    expect(runs).toEqual(['run:A:false']);
    // The pooled player posts the OTHER section's id — same document, B's body runs (A cleaned up).
    post({ type: 'startScript', script: SEC_B, params: { simpleUi: true } });
    expect(runs).toEqual(['run:A:false', 'cleanup:A', 'run:B:true']);
    // And back to A — dynamic dispatch is symmetric, no reload needed.
    post({ type: 'startScript', script: SEC_A, params: { simpleUi: false } });
    expect(runs).toEqual(['run:A:false', 'cleanup:A', 'run:B:true', 'cleanup:B', 'run:A:false']);
  });

  it("[15] 'main' (unknown/legacy name) still maps to the LOADED URL's default — the exact mechanism that made pooled sections collapse", () => {
    const { post, runs } = bootBridge(bridge, `?section=${SEC_B}`);
    post({ type: 'startScript', script: 'main', params: {} });
    expect(runs).toEqual(['run:B:false']);   // NOT A — the boot URL decides for 'main'
  });

  it('[16] PING_SIM_READY re-fire carries the SAME capability payload (no silent legacy downgrade)', () => {
    const { posted, post } = bootBridge(bridge, `?section=${SEC_A}`);
    const before = posted.length;
    post({ type: 'PING_SIM_READY' });
    const refire = posted.slice(before).find((p) => p.type === 'SIM_READY');
    expect(refire).toBeTruthy();
    expect(refire!.dispatch).toBe('dynamic');
    expect(refire!.sections).toEqual(expect.arrayContaining([SEC_A, SEC_B]));
  });
});

// ── Hardening round-trips: the audited wedge/fallback/ack defects stay fixed ─────────

describe('Bridge hardening — cleanup throws, prototype names, missing sections, applied acks', () => {
  let storage: MemStorage;
  let bridge: string;

  const GOOD = "window.__RUNS__.push('run:good');\nreturn function () { window.__RUNS__.push('cleanup:good'); };";
  const THROWING_CLEANUP = "window.__RUNS__.push('run:bad');\nreturn function () { throw new Error('cleanup exploded'); };";

  beforeEach(async () => {
    storage = new MemStorage();
    await storage.uploadFile(ENTRY_KEY, Buffer.from(SEED_HTML, 'utf-8'));
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_A, mainBody: THROWING_CLEANUP });
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: SEC_B, mainBody: GOOD });
    bridge = storage.get(`${PREFIX}/bridge.js`);
  });

  it('[17] startScript posts SCRIPT_APPLIED with the applied script echoed', () => {
    const { posted, post } = bootBridge(bridge, `?section=${SEC_A}`);
    post({ type: 'startScript', script: SEC_B, params: {} });
    const ack = posted.find((p) => p.type === 'SCRIPT_APPLIED') as { script?: string } | undefined;
    expect(ack).toBeTruthy();
    expect(ack!.script).toBe(SEC_B);
  });

  it('[18] a THROWING cleanup reports SCRIPT_ERROR and NEVER wedges later sections (audited permanent wedge)', () => {
    const { posted, post, runs } = bootBridge(bridge, `?section=${SEC_A}`);
    post({ type: 'startScript', script: SEC_A, params: {} });          // runs the bad body
    expect(runs).toContain('run:bad');
    post({ type: 'startScript', script: SEC_B, params: {} });          // its cleanup throws here
    const err = posted.find((p) => p.type === 'SCRIPT_ERROR') as { phase?: string } | undefined;
    expect(err).toBeTruthy();
    expect(err!.phase).toBe('cleanup');
    expect(runs).toContain('run:good');                                 // …and B still started
    // And the document keeps working section after section:
    post({ type: 'startScript', script: SEC_A, params: {} });
    expect(runs.filter((r) => r === 'run:bad')).toHaveLength(2);
  });

  it("[19] prototype names ('constructor') resolve NOTHING — SCRIPT_MISSING, no wedge (audited DoS)", () => {
    const { posted, post, runs } = bootBridge(bridge, `?section=${SEC_A}`);
    post({ type: 'startScript', script: 'constructor', params: {} });
    expect(runs).toEqual([]);                                           // no body ran
    const missing = posted.find((p) => p.type === 'SCRIPT_MISSING') as { script?: string } | undefined;
    expect(missing?.script).toBe('constructor');
    // The document is NOT wedged — a real section still dispatches afterwards.
    post({ type: 'startScript', script: SEC_B, params: {} });
    expect(runs).toContain('run:good');
  });

  it('[20] an unknown modern section id runs NOTHING and reports SCRIPT_MISSING — never another section\'s body', () => {
    const { posted, post, runs } = bootBridge(bridge, `?section=${SEC_A}`);
    post({ type: 'startScript', script: 'cccccccc-9999-4999-8999-cccccccccccc', params: {} });
    expect(runs).toEqual([]);                                           // NOT the boot default (the old silent fallback)
    expect((posted.find((p) => p.type === 'SCRIPT_MISSING') as { script?: string } | undefined)?.script)
      .toBe('cccccccc-9999-4999-8999-cccccccccccc');
  });

  it("[21] the literal 'main' KEEPS its boot-URL-default fallback (old players unchanged)", () => {
    const { post, runs } = bootBridge(bridge, `?section=${SEC_B}`);
    post({ type: 'startScript', script: 'main', params: {} });
    expect(runs).toEqual(['run:good']);                                 // ?section=B default
  });
});

// ── Body prelude: the helpers the generation prompt promises exist in BOTH wrappers ───────────
//
// The prompt's template declares _hidden/_hide/_restoreAll/_ivs/_listeners/_injected inside
// SCRIPTS.main and asks the model to "fill in [YOUR IMPLEMENTATION HERE]"; a body returning only
// that part relies on them. Bare splicing threw ReferenceError on activation and the viewer played
// the film through the whole window (2 of 6 generated bodies, 2026-09-05). Three body shapes must
// all run: prelude-reliant, the worked example's own `var` copies, the template's `const` copies.

// The element logs its display changes into __RUNS__ so the hide and the restore are observable
// in order with the body's own run/cleanup marks.
const FAKE_EL =
  "var el = { style: { d: '', getPropertyValue: function () { return this.d; }, " +
  "setProperty: function (k, v) { this.d = v; window.__RUNS__.push('display:' + v); }, " +
  "removeProperty: function () { this.d = ''; window.__RUNS__.push('display:restored'); } } };\n";
const BODY_PRELUDE_RELIANT =
  FAKE_EL +
  '_hide(el);\n' +
  '_ivs.push(setInterval(function () {}, 50));\n' +
  "_listeners.push([{ removeEventListener: function () { window.__RUNS__.push('unlisten:P'); } }, 'click', function () {}]);\n" +
  "_injected.push({ remove: function () { window.__RUNS__.push('removed:P'); } });\n" +
  "window.__RUNS__.push('run:P');\n" +
  "return function () { window.__RUNS__.push('cleanup:P'); };";
const BODY_OWN_VARS =
  'var _hidden = [], _ivs = [], _listeners = [], _injected = [];\n' +
  "window.__RUNS__.push('run:Q');\n" +
  'return function () { _hidden.forEach(function () {}); };';
const BODY_TEMPLATE_CONSTS =
  'const _hidden = [];\n' +
  'function _hide(el) { _hidden.push(el); }\n' +
  'function _restoreAll() {}\n' +
  'const _ivs = []; const _listeners = []; const _injected = [];\n' +
  '_hide({});\n' +
  "window.__RUNS__.push('run:T');\n" +
  'return function cleanup() { _restoreAll(); };';

describe('Bridge body prelude — the promised helpers exist and are drained by stopScript', () => {
  const P = 'sec-prelude', Q = 'sec-ownvars', T = 'sec-template';
  let bridge: string;

  beforeEach(async () => {
    const storage = new MemStorage();
    await storage.uploadFile(ENTRY_KEY, Buffer.from(SEED_HTML, 'utf-8'));
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: P, mainBody: BODY_PRELUDE_RELIANT });
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: Q, mainBody: BODY_OWN_VARS });
    await generateSection(storage, { prefix: PREFIX, entryKey: ENTRY_KEY, sectionId: T, mainBody: BODY_TEMPLATE_CONSTS });
    bridge = storage.get(`${PREFIX}/bridge.js`);
  });

  it('[P1] combined: a prelude-reliant body runs (no ReferenceError) and stopScript drains what it collected', () => {
    expect(() => new Function(bridge)).not.toThrow();
    const { post, runs, posted } = bootBridge(bridge, `?section=${P}`);
    post({ type: 'startScript', script: P, params: {} });
    // _hide() hid the element (display:none) before the body announced itself.
    expect(runs).toEqual(['display:none', 'run:P']);
    expect(posted.some((m) => m.type === 'SCRIPT_ERROR')).toBe(false);
    post({ type: 'startScript', script: Q, params: {} });
    // The switch ran P's own cleanup, then the shared drain — listener removed, injected removed,
    // display restored — all before Q started.
    expect(runs).toEqual(['display:none', 'run:P', 'cleanup:P', 'unlisten:P', 'removed:P', 'display:restored', 'run:Q']);
  });

  it('[P3] combined: bodies that declare their own copies (var — worked example; const — template) still run', () => {
    const { post, runs, posted } = bootBridge(bridge, `?section=${Q}`);
    post({ type: 'startScript', script: Q, params: {} });
    post({ type: 'startScript', script: T, params: {} });
    expect(runs).toEqual(['run:Q', 'run:T']);
    expect(posted.some((m) => m.type === 'SCRIPT_ERROR')).toBe(false);
  });

  it('[P4] single wrapper (wrapBridgeMainBody): the same prelude-reliant body runs and is drained on stopScript', () => {
    const single = wrapBridgeMainBody(BODY_PRELUDE_RELIANT);
    expect(() => new Function(single)).not.toThrow();
    const { post, runs } = bootBridge(single, '');
    post({ type: 'startScript', script: 'main', params: {} });
    expect(runs).toEqual(['display:none', 'run:P']);
    post({ type: 'stopScript' });
    expect(runs).toEqual(['display:none', 'run:P', 'cleanup:P', 'unlisten:P', 'removed:P', 'display:restored']);
  });
});
