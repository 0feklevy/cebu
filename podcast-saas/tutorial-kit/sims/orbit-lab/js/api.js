'use strict';
/* Orbit Lab · api — the FlowVid contract (window.OrbitSim), present-gating hook, boot. */
(() => {
  const OL = window.OL;
  const $ = id => document.getElementById(id);

  window.OrbitSim = {
    ready: true,
    launch: (x, y, vx, vy) => OL.launch(x ?? OL.W * 0.7, y ?? OL.H * 0.35, vx ?? -120, vy ?? -160),
    demo: () => OL.demo(),
    set(p) {
      if (!p) return;
      if (p.gravity != null) { $('gravity').value = p.gravity; $('gravity').dispatchEvent(new Event('input')); }
      if (p.timescale != null) { $('timescale').value = p.timescale; $('timescale').dispatchEvent(new Event('input')); }
      if (p.vectors != null) { $('vectors').checked = !!p.vectors; $('vectors').dispatchEvent(new Event('change')); }
      if (p.trails != null) { $('trails').checked = !!p.trails; $('trails').dispatchEvent(new Event('change')); }
      if (p.preset) { $('preset').value = p.preset; $('preset').dispatchEvent(new Event('change')); }
    },
    reset: () => OL.setPreset(OL.params.preset),
    pause: () => { OL.paused = true; },
    play: () => { OL.paused = false; },
    getState: () => ({ ...OL.params, bodies: OL.bodies.length, stars: OL.stars.length, paused: OL.paused }),
  };

  /* Present-gating hook: first frames must already be rendered when the runtime reveals us. */
  window.__flowvidReadyForPresent = new Promise(res => {
    requestAnimationFrame(() => requestAnimationFrame(() => res(true)));
  });

  OL.setPreset('star');
  requestAnimationFrame(OL.frame);
  setTimeout(() => { if (!OL.bodies.length) OL.demo(); }, 1400);   // never present a dead screen
  setTimeout(() => { const h = $('hud'); if (h) h.style.opacity = '0'; }, 9000);
})();
