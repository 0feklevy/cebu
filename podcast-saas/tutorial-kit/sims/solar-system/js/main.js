/* Solar System · main — boot, render loop, tap routing, present gating.
   One render loop, no per-frame allocations, rendering parks itself while the
   document is hidden. */

import * as THREE from '../vendor/three.module.js';
import { generateAllTextures } from './textures.js';
import { buildSystem } from './planets.js';
import { CameraRig } from './camera.js';
import { Tour } from './tour.js';
import { installApi, sliderToDps } from './api.js';

/* The present gate exists from the first tick of script evaluation, but it only
   resolves after every texture is generated AND two full frames have rendered —
   FlowVid holds the reveal on this, so a viewer never sees a loading flash. */
let resolveReady;
window.__flowvidReadyForPresent = new Promise(r => { resolveReady = r; });

const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 12000);

const sim = {
  tDays: 0,
  speedDps: sliderToDps(0.6),
  paused: false,
  focusName: 'Overview',
};

boot();

async function boot() {
  const T = await generateAllTextures();
  const system = buildSystem(scene, renderer, T);
  const rig = new CameraRig(canvas, camera);

  /* ---------------------------------------------------------- focus routing */
  const ctx = { sim, rig, system, focusBody, resetView: null };
  const tmpV = new THREE.Vector3();

  /* shortest angular distance helper for choosing an approach side */
  const wrapPi = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

  function focusBody(name, opts = {}) {
    const key = String(name || '').toLowerCase();
    if (key === 'overview') {
      sim.focusName = 'Overview';
      rig.overview(opts.dur ?? 2.0);
    } else if (key === 'sun') {
      sim.focusName = 'Sun';
      rig.flyTo(system.sun.mesh, 'Sun', {
        dist: 54, phi: opts.phi ?? 1.25,
        theta: opts.thetaDelta ? rig.theta + opts.thetaDelta : undefined,
        dur: opts.dur ?? 2.0,
        minD: 24,                                  // never inside the corona
      });
    } else {
      const P = system.byName.get(key);
      if (!P) return;
      sim.focusName = P.name;
      let phi = opts.phi ?? P.hintPhi ?? 1.18;
      let theta;
      if (opts.thetaDelta) {
        theta = rig.theta + opts.thetaDelta;
      } else if (P.hintTheta != null) {
        /* ringed worlds: the ring plane has two open sides — take the sun-lit one */
        P.anchor.getWorldPosition(tmpV);
        const sunAz = Math.atan2(-tmpV.z, -tmpV.x);
        const c2 = P.hintTheta + Math.PI;
        theta = Math.abs(wrapPi(P.hintTheta - sunAz)) <= Math.abs(wrapPi(c2 - sunAz))
          ? P.hintTheta : c2;
      } else {
        /* Terminator-facing arrival: park the camera ~71° off the sun line so
           every visit lands as a two-thirds-lit globe with a live day/night edge. */
        P.anchor.getWorldPosition(tmpV);
        const sunAz = Math.atan2(-tmpV.z, -tmpV.x);
        const off = Math.acos(Math.min(1, Math.max(-1, 0.32 / Math.sin(phi))));
        theta = Math.abs(wrapPi(sunAz + off - rig.theta)) <= Math.abs(wrapPi(sunAz - off - rig.theta))
          ? sunAz + off : sunAz - off;
      }
      rig.flyTo(P.anchor, P.name, {
        dist: P.r * P.frameF, phi, theta,
        dur: opts.dur ?? 2.0,
        minD: Math.max(P.r * 2.3, 1.1),
      });
    }
    if (ctx.syncFocusSelect) ctx.syncFocusSelect(sim.focusName);
  }

  const tour = new Tour({
    focusBody,
    rig,
    setSpeedDps: v => wires.setSpeedDps(v),
    getSpeedDps: () => sim.speedDps,
    onEnd: () => { rig.driftRate = 0.008; },
  });
  ctx.tour = tour;

  const wires = installApi(ctx);

  rig.onUserInput = () => {
    tour.cancel(true);
    rig.driftRate = 0;
  };

  /* --------------------------------------------------------------- tapping */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hits = [];
  rig.onTap = (px, py, isDouble) => {
    ndc.set((px / window.innerWidth) * 2 - 1, -(py / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    hits.length = 0;
    raycaster.intersectObjects(system.hitMeshes, false, hits);
    if (hits.length > 0) {
      focusBody(hits[0].object.userData.body, {});
    } else if (isDouble) {
      focusBody('Overview', {});
    }
  };

  /* re-arm the gentle cinematic drift whenever a flight completes untouched */
  let hadFlight = false;

  /* ------------------------------------------------------------ render loop */
  let last = performance.now();
  let rafId = 0;
  let frames = 0;

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    tour.update(dt);
    if (hadFlight && !rig.flight && !tour.active) {
      rig.driftRate = sim.focusName === 'Overview' ? 0.008 : 0.02;
    }
    hadFlight = !!rig.flight;
    rig.update(dt);

    if (!sim.paused) sim.tDays += dt * sim.speedDps;
    system.update(sim.tDays, now / 1000);
    system.updateLabels(sim.focusName, camera);

    renderer.render(scene, camera);

    if (frames < 2 && ++frames === 2) {
      resolveReady(true);
      document.getElementById('veil').classList.add('gone');
    }
  }
  rafId = requestAnimationFrame(loop);

  /* park the loop while hidden — no rendering, no time advance */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    } else if (!rafId) {
      last = performance.now();
      rafId = requestAnimationFrame(loop);
    }
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  setTimeout(() => { const h = document.getElementById('hud'); if (h) h.style.opacity = '0'; }, 9000);

  /* start with the slow establishing drift going, like a planetarium at rest */
  rig.driftRate = 0.008;
}
