/* Solar System · api — DOM control wiring + the FlowVid contract (window.SolarSim).
   set() drives the real DOM controls and lets their listeners do the work, so
   programmatic state and visible UI can never disagree (orbit-lab pattern). */

const $ = id => document.getElementById(id);

/* #speed is a log-scale slider: 0 → 0.05 days/s (~1.2 h/s), 1 → 36.5 days/s (1 yr / 10 s). */
const SPEED_MIN = 0.05, SPEED_MAX = 36.5;
const L0 = Math.log10(SPEED_MIN), L1 = Math.log10(SPEED_MAX);

export const sliderToDps = v => Math.pow(10, L0 + (L1 - L0) * v);
export const dpsToSlider = d => (Math.log10(Math.min(SPEED_MAX, Math.max(SPEED_MIN, d))) - L0) / (L1 - L0);

function fmtSpeed(dps) {
  if (dps >= 36.4) return '1 yr / 10 s';
  if (dps < 1) return `${(dps * 24).toFixed(1)} hr/s`;
  return `${dps.toFixed(1)} d/s`;
}

/**
 * deps: { sim, rig, tour, system, focusBody(name, opts), resetView() }
 * sim: { tDays, speedDps, paused, focusName }
 */
export function installApi(deps) {
  const { sim, rig, tour, system, focusBody } = deps;
  const speedEl = $('speed'), focusEl = $('focus');
  const labelsEl = $('labels'), orbitsEl = $('orbits');
  const out = $('speed-out');

  /* ------------------------------------------------ DOM → state (listeners) */

  const applySpeed = () => {
    sim.speedDps = sliderToDps(parseFloat(speedEl.value));
    out.textContent = fmtSpeed(sim.speedDps);
  };
  speedEl.addEventListener('input', applySpeed);
  applySpeed();

  focusEl.addEventListener('change', () => focusBody(focusEl.value, {}));

  labelsEl.addEventListener('change', () => system.setLabels(labelsEl.checked));
  orbitsEl.addEventListener('change', () => system.setOrbits(orbitsEl.checked));

  $('tour').addEventListener('click', () => tour.start());
  $('reset').addEventListener('click', () => api.reset());

  /* Keep the select honest when focus changes by tap or tour.
     (The Moon is tappable but has no select entry — leave the select alone then.) */
  deps.syncFocusSelect = name => {
    for (const o of focusEl.options) {
      if (o.value === name) { focusEl.value = name; return; }
    }
  };

  /* ----------------------------------------------------------- the contract */

  const setSpeedDps = d => {
    speedEl.value = String(dpsToSlider(d));
    speedEl.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const api = {
    ready: window.__flowvidReadyForPresent,

    focus(name) { focusBody(name, {}); },

    tour() { tour.start(); },

    set(p) {
      if (!p) return;
      if (p.speed != null) setSpeedDps(+p.speed);
      if (p.labels != null && labelsEl.checked !== !!p.labels) {
        labelsEl.checked = !!p.labels;
        labelsEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (p.orbits != null && orbitsEl.checked !== !!p.orbits) {
        orbitsEl.checked = !!p.orbits;
        orbitsEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (p.focus != null) focusBody(String(p.focus), {});
    },

    reset() {
      tour.cancel(false);
      sim.tDays = 0;
      sim.paused = false;
      setSpeedDps(sliderToDps(0.6));
      if (!labelsEl.checked) { labelsEl.checked = true; labelsEl.dispatchEvent(new Event('change', { bubbles: true })); }
      if (!orbitsEl.checked) { orbitsEl.checked = true; orbitsEl.dispatchEvent(new Event('change', { bubbles: true })); }
      focusBody('Overview', { dur: 1.6 });
    },

    pause() { sim.paused = true; },
    play() { sim.paused = false; },

    getState() {
      return {
        speed: Math.round(sim.speedDps * 1000) / 1000,
        labels: labelsEl.checked,
        orbits: orbitsEl.checked,
        focus: sim.focusName,
        paused: sim.paused,
        touring: tour.active,
        tDays: Math.round(sim.tDays * 100) / 100,
        camera: {
          x: Math.round(rig.camera.position.x * 100) / 100,
          y: Math.round(rig.camera.position.y * 100) / 100,
          z: Math.round(rig.camera.position.z * 100) / 100,
        },
      };
    },
  };

  window.SolarSim = api;
  return { api, setSpeedDps, getSpeedDps: () => sim.speedDps };
}
