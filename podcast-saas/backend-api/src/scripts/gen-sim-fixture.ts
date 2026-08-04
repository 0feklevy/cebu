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
 *   v3managed   — the REAL v3 child runtime (buildChildRuntimeSource) over a recorded transport,
 *                 carrying both managed sections and deliberately legacy-bodied ones.
 *   v3allmanaged— the same runtime with ONLY managed sections, so its honest capability report can
 *                 reach `managed-presentable` (see V3_ALL_MANAGED_DESCRIPTOR).
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
  SAFE_SECTION_ID_RE,
} from '../services/simulation/SimulationService.js';
import { injectSimBootSnippet } from '../controllers/sim-public.controller.js';
import { buildChildRuntimeSource } from '../services/simulation/simRuntimeChild.js';

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
export const BAD_TOKEN_DELTA = 7777;

/**
 * Per-section acknowledgement behaviour for the `delayedack` bridge. Sections with no entry use
 * the bridge's default delay (500 ms), so A / B / SLOW / THROWS / AUTO behave exactly as before.
 */
export const DELAYED_ACK_POLICY: Record<string, { ackDelayMs?: number; tokenDelta?: number; releaseOnNextLifecycle?: boolean }> = {
  // 2400 ms is chosen against the player's own constants: far longer than the ~300-400 ms a test
  // needs to supersede or leave the section (SIM_EXIT_STOP_MS is 280 ms), and still under
  // SIM_APPLY_STALL_MS (3000 ms) so the runtime's terminal bound is not what ends the wait.
  // The acknowledgement is retained until the NEXT REAL LIFECYCLE EVENT on this document — the
  // next startScript (a supersede) or a stopScript (a teardown) — and only then emitted, after
  // that event has been fully applied. This is deterministic WITHOUT a parent-controlled command
  // and without guessing how long the viewer takes to reach the next section: measured, the
  // viewer issued the superseding activation ~5.8s after the seek, so a fixed 2400ms delay had
  // already fired and no stale window ever existed. The production property being reproduced is
  // unchanged — the ack is scheduled outside every tracked/cancellable scope, exactly as the real
  // bridge's _sysRaf(_ack) is, so supersede and stopScript cannot cancel it.
  [FIXTURE_DELAYED_SECTIONS.LATE]: { releaseOnNextLifecycle: true },
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
export function delayedAckBridge(
  entries: Map<string, string>,
  policy: Record<string, { ackDelayMs?: number; tokenDelta?: number; releaseOnNextLifecycle?: boolean }> = {},
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
  // Acknowledgements retained until the next real lifecycle event. Nothing can cancel these —
  // the same scope guarantee production gets from _sysRaf(_ack) living outside _trackTimers.
  var _retained = [];

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
      tokenDelta: ALL_TOKENS_BAD ? BAD_TOKEN_DELTA : ((p && p.tokenDelta) || 0),
      releaseOnNextLifecycle: !!(p && p.releaseOnNextLifecycle)
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
    var fire = function () {
      record({ type: 'SCRIPT_APPLIED', script: name, token: ackToken, requestToken: token,
               receivedAt: receivedAt, applyStart: applyStart, applyComplete: applyComplete,
               ackAt: now() });
      post({ type: 'SCRIPT_APPLIED', script: name, token: ackToken });
    };
    // RETAINED: released by the next startScript/stopScript on this document, once that event has
    // been applied. No parent command, no guessed delay.
    if (pol.releaseOnNextLifecycle) { _retained.push(fire); return; }
    setTimeout(function () {
      fire();
    }, pol.ackDelayMs);
  }

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    // Any retained ack is released by the NEXT lifecycle event, emitted asynchronously AFTER that
    // event has been fully applied — so a stale SCRIPT_APPLIED provably lands while the newer
    // section is already current, which is exactly the production ordering under test.
    // Snapshot BEFORE the new event is applied, release AFTER. Releasing whatever is in the list
    // afterwards would also fire the ack the new activation itself just retained, so LATE would
    // acknowledge its own arrival and never be stale at all.
    var takeRetained = function () { return _retained.splice(0, _retained.length); };
    var releaseTaken = function (held) {
      if (!held.length) return;
      setTimeout(function () { for (var i = 0; i < held.length; i++) held[i](); }, 0);
    };
    if (d.type === 'startScript') {
      var receivedAt = now();
      record({ type: 'startScript', script: d.script, token: d.token, requestToken: d.token,
               receivedAt: receivedAt, applyStart: null, applyComplete: null, ackAt: null });
      // SYNCHRONOUS, exactly like production. Deliberately WITHOUT production's identical-re-post
      // dedupe (_lastSig): keeping it out means the number of acknowledgements depends only on the
      // number of activations, which is what every assertion here is written against.
      var carriedOver = takeRetained();          // whatever the PREVIOUS activation retained
      applySection(d.script, d.params, d.token, receivedAt);
      // The new section is now CURRENT and applied. Only now is the previous activation's ack
      // emitted — stale by ordering rather than by racing a timer.
      releaseTaken(carriedOver);
      return;
    }
    if (d.type === 'stopScript') {
      record({ type: 'stopScript', script: null, token: null, requestToken: null, receivedAt: now(),
               applyStart: null, applyComplete: null, ackAt: null });
      // Runs the section cleanup and NOTHING else. Production's stopScript calls _clearTimers(),
      // which only reaches timers scheduled DURING the body call — the acknowledgement above was
      // scheduled outside that scope and survives a teardown. Cancelling it here is precisely the
      // politeness that hid the post-deactivation stale ack from every test.
      var afterStop = takeRetained();
      if (_cancel) { try { _cancel(); } catch (err) {} _cancel = null; }
      // The teardown has completed. Only now is the retained ack emitted — reproducing
      // production's ack surviving stopScript and landing after deactivation.
      releaseTaken(afterStop);
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

// ── v3 package ────────────────────────────────────────────────────────────────────────────────

/**
 * Sections that exist ONLY in the v3 packages. New ids, deliberately: the modern / legacy / noraf /
 * nopaint / delayedack bytes are pinned by the e2e suites and must not move, and a section id is
 * part of those bytes.
 *
 * FIXTURE_SECTIONS.A and .B are ALSO carried by `v3managed` — unchanged, byte-for-byte the same
 * bodies the v2 packages use. That reuse is the point: those bodies return a cleanup FUNCTION, so
 * they exercise the runtime's legacy wrapper while keeping the colour contract (BLUE = A,
 * YELLOW = B) that every existing browser assertion is written against.
 */
export const FIXTURE_V3_SECTIONS = {
  /** Managed. BLUE-violet marker. The default subject of the protocol and leak tests. */
  V3A: '33333333-a111-4a11-8a11-333333333333',
  /** Managed. ORANGE marker. The other half of every A → B → A cycle. */
  V3B: '44444444-b222-4b22-8b22-444444444444',
  /** Returns a plain cleanup FUNCTION — the legacy wrapper path, inside a v3 document. */
  V3LEGACYBODY: '55555555-c333-4c33-8c33-555555555555',
  /** Managed, but `present()` never calls markPresented. The parent must bound its own wait. */
  V3NOPRESENT: '66666666-d444-4d44-8d44-666666666666',
  /** Managed. `prepare()` returns a promise that resolves after V3_SLOW_PREPARE_MS. */
  V3SLOWPREPARE: '77777777-e555-4e55-8e55-777777777777',
  /** Managed. `prepare()` throws synchronously — SECTION_ERROR, and never SECTION_APPLIED. */
  V3THROWPREPARE: '88888888-f666-4f66-8f66-888888888888',
} as const;

/** How long V3SLOWPREPARE's prepare promise takes to settle. */
export const V3_SLOW_PREPARE_MS = 300;

/**
 * Two behaviours a managed section only performs when the ACTIVATION CONFIG asks for it, read from
 * `config.initialState`.
 *
 * They are knobs rather than dedicated sections because both are properties of ONE activation, not
 * of a package: a section that always double-acked could not also serve the ordinary
 * present-exactly-once case, and the leak test needs V3A and V3B to stay interchangeable twins.
 * `config.initialState` is the right carrier because it is already part of the config hash, so an
 * activation that turns a knob on is a genuinely different presentation and hashes as one.
 */
export const V3_DOUBLE_ACK_KNOB = 'doubleAck';
export const V3_DEFER_ACK_KNOB = 'deferAck';

/**
 * Where a deferred `markPresented` is parked. The parent calls it LATER — after the activation has
 * been superseded — which is the only way to drive the stale-closure refusal deliberately rather
 * than by winning a race.
 */
export const V3_DEFERRED_ACK_GLOBAL = '__V3_DEFERRED_ACK__';

/** The recorded protocol log the v3 packages expose. */
export const V3_PROTO_GLOBAL = '__PROTO_V3__';

/** Per-section observable state, keyed by section LABEL. */
export const V3_STATE_GLOBAL = '__V3_STATE__';

/**
 * A managed section: a real ManagedSectionLifecycle whose every allocation goes through `ctx.scope`.
 *
 * WHY IT ALLOCATES SO MUCH. The leak tests count what the scope reports, so a fixture that
 * allocated nothing would report a clean dispose no matter how broken the scope was. One resource
 * of each mechanically distinct kind is taken deliberately: a self-rescheduling rAF loop (cancelled
 * by handle), an interval registered as AUTOMATION (the only thing pauseAuto may stop), a listener
 * on a real target, an AbortController (aborted at dispose), an object URL (revoked at dispose) and
 * an explicitly TRACKED resource standing in for a GPU texture the scope cannot see by itself.
 */
const v3ManagedBody = (label: string, colour: string) => `
  var scope = ctx.scope;
  var doc = window.document;
  var marker = doc.getElementById('marker');
  var canvas = doc.getElementsByTagName('canvas')[0] || null;
  var state = {
    label: ${JSON.stringify(label)},
    prepared: false, presented: 0, activated: false, autoPaused: false,
    suspended: false, released: false, disposed: false,
    frames: 0, ticks: 0, pings: 0, draws: 0, aborted: false,
    quality: null, audible: null, objectUrl: null, texture: null
  };
  window[${JSON.stringify(V3_STATE_GLOBAL)}] = window[${JSON.stringify(V3_STATE_GLOBAL)}] || {};
  window[${JSON.stringify(V3_STATE_GLOBAL)}][${JSON.stringify(label)}] = state;

  var loop = function () { state.frames++; state.rafId = scope.requestAnimationFrame(loop); };
  state.rafId = scope.requestAnimationFrame(loop);

  state.autoId = scope.registerAutomation(scope.setInterval(function () { state.ticks++; }, 40), 'interval');

  state.onPing = function () { state.pings++; };
  scope.addEventListener(doc, 'v3fixture:ping', state.onPing);

  state.aborter = scope.abortController();
  if (state.aborter.signal && state.aborter.signal.addEventListener) {
    // NOT registered with the scope: this listener lives on a controller the scope already owns and
    // dies with it, so registering it would count one resource twice and make the plateau lie.
    state.aborter.signal.addEventListener('abort', function () { state.aborted = true; });
  }

  state.objectUrl = scope.createObjectURL(new Blob([${JSON.stringify(label)}], { type: 'text/plain' }));

  state.texture = scope.track('glTextures', { label: ${JSON.stringify(label)}, disposed: false }, function (t) { t.disposed = true; });

  function canvasSize() { return canvas ? { width: canvas.width, height: canvas.height } : null; }
  function draw() {
    if (!canvas || !canvas.getContext) return;
    var g = null;
    try { g = canvas.getContext('2d'); } catch (e) { g = null; }
    if (!g) return;
    g.fillStyle = ${JSON.stringify(colour)};
    g.fillRect(0, 0, canvas.width, canvas.height);
    state.draws++;
  }
  function knob(c, name) {
    var init = c && c.config && c.config.initialState;
    return !!(init && init[name]);
  }

  // Kept, rather than returned inline, so a test can read the __managed flag the runtime stamps ON
  // THIS OBJECT. That stamp is the only place the managed/legacy decision is directly observable
  // from inside the document — after INIT_DOCUMENT the wire carries capabilities for the PACKAGE,
  // never for the section currently installed.
  state.lifecycle = {
    prepare: function (c) {
      // COVERED work only. The marker colour is what lets a screenshot name the applied section;
      // nothing public starts moving until activate().
      if (marker) {
        marker.style.background = ${JSON.stringify(colour)};
        marker.setAttribute('data-section', ${JSON.stringify(label)});
      }
      state.prepared = true;
    },
    present: function (c) {
      // The acknowledgement is posted from INSIDE the frame that drew, never before it: an ack
      // that merely schedules a render is the unverified reveal this protocol exists to remove.
      c.scope.requestAnimationFrame(function () {
        draw();
        state.presented++;
        if (knob(c, ${JSON.stringify(V3_DEFER_ACK_KNOB)})) {
          window[${JSON.stringify(V3_DEFERRED_ACK_GLOBAL)}] = function () { c.markPresented({ canvas: canvasSize() }); };
          return;
        }
        c.markPresented({ canvas: canvasSize() });
        // A second call is a BUG in the section and the runtime's exactly-once guard is what
        // absorbs it. A fixture that never makes the mistake cannot prove the guard works.
        if (knob(c, ${JSON.stringify(V3_DOUBLE_ACK_KNOB)})) c.markPresented({ canvas: canvasSize() });
      });
    },
    activate: function (c) { state.activated = true; },
    pauseAuto: function () { state.autoPaused = true; },
    resumeAuto: function () { state.autoPaused = false; },
    setAudible: function (s) { state.audible = { muted: !!s.muted, volume: s.volume }; },
    setQuality: function (p) { state.quality = p; },
    suspend: function () { state.suspended = true; },
    release: function () { state.released = true; },
    dispose: function () {
      state.disposed = true;
      if (marker) marker.setAttribute('data-section', 'none');
    }
  };
  return state.lifecycle;
`;

/** Returns a cleanup FUNCTION — a pre-managed body, running unchanged inside a v3 document. */
const V3_LEGACY_BODY = `
  var doc = window.document;
  var marker = doc.getElementById('marker');
  window[${JSON.stringify(V3_STATE_GLOBAL)}] = window[${JSON.stringify(V3_STATE_GLOBAL)}] || {};
  var state = window[${JSON.stringify(V3_STATE_GLOBAL)}]['V3LEGACYBODY'] = { ticks: 0, cleaned: false };
  if (marker) { marker.style.background = '#00a0a0'; marker.setAttribute('data-section', 'V3LEGACYBODY'); }
  // Deliberately the GLOBAL setInterval, not ctx.scope. A body written before the managed contract
  // existed knows nothing about the scope, and the bounded global swap runLegacy performs around
  // this synchronous call is the only thing that can capture it — allocating through ctx.scope here
  // would prove nothing about that swap.
  var iv = setInterval(function () { state.ticks++; }, 40);
  // Kept for the same reason the managed bodies keep their lifecycle object: a test reads it to
  // confirm the runtime never stamped __managed onto a legacy return value.
  state.cleanup = function cleanup() {
    clearInterval(iv);
    state.cleaned = true;
    if (marker) marker.setAttribute('data-section', 'none');
  };
  return state.cleanup;
`;

/** Managed, and NEVER acknowledges a presentation. The parent's own bound is what must end the wait. */
const V3_NO_PRESENT_BODY = `
  window[${JSON.stringify(V3_STATE_GLOBAL)}] = window[${JSON.stringify(V3_STATE_GLOBAL)}] || {};
  var state = window[${JSON.stringify(V3_STATE_GLOBAL)}]['V3NOPRESENT'] = { presentCalls: 0, disposed: false };
  return {
    prepare: function () {},
    // Renders nothing and says nothing. Silence has to be DELIBERATE here: a fixture that merely
    // forgot to acknowledge would one day be "fixed", and the parent's present-timeout would
    // silently lose its only coverage.
    present: function () { state.presentCalls++; },
    dispose: function () { state.disposed = true; }
  };
`;

const V3_SLOW_PREPARE_BODY = `
  window[${JSON.stringify(V3_STATE_GLOBAL)}] = window[${JSON.stringify(V3_STATE_GLOBAL)}] || {};
  var state = window[${JSON.stringify(V3_STATE_GLOBAL)}]['V3SLOWPREPARE'] = { resolved: false, disposed: false };
  return {
    prepare: function (c) {
      return new Promise(function (resolve) {
        // Through the SCOPE, not a raw setTimeout: a prepare still pending when its activation is
        // superseded must die with everything else the activation allocated. A raw timer would
        // resolve into a disposed scope and acknowledge a section that no longer exists.
        c.scope.setTimeout(function () { state.resolved = true; resolve(); }, ${V3_SLOW_PREPARE_MS});
      });
    },
    present: function (c) { c.scope.requestAnimationFrame(function () { c.markPresented(); }); },
    dispose: function () { state.disposed = true; }
  };
`;

const V3_THROW_PREPARE_BODY = `
  window[${JSON.stringify(V3_STATE_GLOBAL)}] = window[${JSON.stringify(V3_STATE_GLOBAL)}] || {};
  var state = window[${JSON.stringify(V3_STATE_GLOBAL)}]['V3THROWPREPARE'] = { attempts: 0, disposed: false };
  return {
    prepare: function () { state.attempts++; throw new Error('fixture prepare exploded'); },
    present: function (c) { c.markPresented(); },
    dispose: function () { state.disposed = true; }
  };
`;

/**
 * The protocol recorder.
 *
 * IT MUST BE INSTALLED BEFORE THE RUNTIME. Its `message` listener is registered first so it runs
 * first, which is what makes __PROTO_V3__ the order the runtime actually saw and — more
 * importantly — what lets it wrap the offered MessagePort's `postMessage` before the runtime has a
 * chance to adopt and use it. A recorder installed afterwards records everything one step late and
 * cannot see the bootstrap accept at all.
 *
 * IT RECORDS EVERY OFFERED PORT, not just the adopted one. Whether an offer is adopted is exactly
 * what the refusal tests are asking about, so the recorder must not pre-judge it; wrapping a port
 * that is then refused and closed is inert.
 */
const V3_RECORDER_SOURCE = `
  // ── protocol recorder ───────────────────────────────────────────────────────
  var __proto = (window[${JSON.stringify(V3_PROTO_GLOBAL)}] = []);
  var __portSeen = 0;
  function __rec(dir, channel, portIndex, msg) {
    var m = (msg && typeof msg === 'object') ? msg : {};
    var e = {
      dir: dir, channel: channel, port: portIndex, at: Date.now(),
      kind: m.kind || null,
      type: m.type || null,
      seq: (typeof m.seq === 'number') ? m.seq : null,
      playerSessionId: m.playerSessionId || null,
      packageRevision: m.packageRevision || null,
      documentId: m.documentId || null,
      activationId: m.activationId || null,
      variantKey: m.variantKey || null,
      configHash: m.configHash || null,
      payload: m.payload || null
    };
    __proto.push(e);
    // The parent is CROSS-ORIGIN in every real deployment, so it cannot read __PROTO_V3__
    // directly. Every record is posted as well — the same evidence channel the delayedack
    // fixture uses. This is v2-shaped window traffic on purpose: it must never be mistaken for
    // protocol traffic, which lives exclusively on the port.
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'PROTO_V3', entry: e }, '*'); } catch (err) {}
    return e;
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.kind !== 'flowvid.sim.bootstrap') return;
    __rec('in', 'window', null, d);
    var ports = ev.ports || [];
    for (var i = 0; i < ports.length; i++) {
      (function (p, idx) {
        var origPost = p.postMessage;
        p.postMessage = function (m) { __rec('out', 'port', idx, m); return origPost.call(p, m); };
        if (p.addEventListener) {
          p.addEventListener('message', function (e2) { __rec('in', 'port', idx, e2.data); });
        }
      })(ports[i], ++__portSeen);
    }
  }, false);
`;

/**
 * The generation-time capability descriptor. It describes the PACKAGE — see the comment on
 * `sectionsAllManaged` in simRuntimeChild.ts for why the runtime cannot derive it by probing.
 */
export interface V3PackageDescriptor {
  /** EVERY section body in the package returns a managed lifecycle. */
  allManaged: boolean;
  /** At least one section implements setQuality. */
  anyQuality: boolean;
}

/**
 * `v3managed` deliberately carries legacy-bodied sections (A, B, V3LEGACYBODY), so `allManaged` is
 * FALSE and its honest DOCUMENT_READY reports `suspendable: false` — classifyFromCapabilities
 * therefore calls it `managed-partial`. That is not a defect in the fixture, it is the truth about
 * a mixed package, and it is why `v3allmanaged` exists alongside it.
 */
export const V3_MANAGED_DESCRIPTOR: V3PackageDescriptor = { allManaged: false, anyQuality: true };

/** Only managed bodies — the one package whose capability report can reach `managed-presentable`. */
export const V3_ALL_MANAGED_DESCRIPTOR: V3PackageDescriptor = { allManaged: true, anyQuality: true };

/** Section table for `v3managed`. Insertion order IS the order DOCUMENT_READY reports variants in. */
export const V3_MANAGED_SECTION_BODIES: Record<string, string> = {
  [FIXTURE_SECTIONS.A]: SECTION_BODIES[FIXTURE_SECTIONS.A],
  [FIXTURE_SECTIONS.B]: SECTION_BODIES[FIXTURE_SECTIONS.B],
  [FIXTURE_V3_SECTIONS.V3A]: v3ManagedBody('V3A', '#4040ff'),
  [FIXTURE_V3_SECTIONS.V3B]: v3ManagedBody('V3B', '#ff8000'),
  [FIXTURE_V3_SECTIONS.V3LEGACYBODY]: V3_LEGACY_BODY,
  [FIXTURE_V3_SECTIONS.V3NOPRESENT]: V3_NO_PRESENT_BODY,
  [FIXTURE_V3_SECTIONS.V3SLOWPREPARE]: V3_SLOW_PREPARE_BODY,
  [FIXTURE_V3_SECTIONS.V3THROWPREPARE]: V3_THROW_PREPARE_BODY,
};

/** Section table for `v3allmanaged` — every body here returns a ManagedSectionLifecycle. */
export const V3_ALL_MANAGED_SECTION_BODIES: Record<string, string> = {
  [FIXTURE_V3_SECTIONS.V3A]: V3_MANAGED_SECTION_BODIES[FIXTURE_V3_SECTIONS.V3A],
  [FIXTURE_V3_SECTIONS.V3B]: V3_MANAGED_SECTION_BODIES[FIXTURE_V3_SECTIONS.V3B],
  [FIXTURE_V3_SECTIONS.V3NOPRESENT]: V3_NO_PRESENT_BODY,
  [FIXTURE_V3_SECTIONS.V3SLOWPREPARE]: V3_SLOW_PREPARE_BODY,
  [FIXTURE_V3_SECTIONS.V3THROWPREPARE]: V3_THROW_PREPARE_BODY,
};

/**
 * Build the v3 bridge: a `__SECTIONS__` table, the recorder, then the REAL emitted child runtime.
 *
 * The runtime source is concatenated verbatim from `buildChildRuntimeSource` — including the
 * install call it emits — so these bytes exercise the shipping runtime rather than a
 * hand-maintained imitation of it. That is the entire value of this fixture: a divergence between
 * fixture and production is a divergence a test can no longer detect.
 *
 * NO v2 LISTENER IS EMITTED, on purpose. A v2 `SIM_READY` advertising `dispatch: 'dynamic'` next to
 * a `startScript` handler that could not actually run these bodies (they return lifecycle OBJECTS,
 * which the v2 bridge would call as a cleanup function) would be a package lying about itself —
 * and a fixture that lies is worse than no fixture. A player that never offers a port simply sees
 * a document that never becomes ready, which is the honest report for a v3-only package.
 */
export function v3ManagedBridge(entries: Map<string, string>, descriptor: V3PackageDescriptor): string {
  const bodies = [...entries.entries()]
    .map(([id, body]) => {
      // Same guard the production section table uses: these ids become JS object keys.
      if (!SAFE_SECTION_ID_RE.test(id)) throw new Error(`Unsafe sectionId: "${id}"`);
      const indented = body.split('\n').map((l) => (l.trim() === '' ? '' : '      ' + l)).join('\n');
      // `function (params, ctx)` — the v3 runtime hands the body its activation context as the
      // second argument, which is where ctx.scope (and therefore every tracked allocation) comes
      // from. Deliberately NOT wrapped in the v2 @@SIM_BRIDGE@@ markers: parseSectionEntries only
      // recognises the one-argument v2 signature, and emitting markers it cannot parse would
      // advertise a round-trip that does not exist.
      return `    ${JSON.stringify(id)}: function (params, ctx) {\n${indented}\n    },`;
    })
    .join('\n');

  return [
    '/* fixture: v3 package — the REAL child runtime (simRuntimeChild.ts) over a recorded transport */',
    '(function () {',
    "  'use strict';",
    '',
    '  var __SECTIONS__ = {',
    bodies,
    '  };',
    V3_RECORDER_SOURCE,
    buildChildRuntimeSource(descriptor),
    '})();',
  ].join('\n');
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
  // Same entry document and the same rAF gate as every other package — only bridge.js differs.
  emit(
    outDir,
    'v3managed',
    v3ManagedBridge(new Map(Object.entries(V3_MANAGED_SECTION_BODIES)), V3_MANAGED_DESCRIPTOR),
  );
  emit(
    outDir,
    'v3allmanaged',
    v3ManagedBridge(new Map(Object.entries(V3_ALL_MANAGED_SECTION_BODIES)), V3_ALL_MANAGED_DESCRIPTOR),
  );

  console.log(JSON.stringify({
    outDir,
    packages: ['modern', 'legacy', 'noraf', 'nopaint', 'delayedack', 'v3managed', 'v3allmanaged'],
    sections: FIXTURE_SECTIONS,
    delayedOnlySections: FIXTURE_DELAYED_SECTIONS,
    delayedAckPolicy: DELAYED_ACK_POLICY,
    v3Sections: FIXTURE_V3_SECTIONS,
    v3Descriptors: { v3managed: V3_MANAGED_DESCRIPTOR, v3allmanaged: V3_ALL_MANAGED_DESCRIPTOR },
    v3SlowPrepareMs: V3_SLOW_PREPARE_MS,
  }, null, 2));
}

// Only run when invoked directly — the emitted-bridge builders are imported by tests, and an
// import that exits the process kills the whole test run (matches the other scripts' guard).
if (process.argv[1] && process.argv[1].includes('gen-sim-fixture')) {
  main();
}
