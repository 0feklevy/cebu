/**
 * Bridge-compatibility gate for "Replace simulation".
 *
 * The fixtures mirror the anchor shapes found in the DEPLOYED bridges (boids-3d,
 * murmuration-knob): structural selectors, label-text matching, window globals and API members,
 * plus controls that only exist because the sim's own JS builds them at runtime.
 *
 * Against those real packages this module scores 20/20 — every benign edit (identical files,
 * colours, whitespace, retuned constants, appended features) verifies COMPATIBLE and every
 * renamed anchor (class, selector, label text, window global, API method) is refused with
 * per-section attribution. These tests pin that behaviour without needing the network.
 */
import { describe, expect, it } from 'vitest';
import {
  checkReplaceCompatibility,
  describeIncompatibility,
  extractBridgeContract,
  type CandidateBundle,
} from '../SimBridgeContract.js';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

const SEC_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SEC_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** Section A: structural selectors + label text (the boids "show only the rule sliders" shape). */
const BODY_A = `
  var scroll = document.querySelector('.controls-scroll');
  var rows = document.querySelectorAll('.controls .slider-container');
  for (var i = 0; i < rows.length; i++) {
    var lab = rows[i].querySelector('label');
    if (lab && lab.textContent.trim().toLowerCase() === 'separation:') { rows[i].classList.add('control-hidden'); }
  }
  if (window.app && window.app.rig) window.app.setMode(3);
  return function cleanup() {};
`;

/**
 * Section B: pure JS-API driver, no DOM at all — copied in shape from the deployed
 * murmuration-knob body, including its `var app = window.__knob` aliasing.
 */
const BODY_B = `
  function getKnob() {
    var app = window.__knob;
    return (app && app.knob && typeof app.knob.setValue === 'function') ? app.knob : null;
  }
  var k = getKnob(); if (k) k.setValue(1.0);
  return function cleanup() {};
`;

const bridgeWith = (entries: [string, string][]): string =>
  entries.map(([id, body]) => `/* @@SIM_BRIDGE:${id}@@ */\n'${id}': function (params) {${body}},\n/* @@/SIM_BRIDGE:${id}@@ */`).join('\n');

const BRIDGE = bridgeWith([[SEC_A, BODY_A], [SEC_B, BODY_B]]);

const ENTRY = 'sim/index.html';
/** The entry ships only a canvas + script tag; every control is built at runtime by main.js. */
const HTML = `<!doctype html><html><head><link rel="stylesheet" href="./app.css"></head>
<body><canvas id="scene"></canvas><script type="module" src="./src/main.js"></script></body></html>`;
const MAIN_JS = `
  import { Knob } from './Knob.js';
  export const app = { rig: null, setMode(n) { this.mode = n; }, menu: null, flock: null };
  window.app = app;
  function buildMenu() {
    var el = document.createElement('div');
    el.className = 'controls-scroll';
    el.innerHTML = '<div class="slider-container"><label>Separation:</label><input type="range"></div>';
    document.body.appendChild(el);
  }
  buildMenu();
`;
const KNOB_JS = `
  export class Knob { setValue(v) { this.value = v; } }
  window.__knob = { knob: new Knob() };
`;
const APP_CSS = `.controls-scroll { overflow: auto } .control-hidden { display: none } .controls { color: #ff0000 }`;

const bundleOf = (over: Record<string, string> = {}): CandidateBundle => {
  const base: Record<string, string> = {
    [ENTRY]: HTML,
    'sim/src/main.js': MAIN_JS,
    'sim/src/Knob.js': KNOB_JS,
    'sim/app.css': APP_CSS,
  };
  const files = new Map<string, Buffer>();
  for (const [k, v] of Object.entries({ ...base, ...over })) files.set(k, Buffer.from(v, 'utf8'));
  return { files, entryRelPath: ENTRY };
};

/** Apply a rename across every file (what a real "new version" edit looks like). */
const renamed = (from: string, to: string): CandidateBundle => {
  const b = bundleOf();
  const files = new Map<string, Buffer>();
  for (const [k, v] of b.files) files.set(k, Buffer.from(v.toString('utf8').split(from).join(to), 'utf8'));
  return { files, entryRelPath: ENTRY };
};

const check = (bundle: CandidateBundle, bridgeJs = BRIDGE) => checkReplaceCompatibility({ bridgeJs, bundle });

// ── Extraction ──────────────────────────────────────────────────────────────────────────

describe('extractBridgeContract — what a section body requires of the simulation', () => {
  it('captures selectors, label text, classes, globals and API members', () => {
    const c = extractBridgeContract(BODY_A);
    expect(c.selectors).toEqual(expect.arrayContaining(['.controls-scroll', '.controls .slider-container', 'label']));
    expect(c.texts).toContain('separation:');
    expect(c.classes).toContain('control-hidden');
    expect(c.globals).toContain('app');
    expect(c.members).toEqual(expect.arrayContaining(['rig', 'setMode']));
  });

  it('captures an arbitrary window global and its API method (no DOM at all)', () => {
    const c = extractBridgeContract(BODY_B);
    expect(c.globals).toContain('__knob');
    expect(c.members).toEqual(expect.arrayContaining(['knob', 'setValue']));
    expect(c.ids).toHaveLength(0);
    expect(c.selectors).toHaveLength(0);
  });

  it('never treats bridge builtins or generic DOM members as simulation contract', () => {
    const c = extractBridgeContract(`
      window.parent.postMessage({ type: 'x' }, '*');
      document.querySelector('#a').style.display = 'none';
      window.setTimeout(function () {}, 10);
      var n = window.app.items.length; window.app.list.forEach(function () {});
    `);
    expect(c.globals).not.toContain('parent');
    expect(c.globals).not.toContain('setTimeout');
    expect(c.members).not.toContain('length');
    expect(c.members).not.toContain('forEach');
    expect(c.members).not.toContain('style');
  });
});

// ── Specificity: legitimate edits must NEVER be blocked ─────────────────────────────────

describe('specificity — a slightly-edited simulation still adopts the bridge', () => {
  it('IDENTICAL files are compatible (a checker that fails the no-op replace is useless)', () => {
    const r = check(bundleOf());
    expect(r.compatible).toBe(true);
    expect(r.summary).toMatchObject({ sectionsTotal: 2, sectionsOk: 2, sectionsBroken: 0 });
  });

  it('resolves controls that exist ONLY in runtime-built JS, never in the entry HTML', () => {
    // The decisive property: .controls-scroll / .slider-container / "Separation:" appear solely
    // inside main.js. Resolving against the HTML alone would wrongly refuse this replace.
    expect(HTML).not.toContain('controls-scroll');
    expect(HTML).not.toContain('Separation');
    expect(check(bundleOf()).compatible).toBe(true);
  });

  it('tolerates cosmetic, whitespace, constant and feature-addition edits', () => {
    const edits: Record<string, (s: string) => string> = {
      colours: (s) => s.replace(/#[0-9a-fA-F]{6}\b/g, '#123456'),
      whitespace: (s) => s.replace(/\n/g, '\n  '),
      constants: (s) => s.replace(/1\.0/g, '0.75'),
      appended: (s) => `${s}\n// new feature\nfunction __extra() { return 42; }\n`,
    };
    for (const [name, fn] of Object.entries(edits)) {
      const b = bundleOf();
      const files = new Map<string, Buffer>();
      for (const [k, v] of b.files) files.set(k, Buffer.from(fn(v.toString('utf8')), 'utf8'));
      expect(check({ files, entryRelPath: ENTRY }).compatible, name).toBe(true);
    }
  });

  it('ignores the PRESERVED generated artifacts when judging the new sources', () => {
    // bridge.js survives a replace, so it must never vouch for anchors the new sim dropped.
    const withStaleBridge = bundleOf({ 'sim/bridge.js': BRIDGE, 'sim/src/main.js': 'export const app = {};' });
    expect(check(withStaleBridge).compatible).toBe(false);
  });
});

// ── Sensitivity: real breakage must be refused ──────────────────────────────────────────

describe('sensitivity — a too-big change is refused, with per-section attribution', () => {
  it('refuses a renamed structural class', () => {
    const r = check(renamed('controls-scroll', 'panel-scroll'));
    expect(r.compatible).toBe(false);
    const broken = r.sections.filter((s) => s.status === 'broken');
    expect(broken.map((s) => s.sectionId)).toEqual([SEC_A]);      // section B is untouched
    expect(broken[0].missing.some((m) => m.atom === '.controls-scroll')).toBe(true);
  });

  it('refuses a renamed label text (the bridge matches on it)', () => {
    const r = check(renamed('Separation', 'Repel'));
    expect(r.compatible).toBe(false);
    expect(r.sections.find((s) => s.sectionId === SEC_A)!.missing.some((m) => m.kind === 'text')).toBe(true);
  });

  it('refuses a renamed window global', () => {
    const r = check(renamed('__knob', '__dial'));
    expect(r.compatible).toBe(false);
    const b = r.sections.find((s) => s.sectionId === SEC_B)!;
    expect(b.status).toBe('broken');
    expect(b.missing.some((m) => m.kind === 'global' && m.token === 'window.__knob')).toBe(true);
  });

  it('refuses a renamed API method', () => {
    const r = check(renamed('setValue', 'setVal'));
    expect(r.compatible).toBe(false);
    expect(r.sections.find((s) => s.sectionId === SEC_B)!.missing.some((m) => m.token === '.setValue()')).toBe(true);
  });

  it('refuses a completely different simulation (every section breaks)', () => {
    const bundle: CandidateBundle = {
      files: new Map([[ENTRY, Buffer.from('<html><body><canvas id="c"></canvas><script>var q=1;</script></body></html>', 'utf8')]]),
      entryRelPath: ENTRY,
    };
    const r = check(bundle);
    expect(r.compatible).toBe(false);
    expect(r.summary.sectionsBroken).toBe(2);
  });

  it('ONE broken section refuses the WHOLE replace (owner policy: no partial swap)', () => {
    const r = check(renamed('controls-scroll', 'panel-scroll'));
    expect(r.summary.sectionsOk).toBe(1);       // section B is perfectly fine …
    expect(r.summary.sectionsBroken).toBe(1);
    expect(r.compatible).toBe(false);           // … and the replace is still refused
  });
});

// ── Structural gate ─────────────────────────────────────────────────────────────────────

describe('structural gate — the bundle must be able to host the bridge at all', () => {
  it('refuses an entry that references a script missing from the upload', () => {
    const bundle: CandidateBundle = { files: new Map([[ENTRY, Buffer.from(HTML, 'utf8')]]), entryRelPath: ENTRY };
    const r = check(bundle);
    expect(r.compatible).toBe(false);
    expect(r.structural.join(' ')).toContain('sim/src/main.js');
  });

  it('refuses an empty or non-HTML entry file', () => {
    expect(check(bundleOf({ [ENTRY]: '   ' })).structural.join(' ')).toContain('empty');
    expect(check(bundleOf({ [ENTRY]: 'just text, no markup' })).compatible).toBe(false);
  });

  it('does not demand the generated bridge.js be present in the upload', () => {
    // It is re-injected by processReplace; requiring it would break every legitimate replace.
    expect(check(bundleOf()).structural).toEqual([]);
  });
});

// ── Reporting ───────────────────────────────────────────────────────────────────────────

describe('the refusal tells the owner exactly what to fix', () => {
  it('names the section and the missing anchors, and suggests the escape route', () => {
    const msg = describeIncompatibility(check(renamed('controls-scroll', 'panel-scroll')));
    expect(msg).toContain(SEC_A);
    expect(msg).toContain('.controls-scroll');
    expect(msg).toContain('upload it as a NEW simulation');
  });

  it('a compatible report reads as success', () => {
    expect(describeIncompatibility(check(bundleOf()))).toContain('compatible');
  });

  it('a package with no bridge yet is trivially compatible (nothing to preserve)', () => {
    const r = check(bundleOf(), '');
    expect(r.compatible).toBe(true);
    expect(r.summary.sectionsTotal).toBe(0);
  });
});

// ── Minimal-UI hide selectors: reported, never blocking ─────────────────────────────────

describe('Minimal-UI hide selectors degrade rather than block', () => {
  it('flags a hide selector the new files no longer provide, without refusing the replace', () => {
    const r = checkReplaceCompatibility({
      bridgeJs: bridgeWith([[SEC_B, BODY_B]]),          // only the DOM-free section
      bundle: bundleOf(),
      sections: [{ id: SEC_B, simMeta: { uiControls: { controls: [], show: [], hide: ['.gone-forever'] } } }],
    });
    expect(r.compatible).toBe(true);                     // clean view degrades; demo still runs
    expect(r.staleHideSelectors).toEqual([{ sectionId: SEC_B, selectors: ['.gone-forever'] }]);
  });

  it('does not flag hide selectors that still exist', () => {
    const r = checkReplaceCompatibility({
      bridgeJs: bridgeWith([[SEC_B, BODY_B]]),
      bundle: bundleOf(),
      sections: [{ id: SEC_B, simMeta: { uiControls: { controls: [], show: [], hide: ['.controls-scroll'] } } }],
    });
    expect(r.staleHideSelectors).toEqual([]);
  });
});
