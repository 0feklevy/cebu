/**
 * The `controls` FIXTURE PACKAGE — Phase 0 golden fixtures for action recording.
 *
 * Source of requirement: `md-files/ADR-ACTION-RECORDING-SEMANTICS.md` §6.2, from
 * `.claude/review/RESEARCH-ACTION-RECORDING-2026-08-25.md` §10 "שלב 0" / §16 "Phase 0".
 *
 * This package is NOT about transitions, paint or reveal — every other fixture in
 * gen-sim-fixture.ts covers those. This one exists so that a locator generator, a semantic
 * recorder and a plan executor can be tested against the DOM shapes that are known to break them.
 * Every scenario below is here because something in the existing code, or in a cited standard,
 * says it will fail.
 *
 * It is emitted through the same `emit()` as every other package, so it carries the REAL rAF gate,
 * the REAL serve-time boot snippet and the REAL combined bridge. What is fixture-specific is the
 * ENTRY DOCUMENT — the controls themselves.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE NINE SCENARIOS, and the specific failure each one is the only honest source of
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 *  1. VANILLA          #speed (range), #count (number), #enabled (checkbox), #mode-select
 *                      The happy path. If a locator strategy cannot do these, nothing else matters.
 *
 *  2. REACT-CONTROLLED #react-temp
 *                      A faithful emulation of React's controlled-input value tracker (see
 *                      REACT_TRACKER_NOTE below). `el.value = x; dispatchEvent(new Event('input'))`
 *                      is SWALLOWED and reverts. Only writing through the PROTOTYPE's native
 *                      setter — leaving the tracker holding the stale value — makes the change
 *                      stick. This is the single most common reason a replayed slider "does
 *                      nothing" against a React simulation.
 *                      React's own docs state checkbox/radio use `checked`, not `value`, so
 *                      #react-armed is the checkbox half of the same trap.
 *
 *  3. RERENDER         #rerender-target
 *                      Replaced with a BRAND NEW node carrying the same id every 250ms. A held
 *                      element reference goes stale; a locator must re-resolve at every step.
 *                      `useProjectPlayer.ts:4166-4170` assumes a resident document stays usable
 *                      across activations — this is the shape that makes that assumption visible.
 *
 *  4. ESCAPING         #odd\:id\.v2, #\31 23numeric, #has\ space
 *                      Ids that are legal HTML and ILLEGAL raw CSS. `SimulationService.ts:541`
 *                      returns `'#' + el.id` by string concatenation, so each of these produces a
 *                      selector that either throws in querySelector or silently selects something
 *                      else. CSSOM defines CSS.escape for exactly this; verified 2026-08-25 that
 *                      the current code does not call it on any of its three branches.
 *
 *  5. DUPLICATE ID     #dup (twice)
 *                      Legal in HTML, and `#dup` matches BOTH. `SimulationService.ts:541`'s first
 *                      branch assumes id uniqueness with no querySelectorAll length check. The
 *                      verification pass on 2026-08-25 confirmed the structural nth-of-type
 *                      branch IS single-match by construction — the hole is precisely the `#id`
 *                      and `[name="…"]` branches that run BEFORE it.
 *
 *  6. RADIO GROUP      name="mode", three options
 *                      `[name="mode"]` matches all three. This is the report's named failure case:
 *                      a shared name identifies the GROUP, never the option. A locator for a radio
 *                      must resolve to one input.
 *                      #chk-a / #chk-b share name="flags" as the checkbox equivalent — the same
 *                      hole, in a control kind that also has no single "selected" member.
 *
 *  7. HIDDEN PANEL     .advanced (display:none) containing #advanced-gain
 *                      Not clickable, so a click-based picker cannot reach it. It is the reason
 *                      ADR D10 keeps the checkbox list as a first-class fallback rather than a
 *                      degraded mode.
 *
 *  8. CANVAS           #sim-canvas
 *                      Drag-interactive and semantically opaque. Pointer coordinates are not
 *                      state. ADR D5 blocks it; this fixture is what proves the recorder emits a
 *                      DIAGNOSTIC rather than an action, and does not silently drop it either.
 *
 *  9. ACTIVATION-GATED #needs-gesture
 *                      A button whose handler only runs for a trusted event
 *                      (`if (!e.isTrusted) return;`). The DOM Standard states that events from
 *                      dispatchEvent and element.click() are NOT trusted. This is the fixture that
 *                      makes ADR D5's "no generic click" concrete: a replayed click here provably
 *                      does nothing, and the failure is silent without it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * EVERY control writes to `window.__CONTROL_STATE__`, a plain object keyed by a stable
 * `data-probe` name. That, not the DOM, is what a test asserts on — it is the fixture's stand-in
 * for "internal simulation state", and it is deliberately NOT restored by writing a control's
 * value back. `window.__PHYSICS__` accumulates monotonically from #speed, which is what makes ADR
 * D2 demonstrable: setting #speed back to its baseline does NOT return __PHYSICS__ to zero.
 *
 * This is a TEST TOOL. It is never imported by the server.
 */

/** Section ids for the controls package. Must satisfy SAFE_SECTION_ID_RE. */
export const FIXTURE_CONTROL_SECTIONS = {
  /** Leaves every control at its document default — the baseline-scan case. */
  BASE: 'c0c0c0c0-1111-4111-8111-c0c0c0c0c0c0',
  /** Moves several controls during apply, so a baseline scan and a final scan differ. */
  MOVED: 'c1c1c1c1-2222-4222-8222-c1c1c1c1c1c1',
  /** Turns on the rerender loop, so locators must re-resolve mid-replay. */
  CHURN: 'c2c2c2c2-3333-4333-8333-c2c2c2c2c2c2',
} as const;

/**
 * WHY THE REACT EMULATION IS WRITTEN THIS WAY, and what it is not.
 *
 * React does not "listen for change". `ReactDOM` installs an own-property `value` accessor on the
 * input node that maintains a private tracker string, and its synthetic onChange only fires when
 * `updateValueIfChanged(node)` sees the tracker differ from the live value. Setting
 * `node.value = x` goes THROUGH that instance accessor, so the tracker is updated first and the
 * subsequent `input` event is swallowed as a no-op — after which React's next render writes the
 * old state value back. The known workaround is to write through the PROTOTYPE descriptor's
 * setter, which bypasses the instance accessor and leaves the tracker stale.
 *
 * The emulation below reproduces that mechanism exactly: instance accessor, private tracker,
 * swallow-and-revert on an untracked input event. It is NOT React, and this fixture does not claim
 * to be a substitute for testing against a real React simulation — Phase 3 canary does that. What
 * it IS, is a deterministic, dependency-free reproduction of the one behaviour that decides
 * whether a replayed value sticks. If React ever changes that mechanism, this fixture becomes
 * wrong in a way a comment cannot save, so the Phase-3 canary against a real React package is a
 * requirement, not a nicety.
 */
const REACT_TRACKER = `
  function installControlledInput(el, initial, probe) {
    var state = initial;
    var tracker = String(initial);
    var proto = Object.getPrototypeOf(el);
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    var protoGet = desc.get, protoSet = desc.set;
    // The instance accessor React installs. Writing through it updates the tracker FIRST.
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: function () { return protoGet.call(el); },
      set: function (v) { tracker = String(v); protoSet.call(el, v); },
    });
    el.addEventListener('input', function () {
      var live = protoGet.call(el);
      if (String(live) === tracker) {
        // Tracker already agrees — React treats this as "no change" and re-renders the old state.
        protoSet.call(el, state);
        window.__CONTROL_STATE__[probe + ':swallowed'] =
          (window.__CONTROL_STATE__[probe + ':swallowed'] || 0) + 1;
        return;
      }
      tracker = String(live);
      state = live;
      window.__CONTROL_STATE__[probe] = live;
    });
    protoSet.call(el, initial);
    // Seed the probe the way a mounted React component would: the value is in state from the
    // first render, not only after the first ACCEPTED change. Without this seed a test cannot
    // distinguish "the write was swallowed" from "the listener never ran" — both leave undefined.
    window.__CONTROL_STATE__[probe] = initial;
  }

  function installControlledCheckbox(el, initial, probe) {
    var state = initial;
    var tracker = String(initial);
    var proto = Object.getPrototypeOf(el);
    var desc = Object.getOwnPropertyDescriptor(proto, 'checked');
    var protoGet = desc.get, protoSet = desc.set;
    Object.defineProperty(el, 'checked', {
      configurable: true,
      get: function () { return protoGet.call(el); },
      set: function (v) { tracker = String(v); protoSet.call(el, v); },
    });
    el.addEventListener('click', function (e) {
      var live = protoGet.call(el);
      if (String(live) === tracker) { protoSet.call(el, state); return; }
      tracker = String(live);
      state = live;
      window.__CONTROL_STATE__[probe] = live;
    });
    protoSet.call(el, initial);
    window.__CONTROL_STATE__[probe] = initial;
  }
`;

/**
 * The controls entry document.
 *
 * Colour conventions are inherited from ENTRY_HTML in gen-sim-fixture.ts so the same screenshot
 * assertions keep working: green page = minimal UI, red `.controls` = full UI, `#marker` carries
 * the applied section. Everything below `.controls` is what this fixture adds.
 */
export const CONTROLS_ENTRY_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>controls fixture</title>
  <style>
    html, body { margin: 0; height: 100%; background: #00c000; font: 12px system-ui; }
    .controls { position: fixed; inset: 0; background: #ff0000; z-index: 5; overflow: auto; padding: 48px 8px 8px; }
    #marker { position: fixed; left: 0; top: 0; width: 100%; height: 40px; background: #808080; z-index: 9; }
    .advanced { display: none; }
    fieldset { margin: 4px 0; }
    #sim-canvas { border: 1px solid #000; touch-action: none; }
  </style>
</head>
<body>
  <div id="marker" data-section="none"></div>
  <div class="controls">
    <fieldset><legend>vanilla</legend>
      <input type="range" id="speed" data-probe="speed" min="0" max="100" step="5" value="20">
      <input type="number" id="count" data-probe="count" min="0" max="10" step="1" value="3">
      <input type="checkbox" id="enabled" data-probe="enabled" checked>
      <select id="mode-select" data-probe="modeSelect">
        <option value="slow">slow</option>
        <option value="fast" selected>fast</option>
        <option value="turbo">turbo</option>
      </select>
    </fieldset>

    <fieldset><legend>react-controlled</legend>
      <input type="range" id="react-temp" data-probe="reactTemp" min="0" max="50" step="1" value="10">
      <input type="checkbox" id="react-armed" data-probe="reactArmed">
    </fieldset>

    <fieldset><legend>rerender</legend>
      <span id="rerender-host"><input type="range" id="rerender-target" data-probe="rerender" min="0" max="10" step="1" value="1"></span>
    </fieldset>

    <fieldset><legend>escaping</legend>
      <input type="range" id="odd:id.v2" data-probe="oddId" min="0" max="10" step="1" value="2">
      <input type="range" id="123numeric" data-probe="numericId" min="0" max="10" step="1" value="3">
      <input type="range" id="has space" data-probe="spaceId" min="0" max="10" step="1" value="4">
    </fieldset>

    <fieldset><legend>duplicate id</legend>
      <input type="range" id="dup" data-probe="dupFirst" min="0" max="10" step="1" value="5">
      <input type="range" id="dup" data-probe="dupSecond" min="0" max="10" step="1" value="6">
    </fieldset>

    <fieldset><legend>radio group</legend>
      <input type="radio" name="mode" id="mode-a" value="a" data-probe="modeA" checked>
      <input type="radio" name="mode" id="mode-b" value="b" data-probe="modeB">
      <input type="radio" name="mode" id="mode-c" value="c" data-probe="modeC">
      <input type="checkbox" name="flags" id="chk-a" value="a" data-probe="chkA">
      <input type="checkbox" name="flags" id="chk-b" value="b" data-probe="chkB">
    </fieldset>

    <fieldset class="advanced"><legend>advanced</legend>
      <input type="range" id="advanced-gain" data-probe="advancedGain" min="0" max="10" step="1" value="7">
    </fieldset>

    <fieldset><legend>unsupported</legend>
      <canvas id="sim-canvas" width="80" height="40"></canvas>
      <button type="button" id="needs-gesture" data-probe="gesture">needs gesture</button>
    </fieldset>
  </div>
  <canvas id="scene" width="10" height="10"></canvas>
  <script>
    window.__CONTROL_STATE__ = {};
    // Accumulated "internal" state. Nothing that writes a control's value back resets this — which
    // is the whole reason ADR D2 defaults to reload-document instead of in-place restore.
    window.__PHYSICS__ = 0;
    window.__DIAGNOSTIC__ = [];

    ${REACT_TRACKER}

    (function () {
      var S = window.__CONTROL_STATE__;
      function probe(el) { return el.getAttribute('data-probe'); }

      // ── vanilla + escaping + duplicate: plain listeners, value/checked read straight off ──
      var plain = document.querySelectorAll(
        '#speed,#count,#enabled,#mode-select,#advanced-gain,' +
        '[data-probe="oddId"],[data-probe="numericId"],[data-probe="spaceId"],' +
        '[data-probe="dupFirst"],[data-probe="dupSecond"],[data-probe="rerender"]'
      );
      for (var i = 0; i < plain.length; i++) {
        (function (el) {
          var kind = el.type === 'checkbox' ? 'checked' : 'value';
          S[probe(el)] = kind === 'checked' ? el.checked : el.value;
          el.addEventListener('input', function () {
            S[probe(el)] = kind === 'checked' ? el.checked : el.value;
            if (el.id === 'speed') window.__PHYSICS__ += Number(el.value);
          });
          el.addEventListener('change', function () {
            S[probe(el)] = kind === 'checked' ? el.checked : el.value;
          });
        })(plain[i]);
      }

      // ── radio + checkbox groups ──
      var grouped = document.querySelectorAll('[name="mode"],[name="flags"]');
      for (var j = 0; j < grouped.length; j++) {
        (function (el) {
          S[probe(el)] = el.checked;
          el.addEventListener('change', function () {
            // Record the whole group, because a radio turning ON turns two others OFF without
            // ever firing their events — a per-element listener alone would miss that.
            var peers = document.querySelectorAll('[name="' + el.name + '"]');
            for (var k = 0; k < peers.length; k++) S[probe(peers[k])] = peers[k].checked;
            if (el.name === 'mode') S.modeGroup = el.value;
          });
        })(grouped[j]);
      }

      // ── react-controlled ──
      installControlledInput(document.getElementById('react-temp'), '10', 'reactTemp');
      installControlledCheckbox(document.getElementById('react-armed'), false, 'reactArmed');

      // ── rerender churn: replaces the node, same id, preserving its live value ──
      var churn = null;
      window.__START_CHURN__ = function (periodMs) {
        if (churn) return;
        var host = document.getElementById('rerender-host');
        churn = setInterval(function () {
          var old = document.getElementById('rerender-target');
          var next = old.cloneNode(true);
          next.value = old.value;
          host.replaceChild(next, old);
          next.addEventListener('input', function () { S.rerender = next.value; });
          S['rerender:generation'] = (S['rerender:generation'] || 0) + 1;
        }, periodMs || 250);
      };
      window.__STOP_CHURN__ = function () { clearInterval(churn); churn = null; };

      // ── canvas: interactive, and semantically opaque on purpose ──
      var cv = document.getElementById('sim-canvas');
      // A DOM-only harness (jsdom without the optional canvas package) returns null here. Guard
      // it so the interaction is still RECORDED — what matters for the recorder is that a pointer
      // gesture on a canvas produces a diagnostic, not that pixels were drawn.
      var ctx = cv.getContext('2d');
      var dragging = false;
      function paintAt(x, y) {
        if (ctx) { ctx.fillStyle = '#0af'; ctx.fillRect(x - 2, y - 2, 4, 4); }
        S.canvasStrokes = (S.canvasStrokes || 0) + 1;
      }
      cv.addEventListener('pointerdown', function (e) { dragging = true; paintAt(e.offsetX, e.offsetY); });
      cv.addEventListener('pointermove', function (e) { if (dragging) paintAt(e.offsetX, e.offsetY); });
      cv.addEventListener('pointerup', function () { dragging = false; });

      // ── activation-gated button: DOM Standard says a dispatched event is not trusted ──
      document.getElementById('needs-gesture').addEventListener('click', function (e) {
        if (!e.isTrusted) {
          window.__DIAGNOSTIC__.push('untrusted-click');
          return;
        }
        S.gesture = (S.gesture || 0) + 1;
      });
    })();

    // A real sim paints inside its OWN rAF — this is what may legitimately ack SIM_PAINTED.
    requestAnimationFrame(function () {
      var c = document.getElementById('scene').getContext('2d');
      if (c) { c.fillStyle = '#000'; c.fillRect(0, 0, 10, 10); }
      window.__SIM_PAINTED_SELF__ = true;
    });
  </script>
</body>
</html>`;

/**
 * Section bodies. They intentionally do NOT touch the controls through anything resembling the
 * future executor — a fixture that used the mechanism under test would prove nothing about it.
 * They set the marker, and MOVED/CHURN change document state so a baseline scan and a final scan
 * differ in a known way.
 */
export const CONTROL_SECTION_BODIES: Record<string, string> = {
  [FIXTURE_CONTROL_SECTIONS.BASE]: `
    var el = document.getElementById('marker');
    el.style.background = '#0000ff';
    el.setAttribute('data-section', 'CBASE');
    return function cleanup() {
      el.style.background = '#808080';
      el.setAttribute('data-section', 'none');
    };
  `,
  [FIXTURE_CONTROL_SECTIONS.MOVED]: `
    var el = document.getElementById('marker');
    el.style.background = '#ffff00';
    el.setAttribute('data-section', 'CMOVED');
    // Moves state the way an author would, through real events, so listeners run and
    // __PHYSICS__ accumulates. Cleanup restores the VALUES and deliberately leaves __PHYSICS__
    // alone — that residue is the point.
    var speed = document.getElementById('speed');
    speed.value = '80';
    speed.dispatchEvent(new Event('input', { bubbles: true }));
    var sel = document.getElementById('mode-select');
    sel.value = 'turbo';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    var b = document.getElementById('mode-b');
    b.checked = true;
    b.dispatchEvent(new Event('change', { bubbles: true }));
    return function cleanup() {
      el.style.background = '#808080';
      el.setAttribute('data-section', 'none');
      speed.value = '20';
      sel.value = 'fast';
      document.getElementById('mode-a').checked = true;
    };
  `,
  [FIXTURE_CONTROL_SECTIONS.CHURN]: `
    var el = document.getElementById('marker');
    el.style.background = '#ff00ff';
    el.setAttribute('data-section', 'CCHURN');
    window.__START_CHURN__(120);
    return function cleanup() {
      window.__STOP_CHURN__();
      el.style.background = '#808080';
      el.setAttribute('data-section', 'none');
    };
  `,
};
