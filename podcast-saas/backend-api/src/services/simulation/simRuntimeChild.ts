/**
 * The v3 CHILD runtime — the code that runs inside a simulation document.
 *
 * This module produces JavaScript source that is embedded into every generated `bridge.js`. It is
 * written as a string rather than as a compiled module because the bridge is assembled and stored
 * as bytes: there is no bundler between here and the browser, and the output has to run unchanged
 * in whatever document the customer uploaded.
 *
 * WHAT IT IMPLEMENTS
 *   • the child half of the v3 bootstrap (hello → offer → adopt port → accept);
 *   • the document lifecycle (INIT_DOCUMENT … DISPOSED, CONTEXT_LOST/RESTORED);
 *   • the activation lifecycle (PREPARE → APPLIED → PRESENT → PRESENTED → ACTIVATE → RELEASE);
 *   • the managed resource scope (Priority 6.2) with real counters and a leak report;
 *   • the automation, audio, quality and suspension contracts (6.3–6.6).
 *
 * WHAT IT DOES NOT DO
 * It does not replace the v2 listener. The v2 bridge keeps running alongside it, unchanged, so a
 * player that never offers a port sees exactly the document it has always seen. That coexistence
 * is deliberate: the v3 path must be provably additive, or upgrading the bridge would be a
 * behaviour change for every stored package at once.
 *
 * WRITING STYLE
 * ES5. No arrow functions, no const/let, no optional chaining, no template literals in the emitted
 * source. Some uploaded simulations are old enough that their documents are parsed in quirks mode
 * with an old JS engine shim in front of them, and a syntax error in the bridge is a dead package
 * with no error message.
 */

import {
  SIM_PROTOCOL_NAMESPACE,
  SIM_PROTOCOL_VERSION,
} from 'shared/sim/runtimeProtocol';

/**
 * Bumped whenever the emitted child source changes in a way a stored package must be rebuilt for.
 * v2 adds SET_UI_POLICY / SET_AUTOMATION_POLICY and the `policies` advertisement (audit P1.2).
 */
export const SIM_CHILD_RUNTIME_VERSION = 2;

export const SIM_CHILD_MARKER_START = `/* @@SIM_RUNTIME_V${SIM_PROTOCOL_VERSION}_START@@ */`;
export const SIM_CHILD_MARKER_END = `/* @@SIM_RUNTIME_V${SIM_PROTOCOL_VERSION}_END@@ */`;

/**
 * The managed resource scope.
 *
 * TRACKS, DOES NOT MONKEYPATCH (except where it must). Managed sections allocate through the
 * handle they are given, so nothing global is touched for them. Legacy bodies call the globals
 * directly, so for THOSE the scope swaps the globals in for exactly the duration of the
 * synchronous body call and swaps them back in a `finally` — the same bounded window the shipping
 * v2 bridge already uses, and the reason the prompt's "do not globally monkeypatch beyond the
 * lifetime and execution scope" constraint is satisfiable at all.
 *
 * PAUSE IS NOT DISPOSE. `pause()` stops time advancing — rAF callbacks stop being re-scheduled,
 * intervals stop firing, media pauses, the audio graph suspends — while every handle stays
 * registered so `resume()` can put them back. A scope that disposed on pause would destroy the
 * scene the user is coming back to, which is the exact behaviour the single cleanup function was
 * stuck with.
 */
const MANAGED_SCOPE_SOURCE = String.raw`
function __simMakeScope(win, onLeak) {
  var doc = win.document;
  var counts = {
    rafCallbacks: 0, timeouts: 0, intervals: 0, listeners: 0, abortControllers: 0,
    workers: 0, ports: 0, mediaElements: 0, animations: 0, audioContexts: 0, audioNodes: 0,
    objectUrls: 0, imageBitmaps: 0, observers: 0, glRenderers: 0, glGeometries: 0,
    glMaterials: 0, glTextures: 0, glRenderTargets: 0, glPrograms: 0
  };

  var rawRaf = (win.__SIM_RAF_GATE__ && win.__SIM_RAF_GATE__.raw) || win.requestAnimationFrame;
  var rawCaf = win.cancelAnimationFrame;
  var sysRaf = (win.__SIM_RAF_GATE__ && (win.__SIM_RAF_GATE__.sys || win.__SIM_RAF_GATE__.raw)) || win.requestAnimationFrame;
  var rawSetTimeout = win.setTimeout;
  var rawClearTimeout = win.clearTimeout;
  var rawSetInterval = win.setInterval;
  var rawClearInterval = win.clearInterval;

  var paused = false;
  var disposed = false;

  // Live registries. Arrays rather than Maps: the emitted source targets engines old enough that a
  // Map polyfill cannot be assumed, and these lists never grow past a few dozen entries.
  var rafs = [];        // {id, cb, pendingWhilePaused}
  var timeouts = [];    // {id, fn, delay, args, at, remaining}
  var intervals = [];   // {id, fn, delay, args}
  var listeners = [];   // {target, type, fn, opts}
  var aborters = [];
  var tracked = [];     // {kind, resource, dispose, label}
  var automation = [];  // {handle, kind}
  var frameCount = 0;

  function bump(kind, n) { if (counts[kind] !== undefined) counts[kind] += n; }

  // ── animation frames ──────────────────────────────────────────────────────
  function scopeRaf(cb) {
    if (disposed) return 0;
    var rec = { id: 0, cb: cb, queued: false, wrapped: null };
    var wrapped = function (t) {
      rec.queued = false;
      var i = indexOfRec(rafs, rec);
      if (i >= 0) rafs.splice(i, 1);
      bump('rafCallbacks', -1);
      frameCount++;
      try { cb(t); } catch (e) { report('raf', e); }
    };
    // Retained so resume() can put the callback back. Without it a paused scope's render loop is
    // permanently dead: pause() cancels the pending frame and clears 'queued', and resume() has
    // nothing to re-schedule — the document comes back as a frozen picture (measured: +15 frames
    // before suspend, +0 after resume, in all three engines).
    rec.wrapped = wrapped;
    if (paused) {
      // Registered but NOT scheduled. Exactly ONE frame is owed on resume, never a replayed burst:
      // replaying every dropped callback is how a "paused" simulation jumps forward the moment it
      // is shown again.
      rec.queued = false;
      rafs.push(rec); bump('rafCallbacks', 1);
      return -(++pausedHandleSeq);
    }
    rec.id = rawRaf.call(win, wrapped);
    rec.queued = true;
    rafs.push(rec); bump('rafCallbacks', 1);
    return rec.id;
  }
  function scopeCaf(id) {
    for (var i = 0; i < rafs.length; i++) {
      if (rafs[i].id === id) {
        if (rafs[i].queued && rawCaf) { try { rawCaf.call(win, id); } catch (e) {} }
        rafs.splice(i, 1); bump('rafCallbacks', -1);
        return;
      }
    }
    if (rawCaf) { try { rawCaf.call(win, id); } catch (e) {} }
  }

  // ── timers ────────────────────────────────────────────────────────────────
  function scopeSetTimeout(fn, delay) {
    if (disposed) return 0;
    var args = Array.prototype.slice.call(arguments, 2);
    var rec = { id: 0, fn: fn, delay: delay || 0, args: args, at: nowMs(), remaining: delay || 0 };
    var wrapped = function () {
      var i = indexOfRec(timeouts, rec);
      if (i >= 0) timeouts.splice(i, 1);
      bump('timeouts', -1);
      dropAutomation(rec);
      try { fn.apply(win, args); } catch (e) { report('timeout', e); }
    };
    if (!paused) {
      rec.id = rawSetTimeout.call(win, wrapped, delay || 0);
    } else {
      rec.id = -(++pausedHandleSeq);
    }
    rec.wrapped = wrapped;
    timeouts.push(rec); bump('timeouts', 1);
    return rec.id;
  }
  function scopeClearTimeout(id) {
    for (var i = 0; i < timeouts.length; i++) {
      if (timeouts[i].id === id) {
        if (id > 0) { try { rawClearTimeout.call(win, id); } catch (e) {} }
        dropAutomation(timeouts[i]);
        timeouts.splice(i, 1); bump('timeouts', -1);
        return;
      }
    }
    try { rawClearTimeout.call(win, id); } catch (e) {}
  }
  function scopeSetInterval(fn, delay) {
    if (disposed) return 0;
    var args = Array.prototype.slice.call(arguments, 2);
    var rec = { id: 0, fn: fn, delay: delay || 0, args: args };
    var wrapped = function () { try { fn.apply(win, args); } catch (e) { report('interval', e); } };
    rec.wrapped = wrapped;
    if (!paused) rec.id = rawSetInterval.call(win, wrapped, delay || 0);
    else rec.id = -(++pausedHandleSeq);
    intervals.push(rec); bump('intervals', 1);
    return rec.id;
  }
  function scopeClearInterval(id) {
    for (var i = 0; i < intervals.length; i++) {
      if (intervals[i].id === id) {
        if (id > 0) { try { rawClearInterval.call(win, id); } catch (e) {} }
        dropAutomation(intervals[i]);
        intervals.splice(i, 1); bump('intervals', -1);
        return;
      }
    }
    try { rawClearInterval.call(win, id); } catch (e) {}
  }
  var pausedHandleSeq = 0;

  // ── listeners ─────────────────────────────────────────────────────────────
  function scopeAdd(target, type, fn, opts) {
    if (disposed || !target || !target.addEventListener) return;
    target.addEventListener(type, fn, opts);
    listeners.push({ target: target, type: type, fn: fn, opts: opts });
    bump('listeners', 1);
  }
  function scopeRemove(target, type, fn, opts) {
    if (!target || !target.removeEventListener) return;
    try { target.removeEventListener(type, fn, opts); } catch (e) {}
    for (var i = 0; i < listeners.length; i++) {
      var l = listeners[i];
      if (l.target === target && l.type === type && l.fn === fn) {
        listeners.splice(i, 1); bump('listeners', -1); return;
      }
    }
  }

  // ── abort / fetch ─────────────────────────────────────────────────────────
  function scopeAbortController() {
    var AC = win.AbortController;
    if (!AC) return { signal: undefined, abort: function () {} };
    var c = new AC();
    aborters.push(c); bump('abortControllers', 1);
    return c;
  }
  function scopeFetch(input, init) {
    var c = scopeAbortController();
    var opts = init || {};
    var merged = {};
    for (var k in opts) { if (Object.prototype.hasOwnProperty.call(opts, k)) merged[k] = opts[k]; }
    if (c.signal && !merged.signal) merged.signal = c.signal;
    return win.fetch(input, merged);
  }

  // ── object URLs / bitmaps ─────────────────────────────────────────────────
  function scopeCreateObjectURL(obj) {
    var u = win.URL.createObjectURL(obj);
    tracked.push({ kind: 'objectUrls', resource: u, dispose: function (x) { try { win.URL.revokeObjectURL(x); } catch (e) {} }, label: 'objectURL' });
    bump('objectUrls', 1);
    return u;
  }
  function scopeRevokeObjectURL(u) { untrack(u); try { win.URL.revokeObjectURL(u); } catch (e) {} }

  // ── explicit tracking ─────────────────────────────────────────────────────
  function track(kind, resource, dispose, label) {
    if (counts[kind] === undefined) kind = 'observers';
    tracked.push({ kind: kind, resource: resource, dispose: dispose, label: label || kind });
    bump(kind, 1);
    return resource;
  }
  function untrack(resource) {
    for (var i = 0; i < tracked.length; i++) {
      if (tracked[i].resource === resource) {
        bump(tracked[i].kind, -1);
        tracked.splice(i, 1);
        return;
      }
    }
  }

  // ── automation attribution ────────────────────────────────────────────────
  // ONLY what a section explicitly registers is automation. Guessing from the delay was tried and
  // is impossible: the generation prompt asks for 30-150ms demo intervals, which is exactly the
  // rate an engine's own loop runs at, so a heuristic freezes the simulation it meant to leave
  // running (audited). An unregistered timer is therefore left alone — a section that registers
  // nothing is simply not pausable, which is a no-op rather than a frozen scene.
  function registerAutomation(handle, kind) {
    var k = kind || 'interval';
    // Store the RECORD, not the native handle.
    //
    // pause(), resume() and resumeAutomation() all re-schedule, and re-scheduling assigns a NEW
    // native id. A registration that remembered the original id therefore resolved to nothing
    // after the first round trip: pauseAutomation cleared NOTHING while still acknowledging
    // AUTOMATION_PAUSED, so the parent was told the scene was paused while it kept running
    // (measured: 5-7 ticks accrued while "paused", in all three engines).
    var rec = k === 'interval' ? findRec(intervals, handle)
            : k === 'timeout'  ? findRec(timeouts, handle)
            : findRec(rafs, handle);
    automation.push({ rec: rec, kind: k });
    return handle;
  }
  function dropAutomation(rec) {
    for (var i = 0; i < automation.length; i++) {
      if (automation[i].rec === rec) { automation.splice(i, 1); return; }
    }
  }
  var automationPaused = false;
  var automationSaved = [];
  /** How many registered automations the last pauseAutomation() actually stopped. */
  var automationPausedCount = 0;
  function pauseAutomation() {
    if (automationPaused) return automationPausedCount;
    automationPaused = true;
    automationSaved = [];
    for (var i = 0; i < automation.length; i++) {
      var a = automation[i];
      var rec = a.rec;
      if (!rec) continue;
      if (a.kind === 'interval') {
        if (rec.id > 0) { try { rawClearInterval.call(win, rec.id); } catch (e) {} }
        automationSaved.push({ kind: 'interval', rec: rec });
      } else if (a.kind === 'timeout') {
        if (rec.id > 0) { try { rawClearTimeout.call(win, rec.id); } catch (e) {} }
        automationSaved.push({ kind: 'timeout', rec: rec });
      } else {
        if (rec.queued && rawCaf) { try { rawCaf.call(win, rec.id); } catch (e) {} rec.queued = false; }
        automationSaved.push({ kind: 'raf', rec: rec });
      }
    }
    automationPausedCount = automationSaved.length;
    return automationPausedCount;
  }
  function resumeAutomation() {
    if (!automationPaused) return 0;
    automationPaused = false;
    var n = automationSaved.length;
    for (var i = 0; i < automationSaved.length; i++) {
      var sv = automationSaved[i];
      if (sv.kind === 'interval') { sv.rec.id = rawSetInterval.call(win, sv.rec.wrapped, sv.rec.delay); }
      else if (sv.kind === 'timeout') { sv.rec.id = rawSetTimeout.call(win, sv.rec.wrapped, sv.rec.delay); }
      else if (sv.rec.wrapped && !sv.rec.queued) { sv.rec.id = rawRaf.call(win, sv.rec.wrapped); sv.rec.queued = true; }
    }
    automationSaved = [];
    automationPausedCount = 0;
    return n;
  }

  // ── media / audio / animations ────────────────────────────────────────────
  function collectMedia() {
    var out = [];
    try {
      var vids = doc.getElementsByTagName('video');
      var auds = doc.getElementsByTagName('audio');
      for (var i = 0; i < vids.length; i++) out.push(vids[i]);
      for (var j = 0; j < auds.length; j++) out.push(auds[j]);
    } catch (e) {}
    return out;
  }
  function collectAnimations() {
    try {
      if (doc.getAnimations) return doc.getAnimations();
    } catch (e) {}
    return [];
  }
  function audioContexts() {
    var out = [];
    for (var i = 0; i < tracked.length; i++) if (tracked[i].kind === 'audioContexts') out.push(tracked[i].resource);
    return out;
  }

  var audible = { muted: true, volume: 1 };
  function setAudible(state) {
    audible = { muted: !!(state && state.muted), volume: state && typeof state.volume === 'number' ? state.volume : 1 };
    var media = collectMedia();
    for (var i = 0; i < media.length; i++) {
      try { media[i].muted = audible.muted; media[i].volume = audible.muted ? 0 : audible.volume; } catch (e) {}
    }
    var ctxs = audioContexts();
    for (var j = 0; j < ctxs.length; j++) {
      var c = ctxs[j];
      try {
        if (c.__simMasterGain && c.__simMasterGain.gain) {
          c.__simMasterGain.gain.value = audible.muted ? 0 : audible.volume;
        }
        // A muted, HIDDEN document must not merely be silent — a running AudioContext keeps the
        // audio thread alive and, on some platforms, holds the media session. Suspend it.
        if (audible.muted && c.state === 'running' && c.suspend) c.suspend();
        if (!audible.muted && c.state === 'suspended' && c.resume) c.resume();
      } catch (e) {}
    }
  }

  // ── pause / resume / release / dispose ────────────────────────────────────
  function pause() {
    if (paused || disposed) return;
    paused = true;
    for (var i = 0; i < rafs.length; i++) {
      if (rafs[i].queued && rawCaf) { try { rawCaf.call(win, rafs[i].id); } catch (e) {} rafs[i].queued = false; }
    }
    for (var j = 0; j < intervals.length; j++) {
      if (intervals[j].id > 0) { try { rawClearInterval.call(win, intervals[j].id); } catch (e) {} intervals[j].id = -(++pausedHandleSeq); }
    }
    for (var k = 0; k < timeouts.length; k++) {
      if (timeouts[k].id > 0) { try { rawClearTimeout.call(win, timeouts[k].id); } catch (e) {} timeouts[k].id = -(++pausedHandleSeq); }
    }
    var media = collectMedia();
    for (var m = 0; m < media.length; m++) { try { if (!media[m].paused) { media[m].__simWasPlaying = true; media[m].pause(); } } catch (e) {} }
    var anims = collectAnimations();
    for (var a = 0; a < anims.length; a++) { try { if (anims[a].playState === 'running') { anims[a].__simWasRunning = true; anims[a].pause(); } } catch (e) {} }
    var ctxs = audioContexts();
    for (var c = 0; c < ctxs.length; c++) { try { if (ctxs[c].state === 'running' && ctxs[c].suspend) ctxs[c].suspend(); } catch (e) {} }
  }
  function resume() {
    if (!paused || disposed) return;
    paused = false;
    // Animation frames FIRST. pause() cancelled every queued frame and cleared 'queued', leaving
    // the record registered; nothing else in this function used to put them back, so a resumed
    // document rendered exactly nothing until a new activation minted a fresh scope. Worse, the
    // stranded record was silently dropped at dispose, so even the leak report could not reveal it.
    for (var r = 0; r < rafs.length; r++) {
      var rr = rafs[r];
      if (!rr.queued && rr.wrapped) { rr.id = rawRaf.call(win, rr.wrapped); rr.queued = true; }
    }
    for (var j = 0; j < intervals.length; j++) {
      if (intervals[j].id <= 0) intervals[j].id = rawSetInterval.call(win, intervals[j].wrapped, intervals[j].delay);
    }
    for (var k = 0; k < timeouts.length; k++) {
      if (timeouts[k].id <= 0) timeouts[k].id = rawSetTimeout.call(win, timeouts[k].wrapped, timeouts[k].delay);
    }
    var media = collectMedia();
    for (var m = 0; m < media.length; m++) { try { if (media[m].__simWasPlaying) { media[m].__simWasPlaying = false; if (!audible.muted) media[m].play(); } } catch (e) {} }
    var anims = collectAnimations();
    for (var a = 0; a < anims.length; a++) { try { if (anims[a].__simWasRunning) { anims[a].__simWasRunning = false; anims[a].play(); } } catch (e) {} }
    if (!audible.muted) {
      var ctxs = audioContexts();
      for (var c = 0; c < ctxs.length; c++) { try { if (ctxs[c].state === 'suspended' && ctxs[c].resume) ctxs[c].resume(); } catch (e) {} }
    }
  }

  /**
   * Release everything, and keep an HONEST account of what would not release.
   *
   * The obvious implementation — cancel in a loop, then zero every counter — makes the leak report
   * structurally incapable of being non-empty. That is worse than having no report: 'DISPOSED'
   * would carry a proof-of-no-leak that is true by construction for a leaking package and a clean
   * one alike, and no test could tell the difference (a reviewer proved exactly that by replacing
   * the payload with a hardcoded empty list and watching every test still pass).
   *
   * So each resource is removed from its registry ONLY when its release actually succeeded. A
   * throwing dispose leaves its entry counted, and it shows up by name in the report.
   */
  function disposeAll() {
    if (disposed) return;
    disposed = true;
    var stubborn = [];

    var survivingRafs = [];
    for (var i = 0; i < rafs.length; i++) {
      if (!rafs[i].queued) { bump('rafCallbacks', -1); continue; }
      if (!rawCaf) { survivingRafs.push(rafs[i]); stubborn.push('rafCallbacks:no-cancelAnimationFrame'); continue; }
      try { rawCaf.call(win, rafs[i].id); bump('rafCallbacks', -1); }
      catch (e) { survivingRafs.push(rafs[i]); stubborn.push('rafCallbacks:cancel-threw'); }
    }
    rafs = survivingRafs;

    var survivingIntervals = [];
    for (var j = 0; j < intervals.length; j++) {
      if (intervals[j].id <= 0) { bump('intervals', -1); continue; }   // already cleared by pause()
      try { rawClearInterval.call(win, intervals[j].id); bump('intervals', -1); }
      catch (e) { survivingIntervals.push(intervals[j]); stubborn.push('intervals:clear-threw'); }
    }
    intervals = survivingIntervals;

    var survivingTimeouts = [];
    for (var k = 0; k < timeouts.length; k++) {
      if (timeouts[k].id <= 0) { bump('timeouts', -1); continue; }
      try { rawClearTimeout.call(win, timeouts[k].id); bump('timeouts', -1); }
      catch (e) { survivingTimeouts.push(timeouts[k]); stubborn.push('timeouts:clear-threw'); }
    }
    timeouts = survivingTimeouts;

    var survivingListeners = [];
    for (var l = 0; l < listeners.length; l++) {
      var li = listeners[l];
      if (!li.target || typeof li.target.removeEventListener !== 'function') {
        survivingListeners.push(li); stubborn.push('listeners:target-cannot-remove'); continue;
      }
      try { li.target.removeEventListener(li.type, li.fn, li.opts); bump('listeners', -1); }
      catch (e) { survivingListeners.push(li); stubborn.push('listeners:remove-threw'); }
    }
    listeners = survivingListeners;

    var survivingAborters = [];
    for (var b = 0; b < aborters.length; b++) {
      try { aborters[b].abort(); bump('abortControllers', -1); }
      catch (e) { survivingAborters.push(aborters[b]); stubborn.push('abortControllers:abort-threw'); }
    }
    aborters = survivingAborters;

    // Newest-first: a texture registered after the renderer that owns it must go before the
    // renderer, or its dispose call runs against a dead context.
    var survivingTracked = [];
    for (var t = tracked.length - 1; t >= 0; t--) {
      var rec = tracked[t];
      if (typeof rec.dispose !== 'function') {
        // Registered with no way to release it. That is a leak the SECTION created, and naming it
        // is the only way its author ever finds out.
        survivingTracked.push(rec); stubborn.push(rec.kind + ':' + rec.label + ':no-dispose');
        continue;
      }
      try { rec.dispose(rec.resource); bump(rec.kind, -1); }
      catch (e) {
        report('dispose:' + rec.label, e);
        survivingTracked.push(rec); stubborn.push(rec.kind + ':' + rec.label + ':dispose-threw');
      }
    }
    tracked = survivingTracked;

    automation = []; automationSaved = [];
    lastStubborn = stubborn;
  }

  var lastStubborn = [];

  /**
   * Everything still alive AFTER a dispose. A non-empty list is a leak and is reported as one.
   *
   * Two independent sources, because they catch different things: the counters name resources the
   * scope KNOWS it failed to release, and the live-DOM probe catches resources the scope never
   * owned — media the section started outside the scope, an audio graph a library built for itself.
   * A report built on only the first would be silent about exactly the leaks a section is most
   * likely to create.
   */
  function leakReport() {
    var leaked = [];
    for (var kind in counts) {
      if (Object.prototype.hasOwnProperty.call(counts, kind) && counts[kind] > 0) {
        leaked.push(kind + '=' + counts[kind]);
      }
    }
    for (var i = 0; i < lastStubborn.length; i++) leaked.push(lastStubborn[i]);
    var stillRunning = unstoppableReport();
    for (var j = 0; j < stillRunning.length; j++) leaked.push('after-dispose:' + stillRunning[j]);
    return leaked;
  }

  /** Things the scope was asked to stop and could not. Reported, never hidden. */
  function unstoppableReport() {
    var out = [];
    var media = collectMedia();
    for (var i = 0; i < media.length; i++) { if (!media[i].paused) out.push('media-still-playing'); }
    var anims = collectAnimations();
    for (var a = 0; a < anims.length; a++) { if (anims[a].playState === 'running') out.push('animation-still-running'); }
    var ctxs = audioContexts();
    for (var c = 0; c < ctxs.length; c++) { if (ctxs[c].state === 'running') out.push('audiocontext-still-running'); }
    // A Worker has no pause — only terminate, which would destroy the state the section is coming
    // back to. So a tracked Worker keeps computing through a suspension, and the honest thing is to
    // SAY so: a DOCUMENT_SUSPENDED that reported quiescence with a live Worker would be claiming a
    // guarantee the scope cannot make, and the classifier would grant it 'suspendable'.
    for (var w = 0; w < tracked.length; w++) {
      if (tracked[w].kind === 'workers') out.push('worker-still-running');
    }
    return out;
  }

  function snapshot() {
    var out = {};
    for (var k in counts) { if (Object.prototype.hasOwnProperty.call(counts, k)) out[k] = counts[k]; }
    return out;
  }

  function report(where, err) { if (onLeak) { try { onLeak(where, err); } catch (e) {} } }
  function nowMs() { try { return (win.performance && win.performance.now) ? win.performance.now() : +new Date(); } catch (e) { return +new Date(); } }
  function indexOfRec(arr, rec) { for (var i = 0; i < arr.length; i++) if (arr[i] === rec) return i; return -1; }
  function findRec(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }

  /**
   * Run a LEGACY body with the globals temporarily swapped. Bounded to the synchronous call, so
   * nothing global is left patched afterwards.
   */
  function runLegacy(fn) {
    var si = win.setInterval, st = win.setTimeout, ra = win.requestAnimationFrame;
    win.setInterval = function (f, d) { return scopeSetInterval.apply(null, arguments); };
    win.setTimeout = function (f, d) { return scopeSetTimeout.apply(null, arguments); };
    win.requestAnimationFrame = function (cb) { return scopeRaf(cb); };
    try { return fn(); }
    finally { win.setInterval = si; win.setTimeout = st; win.requestAnimationFrame = ra; }
  }

  return {
    handle: {
      requestAnimationFrame: scopeRaf,
      cancelAnimationFrame: scopeCaf,
      setTimeout: scopeSetTimeout,
      clearTimeout: scopeClearTimeout,
      setInterval: scopeSetInterval,
      clearInterval: scopeClearInterval,
      addEventListener: scopeAdd,
      removeEventListener: scopeRemove,
      abortController: scopeAbortController,
      fetch: scopeFetch,
      createObjectURL: scopeCreateObjectURL,
      revokeObjectURL: scopeRevokeObjectURL,
      track: track,
      untrack: untrack,
      registerAutomation: registerAutomation
    },
    pause: pause,
    resume: resume,
    pauseAutomation: pauseAutomation,
    resumeAutomation: resumeAutomation,
    setAudible: setAudible,
    dispose: disposeAll,
    counts: snapshot,
    leaks: leakReport,
    unstoppable: unstoppableReport,
    runLegacy: runLegacy,
    frames: function () { return frameCount; },
    sysRaf: function (cb) { return sysRaf.call(win, cb); },
    isPaused: function () { return paused; }
  };
}
`;

/**
 * The protocol driver: bootstrap, the two lifecycles, and the dispatch that connects them to the
 * section bodies the bridge already carries.
 */
const PROTOCOL_SOURCE = String.raw`
function __simInstallV3(win, sections, opts) {
  var NS = '__NS__';
  var VER = __VER__;
  var doc = win.document;

  var port = null;
  var adopted = false;
  var parentOrigin = null;
  var ident = null;              // {playerSessionId, packageRevision, documentId}
  var outSeq = 0;
  var lastInSeq = 0;
  var docState = 'MOUNTING';
  var scope = null;
  var lifecycle = null;          // the ManagedSectionLifecycle currently installed
  var current = null;            // {activationId, variantKey, configHash, config}
  var presentedFrames = 0;
  var audible = { muted: true, volume: 1 };
  var quality = 'high';
  var contextLostKind = null;

  function post(type, payload, activation) {
    if (!port || !ident) return;
    var env = {
      namespace: NS,
      protocolVersion: VER,
      type: type,
      playerSessionId: ident.playerSessionId,
      packageRevision: ident.packageRevision,
      documentId: ident.documentId,
      seq: ++outSeq,
      payload: payload || {}
    };
    if (activation) {
      env.activationId = activation.activationId;
      env.variantKey = activation.variantKey;
      env.configHash = activation.configHash;
    }
    try { port.postMessage(env); } catch (e) {}
  }

  /**
   * Capability describes the PACKAGE, and is answered at INIT_DOCUMENT — when no section is
   * installed and 'lifecycle' is necessarily null. An earlier version derived these flags from the
   * installed lifecycle, which made 'managedLifecycle' and 'onDemandRender' unconditionally false
   * for every package that has ever existed: the report was unreachable-by-construction, so the
   * canary could never have classified anything 'managed-presentable' and the modern path would
   * have been dead code in production while every test still passed.
   *
   * The truthful source is the static descriptor the bridge builder stamps at generation time,
   * because probing the bodies would mean RUNNING them, and running a section body to find out
   * whether it is managed is exactly the side effect a capability query must not have.
   */
  function capabilities() {
    var allManaged = !!(opts && opts.allManaged);
    return {
      activationScoped: true,
      managedLifecycle: allManaged,
      // The legacy wrapper has a present() too, but it only acknowledges after a bookkeeping frame
      // — it cannot render on demand. Claiming otherwise would let a package whose picture the
      // parent cannot ask for be classified as one whose picture it can.
      onDemandRender: allManaged,
      contextEvents: true,
      // A package containing even one legacy-bodied section cannot promise quiescence for every
      // section, and the promise is package-wide because the parent picks the section at runtime.
      suspendable: allManaged,
      audioControl: true,
      qualityControl: !!(opts && opts.anyQuality)
    };
  }

  function variants() {
    var out = [];
    for (var k in sections) { if (Object.prototype.hasOwnProperty.call(sections, k)) out.push(k); }
    return out;
  }

  // ── validation ────────────────────────────────────────────────────────────
  // These two maps MUST agree with CHILD_INBOUND_TYPES / ACTIVATION_SCOPED_TYPES in
  // shared/sim/runtimeProtocol.ts. They are restated here because this source is emitted as bytes
  // into a package with no bundler in front of it; a test pins the agreement.
  var CHILD_INBOUND = {
    INIT_DOCUMENT: 1, SUSPEND_DOCUMENT: 1, RESUME_DOCUMENT: 1, SET_AUDIBLE: 1, SET_QUALITY: 1,
    DISPOSE_DOCUMENT: 1, PREPARE_SECTION: 1, PRESENT_SECTION: 1, ACTIVATE_SECTION: 1,
    PAUSE_AUTOMATION: 1, RESUME_AUTOMATION: 1, RELEASE_SECTION: 1,
    SET_UI_POLICY: 1, SET_AUTOMATION_POLICY: 1
  };
  var ACTIVATION_SCOPED = {
    PREPARE_SECTION: 1, PRESENT_SECTION: 1, ACTIVATE_SECTION: 1,
    PAUSE_AUTOMATION: 1, RESUME_AUTOMATION: 1, RELEASE_SECTION: 1,
    SET_UI_POLICY: 1, SET_AUTOMATION_POLICY: 1
  };

  function validate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.namespace !== NS) return null;
    if (raw.protocolVersion !== VER) return null;
    if (typeof raw.type !== 'string' || !Object.prototype.hasOwnProperty.call(CHILD_INBOUND, raw.type)) return null;
    if (!ident) return null;
    if (raw.playerSessionId !== ident.playerSessionId) return null;
    if (raw.documentId !== ident.documentId) return null;
    if (raw.packageRevision !== ident.packageRevision) return null;
    if (Object.prototype.hasOwnProperty.call(ACTIVATION_SCOPED, raw.type)) {
      if (!raw.activationId || !raw.variantKey || !raw.configHash) return null;
    }
    if (typeof raw.seq !== 'number' || raw.seq < 1 || raw.seq !== Math.floor(raw.seq)) return null;
    if (raw.seq <= lastInSeq) return null;    // duplicate or out-of-order
    // 'typeof [] === 'object'' and '[]' is truthy, so the obvious form accepts an ARRAY payload —
    // and the parent's validator does not (runtimeProtocol.isObject excludes arrays). The two
    // halves of one protocol must not disagree about what a legal envelope is.
    if (!raw.payload || typeof raw.payload !== 'object' || Object.prototype.toString.call(raw.payload) === '[object Array]') return null;
    lastInSeq = raw.seq;
    return raw;
  }

  // ── section resolution ────────────────────────────────────────────────────
  function bodyFor(name) {
    return (name && Object.prototype.hasOwnProperty.call(sections, name)) ? sections[name] : null;
  }

  /**
   * Wrap whatever a body returned into a lifecycle.
   *
   * A body returning an OBJECT with a 'present' function is managed. A body returning a FUNCTION is
   * a legacy cleanup: it gets a lifecycle whose 'dispose' calls it and which declines every other
   * capability. It is not described as managed anywhere — '__managed' stays false, so the
   * capability report and the classification both tell the truth about it.
   */
  function toLifecycle(ret) {
    if (ret && typeof ret === 'object' && typeof ret.present === 'function') {
      ret.__managed = true;
      return ret;
    }
    var cleanup = typeof ret === 'function' ? ret : null;
    return {
      __managed: false,
      present: function (ctx) {
        // The legacy body already ran synchronously and drew whatever it draws. One system frame
        // later its layout has landed, which is the same bookkeeping frame the v2 ack uses — and,
        // exactly as there, it is the SYSTEM rAF so this frame can never count as the simulation's
        // own first paint.
        var ack = function () {
          scope.sysRaf(function () { ctx.markPresented({ canvas: measureCanvas() }); });
        };
        // Heavy-asset readiness hook (2026-09-04): a package whose first COMPLETE frame depends
        // on large async assets (a multi-MB GLB mid-download) may export
        // window.__flowvidReadyForPresent, a function returning a thenable. The ack — and
        // therefore the parent's poster-to-live reveal — waits for it, so a half-loaded scene with its own
        // loading chrome can never become the acknowledged frame of a published section.
        // Bounded WELL UNDER the parent's SIM_PRESENT_TIMEOUT_MS (5s): on expiry we ack with
        // whatever is drawn rather than let the activation be classified a present-timeout.
        // Absent hook (every package published before this) → the old immediate ack, unchanged.
        var hook = null;
        try { hook = win.__flowvidReadyForPresent; } catch (e) { hook = null; }
        if (typeof hook !== 'function') { ack(); return; }
        var done = false;
        var settle = function () { if (!done) { done = true; ack(); } };
        var timer = win.setTimeout(settle, 4200);
        var clearAndSettle = function () { win.clearTimeout(timer); settle(); };
        try {
          var r = hook();
          if (r && typeof r.then === 'function') r.then(clearAndSettle, clearAndSettle);
          else clearAndSettle();
        } catch (e2) { clearAndSettle(); }
      },
      dispose: function () { if (cleanup) cleanup(); }
    };
  }

  function measureCanvas() {
    try {
      var cs = doc.getElementsByTagName('canvas');
      var best = null;
      for (var i = 0; i < cs.length; i++) {
        if (!best || cs[i].width * cs[i].height > best.width * best.height) best = cs[i];
      }
      return best ? { width: best.width, height: best.height } : null;
    } catch (e) { return null; }
  }

  function makeSignal() {
    try {
      var c = new win.AbortController();
      return c;
    } catch (e) { return { signal: undefined, abort: function () {} }; }
  }

  var currentAbort = null;

  // ── activation lifecycle ──────────────────────────────────────────────────
  function onPrepare(env) {
    var p = env.payload || {};
    // Release the previous activation FIRST: one document serves many sections, and leaving the
    // previous section's resources registered is how a resident pool grows without bound.
    releaseCurrent('superseded');

    // 'config' is the PREPARED config and stays mutable on purpose: a later SET_UI_POLICY /
    // SET_AUTOMATION_POLICY updates it in place so makeCtx() keeps describing what is actually
    // installed. 'autoStarted' records the value the BODY was run with, which is the only thing
    // that can answer "is there any automation to resume at all" — a body started with autoScript
    // off registered nothing, and pretending we resumed it would be a lie.
    current = {
      activationId: env.activationId, variantKey: env.variantKey, configHash: env.configHash,
      config: p.config || {},
      autoStarted: (p.config || {}).autoScript !== false
    };
    presentedFrames = 0;
    scope = __simMakeScope(win, function (where, err) {
      // 'where' names the resource and the phase ('dispose:glTextures', 'raf', 'interval'). Folding
      // every one of them into stage 'automation' made a throwing DISPOSE arrive at the parent as
      // an automation error with no resource name — a report that cannot be acted on.
      var isDispose = String(where).indexOf('dispose') === 0;
      post('SECTION_ERROR', {
        message: String(where) + ': ' + String((err && err.message) || err),
        stage: isDispose ? 'release' : 'automation',
        recoverable: true
      }, current);
    });
    scope.setAudible(audible);
    currentAbort = makeSignal();

    var fn = bodyFor(env.variantKey);
    if (!fn) {
      post('SECTION_ERROR', { message: 'unknown section: ' + env.variantKey, stage: 'prepare', recoverable: true }, current);
      return;
    }

    applyHideUi(p.config);

    var t0 = nowMs();
    var ret;
    try {
      ret = scope.runLegacy(function () { return fn(paramsFrom(p.config), makeCtx('prepare')); });
    } catch (err) {
      post('SECTION_ERROR', { message: String((err && err.message) || err), stage: 'prepare', recoverable: true }, current);
      return;
    }
    lifecycle = toLifecycle(ret);

    // WHOSE ACTIVATION IS THIS? Captured HERE, at call time — never read from the module-level
    // 'current' when the promise settles (simulation-009). prepare() may be async, and by the time
    // it resolves the viewer may have scrubbed to a different section: releaseCurrent will have
    // aborted this one and pointed 'current' at the new one. Posting against 'current' then stamps
    // THIS section's outcome with the OTHER section's identity, the parent's matchesActivation
    // accepts it, and a healthy section is acknowledged — or killed — for work belonging to a
    // section the viewer already left. onPresent below has always done this correctly and calls
    // the alternative "a forged match"; this is the same guard.
    var applyActivation = current;
    var finish = function () {
      if (!current || !applyActivation || current.activationId !== applyActivation.activationId) return;
      // The child recomputes NOTHING about identity: it echoes the exact variantKey and configHash
      // it was asked to install. A child that computed its own hash could disagree with the parent
      // for a reason neither side can see, and the invariant would start rejecting healthy acks.
      post('SECTION_APPLIED', { variantKey: env.variantKey, configHash: env.configHash, applyMs: nowMs() - t0 }, applyActivation);
    };
    if (lifecycle.__managed && typeof lifecycle.prepare === 'function') {
      runMaybeAsync(function () { return lifecycle.prepare(makeCtx('prepare')); }, finish, 'prepare');
    } else {
      finish();
    }
  }

  function onPresent(env) {
    if (!current || current.activationId !== env.activationId) return;
    if (!lifecycle) {
      post('SECTION_ERROR', { message: 'present before prepare', stage: 'present', recoverable: true }, current);
      return;
    }
    var activation = current;
    var done = false;
    var ctx = makeCtx('present');
    ctx.markPresented = function (info) {
      if (done) return;                                   // exactly once per activation
      // Refuse to acknowledge for an activation that is no longer current. A section that calls
      // markPresented from a stale closure would otherwise mint an acknowledgement carrying the
      // CURRENT identity for a render belonging to a previous one — a forged match.
      if (!current || current.activationId !== activation.activationId) return;
      done = true;
      presentedFrames++;
      post('SECTION_PRESENTED', {
        variantKey: activation.variantKey,
        configHash: activation.configHash,
        canvas: (info && info.canvas) || measureCanvas(),
        framesSubmitted: presentedFrames
      }, activation);
    };
    runMaybeAsync(function () { return lifecycle.present(ctx); }, function () {}, 'present');
  }

  function onActivate(env) {
    if (!current || current.activationId !== env.activationId) return;
    scope.resume();
    if (lifecycle && typeof lifecycle.activate === 'function') {
      runMaybeAsync(function () { return lifecycle.activate(makeCtx('activate')); }, function () {}, 'activate');
    }
  }

  function onPauseAutomation(env) {
    if (!current || current.activationId !== env.activationId) return;
    if (lifecycle && typeof lifecycle.pauseAuto === 'function') {
      runMaybeAsync(function () { return lifecycle.pauseAuto(); }, function () {}, 'automation');
    }
    var stopped = scope.pauseAutomation();
    // The COUNT, so the parent can tell "paused 3 timers" from "there was nothing registered to
    // pause". Both are legitimate — a body that registers nothing is deliberately not pausable —
    // but an acknowledgement that cannot distinguish them is one the parent has to guess about.
    post('AUTOMATION_PAUSED', { stopped: stopped || 0 }, current);
  }

  function onResumeAutomation(env) {
    if (!current || current.activationId !== env.activationId) return;
    if (lifecycle && typeof lifecycle.resumeAuto === 'function') {
      runMaybeAsync(function () { return lifecycle.resumeAuto(); }, function () {}, 'automation');
    }
    var restarted = scope.resumeAutomation();
    post('AUTOMATION_RESUMED', { restarted: restarted || 0 }, current);
  }

  // ── policy (audit P1.2) ───────────────────────────────────────────────────
  // CHROME AND AUTOMATION WITHOUT A LIFECYCLE EVENT. Neither handler touches the scope, the
  // lifecycle's dispose, or the body — which is the entire point: a Minimal-UI toggle must not
  // reset the solver. A policy for a superseded activation is dropped exactly the way every other
  // activation-scoped command here is; the parent, which owns the activation identity, is where
  // that refusal is reported.

  function onSetUiPolicy(env) {
    if (!current || current.activationId !== env.activationId) return;
    var p = env.payload || {};
    var next = { simpleUi: !!p.simpleUi, hideSelectors: p.hideSelectors || [] };
    var changed = !sameUiPolicy(current.config, next);
    if (changed) {
      current.config.simpleUi = next.simpleUi;
      current.config.hideSelectors = next.hideSelectors;
      applyHideUi(current.config);
    }
    // The body's OWN hiding is a closure the runtime cannot reach. A managed lifecycle may expose
    // 'setUiPolicy' to re-apply it in place; without one, only the mechanical style moved and the
    // acknowledgement says so rather than implying a complete change.
    var bodyHook = !!(lifecycle && typeof lifecycle.setUiPolicy === 'function');
    if (changed && bodyHook) {
      runMaybeAsync(function () { return lifecycle.setUiPolicy(next); }, function () {}, 'automation');
    }
    post('POLICY_APPLIED', { kind: 'ui', changed: changed, bodyHook: bodyHook }, current);
  }

  function onSetAutomationPolicy(env) {
    if (!current || current.activationId !== env.activationId) return;
    var p = env.payload || {};
    var want = !!p.autoScript;
    if (want === (current.config.autoScript !== false)) {
      post('POLICY_APPLIED', { kind: 'automation', changed: false }, current);
      return;
    }
    if (want && !current.autoStarted) {
      // Nothing was ever started, so there is nothing to resume. Restarting is the only way to get
      // automation for this section, and only the parent can decide to pay for it.
      post('POLICY_REFUSED', { kind: 'automation', reason: 'never-started', requiresRestart: true }, current);
      return;
    }
    current.config.autoScript = want;
    if (want) {
      if (lifecycle && typeof lifecycle.resumeAuto === 'function') {
        runMaybeAsync(function () { return lifecycle.resumeAuto(); }, function () {}, 'automation');
      }
      var restarted = scope ? scope.resumeAutomation() : 0;
      post('POLICY_APPLIED', { kind: 'automation', changed: true, restarted: restarted || 0, unrestorable: 0 }, current);
    } else {
      if (lifecycle && typeof lifecycle.pauseAuto === 'function') {
        runMaybeAsync(function () { return lifecycle.pauseAuto(); }, function () {}, 'automation');
      }
      var stopped = scope ? scope.pauseAutomation() : 0;
      post('POLICY_APPLIED', { kind: 'automation', changed: true, stopped: stopped || 0 }, current);
    }
  }

  /** Set semantics on hideSelectors — the same rule canonicalizeConfig uses. */
  function sameUiPolicy(a, b) {
    if (!!a.simpleUi !== !!b.simpleUi) return false;
    var x = uniqSorted(a.hideSelectors), y = uniqSorted(b.hideSelectors);
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) { if (x[i] !== y[i]) return false; }
    return true;
  }
  function uniqSorted(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) {
      if (out.indexOf(list[i]) === -1) out.push(list[i]);
    }
    return out.sort();
  }

  function onRelease(env) {
    if (!current || current.activationId !== env.activationId) return;
    var activation = current;
    releaseCurrent('released');
    post('SECTION_RELEASED', {}, activation);
  }

  function releaseCurrent(_why) {
    if (currentAbort) { try { currentAbort.abort(); } catch (e) {} currentAbort = null; }
    if (lifecycle) {
      try { if (typeof lifecycle.release === 'function') lifecycle.release(); } catch (e) {}
      try { if (typeof lifecycle.dispose === 'function') lifecycle.dispose(); } catch (e) {}
    }
    lifecycle = null;
    if (scope) { try { scope.dispose(); } catch (e) {} }
    scope = null;
    current = null;
    removeHideUi();
  }

  // ── document lifecycle ────────────────────────────────────────────────────
  function onInit(env) {
    var p = env.payload || {};
    parentOrigin = p.parentOrigin || parentOrigin;
    quality = p.quality || 'high';
    audible = p.audible || { muted: true, volume: 1 };
    docState = 'DOCUMENT_READY';
    // 'policies' is how a package proves it can hot-swap chrome/automation. A package published
    // before P1.2 sends DOCUMENT_READY WITHOUT this field, and the parent reads that absence as
    // "restart me instead" — the honest fallback, never an assumption that the handler is there.
    post('DOCUMENT_READY', { capabilities: capabilities(), variants: variants(), policies: ['ui', 'automation'] });
  }

  function onSuspend() {
    if (scope) scope.pause();
    if (lifecycle && typeof lifecycle.suspend === 'function') {
      try { lifecycle.suspend(); } catch (e) {}
    }
    docState = 'SUSPENDED';
    post('DOCUMENT_SUSPENDED', {
      counts: scope ? scope.counts() : {},
      unstoppable: scope ? scope.unstoppable() : []
    });
  }

  function onResumeDocument() {
    if (scope) scope.resume();
    docState = 'DOCUMENT_READY';
    post('DOCUMENT_RESUMED', {});
  }

  function onSetAudible(env) {
    var p = env.payload || {};
    audible = { muted: !!p.muted, volume: typeof p.volume === 'number' ? p.volume : 1 };
    if (scope) scope.setAudible(audible);
    if (lifecycle && typeof lifecycle.setAudible === 'function') {
      try { lifecycle.setAudible(audible); } catch (e) {}
    }
  }

  function onSetQuality(env) {
    var p = env.payload || {};
    quality = p.profile || quality;
    var outcome = 'unsupported';
    if (lifecycle && typeof lifecycle.setQuality === 'function') {
      try { lifecycle.setQuality(quality); outcome = 'applied'; } catch (e) { outcome = 'unsupported'; }
    }
    post('QUALITY_APPLIED', { profile: quality, outcome: outcome });
  }

  function onDispose() {
    docState = 'DISPOSING';
    // Take the report from the scope BEFORE releasing drops the reference. Reading it afterwards
    // reports an empty object for every document, which is indistinguishable from a clean dispose
    // — so the one message that is supposed to PROVE no leak would instead have proven nothing.
    var doomed = scope;
    releaseCurrent('dispose');
    post('DISPOSED', {
      counts: doomed ? doomed.counts() : {},
      leaked: doomed ? doomed.leaks() : []
    });
    try { if (port) port.close(); } catch (e) {}
    port = null;
    docState = 'EVICTED';
  }

  // ── WebGL context ─────────────────────────────────────────────────────────
  function wireContextEvents() {
    var handler = function (kind) {
      return function (e) {
        if (kind === 'lost') {
          contextLostKind = 'webgl';
          // Preventing the default is what makes restoration possible at all; without it the
          // browser never fires webglcontextrestored.
          try { e.preventDefault(); } catch (err) {}
          post('CONTEXT_LOST', { contextKind: 'webgl' });
        } else {
          contextLostKind = null;
          post('CONTEXT_RESTORED', {});
        }
      };
    };
    try {
      var cs = doc.getElementsByTagName('canvas');
      for (var i = 0; i < cs.length; i++) {
        cs[i].addEventListener('webglcontextlost', handler('lost'), false);
        cs[i].addEventListener('webglcontextrestored', handler('restored'), false);
      }
    } catch (e) {}
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  function makeCtx(_stage) {
    return {
      variantKey: current ? current.variantKey : null,
      config: current ? current.config : {},
      scope: scope ? scope.handle : null,
      signal: currentAbort ? currentAbort.signal : undefined,
      autoScript: !!(current && current.config && current.config.autoScript),
      markPresented: function () {}
    };
  }
  function paramsFrom(config) {
    config = config || {};
    return {
      simpleUi: !!config.simpleUi,
      autoScript: config.autoScript !== false,
      hideSelectors: config.hideSelectors || []
    };
  }
  /**
   * Run fn, which may or may not return a promise, then call then().
   *
   * THE ACTIVATION IS CAPTURED AT CALL TIME (simulation-009). A synchronous throw cannot have
   * outlived its activation, but a REJECTION can and routinely does: the viewer scrubs, the section
   * is superseded, its aborted prepare() rejects, and reading the module-level 'current' at that
   * moment attributes the failure to whichever section is now on screen. The parent's identity
   * check then passes and a healthy section is failed for a dead one's error.
   *
   * A superseded activation's outcome is DROPPED rather than reported against itself: nothing is
   * displaying it any more, so its failure is moot — the same choice markPresented makes.
   */
  function runMaybeAsync(fn, then, stage) {
    var activation = current;
    var r;
    try { r = fn(); } catch (err) {
      post('SECTION_ERROR', { message: String((err && err.message) || err), stage: stage, recoverable: true }, activation);
      return;
    }
    if (r && typeof r.then === 'function') {
      r.then(function () { try { then(); } catch (e) {} }, function (err) {
        if (!current || !activation || current.activationId !== activation.activationId) return;
        post('SECTION_ERROR', { message: String((err && err.message) || err), stage: stage, recoverable: true }, activation);
      });
    } else {
      then();
    }
  }
  function applyHideUi(config) {
    var st = doc.getElementById('__simHideUi');
    if (config && config.simpleUi && config.hideSelectors && config.hideSelectors.length) {
      var rules = [];
      for (var i = 0; i < config.hideSelectors.length; i++) {
        var sel = config.hideSelectors[i];
        if (typeof sel !== 'string' || /[{}<\\]/.test(sel)) continue;
        rules.push(sel + '{display:none !important}');
      }
      if (rules.length) {
        if (!st) { st = doc.createElement('style'); st.id = '__simHideUi'; (doc.head || doc.documentElement).appendChild(st); }
        st.textContent = rules.join('\n');
        return;
      }
    }
    if (st && st.remove) st.remove();
  }
  function removeHideUi() {
    var st = doc.getElementById('__simHideUi');
    if (st && st.remove) st.remove();
  }
  function nowMs() { try { return (win.performance && win.performance.now) ? win.performance.now() : +new Date(); } catch (e) { return +new Date(); } }

  // ── dispatch ──────────────────────────────────────────────────────────────
  function onEnvelope(raw) {
    var env = validate(raw);
    if (!env) return;                 // rejected: no visible state changes, by construction
    switch (env.type) {
      case 'INIT_DOCUMENT':    return onInit(env);
      case 'SUSPEND_DOCUMENT': return onSuspend();
      case 'RESUME_DOCUMENT':  return onResumeDocument();
      case 'SET_AUDIBLE':      return onSetAudible(env);
      case 'SET_QUALITY':      return onSetQuality(env);
      case 'DISPOSE_DOCUMENT': return onDispose();
      case 'PREPARE_SECTION':  return onPrepare(env);
      case 'PRESENT_SECTION':  return onPresent(env);
      case 'ACTIVATE_SECTION': return onActivate(env);
      case 'PAUSE_AUTOMATION': return onPauseAutomation(env);
      case 'RESUME_AUTOMATION':return onResumeAutomation(env);
      case 'SET_UI_POLICY':    return onSetUiPolicy(env);
      case 'SET_AUTOMATION_POLICY': return onSetAutomationPolicy(env);
      case 'RELEASE_SECTION':  return onRelease(env);
      default: return;
    }
  }

  // ── bootstrap ─────────────────────────────────────────────────────────────
  function onBootstrap(e) {
    // Only our REAL parent, and only from the origin the offer itself claims. The two together
    // are what make the port private: an unrelated frame cannot be window.parent, and a parent
    // that lies about its origin fails the self-consistency check.
    if (e.source !== win.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d.kind !== 'flowvid.sim.bootstrap') return;
    if (d.protocolVersion !== VER) return;
    if (typeof d.parentOrigin !== 'string' || d.parentOrigin !== e.origin) return;
    if (!d.playerSessionId || !d.packageRevision || !d.documentId) return;
    if (!e.ports || e.ports.length !== 1) return;

    // REPLACE ONLY FOR A NEW DOCUMENT EPOCH. A repeat offer for the epoch we already adopted is a
    // duplicate from the parent's retry loop, and adopting it is a self-inflicted race:
    //
    //   the parent re-offers every 150 ms, and the moment the child accepts one it closes every
    //   OTHER pending channel. An offer already in flight when that happens would make the child
    //   switch to a port whose parent end has just been closed — and since no engine fires a close
    //   event on a MessagePort, neither side can detect it. The document goes permanently silent
    //   with no error anywhere. That is strictly worse than the wedge replacement was meant to fix,
    //   because it is a routine race rather than a slow-boot edge case.
    //
    // Scoping to a different documentId keeps the recovery — a parent that gave up mints a NEW
    // epoch before it re-offers — while making the retry case impossible to get wrong.
    if (adopted) {
      if (ident && d.documentId === ident.documentId) {
        for (var pi = 0; pi < e.ports.length; pi++) { try { e.ports[pi].close(); } catch (err) {} }
        return;
      }
      if (port) { try { port.onmessage = null; port.close(); } catch (err) {} }
    }
    adopted = true;
    // Every counter belongs to the epoch the offer names, so a replacement starts clean rather
    // than continuing the abandoned channel's sequence.
    outSeq = 0;
    lastInSeq = 0;
    parentOrigin = e.origin;
    ident = { playerSessionId: d.playerSessionId, packageRevision: d.packageRevision, documentId: d.documentId };
    port = e.ports[0];
    port.onmessage = function (ev) { onEnvelope(ev.data); };
    try { port.start(); } catch (err) {}
    try { port.postMessage({ kind: 'flowvid.sim.bootstrap.accept', protocolVersion: VER, documentId: d.documentId }); } catch (err) {}
    wireContextEvents();
  }

  win.addEventListener('message', onBootstrap, false);
  // Announce. targetOrigin '*' is correct for exactly this message and no other: it carries no
  // identity and no secret, and it is sent before any origin has been negotiated.
  try { if (win.parent && win.parent !== win) win.parent.postMessage({ kind: 'flowvid.sim.hello', protocolVersion: VER }, '*'); } catch (e) {}

  return { onEnvelope: onEnvelope, isAdopted: function () { return adopted; } };
}
`;

export interface ChildRuntimeOptions {
  /** Every section body in this package returns a managed lifecycle. */
  allManaged: boolean;
  /** At least one section implements setQuality. */
  anyQuality: boolean;
}

/**
 * Emit the full child runtime source, ready to be concatenated into `bridge.js`.
 *
 * The markers let `stripChildRuntime` remove a previous copy exactly, which is what makes
 * regenerating a bridge idempotent — the property the rebuild tooling in Priority 1 proves for
 * every stored package.
 */
export function buildChildRuntimeSource(opts: ChildRuntimeOptions): string {
  const protocol = PROTOCOL_SOURCE
    .replace('__NS__', SIM_PROTOCOL_NAMESPACE)
    .replace('__VER__', String(SIM_PROTOCOL_VERSION));

  return [
    SIM_CHILD_MARKER_START,
    `/* flowvid sim runtime v${SIM_PROTOCOL_VERSION}.${SIM_CHILD_RUNTIME_VERSION} — generated, do not edit */`,
    MANAGED_SCOPE_SOURCE.trim(),
    protocol.trim(),
    `var __simV3 = __simInstallV3(window, __SECTIONS__, { allManaged: ${opts.allManaged}, anyQuality: ${opts.anyQuality} });`,
    SIM_CHILD_MARKER_END,
  ].join('\n');
}

/** Remove a previously embedded child runtime, so regeneration never stacks two copies. */
export function stripChildRuntime(bridgeJs: string): string {
  const start = bridgeJs.indexOf(SIM_CHILD_MARKER_START);
  const end = bridgeJs.indexOf(SIM_CHILD_MARKER_END);
  if (start === -1 || end === -1 || end < start) return bridgeJs;
  const before = bridgeJs.slice(0, start);
  const after = bridgeJs.slice(end + SIM_CHILD_MARKER_END.length);
  return (before + after).replace(/\n{3,}/g, '\n\n');
}

/** True when a bridge already carries the current child runtime. */
export function hasChildRuntime(bridgeJs: string): boolean {
  return bridgeJs.includes(SIM_CHILD_MARKER_START) && bridgeJs.includes(SIM_CHILD_MARKER_END);
}
