/* Murmuration — public surface and boot.
   window.MurmurationSim is the scripting contract a FlowVid bridge binds to;
   window.__flowvidReadyForPresent() resolves once the first frames are drawn.
   Loads last: flock.js, render.js and input.js have filled window.MURM. */
(function () {
  'use strict';
  var MURM = window.MURM, state = MURM.state;
  var canvas = document.getElementById('stage');

  MURM.render.init(canvas);
  MURM.flock.init(MURM.render.W * MURM.render.H);
  MURM.input.init(canvas);

  function loop() {
    if (state.running) {
      MURM.render.tickCamera();
      MURM.flock.step();
      MURM.render.draw();
      state.frames++;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  /** Scripting surface — what a FlowVid bridge binds to. */
  window.MurmurationSim = {
    set: function (key, value) {
      var el = document.getElementById(key);
      if (!el) return;
      if (el.type === 'checkbox') { if (el.checked !== !!value) el.click(); return; }
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    scatter: function () { document.getElementById('scatter').click(); },
    reset: function () { document.getElementById('reset').click(); },
    pause: function () { state.running = false; },
    play: function () { state.running = true; },
    getState: function () {
      var P = state.P;
      return { cohesion: P.cohesion, alignment: P.alignment, separation: P.separation,
               speed: P.speed, trails: P.trails, boids: MURM.flock.N, running: state.running };
    },
  };

  /** FlowVid heavy-asset readiness hook: first frames drawn = ready (no assets to wait for). */
  window.__flowvidReadyForPresent = function () {
    return new Promise(function (resolve) {
      (function check() { if (state.frames > 2) resolve(); else requestAnimationFrame(check); })();
    });
  };
})();
