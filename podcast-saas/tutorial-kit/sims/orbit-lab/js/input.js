'use strict';
/* Orbit Lab · input — touch-first aiming. Down starts the aim, drag sets the velocity
 * vector (the prediction renders live), release launches. */
(() => {
  const OL = window.OL;
  const canvas = OL.canvas;

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    OL.aim = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    const hud = document.getElementById('hud');
    if (hud) hud.style.opacity = '0';
  });
  canvas.addEventListener('pointermove', e => {
    if (OL.aim) { OL.aim.x1 = e.clientX; OL.aim.y1 = e.clientY; }
  });
  canvas.addEventListener('pointerup', () => {
    if (!OL.aim) return;
    const a = OL.aim;
    OL.launch(a.x0, a.y0, (a.x1 - a.x0) * 1.6, (a.y1 - a.y0) * 1.6);
    OL.aim = null;
  });
  canvas.addEventListener('pointercancel', () => { OL.aim = null; });
})();
