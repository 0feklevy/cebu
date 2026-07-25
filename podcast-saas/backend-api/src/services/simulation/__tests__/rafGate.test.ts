/**
 * D1 — head rAF gate + idempotent entry-HTML injections.
 *
 * Covers:
 *  (a) head-gate + bridge injection idempotency — double-inject yields one gate, one bridge
 *  (b) the rAF gate snippet content (simPause/simResume handling, rAF wrap, __SIM_ENV)
 *  plus placement fallbacks, marker round-trips, coexistence with the combined bridge.js
 *  tag flow, and the deriveEntryRelPath helper the replace endpoint/ops script share.
 */
import { describe, it, expect } from 'vitest';
import {
  injectRafGate,
  stripRafGate,
  injectInlineBridge,
  injectBridgeScriptTag,
  deriveEntryRelPath,
  type BridgeFunction,
} from '../SimulationService.js';
import { wrapGuidanceCombined, type GuidanceEntryStored } from '../GuidanceService.js';

const GATE_MARKER = '<!-- sim-raf-gate v1 -->';
const NO_FNS: BridgeFunction[] = [];

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const SIM_HTML = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '  <title>Sim</title>',
  '  <script src="lib/three.js"></script>',
  '</head>',
  '<body>',
  '  <canvas id="view"></canvas>',
  '  <script src="app.js"></script>',
  '</body>',
  '</html>',
].join('\n');

// ── Gate placement ────────────────────────────────────────────────────────────

describe('injectRafGate — placement', () => {
  it('injects the gate at the START of <head>, before the sim\'s own scripts', () => {
    const out = injectRafGate(SIM_HTML);
    const gateAt = out.indexOf(GATE_MARKER);
    const headAt = out.indexOf('<head>');
    const simScriptAt = out.indexOf('<script src="lib/three.js">');
    expect(gateAt).toBeGreaterThan(headAt);
    expect(gateAt).toBeLessThan(simScriptAt);
  });

  it('falls back to before the first <script> when <head> is missing', () => {
    const html = '<div id="root"></div>\n<script src="app.js"></script>';
    const out = injectRafGate(html);
    expect(out.indexOf(GATE_MARKER)).toBeLessThan(out.indexOf('<script src="app.js">'));
    // The gate's own <script> comes first, but the sim script must still be present after it.
    expect(out.indexOf('app.js')).toBeGreaterThan(out.indexOf('<!-- /sim-raf-gate -->'));
  });

  it('falls back to the top of <body> when neither <head> nor <script> exists', () => {
    const html = '<html><body class="x"><div>hi</div></body></html>';
    const out = injectRafGate(html);
    const bodyOpenEnd = out.indexOf('<body class="x">') + '<body class="x">'.length;
    expect(out.indexOf(GATE_MARKER)).toBe(bodyOpenEnd + 1); // right after body + newline
  });

  it('prepends for fragment HTML with no head/script/body', () => {
    const out = injectRafGate('<div>fragment</div>');
    expect(out.startsWith(GATE_MARKER)).toBe(true);
    expect(out.endsWith('<div>fragment</div>')).toBe(true);
  });

  it('does not mistake <header> for <head> in head-less documents', () => {
    const html = '<html><body class="y"><header>title</header><div>x</div></body></html>';
    const out = injectRafGate(html);
    // Gate must land at the top of <body>, NOT inside/after the <header> open tag.
    expect(out.indexOf(GATE_MARKER)).toBeLessThan(out.indexOf('<header>'));
    expect(out.indexOf(GATE_MARKER)).toBeGreaterThan(out.indexOf('<body class="y">'));
  });
});

// ── (a) Idempotency ───────────────────────────────────────────────────────────

describe('injection idempotency', () => {
  it('double injectRafGate yields exactly one gate and identical bytes', () => {
    const once = injectRafGate(SIM_HTML);
    const twice = injectRafGate(once);
    expect(count(twice, GATE_MARKER)).toBe(1);
    expect(count(twice, 'sim-raf-gate v1 — auto-injected')).toBe(1);
    expect(twice).toBe(once);
  });

  it('collapses accidental duplicate gate blocks into one', () => {
    const once = injectRafGate(SIM_HTML);
    // Simulate a corrupted double block.
    const corrupted = once.replace('</head>', `${GATE_MARKER}\n<script>bad()</script>\n<!-- /sim-raf-gate -->\n</head>`);
    expect(count(corrupted, GATE_MARKER)).toBe(2);
    const fixed = injectRafGate(corrupted);
    expect(count(fixed, GATE_MARKER)).toBe(1);
  });

  it('double-inject (gate + inline bridge) yields one gate and one bridge', () => {
    const injectAll = (html: string) => injectInlineBridge(injectRafGate(html), NO_FNS);
    const once = injectAll(SIM_HTML);
    const twice = injectAll(once);
    expect(count(twice, GATE_MARKER)).toBe(1);
    expect(count(twice, '/* sim-bridge v2')).toBe(1);
    expect(twice).toBe(once);
  });

  it('inline bridge lands before </body>, after sim scripts', () => {
    const out = injectInlineBridge(injectRafGate(SIM_HTML), NO_FNS);
    const bridgeAt = out.indexOf('/* sim-bridge v2');
    expect(bridgeAt).toBeGreaterThan(out.indexOf('<script src="app.js">'));
    expect(bridgeAt).toBeLessThan(out.indexOf('</body>'));
  });

  it('does NOT reintroduce the inline bridge when the combined bridge.js block exists', () => {
    const withTag = injectBridgeScriptTag(injectRafGate(SIM_HTML), './bridge.js', 'abc123');
    const out = injectInlineBridge(withTag, NO_FNS);
    expect(out).toBe(withTag);
    expect(out).not.toContain('/* sim-bridge v2');
    expect(count(out, 'SIM_BRIDGE_SCRIPT_START')).toBe(1);
  });

  it('stripRafGate + injectRafGate round-trips to the original', () => {
    const once = injectRafGate(SIM_HTML);
    expect(stripRafGate(once)).toBe(SIM_HTML);
  });
});

// ── Coexistence with the generate/publish tag flows ───────────────────────────

describe('gate survives the combined-bridge tag flow', () => {
  it('injectBridgeScriptTag on gate+inline-bridge HTML keeps exactly one gate and strips the inline v2', () => {
    // State after a fresh upload: gate in head, inline v2 before </body>.
    const uploaded = injectInlineBridge(injectRafGate(SIM_HTML), NO_FNS);
    // First generation replaces the inline template with the combined bridge.js tag.
    const generated = injectBridgeScriptTag(uploaded, './bridge.js', 'deadbeef1234');
    expect(count(generated, GATE_MARKER)).toBe(1);
    expect(generated).not.toContain('/* sim-bridge v2');
    expect(generated).toContain('<script src="./bridge.js?v=deadbeef1234"></script>');
    // Sim's own scripts are untouched (the legacy cleanup regexes must not overreach).
    expect(generated).toContain('<script src="lib/three.js"></script>');
    expect(generated).toContain('<script src="app.js"></script>');
  });

  it('re-running the gate injection preserves existing bridge.js/guidance.js script tags', () => {
    let html = injectRafGate(SIM_HTML);
    html = injectBridgeScriptTag(html, './bridge.js', 'aaaa00000001');
    html = html.replace('</body>', '<!-- SIM_GUIDANCE_SCRIPT_START -->\n<script src="./guidance.js?v=bbbb00000002"></script>\n<!-- SIM_GUIDANCE_SCRIPT_END -->\n</body>');
    const again = injectInlineBridge(injectRafGate(html), NO_FNS);
    expect(again).toContain('bridge.js?v=aaaa00000001');
    expect(again).toContain('guidance.js?v=bbbb00000002');
    expect(count(again, GATE_MARKER)).toBe(1);
    expect(again).not.toContain('/* sim-bridge v2');
  });
});

// ── (b) Gate snippet content ──────────────────────────────────────────────────

describe('rAF gate snippet content', () => {
  const out = injectRafGate(SIM_HTML);

  it('handles simPause and simResume messages', () => {
    expect(out).toContain("d.type === 'simPause'");
    expect(out).toContain("d.type === 'simResume'");
    expect(out).toContain("window.addEventListener('message'");
  });

  it('wraps requestAnimationFrame and cancelAnimationFrame', () => {
    expect(out).toContain('window.requestAnimationFrame = function');
    expect(out).toContain('window.cancelAnimationFrame = function');
    // Native handles are captured before wrapping.
    expect(out).toContain('window.requestAnimationFrame.bind(window)');
  });

  it('replays queued callbacks via the NATIVE rAF (no fabricated timestamps)', () => {
    expect(out).toContain('nativeRaf(pending[i].cb)');
    expect(out).not.toContain('performance.now');
    expect(out).not.toContain('Date.now');
  });

  it('is runtime-guarded against double installation', () => {
    expect(out).toContain('if (window.__SIM_RAF_GATE__) return;');
  });

  it('exposes window.__SIM_ENV parsed from the iframe URL params', () => {
    expect(out).toContain('window.__SIM_ENV');
    for (const param of ['lowend', 'dpr', 'mem', 'section']) {
      expect(out).toContain(`q.get('${param}')`);
    }
  });

  it('adds no visibilitychange logic (strictly message-driven)', () => {
    expect(out).not.toContain('visibilitychange');
  });

  it('is not matched by the legacy inline-bridge cleanup regexes', () => {
    const cleaned = out
      .replace(/<script[^>]*>\s*\/\* sim-bridge[\s\S]*?<\/script>/gi, '')
      .replace(/<script[^>]*>\s*;?\s*\(function[\s\S]*?sim-bridge v[12][\s\S]*?<\/script>/gi, '');
    expect(count(cleaned, GATE_MARKER)).toBe(1);
    expect(cleaned).toContain("d.type === 'simPause'");
  });
});

// ── guidance.js — rAF poll goes through the gate; pauseScript semantics intact ─

describe('guidance.js template', () => {
  const entries: GuidanceEntryStored[] = [
    {
      id: 'cue1', kind: 'config', title: 'T', narration: 'N', enabled: true,
      trigger: { kind: 'config', predicateBody: 'return true;', observables: [], debounce: 3 },
      audioUrl: null, confidence: 0.9, warnings: [],
    },
  ];
  const js = wrapGuidanceCombined(entries);

  it('polls via requestAnimationFrame (frozen by the head gate on simPause)', () => {
    expect(js).toContain('requestAnimationFrame(_loop)');
    // No interval-based polling that would bypass the rAF gate (the word appears in a
    // comment documenting exactly that, so assert on call sites).
    expect(js).not.toContain('setInterval(');
  });

  it('keeps the existing pauseScript semantics unchanged', () => {
    expect(js).toContain("d.type === 'stopScript' || d.type === 'pauseScript'");
  });
});

// ── deriveEntryRelPath ────────────────────────────────────────────────────────

describe('deriveEntryRelPath', () => {
  const prefix = 'simulations/proj-1/sim-1';

  it('handles storage-key entry_file values', () => {
    expect(deriveEntryRelPath('simulations/proj-1/sim-1/index.html', prefix)).toBe('index.html');
    expect(deriveEntryRelPath('simulations/proj-1/sim-1/nested/main.htm', prefix)).toBe('nested/main.htm');
  });

  it('handles legacy full-URL entry_file values (with query strings)', () => {
    expect(deriveEntryRelPath('https://cdn.example.com/sim-public/simulations/proj-1/sim-1/index.html?v=abc', prefix))
      .toBe('index.html');
    expect(deriveEntryRelPath('http://localhost:4000/sim-public/simulations/proj-1/sim-1/sub/entry.html', prefix))
      .toBe('sub/entry.html');
  });

  it('returns null when underivable', () => {
    expect(deriveEntryRelPath('', prefix)).toBeNull();
    expect(deriveEntryRelPath(null, prefix)).toBeNull();
    expect(deriveEntryRelPath('simulations/other/sim-9/index.html', prefix)).toBeNull();
    expect(deriveEntryRelPath('https://cdn.example.com/media/other.html', prefix)).toBeNull();
  });
});
