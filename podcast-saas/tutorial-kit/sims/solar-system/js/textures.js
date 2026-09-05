/* Solar System · textures — every surface in the scene is generated here, at boot,
   on 2D canvases. Zero image assets ship with this sim; everything below is original
   procedural work (3D value-noise sampled on the sphere, so there are no seams and
   no pole pinching in the noise itself). MIT, FlowVid demo project 2026. */

'use strict';

/* ---------------------------------------------------------------- noise core */

function hash3(ix, iy, iz, seed) {
  let h = seed | 0;
  h = Math.imul(h ^ ix, 0x9E3779B1);
  h = Math.imul(h ^ iy, 0x85EBCA77);
  h = Math.imul(h ^ iz, 0xC2B2AE3D);
  h ^= h >>> 15; h = Math.imul(h, 0x27D4EB2F); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;                    // [0,1)
}

/* 3D value noise, trilinear with quintic fade. Returns [0,1]. */
function vnoise(x, y, z, seed) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  let fx = x - X, fy = y - Y, fz = z - Z;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash3(X, Y, Z, seed),         b = hash3(X + 1, Y, Z, seed);
  const c = hash3(X, Y + 1, Z, seed),     d = hash3(X + 1, Y + 1, Z, seed);
  const e = hash3(X, Y, Z + 1, seed),     f = hash3(X + 1, Y, Z + 1, seed);
  const g = hash3(X, Y + 1, Z + 1, seed), h = hash3(X + 1, Y + 1, Z + 1, seed);
  const x1 = a + (b - a) * ux, x2 = c + (d - c) * ux;
  const x3 = e + (f - e) * ux, x4 = g + (h - g) * ux;
  const y1 = x1 + (x2 - x1) * uy, y2 = x3 + (x4 - x3) * uy;
  return y1 + (y2 - y1) * uz;
}

/* Fractal brownian motion over vnoise. Returns ~[0,1]. */
function fbm(x, y, z, seed, oct, lac = 2.02, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x, y, z, seed + i * 131);
    norm += amp;
    amp *= gain; x *= lac; y *= lac; z *= lac;
  }
  return sum / norm;
}

/* --------------------------------------------------------------- 2D helpers */

function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/* Piecewise-linear color ramp. stops = [[t, r, g, b], …] ascending. */
function ramp(stops, t, out) {
  if (t <= stops[0][0]) { out[0] = stops[0][1]; out[1] = stops[0][2]; out[2] = stops[0][3]; return out; }
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i], k = (t - a[0]) / (b[0] - a[0]);
      out[0] = lerp(a[1], b[1], k); out[1] = lerp(a[2], b[2], k); out[2] = lerp(a[3], b[3], k);
      return out;
    }
  }
  const s = stops[stops.length - 1];
  out[0] = s[1]; out[1] = s[2]; out[2] = s[3]; return out;
}

/* Iterate an equirect canvas; shade(dir, lat, lon, px, i) writes px=[r,g,b,a] 0..255.
   Row/column trig is precomputed, and the 3D direction makes the noise seamless. */
function sphereShade(w, h, shade) {
  const canvas = cv(w, h), ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h), d = img.data;
  const cosLat = new Float64Array(h), sinLat = new Float64Array(h);
  const cosLon = new Float64Array(w), sinLon = new Float64Array(w), lons = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const lat = Math.PI * (0.5 - (y + 0.5) / h);
    cosLat[y] = Math.cos(lat); sinLat[y] = Math.sin(lat);
  }
  for (let x = 0; x < w; x++) {
    const lon = 2 * Math.PI * ((x + 0.5) / w);
    lons[x] = lon; cosLon[x] = Math.cos(lon); sinLon[x] = Math.sin(lon);
  }
  const px = [0, 0, 0, 255], dir = { x: 0, y: 0, z: 0 };
  let i = 0;
  for (let y = 0; y < h; y++) {
    const cl = cosLat[y], lat = Math.PI * (0.5 - (y + 0.5) / h);
    for (let x = 0; x < w; x++, i += 4) {
      dir.x = cl * cosLon[x]; dir.y = sinLat[y]; dir.z = cl * sinLon[x];
      px[3] = 255;
      shade(dir, lat, lons[x], px, i >> 2);
      d[i] = px[0]; d[i + 1] = px[1]; d[i + 2] = px[2]; d[i + 3] = px[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* Deterministic RNG for 2D passes (craters, storms, city dots). */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* Draw an equirect-safe soft disc (duplicated at ±width for seam wrap, x-stretched
   by 1/cos(lat) so it stays round on the sphere). paint(g) fills a unit gradient. */
function eqDisc(ctx, w, h, u, v, r, paint) {
  const lat = Math.PI * (0.5 - v / h);
  const sx = Math.min(6, 1 / Math.max(0.12, Math.cos(lat)));
  for (const ox of [-w, 0, w]) {
    ctx.save();
    ctx.translate(u + ox, v);
    ctx.scale(sx, 1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    paint(g);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
    ctx.restore();
  }
}

/* Crater field: darkened floor + bright rim on the color map, matching relief on
   the bump map. Same RNG stream drives both so they agree. */
function craterField(colorCanvas, bumpCanvas, count, seed, minR, maxR, strength) {
  const w = colorCanvas.width, h = colorCanvas.height;
  const cc = colorCanvas.getContext('2d'), bc = bumpCanvas.getContext('2d');
  const rng = makeRng(seed);
  for (let k = 0; k < count; k++) {
    const u = rng() * w;
    const v = h * (0.12 + 0.76 * rng());              // keep centers off the exact poles
    const t = rng();
    const r = minR + (maxR - minR) * t * t * t;       // many small, few large
    const a = strength * (0.5 + 0.5 * rng());
    eqDisc(cc, w, h, u, v, r, g => {
      g.addColorStop(0.0, `rgba(8,6,4,${0.30 * a})`);
      g.addColorStop(0.62, `rgba(8,6,4,${0.16 * a})`);
      g.addColorStop(0.74, `rgba(0,0,0,0)`);
      g.addColorStop(0.84, `rgba(255,246,232,${0.20 * a})`);
      g.addColorStop(1.0, `rgba(255,246,232,0)`);
    });
    eqDisc(bc, w, h, u, v, r, g => {
      g.addColorStop(0.0, `rgba(0,0,0,${0.42 * a})`);
      g.addColorStop(0.66, `rgba(0,0,0,${0.20 * a})`);
      g.addColorStop(0.76, `rgba(0,0,0,0)`);
      g.addColorStop(0.86, `rgba(255,255,255,${0.30 * a})`);
      g.addColorStop(1.0, `rgba(255,255,255,0)`);
    });
  }
}

const yieldFrame = () => new Promise(r => setTimeout(r, 0));

/* ------------------------------------------------------------------- bodies */

function sunCanvas() {
  const col = [0, 0, 0];
  return sphereShade(512, 256, (p, lat, lon, px) => {
    const gran = fbm(p.x * 40, p.y * 40, p.z * 40, 901, 4);        // fine granulation
    const cell = fbm(p.x * 9, p.y * 9, p.z * 9, 902, 3);           // supergranules
    let t = 0.62 + 0.34 * (gran - 0.5) + 0.22 * (cell - 0.5);
    ramp([[0, 255, 140, 40], [0.42, 255, 190, 80], [0.72, 255, 228, 140], [1, 255, 248, 214]], t, col);
    const spotGate = smooth(0.6, 0.74, fbm(p.x * 1.4 + 3.7, p.y * 1.4, p.z * 1.4, 904, 2));
    const spot = smooth(0.22, 0.17, fbm(p.x * 10, p.y * 10, p.z * 10, 903, 3))
      * smooth(1.05, 0.8, Math.abs(lat)) * spotGate;               // one or two active regions, not mold
    px[0] = col[0] * (1 - 0.42 * spot); px[1] = col[1] * (1 - 0.5 * spot); px[2] = col[2] * (1 - 0.52 * spot);
  });
}

function coronaCanvas() {
  const S = 512, c = cv(S, S), ctx = c.getContext('2d'), R = S / 2;
  const g = ctx.createRadialGradient(R, R, 0, R, R, R);
  g.addColorStop(0.00, 'rgba(255,248,224,1)');
  g.addColorStop(0.14, 'rgba(255,226,158,0.92)');
  g.addColorStop(0.28, 'rgba(255,186,92,0.42)');
  g.addColorStop(0.45, 'rgba(255,142,54,0.13)');
  g.addColorStop(0.68, 'rgba(255,110,44,0.035)');
  g.addColorStop(1.00, 'rgba(255,96,40,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  return c;
}

function raysCanvas() {
  const S = 512, c = cv(S, S), ctx = c.getContext('2d'), R = S / 2;
  const rng = makeRng(77031);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 90; i++) {
    const a = rng() * Math.PI * 2, len = R * (0.42 + 0.55 * rng() * rng());
    const wdt = 0.7 + 2.4 * rng(), al = 0.028 + 0.075 * rng();
    ctx.save();
    ctx.translate(R, R); ctx.rotate(a);
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, `rgba(255,214,150,${al})`);
    g.addColorStop(0.35, `rgba(255,190,110,${al * 0.7})`);
    g.addColorStop(1, 'rgba(255,170,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, -wdt / 2, len, wdt);
    ctx.restore();
  }
  return c;
}

function mercuryCanvases() {
  const col = [0, 0, 0];
  const map = sphereShade(512, 256, (p, lat, lon, px) => {
    const broad = fbm(p.x * 2.6, p.y * 2.6, p.z * 2.6, 111, 4);
    const fine = fbm(p.x * 13, p.y * 13, p.z * 13, 112, 4);
    let t = 0.42 + 0.5 * (broad - 0.5) + 0.34 * (fine - 0.5);
    ramp([[0, 88, 84, 82], [0.5, 138, 134, 132], [0.78, 168, 163, 158], [1, 190, 186, 180]], t, col);
    px[0] = col[0]; px[1] = col[1]; px[2] = col[2];
  });
  const bump = sphereShade(512, 256, (p, lat, lon, px) => {
    const v = 118 + 90 * (fbm(p.x * 9, p.y * 9, p.z * 9, 113, 4) - 0.5);
    px[0] = px[1] = px[2] = v;
  });
  craterField(map, bump, 130, 4242, 2, 26, 0.95);
  return { map, bump };
}

function venusCanvas() {
  const col = [0, 0, 0];
  return sphereShade(512, 256, (p, lat, lon, px) => {
    const warp = fbm(p.x * 2.3, p.y * 2.3, p.z * 2.3, 221, 3) - 0.5;
    const lon2 = lon + lat * 0.9 + warp * 0.8;                     // chevron drift
    const cl = Math.cos(lat), qx = cl * Math.cos(lon2), qz = cl * Math.sin(lon2);
    const band = fbm(qx * 1.5, p.y * 4.6, qz * 1.5, 222, 4);
    const wisp = fbm(qx * 5, p.y * 11, qz * 5, 223, 3);
    let t = 0.5 + 0.75 * (band - 0.5) + 0.25 * (wisp - 0.5) + 0.16 * Math.abs(p.y);
    ramp([[0, 176, 138, 88], [0.35, 208, 172, 116], [0.62, 232, 206, 156], [0.85, 245, 228, 190], [1, 250, 240, 212]], t, col);
    px[0] = col[0]; px[1] = col[1]; px[2] = col[2];
  });
}

function earthCanvases() {
  const W = 1024, H = 512;
  const land = new Float32Array(W * H);        // land factor 0..1 (coast-smoothed)
  const elevA = new Float32Array(W * H);       // elevation over sea level 0..1
  const suit = new Float32Array(W * H);        // "city suitability"
  const col = [0, 0, 0];

  const map = sphereShade(W, H, (p, lat, lon, px, idx) => {
    const cont = fbm(p.x * 1.75, p.y * 1.75, p.z * 1.75, 331, 5);
    const detail = fbm(p.x * 5.2, p.y * 5.2, p.z * 5.2, 332, 4);
    const h = cont + 0.34 * (detail - 0.5);
    const T = 0.538;
    const landF = smooth(T - 0.006, T + 0.006, h);
    const elev = clamp01((h - T) / (0.62 - T));
    land[idx] = landF; elevA[idx] = elev;

    /* climate */
    const tempNoise = fbm(p.x * 3.1, p.y * 3.1, p.z * 3.1, 333, 3) - 0.5;
    const temp = Math.cos(lat * 1.12) - 0.42 * elev + 0.22 * tempNoise;   // 1 hot → 0 cold
    const moist = fbm(p.x * 2.4, p.y * 2.4, p.z * 2.4, 334, 4);

    if (landF < 0.999) {                                    /* ocean & coast */
      const depth = clamp01((T - h) / 0.30);
      ramp([[0, 30, 96, 160], [0.18, 18, 74, 142], [0.5, 9, 46, 110], [1, 4, 24, 72]], depth, col);
    }
    if (landF > 0.001) {                                    /* land */
      let r, g, b;
      if (temp < 0.19) { r = 233; g = 237; b = 242; }                      // snow
      else if (temp < 0.30) { r = 132; g = 132; b = 112; }                 // tundra
      else if (moist < 0.36 && temp > 0.58) {                              // desert
        const dn = fbm(p.x * 7, p.y * 7, p.z * 7, 335, 3);
        r = 190 + 28 * dn; g = 152 + 24 * dn; b = 92 + 16 * dn;
      } else {                                                             // vegetation
        ramp([[0, 108, 122, 56], [0.45, 72, 110, 44], [0.7, 44, 92, 38], [1, 24, 70, 34]],
          clamp01(moist * 1.15 + 0.25 * (temp - 0.5)), col);
        r = col[0]; g = col[1]; b = col[2];
      }
      if (elev > 0.6) {                                                    // rock
        const k = smooth(0.6, 0.85, elev);
        r = lerp(r, 122, k); g = lerp(g, 112, k); b = lerp(b, 98, k);
      }
      if (elev > 0.78 && temp < 0.55) {                                    // snowcaps
        const k = smooth(0.78, 0.92, elev);
        r = lerp(r, 240, k); g = lerp(g, 244, k); b = lerp(b, 248, k);
      }
      const rough = fbm(p.x * 11, p.y * 11, p.z * 11, 336, 3) - 0.5;
      r *= 1 + 0.1 * rough; g *= 1 + 0.1 * rough; b *= 1 + 0.1 * rough;
      col[0] = lerp(col[0], r, landF); col[1] = lerp(col[1], g, landF); col[2] = lerp(col[2], b, landF);
      if (landF > 0.999) { col[0] = r; col[1] = g; col[2] = b; }
      suit[idx] = landF * smooth(0.34, 0.5, temp) * (1 - smooth(0.75, 0.95, temp) * smooth(0.42, 0.3, moist))
        * (1 + 2.4 * smooth(0.1, 0.02, h - T));            // coasts glow brightest
    }

    /* polar ice (over sea and land alike) */
    const iceEdge = 1.24 - 0.06 * fbm(p.x * 6, p.y * 6, p.z * 6, 337, 3);
    const ice = smooth(iceEdge, iceEdge + 0.08, Math.abs(lat));
    if (ice > 0) {
      col[0] = lerp(col[0], 236, ice); col[1] = lerp(col[1], 242, ice); col[2] = lerp(col[2], 248, ice);
    }
    px[0] = col[0]; px[1] = col[1]; px[2] = col[2];
  });

  /* night lights — clustered warm dots on suitable land */
  const night = cv(W, H), nctx = night.getContext('2d');
  nctx.fillStyle = '#000'; nctx.fillRect(0, 0, W, H);
  const nimg = nctx.getImageData(0, 0, W, H), nd = nimg.data;
  for (let y = 2; y < H - 2; y++) {
    const lat = Math.PI * (0.5 - (y + 0.5) / H), cl = Math.cos(lat), sl = Math.sin(lat);
    for (let x = 0; x < W; x++) {
      const idx = y * W + x, s = suit[idx];
      if (s <= 0.02) continue;
      const lon = 2 * Math.PI * ((x + 0.5) / W);
      const dx = cl * Math.cos(lon), dz = cl * Math.sin(lon);
      const clump = Math.max(0, fbm(dx * 7.5, sl * 7.5, dz * 7.5, 338, 3) - 0.55) * 3.4;
      const p = s * clump * 0.22;
      if (hash3(x, y, 7, 991) < p) {
        const b = 80 + 85 * hash3(x, y, 13, 992);
        const i4 = idx * 4;
        nd[i4] = Math.min(255, nd[i4] + b);
        nd[i4 + 1] = Math.min(255, nd[i4 + 1] + b * 0.82);
        nd[i4 + 2] = Math.min(255, nd[i4 + 2] + b * 0.55);
        /* soft halo */
        for (const [ox, oy, f] of [[1, 0, 0.22], [-1, 0, 0.22], [0, 1, 0.22], [0, -1, 0.22]]) {
          const j = ((y + oy) * W + ((x + ox + W) % W)) * 4;
          nd[j] = Math.min(255, nd[j] + b * f);
          nd[j + 1] = Math.min(255, nd[j + 1] + b * f * 0.82);
          nd[j + 2] = Math.min(255, nd[j + 2] + b * f * 0.55);
        }
      }
    }
  }
  nctx.putImageData(nimg, 0, 0);

  /* specular: oceans glint, land does not */
  const spec = cv(512, 256), sctx = spec.getContext('2d');
  const simg = sctx.createImageData(512, 256), sd = simg.data;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
    const src = (y * 2) * W + (x * 2);
    const v = (1 - land[src]) * 215 + 14;
    const i4 = (y * 512 + x) * 4;
    sd[i4] = sd[i4 + 1] = sd[i4 + 2] = v; sd[i4 + 3] = 255;
  }
  sctx.putImageData(simg, 0, 0);

  /* bump: land relief only */
  const bump = cv(512, 256), bctx = bump.getContext('2d');
  const bimg = bctx.createImageData(512, 256), bd = bimg.data;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
    const src = (y * 2) * W + (x * 2);
    const v = 108 + land[src] * (26 + 110 * elevA[src]);
    const i4 = (y * 512 + x) * 4;
    bd[i4] = bd[i4 + 1] = bd[i4 + 2] = v; bd[i4 + 3] = 255;
  }
  bctx.putImageData(bimg, 0, 0);

  /* clouds — domain-warped, wind-stretched along longitude, filamented */
  const clouds = sphereShade(512, 256, (p, lat, lon, px) => {
    const w1 = fbm(p.x * 2.1 + 9.2, p.y * 2.1, p.z * 2.1, 441, 3) - 0.5;
    const w2 = fbm(p.x * 2.1, p.y * 2.1 + 4.4, p.z * 2.1, 442, 3) - 0.5;
    const c = fbm(p.x * 3.4 + w1 * 1.8, p.y * 7.2 + w2 * 1.8, p.z * 3.4 + w1 * 1.5, 443, 5);
    const fine = fbm(p.x * 9, p.y * 16, p.z * 9, 444, 3);
    const bandBoost = 0.05 * Math.cos(lat * 3.2);              // hint of trade-wind belts
    let a = smooth(0.55, 0.74, c + bandBoost + 0.1 * (fine - 0.5));
    a = a * 0.85 + 0.22 * smooth(0.5, 0.56, c) * (1 - a);      // wispy fringe
    a *= 0.55 + 0.45 * smooth(1.35, 1.1, Math.abs(lat));       // thinner over the caps
    px[0] = px[1] = px[2] = 255;
    px[3] = 255 * a;
  });

  return { map, night, spec, bump, clouds };
}

function marsCanvases() {
  const col = [0, 0, 0];
  const map = sphereShade(512, 256, (p, lat, lon, px) => {
    const broad = fbm(p.x * 2.4, p.y * 2.4, p.z * 2.4, 551, 4);
    const fine = fbm(p.x * 9, p.y * 9, p.z * 9, 552, 4);
    let t = 0.5 + 0.55 * (broad - 0.5) + 0.28 * (fine - 0.5);
    ramp([[0, 122, 62, 36], [0.35, 170, 92, 52], [0.62, 204, 122, 72], [0.85, 226, 154, 102], [1, 238, 178, 128]], t, col);
    const basin = smooth(0.46, 0.34, fbm(p.x * 1.6 + 3.3, p.y * 1.6, p.z * 1.6, 553, 4));
    col[0] = lerp(col[0], 92, basin * 0.55); col[1] = lerp(col[1], 54, basin * 0.55); col[2] = lerp(col[2], 38, basin * 0.55);
    const capEdge = (lat > 0 ? 1.27 : 1.34) - 0.05 * fbm(p.x * 5, p.y * 5, p.z * 5, 554, 3);
    const cap = smooth(capEdge, capEdge + 0.07, Math.abs(lat));
    col[0] = lerp(col[0], 244, cap); col[1] = lerp(col[1], 240, cap); col[2] = lerp(col[2], 234, cap);
    px[0] = col[0]; px[1] = col[1]; px[2] = col[2];
  });
  const bump = sphereShade(512, 256, (p, lat, lon, px) => {
    const v = 122 + 82 * (fbm(p.x * 7, p.y * 7, p.z * 7, 555, 4) - 0.5);
    px[0] = px[1] = px[2] = v;
  });
  craterField(map, bump, 40, 8181, 2, 10, 0.4);
  return { map, bump };
}

const JUPITER_STOPS = [
  [-1.571, 172, 148, 120], [-1.2, 196, 172, 140], [-0.96, 156, 122, 92], [-0.78, 228, 212, 182],
  [-0.61, 164, 120, 80], [-0.44, 240, 224, 194], [-0.31, 172, 100, 60], [-0.14, 238, 226, 202],
  [0, 210, 184, 148], [0.12, 246, 236, 212], [0.245, 158, 102, 62], [0.385, 234, 218, 188],
  [0.56, 176, 134, 96], [0.79, 220, 202, 172], [1.05, 172, 146, 118], [1.571, 166, 142, 116],
];

function jupiterCanvas() {
  const col = [0, 0, 0], spotCol = [0, 0, 0];
  const latGRS = -0.40, lonGRS = 0.55;
  return sphereShade(1024, 512, (p, lat, lon, px) => {
    const turb = (fbm(p.x * 4.4, p.y * 4.4, p.z * 4.4, 661, 4) - 0.5);
    const latN = lat + turb * 0.11 * (0.5 + Math.cos(lat));
    ramp(JUPITER_STOPS, latN, col);
    /* wind-stretched streaks inside the bands */
    const streak = fbm(p.x * 1.3, p.y * 10.5, p.z * 1.3, 662, 4) - 0.5;
    let r = col[0] * (1 + 0.2 * streak), g = col[1] * (1 + 0.18 * streak), b = col[2] * (1 + 0.15 * streak);
    /* Great Red Spot */
    let dLon = lon - lonGRS;
    if (dLon > Math.PI) dLon -= 2 * Math.PI; if (dLon < -Math.PI) dLon += 2 * Math.PI;
    const ex = dLon * Math.cos(lat) / 0.30, ey = (lat - latGRS) / 0.135;
    const e = ex * ex + ey * ey;
    if (e < 1.6) {
      const swirl = 0.06 * (fbm(p.x * 9, p.y * 9, p.z * 9, 663, 3) - 0.5);
      const er = Math.sqrt(e) + swirl;
      ramp([[0, 176, 62, 38], [0.3, 196, 82, 50], [0.62, 176, 88, 58], [0.83, 236, 222, 198], [1, r, g, b]],
        clamp01(er), spotCol);
      const k = smooth(1.25, 0.95, er);
      r = lerp(r, spotCol[0], k); g = lerp(g, spotCol[1], k); b = lerp(b, spotCol[2], k);
    }
    /* subtle festoons near the equator, gated to a few longitudes */
    const festGate = smooth(0.5, 0.72, fbm(p.x * 1.6 + 6.6, p.y * 1.6, p.z * 1.6, 665, 2));
    const fest = smooth(0.62, 0.78, fbm(p.x * 6, p.y * 2.2, p.z * 6, 664, 3))
      * smooth(0.3, 0.12, Math.abs(lat + 0.07)) * festGate;
    r = lerp(r, 96, fest * 0.22); g = lerp(g, 116, fest * 0.19); b = lerp(b, 148, fest * 0.16);
    px[0] = r; px[1] = g; px[2] = b;
  });
}

function saturnCanvas() {
  const col = [0, 0, 0];
  return sphereShade(512, 256, (p, lat, lon, px) => {
    const turb = (fbm(p.x * 3.6, p.y * 3.6, p.z * 3.6, 771, 3) - 0.5);
    const latN = lat + turb * 0.04;
    ramp([[-1.571, 150, 128, 92], [-1.15, 178, 152, 110], [-0.85, 152, 128, 92], [-0.55, 210, 186, 140],
      [-0.32, 188, 160, 116], [-0.12, 236, 216, 168], [0.1, 214, 190, 142], [0.32, 232, 210, 160],
      [0.58, 190, 164, 120], [0.9, 206, 182, 136], [1.25, 168, 146, 106], [1.571, 148, 128, 94]], latN, col);
    const streak = fbm(p.x * 1.2, p.y * 9, p.z * 1.2, 772, 3) - 0.5;
    px[0] = col[0] * (1 + 0.09 * streak); px[1] = col[1] * (1 + 0.08 * streak); px[2] = col[2] * (1 + 0.07 * streak);
  });
}

/* Radial ring strip: x axis maps inner→outer radius (in planet radii). */
function saturnRingCanvas() {
  const W = 1024, H = 48, c = cv(W, H), ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H), d = img.data;
  const IN = 1.24, OUT = 2.27;
  for (let x = 0; x < W; x++) {
    const r = IN + (OUT - IN) * (x / (W - 1));
    let a = 0, cr = 205, cg = 184, cb = 150;
    if (r < 1.52) {                                  // C ring — translucent dusty
      a = 0.26 * smooth(1.24, 1.32, r);
      cr = 168; cg = 148; cb = 122;
    } else if (r < 1.95) {                           // B ring — broad and bright
      a = 0.9;
      cr = 222; cg = 200; cb = 162;
    } else if (r < 2.03) {                           // Cassini division
      a = 0.10;
      cr = 150; cg = 134; cb = 112;
    } else {                                         // A ring
      a = 0.62 * smooth(2.27, 2.2, r);
      cr = 206; cg = 184; cb = 148;
      if (Math.abs(r - 2.214) < 0.008) a *= 0.18;    // Encke gap
    }
    /* fine ringlet structure */
    const n1 = vnoise(r * 60, 3.17, 9.1, 881);
    const n2 = vnoise(r * 175, 7.7, 2.3, 882);
    a *= (0.7 + 0.3 * n1) * (0.82 + 0.18 * n2);
    const tint = 0.92 + 0.1 * n1;
    for (let y = 0; y < H; y++) {
      const i4 = (y * W + x) * 4;
      d[i4] = cr * tint; d[i4 + 1] = cg * tint; d[i4 + 2] = cb * tint; d[i4 + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function uranusCanvas() {
  const col = [0, 0, 0];
  return sphereShade(512, 256, (p, lat, lon, px) => {
    const n = fbm(p.x * 3, p.y * 3, p.z * 3, 991, 3) - 0.5;
    ramp([[-1.571, 142, 196, 200], [-0.6, 152, 208, 208], [0, 158, 214, 214], [0.7, 168, 220, 214], [1.571, 178, 226, 216]],
      lat + n * 0.06, col);
    px[0] = col[0] * (1 + 0.03 * n); px[1] = col[1] * (1 + 0.03 * n); px[2] = col[2] * (1 + 0.03 * n);
  });
}

function uranusRingCanvas() {
  const W = 512, H = 16, c = cv(W, H), ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H), d = img.data;
  const IN = 1.55, OUT = 2.05;
  for (let x = 0; x < W; x++) {
    const r = IN + (OUT - IN) * (x / (W - 1));
    let a = 0.045 * smooth(1.6, 1.7, r);                       // faint dusty sheet
    if (Math.abs(r - 1.78) < 0.006) a = 0.16;
    if (Math.abs(r - 1.9) < 0.005) a = 0.13;
    if (Math.abs(r - 2.0) < 0.009) a = 0.38;                   // epsilon ring
    for (let y = 0; y < H; y++) {
      const i4 = (y * W + x) * 4;
      d[i4] = 196; d[i4 + 1] = 208; d[i4 + 2] = 218; d[i4 + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function neptuneCanvas() {
  const col = [0, 0, 0];
  const map = sphereShade(512, 256, (p, lat, lon, px) => {
    const n = fbm(p.x * 2.8, p.y * 2.8, p.z * 2.8, 1101, 4) - 0.5;
    const latN = lat + n * 0.1;
    ramp([[-1.571, 30, 54, 150], [-0.9, 40, 74, 190], [-0.42, 32, 60, 168], [0, 54, 96, 226],
      [0.5, 44, 80, 204], [1.1, 36, 66, 178], [1.571, 30, 56, 152]], latN, col);
    const streak = fbm(p.x * 1.2, p.y * 8, p.z * 1.2, 1102, 3) - 0.5;
    let r = col[0] * (1 + 0.16 * streak), g = col[1] * (1 + 0.14 * streak), b = col[2] * (1 + 0.1 * streak);
    /* Great Dark Spot */
    let dLon = lon - 4.1; if (dLon > Math.PI) dLon -= 2 * Math.PI; if (dLon < -Math.PI) dLon += 2 * Math.PI;
    const e = (dLon * Math.cos(lat) / 0.24) ** 2 + ((lat + 0.5) / 0.11) ** 2;
    const k = smooth(1.1, 0.6, e);
    r = lerp(r, 14, k * 0.5); g = lerp(g, 26, k * 0.5); b = lerp(b, 92, k * 0.5);
    px[0] = r; px[1] = g; px[2] = b;
  });
  /* bright cirrus streaks (Voyager's "scooters") */
  const ctx = map.getContext('2d');
  const rng = makeRng(31337);
  for (let i = 0; i < 7; i++) {
    const u = rng() * 512, v = 256 * (0.3 + 0.4 * rng()), len = 26 + 60 * rng(), th = 1.2 + 2.2 * rng();
    const al = 0.22 + 0.3 * rng();
    for (const ox of [-512, 0, 512]) {
      ctx.save();
      ctx.translate(u + ox, v);
      const g = ctx.createLinearGradient(-len / 2, 0, len / 2, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.3, `rgba(240,248,255,${al})`);
      g.addColorStop(0.7, `rgba(240,248,255,${al})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, len / 2, th, 0, 0, 7); ctx.fill();
      ctx.restore();
    }
  }
  return map;
}

function moonCanvases() {
  const col = [0, 0, 0];
  const map = sphereShade(512, 256, (p, lat, lon, px) => {
    const broad = fbm(p.x * 2.2, p.y * 2.2, p.z * 2.2, 1201, 4);
    const fine = fbm(p.x * 12, p.y * 12, p.z * 12, 1202, 4);
    let t = 0.52 + 0.4 * (broad - 0.5) + 0.3 * (fine - 0.5);
    ramp([[0, 118, 115, 110], [0.55, 168, 165, 158], [1, 205, 202, 194]], t, col);
    const maria = smooth(0.46, 0.36, fbm(p.x * 1.7 + 8.8, p.y * 1.7, p.z * 1.7, 1203, 3));
    col[0] = lerp(col[0], 96, maria * 0.6); col[1] = lerp(col[1], 95, maria * 0.6); col[2] = lerp(col[2], 94, maria * 0.6);
    px[0] = col[0]; px[1] = col[1]; px[2] = col[2];
  });
  const bump = sphereShade(512, 256, (p, lat, lon, px) => {
    const v = 120 + 80 * (fbm(p.x * 10, p.y * 10, p.z * 10, 1204, 4) - 0.5);
    px[0] = px[1] = px[2] = v;
  });
  craterField(map, bump, 90, 5757, 2, 18, 0.85);
  return { map, bump };
}

/* Milky-way sky sphere: a faint clumpy band with dust lanes, never brighter than a
   whisper — it should read as a distant river of stars, not as smoke in the scene. */
function milkyCanvas() {
  const nrm = { x: 0.58, y: 0.44, z: 0.62 };                       // steep, dynamic crossing
  const inv = 1 / Math.hypot(nrm.x, nrm.y, nrm.z);
  nrm.x *= inv; nrm.y *= inv; nrm.z *= inv;
  return sphereShade(768, 384, (p, lat, lon, px) => {
    const d = p.x * nrm.x + p.y * nrm.y + p.z * nrm.z;
    const core = Math.exp(-(d * d) / (0.105 * 0.105));
    const clouds = fbm(p.x * 3.6, p.y * 3.6, p.z * 3.6, 1301, 4);
    const knots = fbm(p.x * 8, p.y * 8, p.z * 8, 1304, 3);
    const dust = smooth(0.46, 0.7, fbm(p.x * 5.2 + 4.4, p.y * 5.2, p.z * 5.2, 1302, 4));
    let L = core * (0.22 + 0.55 * clouds + 0.3 * knots * clouds) * (1 - 0.85 * dust);
    L = Math.max(0, L);
    const base = 2 + 2.5 * fbm(p.x * 1.3, p.y * 1.3, p.z * 1.3, 1303, 2);
    px[0] = base + L * 34 + core * L * 11;                         // faint, slightly warm core
    px[1] = base + L * 37 + core * L * 9;
    px[2] = base + 1 + L * 47;
  });
}

function starDotCanvas() {
  const S = 64, c = cv(S, S), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  return c;
}

/* ------------------------------------------------------------------ pipeline */

/* Generates everything, yielding to the event loop between bodies so the tab
   stays responsive during the ~1.5–2.5s of boot work. */
export async function generateAllTextures() {
  const T = {};
  T.sun = { map: sunCanvas() };
  T.corona = coronaCanvas();
  T.rays = raysCanvas();
  await yieldFrame();
  T.mercury = mercuryCanvases();
  await yieldFrame();
  T.venus = { map: venusCanvas() };
  await yieldFrame();
  T.earth = earthCanvases();
  await yieldFrame();
  T.mars = marsCanvases();
  await yieldFrame();
  T.jupiter = { map: jupiterCanvas() };
  await yieldFrame();
  T.saturn = { map: saturnCanvas(), ring: saturnRingCanvas() };
  T.uranus = { map: uranusCanvas(), ring: uranusRingCanvas() };
  await yieldFrame();
  T.neptune = { map: neptuneCanvas() };
  await yieldFrame();
  T.moon = moonCanvases();
  await yieldFrame();
  T.milky = milkyCanvas();
  T.starDot = starDotCanvas();
  return T;
}
