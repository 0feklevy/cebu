/* Murmuration — the flock model.
   3D boids in a soft-walled flight box around the origin: cohesion, alignment
   and separation over a spatial hash (no N-squared bill at 300 birds), a slow
   Lissajous wander target so the idle flock keeps sweeping the volume, pointer
   attraction dropped into the world by the renderer's ray, and a fear timer
   that turns the attractor into a threat.
   Classic script: everything hangs off the shared window.MURM namespace. */
(function () {
  'use strict';
  var MURM = window.MURM = window.MURM || {};

  /* Shared runtime state. flock.js loads first, so every later file finds it. */
  var state = MURM.state = {
    P: { cohesion: 1, alignment: 1, separation: 1.2, speed: 1, trails: true },
    pointer: { x: null, y: null },  // CSS px on the canvas; null = no pointer
    fear: 0,                        // frames of panic left
    running: true,
    frames: 0,                      // drawn frames; the readiness hook watches this
  };

  var EX = 430, EY = 265, EZ = 430; // flight-box half-extents (world units)
  var flock = MURM.flock = { EX: EX, EY: EY, EZ: EZ, N: 0 };

  var px, py, pz, vx, vy, vz, hue;
  var tick = 0;
  var att = { x: 0, y: 0, z: 0, on: false };
  var wx = 0, wy = 0, wz = 0;

  /* Spatial hash: intrusive linked lists in typed arrays, rebuilt per frame. */
  var CELL = 80, R2 = CELL * CELL;  // neighbour radius = one cell
  var HX = 570, HY = 405, HZ = 570; // hash bounds — a margin beyond the walls
  var GX = Math.ceil(HX * 2 / CELL), GY = Math.ceil(HY * 2 / CELL), GZ = Math.ceil(HZ * 2 / CELL);
  var heads = new Int32Array(GX * GY * GZ), nxt = null;

  function cellOf(v, lo, g) { var c = ((v + lo) / CELL) | 0; return c < 0 ? 0 : c >= g ? g - 1 : c; }

  flock.init = function (area) {
    var N = flock.N = area > 700000 ? 300 : 190;
    px = new Float32Array(N); py = new Float32Array(N); pz = new Float32Array(N);
    vx = new Float32Array(N); vy = new Float32Array(N); vz = new Float32Array(N);
    hue = new Float32Array(N); nxt = new Int32Array(N);
    flock.px = px; flock.py = py; flock.pz = pz;
    flock.vx = vx; flock.vy = vy; flock.vz = vz; flock.hue = hue;
    flock.spawn();
  };

  flock.spawn = function () {
    for (var i = 0; i < flock.N; i++) {
      px[i] = (Math.random() * 2 - 1) * EX * 0.7;
      py[i] = (Math.random() * 2 - 1) * EY * 0.7;
      pz[i] = (Math.random() * 2 - 1) * EZ * 0.7;
      var a = Math.random() * Math.PI * 2, b = (Math.random() - 0.5) * Math.PI;
      vx[i] = Math.cos(a) * Math.cos(b) * 2;
      vy[i] = Math.sin(b) * 2;
      vz[i] = Math.sin(a) * Math.cos(b) * 2;
      hue[i] = 202 + Math.random() * 34;
    }
  };

  /* Panic: raise the fear timer; a kick also throws velocities apart at once. */
  flock.startle = function (frames, kick) {
    if (frames > state.fear) state.fear = frames;
    if (kick) {
      for (var i = 0; i < flock.N; i++) {
        vx[i] += (Math.random() * 2 - 1) * 2.8;
        vy[i] += (Math.random() * 2 - 1) * 2.8;
        vz[i] += (Math.random() * 2 - 1) * 2.8;
      }
    }
  };

  function rebuildHash() {
    heads.fill(-1);
    for (var i = 0; i < flock.N; i++) {
      var c = (cellOf(pz[i], HZ, GZ) * GY + cellOf(py[i], HY, GY)) * GX + cellOf(px[i], HX, GX);
      nxt[i] = heads[c]; heads[c] = i;
    }
  }

  flock.step = function () {
    tick++;
    var N = flock.N, P = state.P, i;

    /* Wander target: a slow Lissajous sweep keeps the idle flock travelling. */
    var wt = tick * 0.009;
    wx = Math.sin(wt * 0.9) * EX * 0.62;
    wy = Math.sin(wt * 1.27 + 1.7) * EY * 0.5;
    wz = Math.cos(wt * 0.65) * EZ * 0.62;

    /* Pointer becomes a 3D attract point on the camera's mid-plane. */
    att.on = state.pointer.x !== null;
    if (att.on) MURM.render.pointerToWorld(state.pointer.x, state.pointer.y, att);

    rebuildHash();

    var mx = 0, my = 0, mz = 0;
    for (i = 0; i < N; i++) { mx += px[i]; my += py[i]; mz += pz[i]; }
    mx /= N; my /= N; mz /= N;

    var fearOn = state.fear > 0;
    var fpx = att.on ? att.x : mx, fpy = att.on ? att.y : my, fpz = att.on ? att.z : mz;
    var maxSp = 3.4 * P.speed * (fearOn ? 1 + state.fear * 0.016 : 1); // panic overspeed
    var minSp = 1.1 * P.speed;
    var co = 0.0038 * P.cohesion, al = 0.07 * P.alignment, se = 24 * P.separation;

    for (i = 0; i < N; i++) {
      var x = px[i], y = py[i], z = pz[i];
      var cx = 0, cy = 0, cz = 0, ax = 0, ay = 0, az = 0, sx = 0, sy = 0, sz = 0, n = 0;
      var cgx = cellOf(x, HX, GX), cgy = cellOf(y, HY, GY), cgz = cellOf(z, HZ, GZ);
      var gz1 = cgz < GZ - 1 ? cgz + 1 : GZ - 1;
      var gy1 = cgy < GY - 1 ? cgy + 1 : GY - 1;
      var gx1 = cgx < GX - 1 ? cgx + 1 : GX - 1;
      for (var gz = cgz > 0 ? cgz - 1 : 0; gz <= gz1; gz++)
        for (var gy = cgy > 0 ? cgy - 1 : 0; gy <= gy1; gy++)
          for (var gx = cgx > 0 ? cgx - 1 : 0; gx <= gx1; gx++)
            for (var j = heads[(gz * GY + gy) * GX + gx]; j !== -1; j = nxt[j]) {
              if (j === i) continue;
              var dx = px[j] - x, dy = py[j] - y, dz = pz[j] - z;
              var d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > R2) continue;
              n++;
              cx += px[j]; cy += py[j]; cz += pz[j];
              ax += vx[j]; ay += vy[j]; az += vz[j];
              if (d2 < 1300) {                       // personal space: 36 units
                var inv = 1 / (d2 > 120 ? d2 : 120);
                sx -= dx * inv; sy -= dy * inv; sz -= dz * inv;
              }
            }
      if (n) {
        vx[i] += (cx / n - x) * co + (ax / n - vx[i]) * al + sx * se;
        vy[i] += (cy / n - y) * co + (ay / n - vy[i]) * al + sy * se;
        vz[i] += (cz / n - z) * co + (az / n - vz[i]) * al + sz * se;
      }
      if (fearOn) {                                  // flee the threat point
        var tx = fpx - x, ty = fpy - y, tz = fpz - z;
        var td = Math.sqrt(tx * tx + ty * ty + tz * tz) + 1;
        if (td < 560) { var fl = -0.85 / td; vx[i] += tx * fl; vy[i] += ty * fl; vz[i] += tz * fl; }
      } else {                                       // calm: drawn to pointer, else wander
        var gxp = att.on ? att.x : wx, gyp = att.on ? att.y : wy, gzp = att.on ? att.z : wz;
        var ptx = gxp - x, pty = gyp - y, ptz = gzp - z;
        var pd = Math.sqrt(ptx * ptx + pty * pty + ptz * ptz) + 1;
        var pull = (att.on ? 0.1 : 0.035) / pd;
        vx[i] += ptx * pull; vy[i] += pty * pull; vz[i] += ptz * pull;
      }
      vx[i] += (Math.random() - 0.5) * 0.06;         // organic shimmer
      vy[i] += (Math.random() - 0.5) * 0.06;
      vz[i] += (Math.random() - 0.5) * 0.06;
      /* Soft walls, engaged a little inside the box. */
      var ov;
      ov = x - (EX - 40); if (ov > 0) vx[i] -= Math.min(ov * 0.0035, 0.5);
      ov = -x - (EX - 40); if (ov > 0) vx[i] += Math.min(ov * 0.0035, 0.5);
      ov = y - (EY - 40); if (ov > 0) vy[i] -= Math.min(ov * 0.0035, 0.5);
      ov = -y - (EY - 40); if (ov > 0) vy[i] += Math.min(ov * 0.0035, 0.5);
      ov = z - (EZ - 40); if (ov > 0) vz[i] -= Math.min(ov * 0.0035, 0.5);
      ov = -z - (EZ - 40); if (ov > 0) vz[i] += Math.min(ov * 0.0035, 0.5);
      var sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]) || 1;
      if (sp > maxSp) { var k1 = maxSp / sp; vx[i] *= k1; vy[i] *= k1; vz[i] *= k1; }
      else if (sp < minSp) { var k2 = minSp / sp; vx[i] *= k2; vy[i] *= k2; vz[i] *= k2; }
      px[i] += vx[i] * P.speed; py[i] += vy[i] * P.speed; pz[i] += vz[i] * P.speed;
    }
    if (state.fear > 0) state.fear--;
  };
})();
