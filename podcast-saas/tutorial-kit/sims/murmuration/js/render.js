/* Murmuration — the renderer.
   A slow-orbit perspective camera, painter-sorted glow sprites with depth fog,
   a faint stationary dust field so the parallax (and therefore the depth) is
   legible at a glance, and fade-to-black light trails. Canvas 2D only. */
(function () {
  'use strict';
  var MURM = window.MURM = window.MURM || {};
  var render = MURM.render = { W: 0, H: 0 };

  var canvas, ctx, DPR = 1, FOC = 700, CX = 0, CY = 0;

  /* Camera state and its orthonormal basis (forward / right / up). */
  var camTh = 0.55, camDist = 920, camTick = 0;
  var ex = 0, ey = 120, ez = 0, eyeLen = 1;
  var fx = 0, fy = 0, fz = -1;      // forward
  var rgx = 1, rgz = 0;             // right (level, so its y is always 0)
  var ux = 0, uy = 1, uz = 0;       // up

  render.resize = function () {
    render.W = canvas.clientWidth; render.H = canvas.clientHeight;
    var d = Math.min(window.devicePixelRatio || 1, 2);   // cap DPR at 2 …
    if (render.W * render.H * d * d > 9.2e6) {           // … and back further off on huge surfaces
      d = Math.max(1, Math.sqrt(9.2e6 / (render.W * render.H)));
    }
    DPR = d;
    canvas.width = Math.round(render.W * DPR);
    canvas.height = Math.round(render.H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    FOC = Math.min(render.H * 0.92, render.W * 1.05);    // fits the box on tall and wide screens
    CX = render.W * 0.5; CY = render.H * 0.5;
  };

  render.tickCamera = function () {
    camTick++;
    camTh += 0.00115;                                    // one lap in about 90 s
    ex = Math.cos(camTh) * camDist;
    ez = Math.sin(camTh) * camDist;
    ey = 120 + Math.sin(camTick * 0.0021) * 55;          // gentle vertical drift
    eyeLen = Math.sqrt(ex * ex + ey * ey + ez * ez);
    var il = 1 / eyeLen;
    fx = -ex * il; fy = -ey * il; fz = -ez * il;         // look at the origin
    var rl = 1 / Math.sqrt(fx * fx + fz * fz);
    rgx = -fz * rl; rgz = fx * rl;
    ux = -rgz * fy; uy = rgz * fx - rgx * fz; uz = rgx * fy;  // up = right × forward
  };

  /* Drop the pointer's ray onto the plane through the origin that faces the
     camera — the pointer lives at the flock's depth, so attraction is 3D. */
  render.pointerToWorld = function (sx, sy, out) {
    var axc = (sx - CX) / FOC, ayc = (CY - sy) / FOC;
    var t = eyeLen;
    out.x = ex + (rgx * axc + ux * ayc + fx) * t;
    out.y = ey + (uy * ayc + fy) * t;
    out.z = ez + (rgz * axc + uz * ayc + fz) * t;
    var F = MURM.flock;
    if (out.x > F.EX) out.x = F.EX; else if (out.x < -F.EX) out.x = -F.EX;
    if (out.y > F.EY) out.y = F.EY; else if (out.y < -F.EY) out.y = -F.EY;
    if (out.z > F.EZ) out.z = F.EZ; else if (out.z < -F.EZ) out.z = -F.EZ;
  };

  /* Pre-rendered glow sprite: shadowBlur per bird would cost the 60fps; one
     radial sprite composited additively gives every bird a halo per drawImage. */
  var glow = document.createElement('canvas');
  glow.width = glow.height = 32;
  (function () {
    var g = glow.getContext('2d');
    var grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(150,205,255,0.6)');
    grad.addColorStop(0.45, 'rgba(95,165,255,0.18)');
    grad.addColorStop(1, 'rgba(95,165,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
  })();

  /* Stationary dust, spread wider than the flight box. */
  var DUST = 120;
  var dpx = new Float32Array(DUST), dpy = new Float32Array(DUST), dpz = new Float32Array(DUST);
  for (var di = 0; di < DUST; di++) {
    dpx[di] = (Math.random() * 2 - 1) * 720;
    dpy[di] = (Math.random() * 2 - 1) * 420;
    dpz[di] = (Math.random() * 2 - 1) * 720;
  }

  /* Per-frame projection scratch, allocated once N is known. */
  var ord = [], zs = null, sxs, sys, ks, hxs, hys, fogs;
  function byDepth(a, b) { return zs[b] - zs[a]; }

  render.init = function (el) {
    canvas = el;
    ctx = el.getContext('2d');
    window.addEventListener('resize', render.resize);
    render.resize();
    render.tickCamera();
  };

  render.draw = function () {
    var W = render.W, H = render.H, F = MURM.flock, N = F.N;
    var px = F.px, py = F.py, pz = F.pz, vx = F.vx, vy = F.vy, vz = F.vz, hue = F.hue;
    if (!zs || zs.length < N) {
      zs = new Float32Array(N); sxs = new Float32Array(N); sys = new Float32Array(N);
      ks = new Float32Array(N); hxs = new Float32Array(N); hys = new Float32Array(N);
      fogs = new Float32Array(N);
    }

    /* Trails are a translucent fade toward the ground colour. The extra
       destination-out pass matters: 8-bit rounding stalls a plain fade a few
       levels above black, and additive glow would otherwise leave permanent
       murky ghosts wherever the flock has ever been. Eroding alpha as well
       lets old light decay all the way to the page's own ground colour. */
    if (MURM.state.P.trails) {
      ctx.fillStyle = 'rgba(6,11,18,0.16)';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,0.085)';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.fillStyle = '#060b12';
      ctx.fillRect(0, 0, W, H);
    }

    var i, k, sx, sy;

    /* Dust field. */
    ctx.fillStyle = 'rgb(148,186,240)';
    for (i = 0; i < DUST; i++) {
      var rx = dpx[i] - ex, ry = dpy[i] - ey, rz = dpz[i] - ez;
      var zc = rx * fx + ry * fy + rz * fz;
      if (zc < 90) continue;
      k = FOC / zc;
      sx = CX + (rx * rgx + rz * rgz) * k;
      sy = CY - (rx * ux + ry * uy + rz * uz) * k;
      if (sx < -6 || sx > W + 6 || sy < -6 || sy > H + 6) continue;
      var da = k * 0.2; if (da > 0.28) da = 0.28;
      ctx.globalAlpha = da;
      var ds = 1 + k; if (ds > 2.6) ds = 2.6;
      ctx.fillRect(sx, sy, ds, ds);
    }
    ctx.globalAlpha = 1;

    /* Project every bird; keep the visible ones. */
    ord.length = 0;
    for (i = 0; i < N; i++) {
      var px1 = px[i] - ex, py1 = py[i] - ey, pz1 = pz[i] - ez;
      var zc1 = px1 * fx + py1 * fy + pz1 * fz;
      if (zc1 < 80) continue;                        // behind or hugging the lens
      k = FOC / zc1;
      var xc = px1 * rgx + pz1 * rgz;
      var yc = px1 * ux + py1 * uy + pz1 * uz;
      sx = CX + xc * k; sy = CY - yc * k;
      if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) continue;
      var vxc = vx[i] * rgx + vz[i] * rgz;
      var vyc = vx[i] * ux + vy[i] * uy + vz[i] * uz;
      var vzc = vx[i] * fx + vy[i] * fy + vz[i] * fz;
      var hx = vxc - xc * vzc / zc1;                 // screen-space heading
      var hy = -(vyc - yc * vzc / zc1);
      var hl = Math.sqrt(hx * hx + hy * hy);
      if (hl < 1e-4) { hx = 1; hy = 0; } else { hx /= hl; hy /= hl; }
      var fg = (zc1 - (eyeLen - 460)) / 980;         // subtle fog with distance
      if (fg < 0) fg = 0; else if (fg > 1) fg = 1;
      zs[i] = zc1; sxs[i] = sx; sys[i] = sy; ks[i] = k;
      hxs[i] = hx; hys[i] = hy; fogs[i] = fg;
      ord.push(i);
    }
    ord.sort(byDepth);                               // painter's order: far first

    /* Halos, additively; far birds sink into the fog. */
    ctx.globalCompositeOperation = 'lighter';
    for (var m = 0; m < ord.length; m++) {
      i = ord[m];
      var g = 28 * ks[i] * (1 - fogs[i] * 0.35);
      ctx.globalAlpha = 0.72 - fogs[i] * 0.52;
      ctx.drawImage(glow, sxs[i] - g * 0.5, sys[i] - g * 0.5, g, g);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    /* Bodies, far to near: darts oriented along the projected velocity,
       scaled and dimmed by depth so the volume reads immediately. */
    for (m = 0; m < ord.length; m++) {
      i = ord[m];
      k = ks[i];
      var hx2 = hxs[i], hy2 = hys[i], qx = -hy2, qy = hx2;
      var X = sxs[i], Y = sys[i], fog = fogs[i];
      var spd = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
      var L = 7.2 * k, B = 5.2 * k, Wd = 3.35 * k;
      var light = 64 + Math.min(spd * 6, 22) - fog * 20;
      ctx.fillStyle = 'hsla(' + hue[i] + ',' + (92 - fog * 26) + '%,' + light + '%,' + (0.98 - fog * 0.55) + ')';
      ctx.beginPath();
      ctx.moveTo(X + hx2 * L, Y + hy2 * L);
      ctx.lineTo(X - hx2 * B + qx * Wd, Y - hy2 * B + qy * Wd);
      ctx.lineTo(X - hx2 * B * 0.42, Y - hy2 * B * 0.42);
      ctx.lineTo(X - hx2 * B - qx * Wd, Y - hy2 * B - qy * Wd);
      ctx.closePath();
      ctx.fill();
    }
  };
})();
