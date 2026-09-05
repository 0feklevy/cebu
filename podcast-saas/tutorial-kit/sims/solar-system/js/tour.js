/* Solar System · tour — the cinematic auto-tour (also FlowVid's auto-script).
   Five stops with eased flights, slow camera drift while dwelling, and a
   per-stop time-lapse so close-ups rotate majestically instead of strobing.
   The visitor's own speed setting is restored when the tour ends. */

/* Earth/Jupiter arrivals use main's automatic terminator-facing angle; Saturn and
   Uranus use their ring-opening hints — so no theta choreography is needed here. */
export const TOUR_STOPS = [
  { name: 'Overview', speed: 3.2, dur: 2.2, dwell: 3.2, drift: 0.03, phi: 1.08 },
  { name: 'Sun', speed: 0.5, dur: 2.4, dwell: 3.0, drift: 0.06, phi: 1.38 },
  { name: 'Earth', speed: 0.05, dur: 2.6, dwell: 4.4, drift: 0.055, phi: 1.22 },
  { name: 'Saturn', speed: 0.05, dur: 2.8, dwell: 4.4, drift: 0.05 },
  { name: 'Jupiter', speed: 0.07, dur: 2.6, dwell: 4.2, drift: -0.05, phi: 1.6 },
];

export class Tour {
  /** deps: { focusBody(name, opts), setSpeedDps(v), getSpeedDps(), rig, onEnd() } */
  constructor(deps) {
    this.d = deps;
    this.active = false;
    this._i = 0;
    this._timer = 0;
    this._phase = 'idle';
    this._savedSpeed = null;
  }

  start() {
    this._savedSpeed = this.d.getSpeedDps();
    this.active = true;
    this._i = -1;
    this._next();
  }

  cancel(restoreSpeed = true) {
    if (!this.active) return;
    this.active = false;
    this._phase = 'idle';
    this.d.rig.driftRate = 0;
    if (restoreSpeed && this._savedSpeed != null) this.d.setSpeedDps(this._savedSpeed);
    this._savedSpeed = null;
  }

  _next() {
    this._i++;
    if (this._i >= TOUR_STOPS.length) {
      /* the ride home */
      this._phase = 'home';
      this._timer = 0;
      this.d.rig.driftRate = 0;
      this.d.focusBody('Overview', { dur: 2.6 });
      if (this._savedSpeed != null) this.d.setSpeedDps(this._savedSpeed);
      return;
    }
    const s = TOUR_STOPS[this._i];
    this._phase = 'go';
    this._timer = 0;
    this.d.setSpeedDps(s.speed);
    this.d.rig.driftRate = 0;
    this.d.focusBody(s.name, { dur: s.dur, phi: s.phi, thetaDelta: s.thetaDelta || 0 });
  }

  update(dt) {
    if (!this.active) return;
    const s = TOUR_STOPS[Math.min(this._i, TOUR_STOPS.length - 1)];
    this._timer += dt;
    if (this._phase === 'go') {
      if (!this.d.rig.flight) {                     // arrived — dwell and drift
        this._phase = 'dwell';
        this._timer = 0;
        this.d.rig.driftRate = s.drift || 0;
      }
    } else if (this._phase === 'dwell') {
      if (this._timer >= s.dwell) this._next();
    } else if (this._phase === 'home') {
      if (!this.d.rig.flight) {
        this.active = false;
        this._phase = 'idle';
        this._savedSpeed = null;
        if (this.d.onEnd) this.d.onEnd();
      }
    }
  }
}
