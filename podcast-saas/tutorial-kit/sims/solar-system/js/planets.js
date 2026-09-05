/* Solar System · planets — scene construction and per-frame kinematics.

   THE SCALE MODEL (documented, deliberately compressed):
   · Planet radii are TRUE relative sizes (Earth = 1 world unit, Jupiter 11.21,
     Mercury 0.383 → floored to 0.42 so it never vanishes at overview distance).
   · The Sun is shown at radius 16 — the real ratio (109 Earth radii) would leave
     every planet sub-pixel. Documented compression: ×0.147 of its true relative size.
   · Orbit radii use a power-compressed scale: R = 62 · AU^0.42. Real spacing
     (Neptune at 78× Mercury's distance) is unshowable in one frame; this keeps
     the ORDER and the visual sense of "inner crowd, outer emptiness".
   · Orbits are drawn circular (real eccentricities ≤0.21 read as circles anyway).
   · The Moon orbits at 3.4 Earth radii (real: 60.3) for the same reason.
   · Orbital PERIODS, spin periods, axial tilts and orbit inclinations are the
     real values — the motion ratios you see are honest.                      */

import * as THREE from '../vendor/three.module.js';

const D2R = Math.PI / 180;

export const BODIES = [
  /* name      tex        r      orbitR periodYr rotDays  tilt°  az   incl°  phase  frameF big */
  { name: 'Mercury', tex: 'mercury', r: 0.42, orbitR: 41.6, periodYr: 0.2408, rotDays: 58.646, tilt: 0.03, az: 0.0, incl: 7.00, phase: 3.6, frameF: 6.4, big: false },
  { name: 'Venus', tex: 'venus', r: 0.949, orbitR: 54.1, periodYr: 0.6152, rotDays: 243.02, tilt: 177.4, az: 0.5, incl: 3.39, phase: 5.3, frameF: 5.0, big: false },
  { name: 'Earth', tex: 'earth', r: 1.0, orbitR: 62.0, periodYr: 1.0, rotDays: 0.9973, tilt: 23.44, az: 1.0, incl: 0.0, phase: 4.75, frameF: 5.0, big: false },
  { name: 'Mars', tex: 'mars', r: 0.532, orbitR: 74.0, periodYr: 1.8808, rotDays: 1.026, tilt: 25.19, az: 1.6, incl: 1.85, phase: 1.1, frameF: 5.8, big: false },
  { name: 'Jupiter', tex: 'jupiter', r: 11.21, orbitR: 124.0, periodYr: 11.862, rotDays: 0.4135, tilt: 3.13, az: 2.2, incl: 1.30, phase: 5.8, frameF: 3.6, big: true },
  /* hintTheta/hintPhi: absolute camera angles that open the ring plane to the viewer */
  { name: 'Saturn', tex: 'saturn', r: 9.45, orbitR: 160.0, periodYr: 29.457, rotDays: 0.444, tilt: 26.73, az: 2.9, incl: 2.49, phase: 3.9, frameF: 6.0, big: true, hintTheta: 3.38, hintPhi: 1.02 },
  { name: 'Uranus', tex: 'uranus', r: 4.01, orbitR: 214.0, periodYr: 84.011, rotDays: 0.7183, tilt: 97.77, az: 3.4, incl: 0.77, phase: 1.5, frameF: 5.2, big: true, hintTheta: 2.88, hintPhi: 1.28 },
  { name: 'Neptune', tex: 'neptune', r: 3.88, orbitR: 259.0, periodYr: 164.79, rotDays: 0.6713, tilt: 28.32, az: 4.0, incl: 1.77, phase: 2.6, frameF: 5.2, big: true },
];

export const SUN_RADIUS = 16;
export const MOON = { name: 'Moon', r: 0.273, orbitR: 3.4, periodDays: 27.322, incl: 5.14, phase: 1.2 };

const OBLATE = { Jupiter: 0.935, Saturn: 0.902 };

/* ------------------------------------------------------------ small helpers */

function srgb(tex) { tex.colorSpace = THREE.SRGBColorSpace; return tex; }

function mapTexture(canvas, renderer, aniso = 4) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = Math.min(aniso, renderer.capabilities.getMaxAnisotropy());
  return srgb(t);
}

function dataTexture(canvas) {           // non-color data (bump, specular)
  return new THREE.CanvasTexture(canvas);
}

/* Additive fresnel rim — the cheap atmosphere. Day-side aware (sun at origin). */
function atmosphereMaterial(colorHex, power, intensity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uC: { value: new THREE.Color(colorHex) },
      uP: { value: power },
      uI: { value: intensity },
    },
    vertexShader: `
      varying vec3 vWN; varying vec3 vWP;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        vWN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uC; uniform float uP; uniform float uI;
      varying vec3 vWN; varying vec3 vWP;
      void main() {
        vec3 n = normalize(vWN);
        vec3 v = normalize(cameraPosition - vWP);
        float rim = pow(1.0 - abs(dot(n, v)), uP);
        float day = clamp(dot(n, normalize(-vWP)) * 0.62 + 0.52, 0.05, 1.0);
        gl_FragColor = vec4(uC, rim * uI * day);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide,
  });
}

const ATMOS = {
  Venus: [0xe8d9a8, 2.6, 0.5],
  Earth: [0x6fa8ff, 2.5, 0.85],
  Mars: [0xd89a74, 3.2, 0.22],
  Jupiter: [0xd8c8a8, 3.0, 0.3],
  Saturn: [0xe0d2ac, 3.0, 0.26],
  Uranus: [0xa8e0e0, 3.0, 0.3],
  Neptune: [0x5878e8, 3.0, 0.38],
};

function labelSprite(text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = '600 52px "Avenir Next","Helvetica Neue",Arial,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(2,6,16,0.95)'; ctx.shadowBlur = 14;
  ctx.fillStyle = 'rgba(234,242,255,0.96)';
  ctx.fillText(text.toUpperCase(), 256, 66);
  const t = srgb(new THREE.CanvasTexture(c));
  const m = new THREE.SpriteMaterial({
    map: t, transparent: true, depthTest: false, depthWrite: false,
    sizeAttenuation: false, opacity: 0.9,
  });
  const s = new THREE.Sprite(m);
  s.center.set(0.5, -0.9);                 // screen-space lift above the body
  s.scale.set(0.135, 0.03375, 1);
  s.renderOrder = 60;
  return s;
}

/* --------------------------------------------------------------- the system */

export function buildSystem(scene, renderer, T) {
  const system = {
    planets: [], byName: new Map(), hitMeshes: [],
    orbitsGroup: new THREE.Group(),
  };

  /* … the Sun … */
  const sunMap = mapTexture(T.sun.map, renderer);
  const sunMat = new THREE.MeshBasicMaterial({ map: sunMap });
  sunMat.color.setRGB(1.8, 1.62, 1.34);                 // pre-tonemap HDR push: it should blaze
  const sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 64, 40), sunMat);
  scene.add(sun);

  const coronaTex = srgb(new THREE.CanvasTexture(T.corona));
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: coronaTex, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: 0.9,
  }));
  glow.scale.setScalar(SUN_RADIUS * 9.4);
  scene.add(glow);

  const glowCore = new THREE.Sprite(new THREE.SpriteMaterial({
    map: coronaTex, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: 1,
  }));
  glowCore.scale.setScalar(SUN_RADIUS * 3.4);
  scene.add(glowCore);

  const rays = new THREE.Sprite(new THREE.SpriteMaterial({
    map: srgb(new THREE.CanvasTexture(T.rays)), blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: 0.9,
  }));
  rays.scale.setScalar(SUN_RADIUS * 6.2);
  scene.add(rays);

  const sunHit = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS * 1.12, 10, 8),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  sunHit.userData.body = 'Sun';
  scene.add(sunHit);
  system.hitMeshes.push(sunHit);
  system.sun = { mesh: sun, glow, rays };

  /* one soft-dot texture shared by stars and the far-planet glints */
  const starTex = srgb(new THREE.CanvasTexture(T.starDot));

  /* From overview distance an honest-scale planet is sub-pixel; real planets are
     naked-eye points of light. Each planet gets a tinted glint sprite that fades
     OUT as soon as the true disc resolves — so the far view sparkles honestly. */
  const DOT_TINT = {
    Mercury: 0xd8d4d0, Venus: 0xf8ead0, Earth: 0xa2c6ff, Mars: 0xef9468,
    Jupiter: 0xf4d8ac, Saturn: 0xf8e8c0, Uranus: 0xc2eeee, Neptune: 0x8ca2ff,
  };

  /* Single light source at the sun + starlight ambient. No shadow maps — the
     day/night terminator comes free from per-fragment Phong shading. */
  scene.add(new THREE.PointLight(0xfff3e0, 3.4, 0, 0));
  scene.add(new THREE.AmbientLight(0x36436a, 0.5));

  /* … the planets … */
  for (const B of BODIES) {
    const inclG = new THREE.Group();
    inclG.rotation.x = B.incl * D2R * Math.cos(B.az * 2.1);
    inclG.rotation.z = B.incl * D2R * Math.sin(B.az * 2.1);
    scene.add(inclG);

    const anchor = new THREE.Group();
    inclG.add(anchor);

    const azG = new THREE.Group();
    azG.rotation.y = B.az;
    anchor.add(azG);

    const tiltG = new THREE.Group();
    tiltG.rotation.z = -B.tilt * D2R;
    azG.add(tiltG);

    const segs = B.big ? [48, 32] : [32, 22];
    const tx = T[B.tex];
    const matOpts = {
      map: mapTexture(tx.map, renderer, B.big ? 8 : 4),
      shininess: 8, specular: new THREE.Color(0x0d0d0d),
    };
    if (tx.bump) {
      matOpts.bumpMap = dataTexture(tx.bump);
      matOpts.bumpMap.wrapS = THREE.RepeatWrapping;
      matOpts.bumpScale = B.name === 'Earth' ? 0.8 : 1.5;
    }
    if (B.name === 'Earth') {
      matOpts.specularMap = dataTexture(tx.spec);
      matOpts.specularMap.wrapS = THREE.RepeatWrapping;
      matOpts.specular = new THREE.Color(0x8899aa);
      matOpts.shininess = 18;
      matOpts.emissive = new THREE.Color(0xffffff);
      matOpts.emissiveMap = mapTexture(tx.night, renderer);
      matOpts.emissiveIntensity = 0.75;          // bright against night, lost in daylight
    }
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(B.r, segs[0], segs[1]), new THREE.MeshPhongMaterial(matOpts));
    if (OBLATE[B.name]) mesh.scale.y = OBLATE[B.name];
    tiltG.add(mesh);

    let clouds = null;
    if (B.name === 'Earth') {
      const ct = mapTexture(tx.clouds, renderer);
      clouds = new THREE.Mesh(
        new THREE.SphereGeometry(B.r * 1.018, segs[0], segs[1]),
        new THREE.MeshLambertMaterial({ map: ct, transparent: true, depthWrite: false }),
      );
      clouds.renderOrder = 2;
      tiltG.add(clouds);
    }

    if (ATMOS[B.name]) {
      const [c, p, i] = ATMOS[B.name];
      const atm = new THREE.Mesh(
        new THREE.SphereGeometry(B.r * 1.028, segs[0], segs[1]),
        atmosphereMaterial(c, p, i),
      );
      if (OBLATE[B.name]) atm.scale.y = OBLATE[B.name];
      atm.renderOrder = 3;
      tiltG.add(atm);
    }

    if (B.name === 'Saturn' || B.name === 'Uranus') {
      const rc = tx.ring;
      const inner = B.name === 'Saturn' ? 1.24 : 1.55;
      const outer = B.name === 'Saturn' ? 2.27 : 2.05;
      const geo = new THREE.RingGeometry(B.r * inner, B.r * outer, 168, 1);
      /* remap UVs radially so the 1-D strip texture reads as ring structure */
      const pos = geo.attributes.position, uv = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const rr = Math.hypot(pos.getX(i), pos.getY(i)) / B.r;
        uv.setXY(i, (rr - inner) / (outer - inner), 0.5);
      }
      const rt = mapTexture(rc, renderer, 8);
      rt.wrapS = THREE.ClampToEdgeWrapping;
      /* Lambert for the sun side, plus a low emissive floor so the ring reads as
         luminous ice from every angle instead of vanishing at grazing light. */
      const ring = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
        map: rt, side: THREE.DoubleSide, transparent: true, depthWrite: false,
        emissive: new THREE.Color(B.name === 'Saturn' ? 0x57503f : 0x272e35),
        emissiveMap: rt, emissiveIntensity: 1,
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 4;
      tiltG.add(ring);
    }

    /* generous invisible hit target so small planets are tappable */
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(B.r * 1.7, 2.6), 10, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.userData.body = B.name;
    anchor.add(hit);
    system.hitMeshes.push(hit);

    const label = labelSprite(B.name);
    anchor.add(label);

    const dot = new THREE.Sprite(new THREE.SpriteMaterial({
      map: starTex, color: DOT_TINT[B.name], transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false,
    }));
    dot.scale.set(0.0095, 0.0095, 1);
    dot.renderOrder = 8;
    anchor.add(dot);

    /* orbit line — its own holder so the whole set toggles with one flag */
    const holder = new THREE.Group();
    holder.rotation.copy(inclG.rotation);
    const N = 192, arr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      arr[i * 3] = Math.cos(a) * B.orbitR; arr[i * 3 + 2] = -Math.sin(a) * B.orbitR;
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    holder.add(new THREE.LineLoop(lg, new THREE.LineBasicMaterial({
      color: 0x7f97c2, transparent: true, opacity: 0.26, depthWrite: false,
    })));
    system.orbitsGroup.add(holder);

    const P = { ...B, anchor, mesh, clouds, label, hit, dot };
    system.planets.push(P);
    system.byName.set(B.name.toLowerCase(), P);
    if (B.name === 'Earth') {
      /* … the Moon … */
      const mIncl = new THREE.Group();
      mIncl.rotation.x = MOON.incl * D2R;
      anchor.add(mIncl);
      const mAnchor = new THREE.Group();
      mIncl.add(mAnchor);
      const mm = T.moon;
      const moonBump = dataTexture(mm.bump);
      moonBump.wrapS = THREE.RepeatWrapping;
      const moonMesh = new THREE.Mesh(
        new THREE.SphereGeometry(MOON.r, 26, 18),
        new THREE.MeshPhongMaterial({
          map: mapTexture(mm.map, renderer),
          bumpMap: moonBump, bumpScale: 1.3,
          shininess: 4, specular: new THREE.Color(0x050505),
        }),
      );
      mAnchor.add(moonMesh);
      const mHit = new THREE.Mesh(
        new THREE.SphereGeometry(1.4, 8, 6),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      mHit.userData.body = 'Moon';
      mAnchor.add(mHit);
      const mLabel = labelSprite('Moon');
      mLabel.scale.multiplyScalar(0.72);
      mAnchor.add(mLabel);
      system.hitMeshes.push(mHit);
      const MP = { name: 'Moon', r: MOON.r, frameF: 8, anchor: mAnchor, mesh: moonMesh, label: mLabel, orbitR: MOON.orbitR };
      system.planets.push(MP);
      system.byName.set('moon', MP);
    }
  }

  scene.add(system.orbitsGroup);

  /* … starfield (three shells for size/brightness variance) … */
  const bandN = new THREE.Vector3(0.58, 0.44, 0.62).normalize();
  const mkStars = (count, size, brightness, seed) => {
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    let i = 0, s = seed;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const v = new THREE.Vector3();
    while (i < count) {
      v.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
      const l2 = v.lengthSq();
      if (l2 < 0.04 || l2 > 1) continue;
      v.normalize();
      const d = v.dot(bandN);
      if (rnd() > 0.5 + 0.5 * Math.exp(-(d * d) / 0.12)) continue;   // densify the band
      const R = 3900 + rnd() * 700;
      pos[i * 3] = v.x * R; pos[i * 3 + 1] = v.y * R; pos[i * 3 + 2] = v.z * R;
      const b = brightness * (0.4 + 0.6 * rnd() * rnd());
      const t = rnd();
      let cr = 1, cg = 1, cb = 1;
      if (t < 0.13) { cr = 1; cg = 0.82; cb = 0.62; }                // K/M warm
      else if (t < 0.24) { cr = 0.72; cg = 0.82; cb = 1; }           // hot blue
      col[i * 3] = cr * b; col[i * 3 + 1] = cg * b; col[i * 3 + 2] = cb * b;
      i++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({
      size, map: starTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, vertexColors: true, sizeAttenuation: false,
    }));
    scene.add(p);
    return p;
  };
  mkStars(2900, 1.9, 0.7, 101);
  mkStars(1050, 3.1, 0.95, 202);
  mkStars(260, 5.2, 1.0, 303);

  /* … milky-way sky sphere … */
  const milky = new THREE.Mesh(
    new THREE.SphereGeometry(5200, 40, 24),
    new THREE.MeshBasicMaterial({ map: mapTexture(T.milky, renderer), side: THREE.BackSide, depthWrite: false }),
  );
  milky.renderOrder = -5;
  scene.add(milky);

  /* ------------------------------------------------------------ kinematics */
  const TWO_PI = Math.PI * 2;

  system.update = (tDays, wallSec) => {
    for (const P of system.planets) {
      if (P.name === 'Moon') {
        const a = MOON.phase + TWO_PI * tDays / MOON.periodDays;
        P.anchor.position.set(Math.cos(a) * MOON.orbitR, 0, -Math.sin(a) * MOON.orbitR);
        P.mesh.rotation.y = a;                                       // tidally locked
        continue;
      }
      const a = P.phase + TWO_PI * tDays / (365.25 * P.periodYr);
      P.anchor.position.set(Math.cos(a) * P.orbitR, 0, -Math.sin(a) * P.orbitR);
      P.mesh.rotation.y = TWO_PI * tDays / P.rotDays;
      if (P.clouds) P.clouds.rotation.y = TWO_PI * tDays / P.rotDays * 0.88 + 0.4;
    }
    sun.rotation.y = TWO_PI * tDays / 25.38;
    rays.material.rotation = -wallSec * 0.012;
    const pulse = 1 + 0.014 * Math.sin(wallSec * 0.9) + 0.008 * Math.sin(wallSec * 2.3);
    glow.scale.setScalar(SUN_RADIUS * 9.4 * pulse);
    glowCore.scale.setScalar(SUN_RADIUS * 3.4 * (1 + 0.03 * Math.sin(wallSec * 2.1)));
  };

  system.setLabels = v => { system.labelsOn = v; };
  system.setOrbits = v => { system.orbitsGroup.visible = v; };
  system.labelsOn = true;

  /* Per-frame overlay pass: far-planet glints fade against true disc size, the
     focused body's label yields when the surface fills the view, and the Moon's
     label only appears once the camera is actually visiting Earth. */
  const wp = new THREE.Vector3(), wp2 = new THREE.Vector3();
  const earthP = system.byName.get('earth');
  system.updateLabels = (focusName, camera) => {
    const halfTan = Math.tan(camera.fov * 0.5 * D2R);
    for (const P of system.planets) {
      P.anchor.getWorldPosition(wp);
      const d = wp.distanceTo(camera.position);
      if (P.dot) {
        const frac = (P.r / Math.max(d, 1e-3)) / halfTan;      // fraction of half-viewport
        const o = Math.min(1, Math.max(0, (0.012 - frac) / 0.008));
        P.dot.material.opacity = o;
        P.dot.visible = o > 0.02;
      }
      if (!system.labelsOn) { P.label.visible = false; continue; }
      if (P.name === 'Moon') {
        earthP.anchor.getWorldPosition(wp2);
        P.label.visible = wp2.distanceTo(camera.position) < 34 && d > P.r * 14;
      } else if (P.name === focusName) {
        P.label.visible = d > P.r * 14;
      } else P.label.visible = true;
    }
  };

  return system;
}
