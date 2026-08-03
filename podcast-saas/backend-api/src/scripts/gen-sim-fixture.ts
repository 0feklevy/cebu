/**
 * Deterministic simulation-package FIXTURE generator — for browser transition tests only.
 *
 * Emits a package whose bytes are IDENTICAL in shape to what production serves: the real head
 * rAF gate (injectRafGate), the real serve-time minimal-UI boot snippet (injectSimBootSnippet),
 * the real combined bridge (wrapBridgeCombined + buildSectionEntry) and the real bridge script
 * tag (injectBridgeScriptTag). Only the SECTION BODIES are fixtures, chosen so a screenshot can
 * tell — by colour alone — which section is applied and whether Full UI is showing:
 *
 *   page background      GREEN   (#00c000)  → minimal UI (controls hidden)
 *   .controls overlay    RED     (#ff0000)  → FULL UI is visible
 *   #marker              BLUE    (#0000ff)  → section A applied
 *                        YELLOW  (#ffff00)  → section B applied
 *                        GREY    (#808080)  → no section applied (boot state)
 *
 * A second package is emitted with a LEGACY bridge (no SCRIPT_APPLIED/SCRIPT_MISSING and the old
 * unguarded dispatch) so the compatibility path can be tested against a real old-shaped document.
 *
 *   npx tsx src/scripts/gen-sim-fixture.ts <outDir>
 *
 * This is a TEST TOOL. It is never imported by the server and writes only to the given directory.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  injectBridgeScriptTag,
  injectRafGate,
  wrapBridgeCombined,
} from '../services/simulation/SimulationService.js';
import { injectSimBootSnippet } from '../controllers/sim-public.controller.js';

export const FIXTURE_SECTIONS = {
  A: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  B: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  SLOW: 'cccccccc-3333-4333-8333-cccccccccccc',
  THROWS: 'dddddddd-4444-4444-8444-dddddddddddd',
  AUTO: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
} as const;

/** Marks the section and paints its colour; cleanup returns to the neutral boot state. */
const bodyFor = (label: string, colour: string, extra = '') => `
  var el = document.getElementById('marker');
  ${extra}
  el.style.background = ${JSON.stringify(colour)};
  el.setAttribute('data-section', ${JSON.stringify(label)});
  window.__APPLIED__ = (window.__APPLIED__ || []); window.__APPLIED__.push(${JSON.stringify(label)});
  return function cleanup() {
    el.style.background = '#808080';
    el.setAttribute('data-section', 'none');
  };
`;

const SECTION_BODIES: Record<string, string> = {
  [FIXTURE_SECTIONS.A]: bodyFor('A', '#0000ff'),
  [FIXTURE_SECTIONS.B]: bodyFor('B', '#ffff00'),
  // Applies only after a BLOCKING delay longer than the player's 200ms ack ceiling.
  [FIXTURE_SECTIONS.SLOW]: bodyFor('SLOW', '#ff00ff', "var t0 = Date.now(); while (Date.now() - t0 < 450) { /* block */ }"),
  // Applies fine, but its cleanup throws — the audited "wedges every later switch" case.
  // Auto-demo driven by setInterval exactly as the generation prompt mandates: the handle lives
  // in the body closure, which is why pauseScript needed the bridge's timer scope to reach it.
  [FIXTURE_SECTIONS.AUTO]: `
    var el = document.getElementById('marker');
    el.style.background = '#0000ff';
    el.setAttribute('data-section', 'AUTO');
    window.__TICKS__ = 0;
    window.__ENGINE__ = 0;
    // The DEMO timer, registered exactly as the generation prompt now mandates. Only registered
    // handles are stopped by pauseScript.
    var iv = simDemoTimer(setInterval(function () { window.__TICKS__++; }, 20));
    // An UNREGISTERED timer standing in for the simulation's OWN engine loop — a body that calls
    // into the sim synchronously schedules these too. pauseScript must NOT touch it: clearing it
    // would freeze the scene, which is strictly worse than the automation it meant to stop.
    var engine = setInterval(function () { window.__ENGINE__++; }, 20);
    return function cleanup() {
      clearInterval(iv); clearInterval(engine);
      el.setAttribute('data-section', 'none');
    };
  `,
  [FIXTURE_SECTIONS.THROWS]: `
    var el = document.getElementById('marker');
    el.style.background = '#00ffff';
    el.setAttribute('data-section', 'THROWS');
    return function cleanup() { throw new Error('fixture cleanup exploded'); };
  `,
};

const NO_RAF_ENTRY = (): string => ENTRY_HTML.replace(
  /<script>[\s\S]*?<\/script>\s*<\/body>/,
  '<script>var c=document.getElementById("scene").getContext("2d");c.fillStyle="#000";c.fillRect(0,0,10,10);</script></body>',
);

const ENTRY_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>fixture sim</title>
  <style>
    html, body { margin: 0; height: 100%; background: #00c000; }           /* minimal-UI green */
    .controls { position: fixed; inset: 0; background: #ff0000; z-index: 5; }  /* FULL UI red */
    #marker { position: fixed; left: 0; top: 0; width: 100%; height: 40%; background: #808080; z-index: 9; }
  </style>
</head>
<body>
  <div id="marker" data-section="none"></div>
  <div class="controls">FULL UI</div>
  <canvas id="scene" width="10" height="10"></canvas>
  <script>
    // A real sim paints inside its OWN rAF — this is what may legitimately ack SIM_PAINTED.
    requestAnimationFrame(function () {
      var c = document.getElementById('scene').getContext('2d');
      c.fillStyle = '#000'; c.fillRect(0, 0, 10, 10);
      window.__SIM_PAINTED_SELF__ = true;
    });
  </script>
</body>
</html>`;


/**
 * DELAYED-ACK bridge — the fixture that makes the apply gate observable at viewer level.
 *
 * WHY IT EXISTS. The gate only changes behaviour when a section takes real time to apply. The
 * blocking SLOW body cannot demonstrate that: the sim is served from the API origin (the only one
 * the app's CSP admits, and the one resolveAssetUrl rewrites every loopback URL to), which is
 * SAME-SITE with the app, so the sim shares the parent's process — a busy loop freezes the parent's
 * own opacity sampler along with it. Measured: with an instantly-applying body the clean and
 * dead-gate opacity trajectories are byte-identical, so the suite could not tell them apart.
 *
 * This bridge instead defers application with setTimeout: the event loop keeps running, the parent
 * keeps sampling, and there is a real ~DELAY_MS window in which the frame MUST stay hidden because
 * the acknowledgement has not arrived. A dead gate reveals inside that window; a live one does not.
 *
 * It also records deterministic protocol evidence (type/script/token and four timestamps) on
 * window.__PROTO__, so the test can correlate the parent's opacity samples with the exact instant
 * the child acknowledged — no slices, no settle delays, no fixed allowance of wrong frames.
 */
function delayedAckBridge(entries: Map<string, string>, delayMs = 500): string {
  const sections = JSON.stringify(Object.fromEntries(
    [...entries.entries()].map(([id, body]) => [id, body]),
  ));
  return `/* fixture: delayed-ack bridge (non-blocking, ${delayMs}ms) */
(function () {
  var SECTIONS = ${sections};
  var DELAY = ${delayMs};
  var PROTO = (window.__PROTO__ = []);
  var _cancel = null;
  var _pending = null;

  function post(msg) { try { parent.postMessage(msg, '*'); } catch (e) {} }
  function now() { return Date.now(); }
  // The parent is CROSS-ORIGIN (the app's CSP admits only the API origin), so it cannot read
  // window.__PROTO__ directly. Every record is posted as well — that is the evidence channel.
  function record(e) { PROTO.push(e); post({ type: 'PROTO', entry: e }); }

  function applySection(name, params, token, receivedAt) {
    var applyStart = now();
    if (_cancel) { try { _cancel(); } catch (e) {} _cancel = null; }
    var fn = Object.prototype.hasOwnProperty.call(SECTIONS, name) ? SECTIONS[name] : null;
    if (!fn) {
      record({ type: 'SCRIPT_MISSING', script: name, token: token, receivedAt: receivedAt,
               applyStart: applyStart, applyComplete: null, ackAt: now() });
      post({ type: 'SCRIPT_MISSING', script: name, token: token });
      return;
    }
    try {
      _cancel = new Function('params', fn)(params || {}) || null;
    } catch (err) {
      record({ type: 'SCRIPT_ERROR', script: name, token: token, receivedAt: receivedAt,
               applyStart: applyStart, applyComplete: null, ackAt: now() });
      post({ type: 'SCRIPT_ERROR', phase: 'start', script: name, token: token, message: String(err) });
      return;
    }
    var applyComplete = now();
    // The acknowledgement is emitted only once the section is genuinely applied — which is the
    // contract the gate relies on, and the thing a dead gate ignores.
    var ackAt = now();
    record({ type: 'SCRIPT_APPLIED', script: name, token: token, receivedAt: receivedAt,
             applyStart: applyStart, applyComplete: applyComplete, ackAt: ackAt });
    post({ type: 'SCRIPT_APPLIED', script: name, token: token });
  }

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'startScript') {
      var receivedAt = now();
      record({ type: 'startScript', script: d.script, token: d.token, receivedAt: receivedAt,
               applyStart: null, applyComplete: null, ackAt: null });
      if (_pending) { clearTimeout(_pending); _pending = null; }
      // NON-BLOCKING delay: the event loop and the parent's sampler keep running throughout.
      _pending = setTimeout(function () {
        _pending = null;
        applySection(d.script, d.params, d.token, receivedAt);
      }, DELAY);
      return;
    }
    if (d.type === 'stopScript') {
      record({ type: 'stopScript', script: null, token: null, receivedAt: now(),
               applyStart: null, applyComplete: null, ackAt: null });
      if (_pending) { clearTimeout(_pending); _pending = null; }
      if (_cancel) { try { _cancel(); } catch (err) {} _cancel = null; }
      return;
    }
    if (d.type === 'PING_SIM_READY') post(readyMsg());
    if (d.type === 'PING_SIM_PAINTED' && window.__SIM_PAINTED_SELF__) post({ type: 'SIM_PAINTED' });
  });

  function readyMsg() {
    var ids = []; for (var k in SECTIONS) { if (Object.prototype.hasOwnProperty.call(SECTIONS, k)) ids.push(k); }
    return { type: 'SIM_READY', dispatch: 'dynamic', sections: ids };
  }
  post(readyMsg());
})();`;
}

/** The pre-v2.1 bridge: no SCRIPT_APPLIED/MISSING/ERROR, unguarded dispatch + cleanup. */
function legacyBridge(entries: Map<string, string>): string {
  const bodies = [...entries.entries()]
    .map(([id, body]) => `    ${JSON.stringify(id)}: function (params) {${body}},`)
    .join('\n');
  return `;(function () {
  var __SECTIONS__ = {
${bodies}
  };
  var _ready = false;
  function _fireReady() {
    if (_ready) return; _ready = true; window._simReadyFired = true;
    var ids = []; for (var k in __SECTIONS__) { if (Object.prototype.hasOwnProperty.call(__SECTIONS__, k)) ids.push(k); }
    window.parent && window.parent.postMessage({ type: 'SIM_READY', dispatch: 'dynamic', sections: ids }, '*');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(_fireReady); });
  else requestAnimationFrame(_fireReady);
  var _defaultSectionId = new URLSearchParams(location.search).get('section');
  var _cancelFn = null, _lastSig = null;
  function _sectionBody(name) { return (name && Object.prototype.hasOwnProperty.call(__SECTIONS__, name)) ? __SECTIONS__[name] : null; }
  var SCRIPTS = { main: function (params) { var b = _sectionBody(_defaultSectionId); return b ? b(params) : null; } };
  function applyHideUi(params) {
    var st = document.getElementById('__simHideUi');
    if (params && params.simpleUi && params.hideSelectors && params.hideSelectors.length) {
      var rules = [];
      for (var i = 0; i < params.hideSelectors.length; i++) rules.push(params.hideSelectors[i] + '{display:none !important}');
      if (!st) { st = document.createElement('style'); st.id = '__simHideUi'; document.head.appendChild(st); }
      st.textContent = rules.join('\\n'); return;
    }
    if (st && st.remove) st.remove();
  }
  function stopScript() {
    if (_cancelFn) { _cancelFn(); _cancelFn = null; }        /* UNGUARDED — the audited wedge */
    _lastSig = null;
    var st = document.getElementById('__simHideUi'); if (st && st.remove) st.remove();
  }
  function startScript(name, params) {
    var sig = (name || 'main') + ':' + JSON.stringify(params || {});
    if (_cancelFn && sig === _lastSig) return;
    stopScript(); _lastSig = sig; applyHideUi(params);
    var bh = document.getElementById('__simBootHide'); if (bh && bh.remove) bh.remove();
    var fn = SCRIPTS[name] || _sectionBody(name) || SCRIPTS.main;   /* silent wrong-section fallback */
    if (fn) _cancelFn = fn(params || {}) || null;
  }
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'startScript') startScript(d.script || 'main', d.params);
    if (d.type === 'stopScript') stopScript();
    if (d.type === 'PING_SIM_READY' && window._simReadyFired) {
      var ids = []; for (var k in __SECTIONS__) { if (Object.prototype.hasOwnProperty.call(__SECTIONS__, k)) ids.push(k); }
      window.parent && window.parent.postMessage({ type: 'SIM_READY', dispatch: 'dynamic', sections: ids }, '*');
    }
  });
})();`;
}

function emit(outDir: string, name: string, bridgeJs: string, entry: string = ENTRY_HTML): void {
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256').update(bridgeJs).digest('hex').slice(0, 12);
  writeFileSync(join(dir, 'bridge.js'), bridgeJs);
  // Exactly what the proxy serves: gate in <head>, bridge script tag, boot snippet.
  const html = injectSimBootSnippet(injectBridgeScriptTag(injectRafGate(entry), './bridge.js', hash));
  writeFileSync(join(dir, 'index.html'), html);
}

function main(): void {
  const outDir = process.argv[2];
  if (!outDir) { console.error('usage: gen-sim-fixture.ts <outDir>'); process.exit(1); }
  // wrapBridgeCombined takes RAW bodies and applies buildSectionEntry itself — pre-wrapping
  // here produced a nested object literal that failed to parse in the browser.
  const entries = new Map<string, string>(Object.entries(SECTION_BODIES));

  emit(outDir, 'modern', wrapBridgeCombined(entries));
  emit(outDir, 'legacy', legacyBridge(new Map(Object.entries(SECTION_BODIES))));
  emit(outDir, 'noraf', wrapBridgeCombined(entries), NO_RAF_ENTRY());
  emit(outDir, 'delayedack', delayedAckBridge(new Map(Object.entries(SECTION_BODIES))));

  console.log(JSON.stringify({
    outDir, packages: ['modern', 'legacy', 'noraf', 'delayedack'], sections: FIXTURE_SECTIONS,
  }, null, 2));
}

main();
