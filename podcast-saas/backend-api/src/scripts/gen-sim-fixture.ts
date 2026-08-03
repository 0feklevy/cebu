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
 * THE PACKAGES, and what each one is the ONLY honest source of:
 *   modern      — the real combined bridge + the real v4 rAF gate. The baseline.
 *   legacy      — the pre-v2.1 bridge (no acks, unguarded dispatch). Still advertises
 *                 `dispatch: 'dynamic'` and still carries the v4 gate, so it PAINTS.
 *   noraf       — modern bridge, entry document that draws OUTSIDE requestAnimationFrame.
 *   nopaint     — the honest never-acks-a-paint document (see below).
 *   delayedack  — production-parity late acknowledgements (see delayedAckBridge).
 *
 * WHY `nopaint` EXISTS. `legacy`, `noraf` and `delayedack` all advertise
 * `{type:'SIM_READY', dispatch:'dynamic'}`, and emit() injects the real v4 rAF gate into every
 * package — so learnCanEmitPaint() folds `dynamic === true` into `canEmitPaint = true` for all of
 * them, and the injected gate (plus the e2e harness's own requestAnimationFrame reporter) makes
 * even `noraf` post SIM_PAINTED. Consequence, verified: `canEmitPaint === false` was UNREACHABLE
 * in the whole e2e suite, so the viewer's `!m.canEmitPaint` bounded-hold force-reveal branch had
 * zero coverage. `nopaint` is a document that can become READY, advertises NO dispatch capability
 * (bare SIM_READY → the viewer classifies it load-time-locked, canEmitPaint === false) and can
 * NEVER emit a reliable paint acknowledgement — it is the one package emitted with
 * `{ rafGate: false }`, and nothing in its bytes posts SIM_PAINTED or answers PING_SIM_PAINTED.
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

/**
 * Sections that exist ONLY in the `delayedack` package, so the shared FIXTURE_SECTIONS map — and
 * therefore the modern / legacy / noraf / nopaint bytes — stays exactly as it is.
 *
 * Each one selects an ACK BEHAVIOUR (see DELAYED_ACK_POLICY), which is what lets an e2e test drive
 * a stale/superseded/mismatched acknowledgement DETERMINISTICALLY: the behaviour is chosen by the
 * section id the player dispatches on, so there is no timing race and no URL surgery. (A URL knob
 * would be the wrong primary mechanism here anyway: packageKeyOf() strips the query string, so all
 * sections of one package share ONE document whose src is whichever section pooled first.)
 */
export const FIXTURE_DELAYED_SECTIONS = {
  /** Acknowledges very late (DELAYED_ACK_POLICY below) — a supersede/teardown always wins the race. */
  LATE: '11111111-6666-4666-8666-111111111111',
  /** Acknowledges promptly but echoes a token that does NOT match the activation. */
  BADTOKEN: '22222222-7777-4777-8777-222222222222',
} as const;

/** Token corruption applied by the BADTOKEN section (and by `?badtoken=1`). */
const BAD_TOKEN_DELTA = 7777;

/**
 * Per-section acknowledgement behaviour for the `delayedack` bridge. Sections with no entry use
 * the bridge's default delay (500 ms), so A / B / SLOW / THROWS / AUTO behave exactly as before.
 */
const DELAYED_ACK_POLICY: Record<string, { ackDelayMs?: number; tokenDelta?: number }> = {
  // 2400 ms is chosen against the player's own constants: far longer than the ~300-400 ms a test
  // needs to supersede or leave the section (SIM_EXIT_STOP_MS is 280 ms), and still under
  // SIM_APPLY_STALL_MS (3000 ms) so the runtime's terminal bound is not what ends the wait.
  [FIXTURE_DELAYED_SECTIONS.LATE]: { ackDelayMs: 2400 },
  // Prompt, but mis-tokened: matchesPending() must reject it, and the ONLY thing that may
  // eventually release the hold is the runtime's SIM_APPLY_STALL_MS terminal bound.
  [FIXTURE_DELAYED_SECTIONS.BADTOKEN]: { ackDelayMs: 400, tokenDelta: BAD_TOKEN_DELTA },
};

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

/**
 * The `delayedack` package's section table: everything in SECTION_BODIES plus the two ack-policy
 * sections. Bodies are ordinary marker bodies — the interesting behaviour is entirely in WHEN (and
 * with WHICH token) the bridge acknowledges them.
 */
const DELAYED_SECTION_BODIES: Record<string, string> = {
  ...SECTION_BODIES,
  [FIXTURE_DELAYED_SECTIONS.LATE]: bodyFor('LATE', '#ff8000'),
  [FIXTURE_DELAYED_SECTIONS.BADTOKEN]: bodyFor('BADTOKEN', '#8000ff'),
};

const NO_RAF_ENTRY = (): string => ENTRY_HTML.replace(
  /<script>[\s\S]*?<\/script>\s*<\/body>/,
  '<script>var c=document.getElementById("scene").getContext("2d");c.fillStyle="#000";c.fillRect(0,0,10,10);</script></body>',
);

/**
 * Entry document for `nopaint`. It DOES draw — inside its own requestAnimationFrame, like any real
 * simulation — it simply has no channel to report that: this package is emitted with
 * `{ rafGate: false }`, so nothing wraps requestAnimationFrame and nothing can post a paint
 * acknowledgement. The self-drew flag is deliberately renamed so the package's bytes contain no
 * paint-ack token at all (`grep -c SIM_PAINTED nopaint/index.html` must be 0), and so the
 * delayedack bridge's `__SIM_PAINTED_SELF__` PING answer can never be revived here by copy/paste.
 *
 * NOTE for the e2e harness: the reporter the viewer suite splices into every fixture document runs
 * its loop on requestAnimationFrame. With no gate injected that is the NATIVE one, so the reporter
 * cannot make this package look painted — no spec change is needed to keep this package honest.
 */
const NO_PAINT_ENTRY = (): string => ENTRY_HTML.replace(
  /<script>[\s\S]*?<\/script>\s*<\/body>/,
  `<script>
    // No gate is injected into this package, so this is the NATIVE requestAnimationFrame: the
    // scene really is drawn, and absolutely nothing observes or announces it.
    requestAnimationFrame(function () {
      var c = document.getElementById('scene').getContext('2d');
      c.fillStyle = '#000'; c.fillRect(0, 0, 10, 10);
      window.__DREW_SELF__ = true;
    });
  </script></body>`,
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
 * DELAYED-ACK bridge — the fixture that makes the apply gate observable at viewer level, and the
 * only source of the STALE acknowledgements SimRuntimeClient.matchesPending exists to reject.
 *
 * WHY IT EXISTS. The gate only changes behaviour when the acknowledgement lags the request. The
 * blocking SLOW body cannot demonstrate that: the sim is served from the API origin (the only one
 * the app's CSP admits, and the one resolveAssetUrl rewrites every loopback URL to), which is
 * SAME-SITE with the app, so the sim shares the parent's process — a busy loop freezes the parent's
 * own opacity sampler along with it. Measured: with an instantly-acknowledging body the clean and
 * dead-gate opacity trajectories are byte-identical, so the suite could not tell them apart.
 *
 * PRODUCTION PARITY — the part that changed, and why it had to.
 * The shipping bridge (wrapBridgeCombined) runs a section body SYNCHRONOUSLY on receipt of
 * startScript and then schedules ONLY the acknowledgement, one frame later, via `_sysRaf(_ack)` —
 * a call made OUTSIDE `_trackTimers`, so neither `_clearTimers` nor `stopScript` can cancel it.
 * Two consequences follow in production and MUST be reproducible here:
 *   • a supersede does not cancel the superseded acknowledgement — it still arrives, late,
 *     carrying a token that no longer matches the live activation;
 *   • a teardown does not cancel a pending acknowledgement either — it arrives after stopScript.
 * The previous fixture was politer than production on both counts (a second startScript
 * clearTimeout'd the first so it was NEVER acked; stopScript cancelled the pending apply), which
 * left the entire stale-ack path — the reason matchesPending exists — with no fixture at all.
 *
 * So: apply synchronously, exactly like production; defer ONLY the SCRIPT_APPLIED post, with a
 * setTimeout standing in for production's one-frame rAF so the pre-ack window is long enough for
 * the parent to sample; and never hold a handle that anything could clear. SCRIPT_MISSING and
 * SCRIPT_ERROR stay synchronous — production posts those without going through the rAF.
 *
 * DETERMINISTIC BEHAVIOUR SELECTION. `policy` maps a SECTION ID to its ack behaviour
 * (see DELAYED_ACK_POLICY), so a test picks late / mis-tokened acknowledgements by putting that
 * section on the timeline — no timing races. Two document-wide query knobs exist as an escape
 * hatch: `?ackdelay=<ms>` overrides the default delay and `?badtoken=1` corrupts every token.
 * They are secondary on purpose: packageKeyOf() strips the query string, so every section URL of
 * one package would have to carry an identical knob to be meaningful.
 *
 * It also records deterministic protocol evidence (type/script/token and four timestamps) on
 * window.__PROTO__ and posts every record to the parent, so a test can correlate the parent's
 * opacity samples with the exact instant the child acknowledged — no slices, no settle delays, no
 * fixed allowance of wrong frames. `token` on a record is the token PUT ON THE WIRE and
 * `requestToken` is the one the activation carried: they differ exactly when a mis-tokened
 * acknowledgement is being exercised.
 */
function delayedAckBridge(
  entries: Map<string, string>,
  policy: Record<string, { ackDelayMs?: number; tokenDelta?: number }> = {},
  delayMs = 500,
): string {
  const sections = JSON.stringify(Object.fromEntries(
    [...entries.entries()].map(([id, body]) => [id, body]),
  ));
  return `/* fixture: delayed-ack bridge (production parity: SYNC apply, UNCANCELLABLE late ack; default ${delayMs}ms) */
(function () {
  var SECTIONS = ${sections};
  var POLICY = ${JSON.stringify(policy)};
  var BAD_TOKEN_DELTA = ${BAD_TOKEN_DELTA};
  var DELAY = ${delayMs};
  var PROTO = (window.__PROTO__ = []);
  var _cancel = null;

  // Document-wide escape hatches. Secondary to the per-section POLICY above (see the doc comment).
  var _q = null;
  try { _q = new URLSearchParams(location.search); } catch (e) { _q = null; }
  function qs(name) { try { return _q ? _q.get(name) : null; } catch (e) { return null; } }
  var _qDelay = parseInt(qs('ackdelay') || '', 10);
  if (isFinite(_qDelay) && _qDelay >= 0) DELAY = _qDelay;
  var ALL_TOKENS_BAD = qs('badtoken') === '1';

  function post(msg) { try { parent.postMessage(msg, '*'); } catch (e) {} }
  function now() { return Date.now(); }
  // The parent is CROSS-ORIGIN (the app's CSP admits only the API origin), so it cannot read
  // window.__PROTO__ directly. Every record is posted as well — that is the evidence channel.
  function record(e) { PROTO.push(e); post({ type: 'PROTO', entry: e }); }

  function policyFor(name) {
    var p = (name && Object.prototype.hasOwnProperty.call(POLICY, name)) ? POLICY[name] : null;
    return {
      ackDelayMs: (p && typeof p.ackDelayMs === 'number') ? p.ackDelayMs : DELAY,
      tokenDelta: ALL_TOKENS_BAD ? BAD_TOKEN_DELTA : ((p && p.tokenDelta) || 0)
    };
  }

  function applySection(name, params, token, receivedAt) {
    var applyStart = now();
    var pol = policyFor(name);
    if (_cancel) { try { _cancel(); } catch (e) {} _cancel = null; }
    var fn = Object.prototype.hasOwnProperty.call(SECTIONS, name) ? SECTIONS[name] : null;
    if (!fn) {
      // Synchronous, as in production — only SCRIPT_APPLIED goes through the deferred path.
      record({ type: 'SCRIPT_MISSING', script: name, token: token, requestToken: token,
               receivedAt: receivedAt, applyStart: applyStart, applyComplete: null, ackAt: now() });
      post({ type: 'SCRIPT_MISSING', script: name, token: token });
      return;
    }
    try {
      _cancel = new Function('params', fn)(params || {}) || null;
    } catch (err) {
      record({ type: 'SCRIPT_ERROR', script: name, token: token, requestToken: token,
               receivedAt: receivedAt, applyStart: applyStart, applyComplete: null, ackAt: now() });
      post({ type: 'SCRIPT_ERROR', phase: 'start', script: name, token: token, message: String(err) });
      return;
    }
    var applyComplete = now();
    var ackToken = (typeof token === 'number') ? token + pol.tokenDelta : token;
    // THE UNCANCELLABLE ACKNOWLEDGEMENT. The handle is deliberately not stored anywhere: this
    // mirrors production's _sysRaf(_ack), which is scheduled outside _trackTimers and therefore
    // survives every supersede and every stopScript. A late, stale SCRIPT_APPLIED genuinely can
    // arrive — that is the whole point of this package.
    setTimeout(function () {
      record({ type: 'SCRIPT_APPLIED', script: name, token: ackToken, requestToken: token,
               receivedAt: receivedAt, applyStart: applyStart, applyComplete: applyComplete,
               ackAt: now() });
      post({ type: 'SCRIPT_APPLIED', script: name, token: ackToken });
    }, pol.ackDelayMs);
  }

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'startScript') {
      var receivedAt = now();
      record({ type: 'startScript', script: d.script, token: d.token, requestToken: d.token,
               receivedAt: receivedAt, applyStart: null, applyComplete: null, ackAt: null });
      // SYNCHRONOUS, exactly like production. Deliberately WITHOUT production's identical-re-post
      // dedupe (_lastSig): keeping it out means the number of acknowledgements depends only on the
      // number of activations, which is what every assertion here is written against.
      applySection(d.script, d.params, d.token, receivedAt);
      return;
    }
    if (d.type === 'stopScript') {
      record({ type: 'stopScript', script: null, token: null, requestToken: null, receivedAt: now(),
               applyStart: null, applyComplete: null, ackAt: null });
      // Runs the section cleanup and NOTHING else. Production's stopScript calls _clearTimers(),
      // which only reaches timers scheduled DURING the body call — the acknowledgement above was
      // scheduled outside that scope and survives a teardown. Cancelling it here is precisely the
      // politeness that hid the post-deactivation stale ack from every test.
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

interface LegacyBridgeOptions {
  /**
   * The SIM_READY capability advertisement.
   *  'dynamic' (default) — the shipping v2 payload `{type, dispatch:'dynamic', sections}`. The
   *      viewer classifies the document `dynamic: true`, and learnCanEmitPaint() folds that into
   *      `canEmitPaint: true`.
   *  null — a BARE `{type:'SIM_READY'}`: a load-time-locked pre-v2 document. The viewer leaves
   *      `dynamic` null, so `canEmitPaint` stays FALSE and the player's `!m.canEmitPaint`
   *      bounded-hold force-reveal branch becomes reachable. Used only by `nopaint`, which is
   *      also the only package emitted without the v4 rAF gate — the two facts have to agree, or
   *      the package would be advertising an inability it does not actually have.
   */
  dispatch?: 'dynamic' | null;
}

/** The pre-v2.1 bridge: no SCRIPT_APPLIED/MISSING/ERROR, unguarded dispatch + cleanup. */
function legacyBridge(entries: Map<string, string>, opts: LegacyBridgeOptions = {}): string {
  const bodies = [...entries.entries()]
    .map(([id, body]) => `    ${JSON.stringify(id)}: function (params) {${body}},`)
    .join('\n');
  // Byte-compatible by construction: the default substitution is the exact literal this file
  // emitted before the option existed.
  const readyPayload = opts.dispatch === null
    ? "{ type: 'SIM_READY' }"
    : "{ type: 'SIM_READY', dispatch: 'dynamic', sections: ids }";
  return `;(function () {
  var __SECTIONS__ = {
${bodies}
  };
  var _ready = false;
  function _fireReady() {
    if (_ready) return; _ready = true; window._simReadyFired = true;
    var ids = []; for (var k in __SECTIONS__) { if (Object.prototype.hasOwnProperty.call(__SECTIONS__, k)) ids.push(k); }
    window.parent && window.parent.postMessage(${readyPayload}, '*');
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
      window.parent && window.parent.postMessage(${readyPayload}, '*');
    }
  });
})();`;
}

interface EmitOptions {
  /**
   * Inject the real v4 rAF gate. TRUE by default — every package the platform serves has it, and
   * the fixture's whole value is that its bytes match production.
   *
   * FALSE is the one deliberate, documented exception (`nopaint`): the gate IS the thing that
   * wraps requestAnimationFrame and posts SIM_PAINTED, so a document that must never be able to
   * emit a paint acknowledgement cannot be handed it. Injecting the gate and then hoping nothing
   * triggers it is not a no-paint fixture — it is what made `noraf` ack anyway, via the gate plus
   * the e2e harness's own requestAnimationFrame reporter.
   */
  rafGate?: boolean;
}

function emit(
  outDir: string,
  name: string,
  bridgeJs: string,
  entry: string = ENTRY_HTML,
  opts: EmitOptions = {},
): void {
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256').update(bridgeJs).digest('hex').slice(0, 12);
  writeFileSync(join(dir, 'bridge.js'), bridgeJs);
  // Exactly what the proxy serves: gate in <head>, bridge script tag, boot snippet.
  const gated = opts.rafGate === false ? entry : injectRafGate(entry);
  const html = injectSimBootSnippet(injectBridgeScriptTag(gated, './bridge.js', hash));
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
  // The honest no-paint / load-time-locked package: bare SIM_READY *and* no rAF gate. Both halves
  // are required — advertising no dispatch while still carrying the gate would paint anyway.
  emit(
    outDir,
    'nopaint',
    legacyBridge(new Map(Object.entries(SECTION_BODIES)), { dispatch: null }),
    NO_PAINT_ENTRY(),
    { rafGate: false },
  );
  emit(
    outDir,
    'delayedack',
    delayedAckBridge(new Map(Object.entries(DELAYED_SECTION_BODIES)), DELAYED_ACK_POLICY),
  );

  console.log(JSON.stringify({
    outDir,
    packages: ['modern', 'legacy', 'noraf', 'nopaint', 'delayedack'],
    sections: FIXTURE_SECTIONS,
    delayedOnlySections: FIXTURE_DELAYED_SECTIONS,
    delayedAckPolicy: DELAYED_ACK_POLICY,
  }, null, 2));
}

main();
