'use strict';
/* Orbit Lab · core — canvas, state, and the physics model.
 * Classical mechanics with visible force vectors. Original work for the FlowVid demo
 * project (2026). License: MIT — commercial use unrestricted. Zero dependencies.
 *
 * The one-second story: drag = velocity vector, a dotted PREDICTED PATH shows where
 * physics will take the planet before you let go; release, and the gravity arrows keep
 * telling the truth the whole flight. */

window.OL = (() => {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  const OL = {
    canvas, ctx, W: 0, H: 0,
    G_BASE: 3000000,         // vCirc(144px) ≈ 144 px/s → a mid orbit closes in ~6s and drags feel 1:1
    BODY_CAP: 14,
    PALETTE: [205, 165, 285, 25, 140, 330, 55, 250],
    params: { gravity: 1, timescale: 1, vectors: true, trails: true, preset: 'star' },
    stars: [],               // fixed massive bodies
    bodies: [],              // launched planets {x,y,vx,vy,r,hue,age,path:[]}
    aim: null,               // {x0,y0,x1,y1} while the pointer is down
    flare: null,             // star-absorb flash {x,y,t}
    paused: false,
    hueIdx: 0,
  };

  function resize() {
    OL.W = window.innerWidth; OL.H = window.innerHeight;
    canvas.width = Math.round(OL.W * DPR); canvas.height = Math.round(OL.H * DPR);
    canvas.style.width = OL.W + 'px'; canvas.style.height = OL.H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize); resize();

  OL.setPreset = function (name) {
    OL.params.preset = name;
    const cx = OL.W / 2, cy = OL.H / 2;
    if (name === 'binary') {
      const d = Math.min(OL.W, OL.H) * 0.17;
      OL.stars = [{ x: cx - d, y: cy, m: 0.62, r: 17 }, { x: cx + d, y: cy, m: 0.62, r: 17 }];
    } else if (name === 'empty') {
      OL.stars = [];
    } else {
      OL.stars = [{ x: cx, y: cy, m: 1, r: 22 }];
    }
    OL.bodies = [];
    ctx.fillStyle = '#070b14'; ctx.fillRect(0, 0, OL.W, OL.H);
  };

  OL.accel = function (x, y) {
    // Star-only gravity: stable, legible orbits (mutual planet pulls would eject half the scene).
    let ax = 0, ay = 0;
    for (const s of OL.stars) {
      const dx = s.x - x, dy = s.y - y;
      const d2 = dx * dx + dy * dy;
      const d = Math.sqrt(d2) + 1e-6;
      const soft = Math.max(d2, 1200);         // softening keeps close passes sane
      const a = OL.G_BASE * OL.params.gravity * s.m / soft;
      ax += a * dx / d; ay += a * dy / d;
    }
    return [ax, ay];
  };

  OL.step = function (dt) {
    for (const b of OL.bodies) {
      const [ax, ay] = OL.accel(b.x, b.y);
      b.vx += ax * dt; b.vy += ay * dt;        // symplectic Euler — energy-stable enough here
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.age += dt;
      if (OL.params.trails) {
        b.path.push(b.x, b.y);
        if (b.path.length > 520) b.path.splice(0, 2);
      } else b.path.length = 0;
    }
    // absorb on star contact; drift far offscreen = quiet removal
    OL.bodies = OL.bodies.filter(b => {
      for (const s of OL.stars) {
        const dx = b.x - s.x, dy = b.y - s.y;
        if (dx * dx + dy * dy < (s.r + b.r) * (s.r + b.r)) { OL.flare = { x: s.x, y: s.y, t: 0 }; return false; }
      }
      return b.x > -OL.W && b.x < 2 * OL.W && b.y > -OL.H && b.y < 2 * OL.H;
    });
  };

  OL.launch = function (x, y, vx, vy) {
    if (OL.bodies.length >= OL.BODY_CAP) OL.bodies.shift();
    OL.bodies.push({ x, y, vx, vy, r: 6.5, hue: OL.PALETTE[OL.hueIdx++ % OL.PALETTE.length], age: 0, path: [] });
  };

  OL.predict = function (x, y, vx, vy) {
    // Integrate ~2.4s ahead with the same physics — the dotted aim line IS the truth.
    const pts = [];
    const dt = 1 / 60;
    let px = x, py = y, pvx = vx, pvy = vy;
    for (let i = 0; i < 144; i++) {
      const [ax, ay] = OL.accel(px, py);
      pvx += ax * dt; pvy += ay * dt; px += pvx * dt; py += pvy * dt;
      if (i % 4 === 0) pts.push(px, py);
      for (const s of OL.stars) {
        const dx = px - s.x, dy = py - s.y;
        if (dx * dx + dy * dy < s.r * s.r) return pts;
      }
    }
    return pts;
  };

  return OL;
})();
