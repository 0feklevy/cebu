'use strict';
/* Orbit Lab · controls — wiring for the static DOM control ids, plus the demo choreography. */
(() => {
  const OL = window.OL;
  const $ = id => document.getElementById(id);

  $('gravity').addEventListener('input', e => {
    OL.params.gravity = +e.target.value;
    $('gravity-out').textContent = OL.params.gravity.toFixed(2).replace(/0$/, '') + '×';
  });
  $('timescale').addEventListener('input', e => {
    OL.params.timescale = +e.target.value;
    $('timescale-out').textContent = OL.params.timescale.toFixed(2).replace(/0$/, '') + '×';
  });
  $('vectors').addEventListener('change', e => { OL.params.vectors = e.target.checked; });
  $('trails').addEventListener('change', e => { OL.params.trails = e.target.checked; });
  $('preset').addEventListener('change', e => OL.setPreset(e.target.value));
  $('reset').addEventListener('click', () => OL.setPreset(OL.params.preset));
  $('demo').addEventListener('click', () => OL.demo());

  /* Demo choreography: three launches that settle into distinct nested orbits, then a comet. */
  OL.demo = function () {
    OL.setPreset(OL.params.preset === 'empty' ? 'star' : OL.params.preset);
    const cx = OL.W / 2, cy = OL.H / 2;
    const binary = OL.params.preset === 'binary';
    const M = OL.stars.reduce((t, s) => t + s.m, 0) || 1;
    const base = Math.min(OL.W, OL.H);
    const R1 = base * (binary ? 0.30 : 0.16), R2 = base * (binary ? 0.37 : 0.26), R3 = base * 0.44;
    const vCirc = r => Math.sqrt(OL.G_BASE * OL.params.gravity * M / r);
    const seq = [
      () => OL.launch(cx + R1, cy, 0, -vCirc(R1)),
      () => OL.launch(cx - R2, cy, 0, vCirc(R2)),
      () => OL.launch(cx, cy - R3, -vCirc(R3), 0),
      () => OL.launch(cx - OL.W * 0.42, cy + OL.H * 0.32, vCirc(R3) * 0.9, -vCirc(R3) * 0.55), // comet
    ];
    seq.forEach((f, i) => setTimeout(f, i * 900));
  };
})();
