/**
 * The authoring script — the picker's half that lives INSIDE the simulation document.
 *
 * WHY IT IS SERVED, NOT PUBLISHED. The runtime scanner has always lived in the rAF gate, and the
 * gate is baked into a package at PUBLICATION time. So a capability added there reaches only
 * packages republished afterwards — which is precisely why the picker reported "No controls
 * detected" on real simulations: their stored gates predate the scanner and never answered. This
 * script is fetched at SERVE time by a hook in the boot snippet, so it reaches every package that
 * already exists, today, with no republication and no change to stored bytes.
 *
 * WHAT IT DOES
 *   1. adopts a MessagePort the editor transfers in a CONNECT message;
 *   2. answers SCAN_CONTROLS with the SHARED scanner's result (simScannerSource.ts);
 *   3. draws green "Keep" / red "Hidden" badges on the controls and reports clicks on them;
 *   4. while explicitly armed, reports controls that script-dispatched events touch.
 *
 * INERT BY CONSTRUCTION. Nothing here runs for a viewer: the file is only fetched after a CONNECT
 * from an allowlisted parent origin, and a viewer never sends one.
 *
 * ES5 ONLY. This runs in whatever document the customer uploaded.
 */
import { createHash } from 'node:crypto';
import { SIM_SCANNER_SOURCE } from './simScannerSource.js';
import {
  SIM_AUTHORING_NS,
  SIM_AUTHORING_VERSION,
  SIM_AUTHORING_OVERLAY_ATTR,
} from 'shared/sim/authoringProtocol';

export const SIM_AUTHORING_SCRIPT = `;(function () {
  'use strict';
  if (window.__SIM_AUTHORING_ACTIVE__) return;
  window.__SIM_AUTHORING_ACTIVE__ = true;

  var NS = ${JSON.stringify(SIM_AUTHORING_NS)};
  var V = ${SIM_AUTHORING_VERSION};
  var OVERLAY_ATTR = ${JSON.stringify(SIM_AUTHORING_OVERLAY_ATTR)};

${SIM_SCANNER_SOURCE}

  // ── Session state ───────────────────────────────────────────────────────────
  var port = null;
  var sid = null;
  var marks = {};            // selector -> 'keep' | 'hide'
  var lastScan = [];         // controls from the most recent scan
  var overlay = null;
  var pills = {};            // selector -> pill element
  var observing = false;
  /** Set by DISARM. Guards the paint loop, which is the only thing that can rebuild the overlay. */
  var disarmed = false;
  var touched = {};
  var touchTimer = 0;
  var rafHandle = 0;

  function send(type, payload) {
    if (!port) return;
    var msg = { ns: NS, v: V, sid: sid, type: type };
    for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
    try { port.postMessage(msg); } catch (e) { /* port closed */ }
  }

  // ── Overlay ─────────────────────────────────────────────────────────────────
  // Positioning is \`position: fixed\` at raw getBoundingClientRect() coordinates. That is the
  // whole reason nested scrolling needs no special case: viewport coordinates already account
  // for every ancestor scroller, so a control inside a scrolling panel needs no offset walk.

  function ensureOverlay() {
    if (overlay && overlay.parentNode) return overlay;
    if (!document.body) return null;
    overlay = document.createElement('div');
    overlay.setAttribute(OVERLAY_ATTR, '');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' +
      'font:600 11px system-ui,-apple-system,sans-serif;';
    document.body.appendChild(overlay);
    return overlay;
  }

  function pillFor(selector) {
    if (pills[selector] && pills[selector].parentNode) return pills[selector];
    var el = document.createElement('span');
    // A plain <span> with no role: the scanner's candidate set is
    // button/input/select/textarea/[role=...], so a pill can never be mistaken for a control
    // even before the overlay-subtree skip catches it.
    el.style.cssText =
      'position:fixed;pointer-events:auto;cursor:pointer;padding:1px 6px;border-radius:999px;' +
      'white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.3);user-select:none;';
    el.addEventListener('click', function (e) {
      // Only the pill's own click is consumed — the simulation beneath keeps every other click.
      e.preventDefault();
      e.stopPropagation();
      send('MARK_TOGGLED', { selector: selector });
    }, true);
    pills[selector] = el;
    return el;
  }

  function paint() {
    var root = ensureOverlay();
    if (!root) return;
    var seen = {};
    for (var i = 0; i < lastScan.length; i++) {
      var c = lastScan[i];
      // A control the SIMULATION keeps hidden gets no badge — there is nothing to anchor to.
      // The list in the editor is its only path, which is what the ADR requires anyway.
      if (c.hidden) continue;
      var el = null;
      // Re-resolved every tick rather than cached: the RERENDER fixture replaces its node every
      // 250ms, and a held reference would leave the badge anchored to a detached element.
      try { el = document.querySelector(c.selector); } catch (err) { el = null; }
      if (!el) continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // Off-viewport controls get no pill; the list covers them.
      if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue;
      var hide = marks[c.selector] === 'hide';
      var p = pillFor(c.selector);
      if (p.parentNode !== root) root.appendChild(p);
      // Icon AND text, never colour alone (ADR D10) — colour is the fast read, the glyph and the
      // word are what make it legible to a colour-blind author and in a screenshot.
      p.textContent = hide ? '\\u2715 Hidden' : '\\u2713 Keep';
      p.style.background = hide ? '#dc2626' : '#16a34a';
      p.style.color = '#fff';
      p.style.left = Math.max(0, r.left) + 'px';
      p.style.top = Math.max(0, r.top - 16) + 'px';
      seen[c.selector] = 1;
    }
    for (var s in pills) {
      if (!seen[s] && pills[s].parentNode) pills[s].parentNode.removeChild(pills[s]);
    }
  }

  // Repositioning rides the gate's RAW rAF when present. The gated one is frozen while the sim is
  // paused, and badges that stop tracking a scrolling page while the author is picking would look
  // exactly like the feature being broken.
  function schedulePaint() {
    if (disarmed || rafHandle) return;
    var raf = (window.__SIM_RAF_GATE__ && window.__SIM_RAF_GATE__.raw) || window.requestAnimationFrame;
    rafHandle = raf(function () {
      rafHandle = 0;
      // Checked again HERE, not only at schedule time. DISARM can land between the two, and a
      // frame that was already queued would then rebuild the overlay it had just removed —
      // observed in the browser, where the overlay came back within one frame of teardown.
      if (disarmed) return;
      paint();
    });
  }

  // Capture phase, so a scroll in ANY nested container reaches this.
  window.addEventListener('scroll', schedulePaint, true);
  window.addEventListener('resize', schedulePaint, true);

  function teardown() {
    disarmed = true;
    rafHandle = 0;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    pills = {};
    observing = false;
    touched = {};
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = 0; }
  }

  // ── Script-touch observation ────────────────────────────────────────────────
  // Armed ONLY between OBSERVE_START and OBSERVE_STOP. A document-lifetime listener would sweep
  // up the simulation's own initialisation — which also dispatches untrusted events — and report
  // it as Auto Script activity.

  function flushTouched() {
    touchTimer = 0;
    var out = [];
    for (var s in touched) out.push(s);
    if (out.length) send('SCRIPT_TOUCHED', { selectors: out, heuristic: true });
    touched = {};
  }

  function onScriptEvent(e) {
    if (!observing) return;
    // isTrusted === false means "dispatched by script" per the DOM Standard. That is the whole
    // signal, and it is one-directional: a script writing element.value with no event at all is
    // invisible here, which is why the editor labels this heuristic.
    if (e.isTrusted) return;
    var target = e.target;
    if (!target || !target.closest) return;
    if (target.closest('[' + OVERLAY_ATTR + ']')) return;
    // Resolve to a control from the LATEST scan, walking up: the event may land on a child of the
    // control (a <span> inside a button).
    for (var i = 0; i < lastScan.length; i++) {
      var c = lastScan[i];
      var el = null;
      try { el = document.querySelector(c.selector); } catch (err) { el = null; }
      if (el && (el === target || el.contains(target))) {
        touched[c.selector] = 1;
        if (!touchTimer) touchTimer = setTimeout(flushTouched, 250);
        return;
      }
    }
  }

  document.addEventListener('input', onScriptEvent, true);
  document.addEventListener('change', onScriptEvent, true);
  document.addEventListener('click', onScriptEvent, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && port) send('ESCAPE_REQUESTED', {});
  }, true);

  // ── Port protocol ───────────────────────────────────────────────────────────
  function onPortMessage(e) {
    var d = e && e.data;
    if (!d || d.ns !== NS || d.v !== V) return;
    // A message tagged with a superseded session is from a CONNECT the editor has replaced.
    if (d.sid && sid && d.sid !== sid) return;

    if (d.type === 'SCAN_CONTROLS') {
      var r = collectSimControls();
      lastScan = r.controls;
      // ALWAYS answers — an empty list is a fact ("this document has no controls"), and it must
      // be distinguishable from silence ("the scanner could not be reached"). Conflating those is
      // what made the old picker say "Not scanned yet" and "No controls detected" at once.
      send('CONTROLS_LIST', {
        requestId: d.requestId,
        controls: r.controls,
        truncated: r.truncated,
        scanned: true,
      });
      schedulePaint();
      return;
    }
    if (d.type === 'SET_MARKS') {
      marks = {};
      var list = d.marks || [];
      for (var i = 0; i < list.length; i++) marks[list[i].selector] = list[i].mark;
      schedulePaint();
      return;
    }
    if (d.type === 'OBSERVE_START') { observing = true; touched = {}; return; }
    if (d.type === 'OBSERVE_STOP') { observing = false; if (touchTimer) { clearTimeout(touchTimer); touchTimer = 0; } return; }
    if (d.type === 'DISARM') { teardown(); return; }
  }

  function adopt(pending) {
    if (!pending || !pending.port) return;
    if (port && port !== pending.port) { try { port.close(); } catch (e) {} }
    port = pending.port;
    sid = pending.sid;
    marks = {};
    lastScan = [];
    teardown();
    disarmed = false;   // a fresh session re-arms; teardown above only cleaned the previous one
    port.onmessage = onPortMessage;
    try { port.start(); } catch (e) {}
    send('CONNECTED', {});
  }

  // The hook records the CONNECT it accepted; a later CONNECT (reconnect after a reload) is
  // handed over through the same slot.
  window.__SIM_AUTHORING_ADOPT__ = adopt;
  adopt(window.__SIM_AUTHORING_PENDING__);
})();
`;

/** Strong ETag over the exact bytes served. Computed once — the script is a build-time constant. */
export const SIM_AUTHORING_SCRIPT_ETAG =
  '"' + createHash('sha1').update(SIM_AUTHORING_SCRIPT).digest('hex') + '"';
