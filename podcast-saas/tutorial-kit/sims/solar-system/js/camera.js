/* Solar System · camera — a touch-first orbit rig with eased flights and follow.
   Drag = orbit, wheel/pinch = clamped zoom, tap = handled by main via onTap.
   No per-frame allocations: every vector below is preallocated. */

import * as THREE from '../vendor/three.module.js';

const EASE = t => t * t * t * (t * (t * 6 - 15) + 10);       // smootherstep
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export const OVERVIEW = { dist: 336, phi: 1.13, theta: -0.62 };

export class CameraRig {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;
    this.target = new THREE.Vector3(0, 0, 0);
    this.theta = OVERVIEW.theta;
    this.phi = OVERVIEW.phi;
    this.dist = OVERVIEW.dist;
    this.zoomTo = this.dist;
    this.minDist = 24;
    this.maxDist = 1400;
    this.followAnchor = null;               // Object3D whose world position we track
    this.followName = null;
    this.flight = null;
    this.driftRate = 0;                     // slow cinematic theta drift (rad/s)
    this.vTheta = 0; this.vPhi = 0;         // release inertia
    this.onTap = null;                      // (bodyName|null, isDouble) => {}
    this.onUserInput = null;                // any direct manipulation => {}

    /* preallocated temps */
    this._toT = new THREE.Vector3();
    this._fromT = new THREE.Vector3();
    this._wp = new THREE.Vector3();

    this._pointers = new Map();
    this._drag = null;
    this._pinch0 = 0; this._pinchDist0 = 0;
    this._lastTap = { t: -1e9, x: 0, y: 0 };

    canvas.addEventListener('pointerdown', e => this._down(e));
    canvas.addEventListener('pointermove', e => this._move(e));
    canvas.addEventListener('pointerup', e => this._up(e));
    canvas.addEventListener('pointercancel', e => this._cancel(e));
    canvas.addEventListener('wheel', e => this._wheel(e), { passive: false });
  }

  /* ------------------------------------------------------------ pointer io */

  _down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 1) {
      this._drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
      this.canvas.classList.add('dragging');
    } else if (this._pointers.size === 2) {
      const [a, b] = [...this._pointers.values()];
      this._pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      this._pinchDist0 = this.zoomTo;
      this._drag = null;
    }
    this.vTheta = 0; this.vPhi = 0;
    if (this.flight) this.flight.userSteer = true;
    if (this.onUserInput) this.onUserInput();
  }

  _move(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this._pointers.size === 2) {
      const [a, b] = [...this._pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this._pinch0 > 0 && d > 0) {
        this.zoomTo = clamp(this._pinchDist0 * (this._pinch0 / d), this.minDist, this.maxDist);
      }
      return;
    }
    if (!this._drag) return;
    this._drag.moved += Math.abs(dx) + Math.abs(dy);
    const k = 0.0048;
    this.theta -= dx * k;
    this.phi = clamp(this.phi - dy * k, 0.12, Math.PI - 0.12);
    this.vTheta = -dx * k * 60; this.vPhi = -dy * k * 60;
  }

  _up(e) {
    const wasDrag = this._drag;
    this._pointers.delete(e.pointerId);
    if (this._pointers.size === 1) {
      /* pinch → single drag: re-anchor the surviving pointer */
      const [rest] = [...this._pointers.values()];
      this._drag = { x: rest.x, y: rest.y, t: performance.now(), moved: 99 };
      return;
    }
    if (this._pointers.size > 0) return;
    this.canvas.classList.remove('dragging');
    this._drag = null;
    if (!wasDrag) return;
    const dt = performance.now() - wasDrag.t;
    if (dt < 380 && wasDrag.moved < 9) {
      const now = performance.now();
      const isDouble = (now - this._lastTap.t) < 330 &&
        Math.hypot(e.clientX - this._lastTap.x, e.clientY - this._lastTap.y) < 44;
      this._lastTap = { t: isDouble ? -1e9 : now, x: e.clientX, y: e.clientY };
      if (this.onTap) this.onTap(e.clientX, e.clientY, isDouble);
      this.vTheta = 0; this.vPhi = 0;
    }
  }

  _cancel(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size === 0) { this._drag = null; this.canvas.classList.remove('dragging'); }
  }

  _wheel(e) {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 0.033 : 0.00105;
    this.zoomTo = clamp(this.zoomTo * Math.exp(e.deltaY * k), this.minDist, this.maxDist);
    if (this.onUserInput) this.onUserInput();
  }

  /* -------------------------------------------------------------- commands */

  /** Eased flight to a body (anchor) or to the overview (anchor = null). */
  flyTo(anchor, name, { dist, phi, theta, dur = 2.0, minD } = {}) {
    this._fromT.copy(this.target);
    this.flight = {
      t: 0, dur,
      anchor,
      fromDist: this.dist, toDist: dist ?? this.dist,
      fromPhi: this.phi, toPhi: phi ?? this.phi,
      fromTheta: this.theta,
      toTheta: theta ?? this.theta,
      userSteer: false,
    };
    /* shortest way around for theta */
    let d = this.flight.toTheta - this.flight.fromTheta;
    d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.flight.toTheta = this.flight.fromTheta + d;
    this.followAnchor = anchor;
    this.followName = name;
    this.minDist = minD ?? 24;
  }

  overview(dur = 2.0) {
    this.flyTo(null, 'Overview', { dist: OVERVIEW.dist, phi: OVERVIEW.phi, dur });
  }

  /* ---------------------------------------------------------------- update */

  update(dt) {
    const F = this.flight;
    if (F) {
      F.t += dt / F.dur;
      const e = EASE(clamp(F.t, 0, 1));
      if (F.anchor) F.anchor.getWorldPosition(this._toT); else this._toT.set(0, 0, 0);
      this.target.lerpVectors(this._fromT, this._toT, e);
      this.dist = Math.exp(THREE.MathUtils.lerp(Math.log(F.fromDist), Math.log(F.toDist), e));
      this.zoomTo = this.dist;
      if (!F.userSteer) {
        this.phi = THREE.MathUtils.lerp(F.fromPhi, F.toPhi, e);
        this.theta = THREE.MathUtils.lerp(F.fromTheta, F.toTheta, e);
      }
      if (F.t >= 1) this.flight = null;
    } else {
      if (this.followAnchor) {
        this.followAnchor.getWorldPosition(this.target);
      }
      /* damped zoom */
      const zk = 1 - Math.exp(-dt * 7);
      this.dist += (this.zoomTo - this.dist) * zk;
      /* release inertia */
      if (!this._drag && (Math.abs(this.vTheta) > 1e-4 || Math.abs(this.vPhi) > 1e-4)) {
        this.theta += this.vTheta * dt;
        this.phi = clamp(this.phi + this.vPhi * dt, 0.12, Math.PI - 0.12);
        const decay = Math.exp(-dt * 4.2);
        this.vTheta *= decay; this.vPhi *= decay;
      }
      /* cinematic drift */
      if (this.driftRate !== 0) this.theta += this.driftRate * dt;
    }

    const sp = Math.sin(this.phi), cp = Math.cos(this.phi);
    this.camera.position.set(
      this.target.x + this.dist * sp * Math.cos(this.theta),
      this.target.y + this.dist * cp,
      this.target.z + this.dist * sp * Math.sin(this.theta),
    );
    this.camera.lookAt(this.target);
  }
}
