'use strict';
/* Orbit Lab · render — glow sprites, force arrows, starfield, and the frame loop. */
(() => {
  const OL = window.OL;
  const ctx = OL.ctx;

  OL.drawGlow = function (x, y, r, color, alpha) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color.replace('$a', String(alpha)));
    g.addColorStop(1, color.replace('$a', '0'));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  };

  OL.arrow = function (x, y, dx, dy, color, width) {
    const len = Math.hypot(dx, dy);
    if (len < 2) return;
    const ux = dx / len, uy = dy / len;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dx, y + dy); ctx.stroke();
    const hx = x + dx, hy = y + dy, s = Math.min(9, 3 + len * 0.06);
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - ux * s * 1.8 - uy * s, hy - uy * s * 1.8 + ux * s);
    ctx.lineTo(hx - ux * s * 1.8 + uy * s, hy - uy * s * 1.8 - ux * s);
    ctx.closePath(); ctx.fill();
  };

  const fieldStars = Array.from({ length: 110 }, () => ({
    x: Math.random(), y: Math.random(), r: Math.random() * 1.1 + 0.3, a: Math.random() * 0.22 + 0.08,
  }));
  function drawField() {
    ctx.fillStyle = '#cfe0ff';
    for (const f of fieldStars) {
      ctx.globalAlpha = f.a;
      ctx.beginPath(); ctx.arc(f.x * OL.W, f.y * OL.H, f.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  let tPrev = performance.now();
  OL.frame = function frame(tNow) {
    requestAnimationFrame(frame);
    const dt = Math.min((tNow - tPrev) / 1000, 1 / 20);
    tPrev = tNow;
    if (!OL.paused) {
      const scaled = dt * OL.params.timescale;
      const sub = Math.max(1, Math.ceil(scaled / (1 / 120)));
      for (let i = 0; i < sub; i++) OL.step(scaled / sub);
    }

    // fade-to-dark compositing: trails when on, clean wipe when off
    ctx.fillStyle = OL.params.trails ? 'rgba(7,11,20,0.055)' : '#070b14';
    ctx.fillRect(0, 0, OL.W, OL.H);
    drawField();

    for (const s of OL.stars) {
      OL.drawGlow(s.x, s.y, s.r * 3.2, 'rgba(255,196,110,$a)', 0.26);
      OL.drawGlow(s.x, s.y, s.r * 1.45, 'rgba(255,228,170,$a)', 0.9);
      ctx.fillStyle = '#fff3dd';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 0.62, 0, 7); ctx.fill();
    }

    for (const b of OL.bodies) {
      const col = `hsla(${b.hue},95%,70%,$a)`;
      // the orbit itself, drawn as a polyline with alpha ramping toward the planet —
      // this is what makes closed orbits READ as luminous rings
      if (OL.params.trails && b.path.length >= 8) {
        const n = b.path.length / 2;
        ctx.lineWidth = 2; ctx.lineCap = 'round';
        for (let i = 2; i < b.path.length; i += 2) {
          ctx.strokeStyle = `hsla(${b.hue},90%,66%,${(i / 2 / n) * 0.42})`;
          ctx.beginPath();
          ctx.moveTo(b.path[i - 2], b.path[i - 1]);
          ctx.lineTo(b.path[i], b.path[i + 1]);
          ctx.stroke();
        }
      }
      OL.drawGlow(b.x, b.y, b.r * 3.6, col, 0.55);
      ctx.fillStyle = `hsl(${b.hue},95%,78%)`;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
      if (OL.params.vectors && OL.stars.length) {
        const [ax, ay] = OL.accel(b.x, b.y);
        const m = Math.hypot(ax, ay);
        const L = Math.min(84, 18 + m * 0.11);   // arrow length ~ |F|, capped
        OL.arrow(b.x, b.y, ax / m * L, ay / m * L, 'rgba(255,170,90,0.95)', 2.8);
      }
    }

    if (OL.flare) {
      OL.flare.t += dt;
      const k = OL.flare.t / 0.6;
      if (k < 1) OL.drawGlow(OL.flare.x, OL.flare.y, 60 + 160 * k, 'rgba(255,214,140,$a)', 0.5 * (1 - k));
      else OL.flare = null;
    }

    // aim: velocity arrow + predicted path
    if (OL.aim) {
      const a = OL.aim;
      const vx = (a.x1 - a.x0) * 1.6, vy = (a.y1 - a.y0) * 1.6;
      OL.arrow(a.x0, a.y0, (a.x1 - a.x0), (a.y1 - a.y0), 'rgba(234,242,255,0.9)', 2.4);
      const pts = OL.predict(a.x0, a.y0, vx, vy);
      ctx.fillStyle = 'rgba(140,200,255,0.8)';
      for (let i = 0; i < pts.length; i += 2) {
        ctx.globalAlpha = (1 - i / pts.length) * 0.8;
        ctx.beginPath(); ctx.arc(pts[i], pts[i + 1], 2.1, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
      OL.drawGlow(a.x0, a.y0, 14, 'rgba(234,242,255,$a)', 0.8);
    }
  };
})();
