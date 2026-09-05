/* Murmuration — input.
   The pointer/touch attractor (a tap startles the flock) and the control
   panel bindings. All controls write into MURM.state; the model reads it. */
(function () {
  'use strict';
  var MURM = window.MURM = window.MURM || {};
  var state = MURM.state, P = state.P, pointer = state.pointer;

  MURM.input = { init: init };

  function init(canvas) {
    canvas.addEventListener('pointermove', function (e) { pointer.x = e.clientX; pointer.y = e.clientY; });
    canvas.addEventListener('pointerdown', function (e) {
      pointer.x = e.clientX; pointer.y = e.clientY;
      MURM.flock.startle(60, false);
    });
    canvas.addEventListener('pointerleave', clearPointer);
    canvas.addEventListener('pointercancel', clearPointer);
    function clearPointer() { pointer.x = pointer.y = null; }

    function bind(id, key, fmt) {
      var el = document.getElementById(id), out = document.getElementById(id + '-out');
      el.addEventListener('input', function () {
        P[key] = parseFloat(el.value);
        out.textContent = fmt ? fmt(P[key]) : P[key].toFixed(2).replace(/0$/, '');
      });
    }
    bind('cohesion', 'cohesion');
    bind('alignment', 'alignment');
    bind('separation', 'separation');
    bind('speed', 'speed', function (v) { return v.toFixed(2).replace(/0$/, '') + '×'; });

    document.getElementById('trails').addEventListener('change', function (e) { P.trails = e.target.checked; });
    document.getElementById('scatter').addEventListener('click', function () { MURM.flock.startle(90, true); });
    document.getElementById('reset').addEventListener('click', function () {
      P.cohesion = 1; P.alignment = 1; P.separation = 1.2; P.speed = 1;
      ['cohesion', 'alignment', 'separation', 'speed'].forEach(function (k) {
        var el = document.getElementById(k);
        el.value = String(P[k]);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      MURM.flock.spawn();
    });
  }
})();
