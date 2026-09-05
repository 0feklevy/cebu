#!/usr/bin/env node
// ---------------------------------------------------------------------------
// synthesize.mjs — ORIGINAL music beds for the five FlowVid tutorial films
//
// v2 — the "driving" rework. The owner rejected the v1 ambient-pad beds as
// wallpaper; these are rebuilt from scratch for modern, kinetic US-SaaS-ad
// energy: a four-on-the-floor synthesized kick, sidechain-style pumping pads,
// punchy filtered saw pulses, moving 8th-note basslines, tight synthesized
// claps/hats/ticks, noise risers into section lifts, and hard button endings
// (no fade-outs on the driving beds).
//
// Every sound is synthesized from first principles at render time: sine and
// polyBLEP-saw oscillators, seeded-PRNG noise, Karplus-Strong plucked strings
// (excited by seeded noise), biquad/one-pole/state-variable filters, a
// ping-pong feedback delay and tanh saturation. There are NO samples, NO
// third-party loops or presets, and NO quoted melodies — all chord material is
// generic diatonic progression + procedurally chosen chord-tone riffs.
// License-clean by construction; commercial use unrestricted.
//
// Loudness: each bed measures itself with an internal ITU-R BS.1770-4
// integrated-loudness meter (K-weighting + gating) and normalizes to
// -27 LUFS integrated; true peak stays far below -2 dBTP (verify with
// ffmpeg ebur128). Rendering is deterministic: same script -> same bytes.
//
// Usage:
//   node synthesize.mjs                    # render the five beds
//   node synthesize.mjs teaser powers      # a subset
//   node synthesize.mjs sting              # legacy ambient sting ONLY when
//                                          # explicitly asked (the shipped
//                                          # sting-ambient.wav is kept as-is)
//   node synthesize.mjs --outdir=/tmp/x    # render elsewhere (verification)
//
// Output: 48 kHz / stereo / 24-bit WAV next to this script, encoded by piping
// raw float32 PCM into ffmpeg (node stdlib only on the synthesis side).
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const TAU = Math.PI * 2;
const DIR = path.dirname(fileURLToPath(import.meta.url));

const TARGET_LUFS = -27; // beds: integrated, per ffmpeg ebur128 (±1 window)

// Per-track reconciliation trim (dB) applied after the internal BS.1770
// normalize, in case ffmpeg's meter disagrees with ours by more than ~0.3 LU.
// Calibrated against ffmpeg 8.1.2; keep at 0 unless measurement says otherwise.
const TRIM_DB = {
  'bed-teaser': 0,
  'bed-tutorial': 0,
  'bed-heavy': 0,
  'bed-powers': 0,
  'bed-share': 0,
};

function ffmpegBin() {
  for (const c of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (existsSync(c)) return c;
  }
  return 'ffmpeg';
}
const FFMPEG = ffmpegBin();

// --------------------------------------------------------------- helpers ---

const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C3' | 'F#2' | 'Bb1' -> frequency in Hz (A4 = 440, C4 = middle C). */
function hz(note) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(note);
  if (!m) throw new Error(`bad note: ${note}`);
  const s = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * 2 ** ((s + (Number(m[3]) + 1) * 12 - 69) / 12);
}
const cents = (f, c) => f * 2 ** (c / 1200);
const m2f = (m) => 440 * 2 ** ((m - 69) / 12);

/** Deterministic xorshift32 PRNG seeded from a string (FNV-1a). */
function makeRng(seedStr) {
  let s = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    s ^= seedStr.charCodeAt(i);
    s = Math.imul(s, 16777619) >>> 0;
  }
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** polyBLEP residual for an alias-suppressed sawtooth. */
function polyblep(t, dt) {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

/** Equal-power pan: pan in [-1, 1] -> [gainL, gainR]. */
function panLR(pan) {
  const a = (Math.max(-1, Math.min(1, pan)) + 1) * Math.PI / 4;
  return [Math.cos(a), Math.sin(a)];
}

/** RBJ biquad coefficients (normalized, a0 divided out). */
function bqCoef(type, f0, Q) {
  const w = TAU * f0 / SR, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * Q);
  let b0, b1, b2;
  const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; }
  else throw new Error('bq type');
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function runBiquad(X, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < X.length; i++) {
    const x = X[i];
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    X[i] = y;
  }
}

// ------------------------------------------------------------ bus layer ---

function makeBuses(N) {
  const mk = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
  return { drums: mk(), bass: mk(), pulse: mk(), pad: mk(), lead: mk(), fx: mk() };
}

function filterBus(bus, type, f0, Q) {
  const c = bqCoef(type, f0, Q);
  runBiquad(bus.L, c);
  runBiquad(bus.R, c);
}

/** Sidechain gain curve: dips at every kick, recovers with a pump curve. */
function buildDuckEnv(N, kicks, { depth = 0.7, dip = 0.006, hold = 0.025, rel = 0.26 } = {}) {
  const env = new Float32Array(N).fill(1);
  const total = dip + hold + rel;
  for (const kt of kicks) {
    const i0 = Math.max(0, Math.round(kt * SR));
    const i1 = Math.min(N, Math.round((kt + total) * SR));
    for (let i = i0; i < i1; i++) {
      const tl = (i - i0) / SR;
      let g;
      if (tl < dip) g = 1 - depth * (tl / dip);
      else if (tl < dip + hold) g = 1 - depth;
      else { const x = (tl - dip - hold) / rel; g = 1 - depth + depth * Math.pow(x, 1.6); }
      if (g < env[i]) env[i] = g;
    }
  }
  return env;
}

function applyDuck(bus, env, amount) {
  if (amount <= 0) return;
  const N = bus.L.length;
  for (let i = 0; i < N; i++) {
    const g = 1 - amount * (1 - env[i]);
    bus.L[i] *= g;
    bus.R[i] *= g;
  }
}

/** Hard-stop a bus at time t with a short declick ramp (arrangement mute). */
function muteBusAfter(bus, t, ramp = 0.06) {
  const N = bus.L.length;
  const i0 = Math.max(0, Math.round(t * SR));
  const nr = Math.max(1, Math.round(ramp * SR));
  for (let i = i0; i < N; i++) {
    const g = i < i0 + nr ? 1 - (i - i0) / nr : 0;
    bus.L[i] *= g;
    bus.R[i] *= g;
  }
}

// ---------------------------------------------------------- percussion ---

/** Punchy synthesized kick: pitch-swept sine through tanh + noise click. */
function kick(ctx, t, o = {}) {
  const {
    level = 0.9, fStart = 165, fEnd = 45, pitchTau = 0.03,
    ampTau = 0.2, drive = 2.0, clickLvl = 0.45, bus = ctx.buses.drums,
  } = o;
  ctx.kicks.push(t);
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t * SR));
  const i1 = Math.min(L.length, i0 + Math.floor(0.42 * SR));
  const rng = makeRng('kick:' + t.toFixed(4));
  let p = 0, hpS = 0;
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    const f = fEnd + (fStart - fEnd) * Math.exp(-tl / pitchTau);
    p += f / SR;
    const env = Math.min(1, tl / 0.0012) * Math.exp(-tl / ampTau);
    let s = Math.tanh(drive * Math.sin(TAU * p)) * env;
    if (tl < 0.006 && clickLvl > 0) {
      const w = rng() * 2 - 1;
      hpS += 0.35 * (w - hpS);
      s += (w - hpS) * clickLvl * Math.exp(-tl / 0.0018);
    }
    s *= level;
    L[i] += s * 0.7071;
    R[i] += s * 0.7071;
  }
}

/** Classic multi-burst synthesized clap; `snap` preset = softer/rounder. */
function clap(ctx, t, o = {}) {
  const {
    level = 0.5, tone = 1250, q = 1.2, bursts = [0, 0.012, 0.024],
    tailAt = 0.03, tailTau = 0.1, decayTau = 0.0075, bus = ctx.buses.drums,
  } = o;
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t * SR));
  const i1 = Math.min(L.length, i0 + Math.floor(0.4 * SR));
  const rng = makeRng('clap:' + t.toFixed(4) + ':' + tone);
  const jb = bursts.map((b, k) => (k === 0 ? 0 : b + (rng() * 0.004 - 0.002)));
  const cl = bqCoef('bp', tone * 0.97, q);
  const cr = bqCoef('bp', tone * 1.04, q);
  let x1l = 0, x2l = 0, y1l = 0, y2l = 0, x1r = 0, x2r = 0, y1r = 0, y2r = 0;
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    let env = 0;
    for (const b of jb) if (tl >= b) env = Math.max(env, Math.exp(-(tl - b) / decayTau));
    if (tl >= tailAt) env = Math.max(env, 0.72 * Math.exp(-(tl - tailAt) / tailTau));
    const w = (rng() * 2 - 1) * env;
    let y = cl.b0 * w + cl.b1 * x1l + cl.b2 * x2l - cl.a1 * y1l - cl.a2 * y2l;
    x2l = x1l; x1l = w; y2l = y1l; y1l = y;
    L[i] += y * level * 2.1;
    y = cr.b0 * w + cr.b1 * x1r + cr.b2 * x2r - cr.a1 * y1r - cr.a2 * y2r;
    x2r = x1r; x1r = w; y2r = y1r; y1r = y;
    R[i] += y * level * 2.1;
  }
}

const snap = (ctx, t, o = {}) => clap(ctx, t, {
  tone: 1750, q: 1.0, bursts: [0, 0.01], tailAt: 0.016, tailTau: 0.05,
  level: 0.32, ...o,
});

/** Hi-hat: seeded noise through steep highpass; open = longer decay. */
function hat(ctx, t, o = {}) {
  const {
    level = 0.18, decay = 0.028, hpf = 8000, pan = 0, open = false,
    bus = ctx.buses.drums,
  } = o;
  const dTau = open ? (o.openDecay ?? 0.15) : decay;
  const span = open ? 0.55 : 0.1;
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t * SR));
  const i1 = Math.min(L.length, i0 + Math.floor(span * SR));
  const rng = makeRng('hat:' + t.toFixed(4) + (open ? 'o' : 'c'));
  const c = bqCoef('hp', hpf, 0.75);
  const [gl, gr] = panLR(pan);
  const lvl = level * (0.92 + 0.16 * rng());
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, hp1 = 0;
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    const env = Math.min(1, tl / 0.0008) * Math.exp(-tl / dTau);
    const w = rng() * 2 - 1;
    hp1 += 0.45 * (w - hp1);
    const x = w - hp1;
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    const s = y * env * lvl * 1.6;
    L[i] += s * gl;
    R[i] += s * gr;
  }
}

/** Shaker hit: band-noise with a soft swell into each hit ("shh-t"). */
function shakerHit(ctx, t, o = {}) {
  const { level = 0.07, pan = 0.22, bus = ctx.buses.drums } = o;
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t * SR));
  const i1 = Math.min(L.length, i0 + Math.floor(0.07 * SR));
  const rng = makeRng('shk:' + t.toFixed(4));
  const c = bqCoef('bp', 6200, 0.9);
  const [gl, gr] = panLR(pan);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    const env = Math.min(1, tl / 0.011) * Math.exp(-tl / 0.021);
    const w = rng() * 2 - 1;
    const y = c.b0 * w + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = w; y2 = y1; y1 = y;
    const s = y * env * level * 2.4;
    L[i] += s * gl;
    R[i] += s * gr;
  }
}

/** Tight percussive tick: band-noise click + tiny sine ping. */
function tickHit(ctx, t, o = {}) {
  const { level = 0.12, tone = 2600, pan = 0, bus = ctx.buses.drums } = o;
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t * SR));
  const i1 = Math.min(L.length, i0 + Math.floor(0.05 * SR));
  const rng = makeRng('tick:' + t.toFixed(4));
  const c = bqCoef('bp', tone, 3);
  const [gl, gr] = panLR(pan);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, p = 0;
  const dt = tone * 0.68 / SR;
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    const w = rng() * 2 - 1;
    const y = c.b0 * w + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = w; y2 = y1; y1 = y;
    p += dt;
    const s = (y * 2.6 * Math.exp(-tl / 0.007)
      + Math.sin(TAU * p) * 0.5 * Math.exp(-tl / 0.012)) * level;
    L[i] += s * gl;
    R[i] += s * gr;
  }
}

/** Downbeat impact: low sine drop + lowpassed noise splash. */
function impact(ctx, t, o = {}) {
  const { level = 0.5, bus = ctx.buses.drums } = o;
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t * SR));
  const i1 = Math.min(L.length, i0 + Math.floor(1.1 * SR));
  const rng = makeRng('imp:' + t.toFixed(4));
  let p = 0, lp = 0;
  const aLp = 1 - Math.exp(-TAU * 750 / SR);
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    const f = 38 + 20 * Math.exp(-tl / 0.12);
    p += f / SR;
    const sub = Math.tanh(1.6 * Math.sin(TAU * p)) * Math.exp(-tl / 0.42);
    const w = rng() * 2 - 1;
    lp += aLp * (w - lp);
    const splash = lp * Math.exp(-tl / 0.1) * 0.9;
    const s = (sub * 0.85 + splash) * Math.min(1, tl / 0.002) * level;
    L[i] += s * 0.7071;
    R[i] += s * 0.7071;
  }
}

/** Accelerating tick roll (intro fills). */
function tickRoll(ctx, t0, dur, eighth, o = {}) {
  const { startLvl = 0.05, endLvl = 0.28 } = o;
  let t = 0;
  while (t < dur - 0.01) {
    const x = t / dur;
    const step = x < 0.5 ? eighth : x < 0.8 ? eighth / 2 : eighth / 4;
    tickHit(ctx, t0 + t, {
      level: startLvl + (endLvl - startLvl) * Math.pow(x, 1.4),
      tone: 2300 + 2100 * x,
      pan: (Math.floor(t / step) % 2 ? 0.25 : -0.25),
    });
    t += step;
  }
}

// ------------------------------------------------------------ tonal ---

/** Driving mono bass note: polyBLEP saw + sine fundamental, LP env, tanh. */
function bassNote(ctx, t, dur, midi, o = {}) {
  const {
    level = 0.5, cutoff = 650, envAmt = 2.4, drive = 1.7, subMix = 0.42,
    accent = 1, bus = ctx.buses.bass,
  } = o;
  const f = m2f(midi);
  const dt = f / SR;
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t * SR));
  const i1 = Math.min(L.length, Math.round((t + dur + 0.06) * SR));
  let p = 0, lp1 = 0, lp2 = 0;
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    let env = Math.min(1, tl / 0.004) * Math.exp(-tl / 0.7);
    if (tl > dur) env *= Math.exp(-(tl - dur) / 0.03);
    p += dt; if (p >= 1) p -= 1;
    const saw = 2 * p - 1 - polyblep(p, dt);
    const fc = Math.min(6000, cutoff * (1 + envAmt * Math.exp(-tl / 0.045)));
    const a = 1 - Math.exp(-TAU * fc / SR);
    lp1 += a * (saw - lp1);
    lp2 += a * (lp1 - lp2);
    const s = Math.tanh(drive * (lp2 + subMix * Math.sin(TAU * p))) * env * level * accent;
    L[i] += s * 0.7071;
    R[i] += s * 0.7071;
  }
}

/** Punchy filtered chord stab: detuned saws (L/R spread), LP env, tanh. */
function stab(ctx, t, dur, midis, o = {}) {
  const {
    level = 0.3, cutoff = 1500, detune = 9, decayTau = 0.11, sustain = 0.22,
    drive = 1.15, pan = 0, envOpen = 1.8, bus = ctx.buses.pulse,
  } = o;
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t * SR));
  const i1 = Math.min(L.length, Math.round((t + dur + 0.12) * SR));
  const n = midis.length;
  const dtl = new Float64Array(n), dtr = new Float64Array(n);
  const pl = new Float64Array(n), pr = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const f = m2f(midis[k]);
    dtl[k] = cents(f, detune) / SR;
    dtr[k] = cents(f, -detune) / SR;
    pl[k] = (k * 0.31) % 1;
    pr[k] = (k * 0.47 + 0.19) % 1;
  }
  const norm = level / Math.sqrt(n);
  const [gl, gr] = panLR(pan);
  let l1 = 0, l2 = 0, r1 = 0, r2 = 0;
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    let env = Math.min(1, tl / 0.0025) * (sustain + (1 - sustain) * Math.exp(-tl / decayTau));
    if (tl > dur) env *= Math.exp(-(tl - dur) / 0.02);
    let xl = 0, xr = 0;
    for (let k = 0; k < n; k++) {
      pl[k] += dtl[k]; if (pl[k] >= 1) pl[k] -= 1;
      pr[k] += dtr[k]; if (pr[k] >= 1) pr[k] -= 1;
      xl += 2 * pl[k] - 1 - polyblep(pl[k], dtl[k]);
      xr += 2 * pr[k] - 1 - polyblep(pr[k], dtr[k]);
    }
    const fc = Math.min(9000, cutoff * (1 + envOpen * Math.exp(-tl / 0.02)));
    const a = 1 - Math.exp(-TAU * fc / SR);
    l1 += a * (xl - l1); l2 += a * (l1 - l2);
    r1 += a * (xr - r1); r2 += a * (r1 - r2);
    L[i] += Math.tanh(drive * l2) * env * norm * gl * 1.35;
    R[i] += Math.tanh(drive * r2) * env * norm * gr * 1.35;
  }
}

/** Pump pad: detuned saw chord, quick attack — the duck does the shaping. */
function pad2(ctx, t0, dur, midis, o = {}) {
  const {
    level = 0.24, cutoff = 900, detune = 7, attack = 0.05, release = 0.3,
    bus = ctx.buses.pad,
  } = o;
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t0 * SR));
  const i1 = Math.min(L.length, Math.round((t0 + dur + release) * SR));
  const rng = makeRng('pad:' + t0.toFixed(3) + ':' + midis.join('.'));
  const n = midis.length;
  const dtl = new Float64Array(n), dtr = new Float64Array(n);
  const pl = new Float64Array(n), pr = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const f = m2f(midis[k]);
    const det = detune * (0.7 + 0.6 * rng());
    dtl[k] = cents(f, det) / SR;
    dtr[k] = cents(f, -det) / SR;
    pl[k] = rng(); pr[k] = rng();
  }
  const a = 1 - Math.exp(-TAU * Math.min(cutoff, 6000) / SR);
  const norm = level / Math.sqrt(n);
  let l1 = 0, l2 = 0, r1 = 0, r2 = 0;
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    let env;
    if (tl < attack) env = tl / attack;
    else if (tl <= dur) env = 1;
    else { const x = (tl - dur) / release; env = x >= 1 ? 0 : (1 - x) * (1 - x); }
    if (env <= 0) continue;
    let xl = 0, xr = 0;
    for (let k = 0; k < n; k++) {
      pl[k] += dtl[k]; if (pl[k] >= 1) pl[k] -= 1;
      pr[k] += dtr[k]; if (pr[k] >= 1) pr[k] -= 1;
      xl += 2 * pl[k] - 1 - polyblep(pl[k], dtl[k]);
      xr += 2 * pr[k] - 1 - polyblep(pr[k], dtr[k]);
    }
    l1 += a * (xl - l1); l2 += a * (l1 - l2);
    r1 += a * (xr - r1); r2 += a * (r1 - r2);
    L[i] += l2 * env * norm;
    R[i] += r2 * env * norm;
  }
}

/** Karplus-Strong pluck excited by seeded noise. Deterministic per (t, midi). */
function ks(ctx, t, midi, o = {}) {
  const {
    level = 0.22, decayS = 0.9, bright = 0.55, pan = 0, rho = 0.9965,
    bus = ctx.buses.lead,
  } = o;
  const f = m2f(midi);
  const n = Math.max(2, Math.round(SR / f));
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t * SR));
  const span = Math.min(2.4, decayS * 3.5);
  const i1 = Math.min(L.length, i0 + Math.floor(span * SR));
  const rng = makeRng('ks:' + t.toFixed(4) + ':' + midi);
  const buf = new Float64Array(n);
  let pv = 0;
  for (let j = 0; j < n; j++) {
    const w = rng() * 2 - 1;
    pv += bright * (w - pv);
    buf[j] = pv;
  }
  const [gl, gr] = panLR(pan);
  let idx = 0;
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    const out = buf[idx];
    const nxt = idx + 1 < n ? idx + 1 : 0;
    buf[idx] = rho * 0.5 * (out + buf[nxt]);
    idx = nxt;
    const env = Math.min(1, tl / 0.001) * Math.exp(-tl / decayS);
    const s = out * env * level * 1.7;
    L[i] += s * gl;
    R[i] += s * gr;
  }
}

/** Staggered KS chord strum. */
function strum(ctx, t, midis, o = {}) {
  const { stagger = 0.014, panSpread = 0.5 } = o;
  for (let k = 0; k < midis.length; k++) {
    ks(ctx, t + k * stagger, midis[k], {
      ...o,
      level: (o.level ?? 0.2) / Math.sqrt(midis.length) * 1.5,
      pan: (k / Math.max(1, midis.length - 1) - 0.5) * 2 * panSpread,
    });
  }
}

/** Playful sine "bloop": quick upward glide, short ring. */
function bloop(ctx, t, m0, m1, o = {}) {
  const { level = 0.12, pan = 0.2, glide = 0.08, bus = ctx.buses.lead } = o;
  const f0 = m2f(m0), f1 = m2f(m1);
  const L = bus.L, R = bus.R;
  const i0 = Math.max(0, Math.round(t * SR));
  const i1 = Math.min(L.length, i0 + Math.floor(0.5 * SR));
  const [gl, gr] = panLR(pan);
  let p = 0;
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    const x = Math.min(1, tl / glide);
    const f = f0 * Math.pow(f1 / f0, x);
    p += f / SR;
    const env = Math.min(1, tl / 0.005) * Math.exp(-tl / 0.16);
    const s = (Math.sin(TAU * p) + 0.22 * Math.sin(2 * TAU * p)) * env * level;
    L[i] += s * gl;
    R[i] += s * gr;
  }
}

/** Noise riser sweeping up into tEnd (state-variable bandpass). */
function riser(ctx, tEnd, dur, o = {}) {
  const {
    level = 0.4, f0 = 300, f1 = 6200, q = 1.2, curve = 2.2, bus = ctx.buses.fx,
  } = o;
  const L = bus.L, R = bus.R;
  const t0 = Math.max(0, tEnd - dur);
  const i0 = Math.round(t0 * SR);
  const i1 = Math.min(L.length, Math.round(tEnd * SR));
  const rng = makeRng('rise:' + tEnd.toFixed(3));
  const q1 = 1 / q;
  let lp = 0, bp = 0;
  const declick = 128;
  for (let i = i0; i < i1; i++) {
    const x = (i - i0) / Math.max(1, i1 - i0);
    const fc = Math.min(7500, f0 * Math.pow(f1 / f0, x));
    const fk = 2 * Math.sin(Math.PI * fc / SR);
    const w = rng() * 2 - 1;
    lp += fk * bp;
    const hp = w - lp - q1 * bp;
    bp += fk * hp;
    let g = Math.pow(x, curve) * level;
    if (i1 - i <= declick) g *= (i1 - i) / declick;
    const s = bp * g * 0.8;
    L[i] += s * 0.7071;
    R[i] += s * 0.7071;
  }
}

/** Tonal riser: sine gliding up, swelling into tEnd. */
function toneRise(ctx, tEnd, dur, o = {}) {
  const { f0 = 220, f1 = 440, level = 0.1, pan = 0, bus = ctx.buses.fx } = o;
  const L = bus.L, R = bus.R;
  const t0 = Math.max(0, tEnd - dur);
  const i0 = Math.round(t0 * SR);
  const i1 = Math.min(L.length, Math.round(tEnd * SR));
  const [gl, gr] = panLR(pan);
  let p = 0;
  const declick = 96;
  for (let i = i0; i < i1; i++) {
    const x = (i - i0) / Math.max(1, i1 - i0);
    const f = f0 * Math.pow(f1 / f0, x);
    p += f / SR;
    let g = Math.pow(x, 2.4) * level;
    if (i1 - i <= declick) g *= (i1 - i) / declick;
    const s = (Math.sin(TAU * p) + 0.3 * Math.sin(TAU * p * 2 + 0.8)) * g;
    L[i] += s * gl;
    R[i] += s * gr;
  }
}

// ------------------------------------------------------------------- fx ---

/** Ping-pong feedback delay with damped cross-feedback. */
function pingPong(L, R, { time, feedback = 0.32, damp = 3000, wet = 0.16 }) {
  const N = L.length;
  const D = Math.max(1, Math.round(time * SR));
  const bl = new Float32Array(D);
  const br = new Float32Array(D);
  const a = 1 - Math.exp(-TAU * damp / SR);
  let fl = 0, fr = 0, idx = 0;
  for (let i = 0; i < N; i++) {
    const outL = bl[idx], outR = br[idx];
    const mono = (L[i] + R[i]) * 0.5;
    fl += a * (outR * feedback - fl);
    fr += a * (outL * feedback - fr);
    bl[idx] = mono + fl;
    br[idx] = fr;
    L[i] += outL * wet;
    R[i] += outR * wet;
    idx++; if (idx >= D) idx = 0;
  }
}

// -------------------------------------------------- loudness / mastering ---

/**
 * ITU-R BS.1770-4 integrated loudness (K-weighting + absolute/relative
 * gating) at 48 kHz. Returns LUFS.
 */
function integratedLufs(L, R) {
  const N = L.length;
  const pre = {
    b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285,
    a1: -1.69065929318241, a2: 0.73248077421585,
  };
  const rlb = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };
  const wsq = new Float64Array(N);
  for (const X of [L, R]) {
    let px1 = 0, px2 = 0, py1 = 0, py2 = 0;
    let qx1 = 0, qx2 = 0, qy1 = 0, qy2 = 0;
    for (let i = 0; i < N; i++) {
      const x = X[i];
      const y1 = pre.b0 * x + pre.b1 * px1 + pre.b2 * px2 - pre.a1 * py1 - pre.a2 * py2;
      px2 = px1; px1 = x; py2 = py1; py1 = y1;
      const y2 = rlb.b0 * y1 + rlb.b1 * qx1 + rlb.b2 * qx2 - rlb.a1 * qy1 - rlb.a2 * qy2;
      qx2 = qx1; qx1 = y1; qy2 = qy1; qy1 = y2;
      wsq[i] += y2 * y2;
    }
  }
  const cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + wsq[i];
  const win = Math.round(0.4 * SR), hop = Math.round(0.1 * SR);
  const msArr = [], lArr = [];
  for (let s = 0; s + win <= N; s += hop) {
    const ms = (cum[s + win] - cum[s]) / win;
    msArr.push(ms);
    lArr.push(ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);
  }
  let sum = 0, cnt = 0;
  for (let j = 0; j < lArr.length; j++) if (lArr[j] > -70) { sum += msArr[j]; cnt++; }
  if (!cnt) return -Infinity;
  const relThresh = -0.691 + 10 * Math.log10(sum / cnt) - 10;
  sum = 0; cnt = 0;
  for (let j = 0; j < lArr.length; j++) {
    if (lArr[j] > -70 && lArr[j] > relThresh) { sum += msArr[j]; cnt++; }
  }
  if (!cnt) return -Infinity;
  return -0.691 + 10 * Math.log10(sum / cnt);
}

function beginTrack(durS) {
  const N = Math.ceil(durS * SR);
  return { N, buses: makeBuses(N), kicks: [], post: null, meta: {} };
}

/** Bus filtering, delays, sidechain, mutes, mix, softclip, LUFS normalize. */
function finalize(name, ctx) {
  const { buses, kicks, post, N } = ctx;
  for (const [bn, f] of Object.entries(post.busHp || {})) filterBus(buses[bn], 'hp', f, 0.72);
  for (const [bn, d] of Object.entries(post.delays || {})) pingPong(buses[bn].L, buses[bn].R, d);
  const env = buildDuckEnv(N, kicks, post.duck);
  for (const [bn, amt] of Object.entries(post.duck.amounts)) applyDuck(buses[bn], env, amt);
  for (const m of post.mutes || []) for (const bn of m.buses) muteBusAfter(buses[bn], m.t, m.ramp);

  const L = new Float64Array(N), R = new Float64Array(N);
  for (const [bn, g] of Object.entries(post.mix)) {
    const b = buses[bn];
    for (let i = 0; i < N; i++) { L[i] += b.L[i] * g; R[i] += b.R[i] * g; }
  }
  const hpc = bqCoef('hp', 24, 0.6);
  runBiquad(L, hpc);
  runBiquad(R, hpc);
  const d = 1.25, k = Math.tanh(d);
  for (let i = 0; i < N; i++) {
    L[i] = Math.tanh(d * L[i]) / k;
    R[i] = Math.tanh(d * R[i]) / k;
  }
  const nIn = Math.round(0.004 * SR);
  for (let i = 0; i < nIn; i++) { const g = i / nIn; L[i] *= g; R[i] *= g; }
  const nOut = Math.round(0.03 * SR);
  for (let i = 0; i < nOut; i++) {
    const g = (i + 1) / nOut, j = N - 1 - i;
    L[j] *= g; R[j] *= g;
  }

  const want = TARGET_LUFS + (TRIM_DB[name] ?? 0);
  let lufs = integratedLufs(L, R);
  let g = 10 ** ((want - lufs) / 20);
  for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; }
  lufs = integratedLufs(L, R);
  if (Math.abs(want - lufs) > 0.05) {
    g = 10 ** ((want - lufs) / 20);
    for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; }
    lufs = integratedLufs(L, R);
  }
  let peak = 0;
  for (let i = 0; i < N; i++) {
    if (Number.isNaN(L[i]) || Number.isNaN(R[i])) throw new Error('NaN in render');
    const al = Math.abs(L[i]); if (al > peak) peak = al;
    const ar = Math.abs(R[i]); if (ar > peak) peak = ar;
  }
  const peakCeil = 10 ** (-3 / 20); // sample-peak safety well under -2 dBTP
  if (peak > peakCeil) {
    const s = peakCeil / peak;
    for (let i = 0; i < N; i++) { L[i] *= s; R[i] *= s; }
    lufs += 20 * Math.log10(s);
    peak = peakCeil;
  }
  return { L, R, stats: { lufs, peakDb: 20 * Math.log10(peak), durS: N / SR } };
}

/** Encode interleaved float32 PCM to 24-bit WAV by piping into ffmpeg. */
function writeWav(file, Lb, Rb) {
  return new Promise((resolve, reject) => {
    const N = Lb.length;
    const inter = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      inter[2 * i] = Lb[i];
      inter[2 * i + 1] = Rb[i];
    }
    const p = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', 'pipe:0',
      '-c:a', 'pcm_s24le', file,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    p.stdin.on('error', () => {});
    const buf = Buffer.from(inter.buffer, inter.byteOffset, inter.byteLength);
    const CHUNK = 1 << 22;
    let off = 0;
    const pump = () => {
      while (off < buf.length) {
        const end = Math.min(off + CHUNK, buf.length);
        const ok = p.stdin.write(buf.subarray(off, end));
        off = end;
        if (!ok) { p.stdin.once('drain', pump); return; }
      }
      p.stdin.end();
    };
    pump();
  });
}

// ---------------------------------------------------------------- tracks ---
//
// Shared pattern language: each chord = { bass: midi, tones: diatonic offsets
// [root, 3rd-ish, 5th, 7th-ish, octave] for bass riffs, stab: mid voicing,
// pad: low-mid voicing }. Riffs are index arrays into `tones` (null = rest).
// All riffs are chord-tone/diatonic figures — generic material, no quotes.

const ACC8 = [1, 0.72, 0.85, 0.72, 0.95, 0.72, 0.85, 0.78];
const HAT8 = [0.55, 1, 0.62, 1, 0.55, 1, 0.62, 1];

// --- bed-teaser — A minor, 108 BPM, ~62 s -----------------------------------
// 4.0 s rise from silence -> drop at 0:04 (the first live-window moment),
// then 26 bars of four-on-the-floor with a lift every 4 bars (~8.9 s), a
// half-bar breath at bar 12, and a hard da-da-DUM button end.
function buildTeaser() {
  const bpm = 108, beat = 60 / bpm, bar = 4 * beat, eighth = beat / 2, six = beat / 4;
  const intro = 4.0, bars = 26;
  const T = intro + bars * bar;           // 61.778 s — the button
  const ctx = beginTrack(T + 0.65);
  const rnd = makeRng('flowvid2:bed-teaser');

  const CH = [
    { n: 'Am', bass: 33, tones: [0, 3, 7, 10, 12], stab: [57, 60, 64], pad: [45, 52, 57, 60] },
    { n: 'F', bass: 29, tones: [0, 4, 7, 9, 12], stab: [57, 60, 65], pad: [41, 48, 57, 60] },
    { n: 'C', bass: 36, tones: [0, 4, 7, 9, 12], stab: [55, 60, 64], pad: [48, 55, 60, 64] },
    { n: 'G', bass: 31, tones: [0, 4, 7, 10, 12], stab: [55, 59, 62], pad: [43, 50, 55, 59] },
  ];
  const RIFFS = [
    [0, null, 0, 4, 0, null, 0, 2],
    [0, null, 0, 4, 0, 3, 4, 2],
    [0, 0, 4, 0, 2, 0, 3, 4],
    [0, 0, 0, 4, 0, 0, 3, 4],
  ];
  const riffPlan = [
    [0, 0, 1, 0], [0, 1, 0, 1], [1, 2, 1, 2], [0, 1, 2, 1],
    [3, 1, 3, 2], [3, 2, 3, 2], [3, 3],
  ];
  const cutoffs = [1050, 1300, 1600, 2000, 2500, 3100, 3600];
  const guard = T - beat - eighth + 1e-3; // last normal event slot
  const kGuard = T - beat - 0.01;

  // ---- intro rise (0 -> 4.0 s)
  for (let e = 0; e < 14; e++) {
    const t = e * eighth, x = t / intro;
    stab(ctx, t, eighth * 0.5, [45, 57], {
      level: 0.2 + 0.26 * x, cutoff: 460 + 620 * x, detune: 6,
      decayTau: 0.07, sustain: 0.12,
    });
  }
  for (let q = 0; q < 7; q++) {
    const t = q * beat;
    kick(ctx, t, { level: 0.3 + 0.34 * (t / intro), fStart: 112, drive: 1.25, clickLvl: 0.12, ampTau: 0.15 });
  }
  for (let e = 1; e < 14; e += 2) {
    hat(ctx, e * eighth, { level: 0.05 + 0.1 * (e / 14), decay: 0.02, pan: e % 4 === 1 ? 0.2 : -0.2 });
  }
  riser(ctx, intro, 4.0, { level: 0.62, f0: 220, f1: 7400, curve: 2.6 });
  toneRise(ctx, intro, 2.2, { f0: 220, f1: 440, level: 0.11 });
  bassNote(ctx, 2.0, 1.9, 33, { level: 0.3, cutoff: 380, envAmt: 0.6 });

  // ---- groove
  impact(ctx, intro, { level: 0.62 });
  for (let b = 0; b < bars; b++) {
    const s = Math.min(6, Math.floor(b / 4));
    const ch = CH[b % 4];
    const t0 = intro + b * bar;
    const lastBar = b === bars - 1;
    const secLast = b % 4 === 3 && !lastBar;
    const breath = b === 12;

    // kick: four on the floor (+ push kick on section-final bars later on)
    for (let q = 0; q < 4; q++) {
      const t = t0 + q * beat;
      if (t > kGuard) continue;
      if (breath && q >= 2) continue;
      kick(ctx, t, { level: 0.82, fStart: 168, drive: 2.0, ampTau: 0.19 });
    }
    if (s >= 2 && secLast) {
      const t = t0 + 3.5 * beat;
      if (t <= kGuard) kick(ctx, t, { level: 0.55, fStart: 168, drive: 1.8, ampTau: 0.12 });
    }
    // clap backbeat
    for (const q of [1, 3]) {
      const t = t0 + q * beat;
      if (t > guard || (breath && q === 3)) continue;
      clap(ctx, t, { level: 0.72 });
    }
    if (s >= 3 && secLast) clap(ctx, t0 + 3.25 * beat, { level: 0.42 });
    // hats
    if (!breath || true) {
      if (s >= 5) {
        for (let e = 0; e < 16; e++) {
          const t = t0 + e * six;
          if (t > guard || (breath && e >= 8)) continue;
          const acc = e % 4 === 0 ? 0.85 : e % 4 === 2 ? 0.62 : 0.4;
          hat(ctx, t, { level: 0.3 * acc, decay: 0.024, pan: e % 2 ? 0.24 : -0.18 });
        }
      } else {
        for (let e = 0; e < 8; e++) {
          const t = t0 + e * eighth;
          if (t > guard || (breath && e >= 4)) continue;
          hat(ctx, t, { level: (0.26 + 0.02 * s) * HAT8[e], decay: 0.026, pan: e % 2 ? 0.24 : -0.18 });
        }
      }
      if (s >= 1) {
        for (const q of [0.5, 1.5, 2.5, 3.5]) {
          const t = t0 + q * beat;
          if (t > guard || (breath && q >= 2)) continue;
          hat(ctx, t, { level: 0.15 + 0.025 * s, open: true, openDecay: 0.12, pan: 0.12 });
        }
      }
      if (s >= 4) {
        for (let e = 0; e < 16; e++) {
          const t = t0 + e * six;
          if (t > guard || (breath && e >= 8)) continue;
          shakerHit(ctx, t, { level: 0.1 * (e % 4 === 2 ? 1 : 0.55), pan: 0.3 });
        }
      }
      if (rnd() < 0.6) {
        const q = rnd() < 0.5 ? 1.75 : 3.75;
        const t = t0 + q * beat;
        if (t <= guard && !breath) tickHit(ctx, t, { level: 0.13, pan: rnd() < 0.5 ? 0.35 : -0.35 });
      }
    }
    // bass riff
    const plan = riffPlan[s];
    const riff = RIFFS[plan[(b % 4) % plan.length]];
    for (let e = 0; e < 8; e++) {
      const idx = riff[e];
      if (idx === null) continue;
      const t = t0 + e * eighth;
      if (t > guard || (breath && e >= 4)) continue;
      bassNote(ctx, t, eighth * 0.82, ch.bass + ch.tones[idx], {
        level: 0.42, cutoff: 850 + 70 * s, accent: ACC8[e],
      });
    }
    // pulse: filtered stabs on every 8th, offbeat-accented, cutoff per section
    for (let e = 0; e < 8; e++) {
      const t = t0 + e * eighth;
      if (t > guard || (breath && e >= 4)) continue;
      stab(ctx, t, eighth * 0.55, ch.stab, {
        level: 0.42 * (e % 2 ? 1 : 0.64), cutoff: cutoffs[s],
        decayTau: 0.1, sustain: 0.2, pan: e % 2 ? 0.12 : -0.12,
      });
    }
    if (secLast && s >= 1) {
      const nx = CH[(b + 1) % 4];
      const t = t0 + 7.5 * eighth;
      if (t <= guard) stab(ctx, t, eighth * 0.4, nx.stab, { level: 0.36, cutoff: cutoffs[s] * 1.15, decayTau: 0.08, sustain: 0 });
    }
    // pad (the pump layer)
    const padDur = lastBar ? 3 * beat - 0.08 : bar * 1.01;
    pad2(ctx, t0, padDur, ch.pad, {
      level: 0.27 + 0.025 * s, cutoff: 900 + 140 * s, attack: 0.05, release: 0.22,
    });
    if (s >= 3) {
      pad2(ctx, t0, padDur, ch.pad.map((x) => x + 12), {
        level: 0.1 + 0.015 * s, cutoff: 2000 + 250 * s, attack: 0.06, release: 0.2,
      });
    }
    // arp
    const arpN = [...ch.stab, ch.stab[0] + 12];
    if (s >= 4) {
      const seq = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 3, 2, 1, 0];
      for (let e = 0; e < 16; e++) {
        const t = t0 + e * six;
        if (t > guard || (breath && e >= 8)) continue;
        ks(ctx, t, arpN[seq[e]] + (s >= 5 ? 12 : 0), {
          level: 0.19 * (e % 4 === 0 ? 1 : 0.72), decayS: 0.35, bright: 0.72,
          pan: e % 2 ? 0.4 : -0.4,
        });
      }
    } else if (s >= 2) {
      for (let e = 1; e < 8; e += 2) {
        const t = t0 + e * eighth;
        if (t > guard || (breath && e >= 4)) continue;
        ks(ctx, t, arpN[(e >> 1) % 4], { level: 0.2, decayS: 0.5, bright: 0.65, pan: e % 4 === 1 ? 0.35 : -0.35 });
      }
    }
  }
  // section risers + impacts (the ~8 s momentum lifts)
  for (const sb of [4, 8, 12, 16, 20, 24]) {
    const tB = intro + sb * bar;
    const s = sb / 4;
    riser(ctx, tB, 1.35, { level: 0.26 + 0.035 * s, f0: 400, f1: 5200 });
    impact(ctx, tB, { level: sb === 12 ? 0.3 : 0.42 });
  }
  riser(ctx, intro + 13 * bar, 1.7, { level: 0.44, f0: 350, f1: 6000 }); // out of the breath
  impact(ctx, intro + 13 * bar, { level: 0.5 });
  // final riser + hard button: da-da-DUM
  riser(ctx, T, 2.3, { level: 0.56, f0: 300, f1: 7600 });
  toneRise(ctx, T, 1.6, { f0: 440, f1: 880, level: 0.1 });
  const AmStab = [57, 60, 64];
  stab(ctx, T - beat, 0.16, AmStab, { level: 0.44, cutoff: 2600, decayTau: 0.09, sustain: 0, bus: ctx.buses.drums });
  kick(ctx, T - beat, { level: 0.78 });
  stab(ctx, T - beat / 2, 0.16, AmStab, { level: 0.5, cutoff: 3000, decayTau: 0.09, sustain: 0, bus: ctx.buses.drums });
  tickHit(ctx, T - beat / 2, { level: 0.12 });
  kick(ctx, T, { level: 1.0, ampTau: 0.24 });
  clap(ctx, T, { level: 0.78 });
  stab(ctx, T, 0.3, [57, 60, 64, 69], { level: 0.62, cutoff: 3400, decayTau: 0.22, sustain: 0, bus: ctx.buses.drums });
  bassNote(ctx, T, 0.2, 33, { level: 0.5, cutoff: 900, bus: ctx.buses.drums });

  ctx.post = {
    duck: { depth: 0.85, dip: 0.007, hold: 0.02, rel: 0.3, amounts: { pad: 1, pulse: 0.62, bass: 0.5, lead: 0.45, fx: 0.3 } },
    delays: { lead: { time: beat * 0.75, feedback: 0.3, damp: 3200, wet: 0.22 } },
    busHp: { pad: 160, pulse: 175, lead: 240, fx: 130, bass: 30 },
    mix: { drums: 1.0, bass: 0.72, pulse: 0.82, pad: 0.56, lead: 0.5, fx: 0.6 },
    mutes: [
      { buses: ['pulse', 'pad', 'lead', 'bass'], t: T - beat + 0.1, ramp: 0.08 },
      { buses: ['fx'], t: T - 0.015, ramp: 0.012 },
    ],
  };
  ctx.meta = { bpm, key: 'A minor', T };
  return ctx;
}

// --- bed-tutorial — D minor, 98 BPM, ~100 s ---------------------------------
// The workhorse: driving but narration-friendly. The moving 8th-note bassline
// is the lead voice; drums stay tight and soft-edged, lifts every 8 bars.
function buildTutorial() {
  const bpm = 98, beat = 60 / bpm, bar = 4 * beat, eighth = beat / 2, six = beat / 4;
  const bars = 41;
  const T = bars * bar;                   // 100.41 s
  const ctx = beginTrack(T + 0.75);
  const rnd = makeRng('flowvid2:bed-tutorial');

  const CH = [
    { n: 'Dm', bass: 38, tones: [0, 3, 7, 10, 12], stab: [57, 62, 65], pad: [50, 53, 57, 64] },
    { n: 'Bb', bass: 34, tones: [0, 4, 7, 9, 12], stab: [58, 62, 65], pad: [46, 53, 58, 62] },
    { n: 'F', bass: 29, tones: [0, 4, 7, 9, 12], stab: [57, 60, 65], pad: [41, 48, 53, 57] },
    { n: 'C', bass: 36, tones: [0, 4, 7, 10, 12], stab: [55, 60, 64], pad: [48, 55, 60, 64] },
  ];
  const RIFFS = [
    [0, null, 2, null, 3, null, 2, null],
    [0, null, 2, 3, 4, null, 3, 2],
    [0, 0, null, 2, null, 3, 4, null],
    [0, null, 0, 2, 3, 2, 4, 3],
    [0, 2, 3, 4, 3, 2, 3, null],
  ];
  const plans = [
    [0, 0, 1, 0, 0, 1, 0, 2],
    [1, 0, 2, 1, 1, 2, 0, 3],
    [3, 1, 3, 2, 3, 1, 2, 4],
    [3, 4, 3, 2, 4, 3, 4, 2],
    [1, 3, 2, 3, 3, 2, 1, 4],
  ];
  const guard = T - eighth - 0.01;

  for (let b = 0; b < bars; b++) {
    const s = Math.min(4, Math.floor(b / 8));
    const ch = CH[b % 4];
    const t0 = b * bar;

    for (let q = 0; q < 4; q++) {
      const t = t0 + q * beat;
      if (t > guard) continue;
      kick(ctx, t, { level: 0.74, fStart: 135, drive: 1.45, clickLvl: 0.28, ampTau: 0.21 });
    }
    if (s >= 1) {
      for (const q of [1, 3]) {
        const t = t0 + q * beat;
        if (t <= guard) snap(ctx, t, { level: 0.42 + 0.03 * s });
      }
    }
    for (let e = 0; e < 8; e++) {
      if (s === 0 && e % 2 === 0) continue;
      const t = t0 + e * eighth;
      if (t > guard) continue;
      hat(ctx, t, { level: 0.19 * HAT8[e], decay: 0.024, hpf: 8600, pan: e % 2 ? 0.2 : -0.15 });
    }
    if (s >= 3) {
      for (const q of [1.5, 3.5]) {
        const t = t0 + q * beat;
        if (t <= guard) hat(ctx, t, { level: 0.12, open: true, openDecay: 0.1, pan: 0.14 });
      }
      for (let e = 2; e < 16; e += 4) {
        const t = t0 + e * six;
        if (t <= guard) shakerHit(ctx, t, { level: 0.075, pan: 0.28 });
      }
    }
    if (b % 4 === 3 && b < bars - 1) {
      for (let e = 0; e < 4; e++) {
        const t = t0 + 3 * beat + e * six;
        if (t <= guard) tickHit(ctx, t, { level: 0.07 + 0.025 * e, tone: 2500 + 300 * e, pan: e % 2 ? 0.3 : -0.3 });
      }
    }
    // the moving bassline (lead voice of this bed)
    const plan = plans[s];
    const riff = RIFFS[plan[b % 8]];
    for (let e = 0; e < 8; e++) {
      const idx = riff[e];
      if (idx === null) continue;
      const t = t0 + e * eighth;
      if (t > guard) continue;
      bassNote(ctx, t, eighth * 0.85, ch.bass + ch.tones[idx], {
        level: 0.46, cutoff: 780 + 65 * s, envAmt: 2.0, accent: ACC8[e],
      });
    }
    if (b % 2 === 1) {
      const t = t0 + 15 * six;
      if (t <= guard) bassNote(ctx, t, six * 0.8, ch.bass + 12, { level: 0.4, cutoff: 950, accent: 0.8 });
    }
    // quiet offbeat comps
    if (s >= 2) {
      for (const q of [1.5, 3.5]) {
        const t = t0 + q * beat;
        if (t > guard) continue;
        stab(ctx, t, beat * 0.3, ch.stab, {
          level: 0.26, cutoff: 1250 + 110 * s, decayTau: 0.09, sustain: 0.1, pan: q > 2 ? 0.18 : -0.18,
        });
      }
    }
    if (s >= 1) {
      pad2(ctx, t0, bar * 1.01, ch.pad, { level: 0.26, cutoff: 820 + 70 * s, attack: 0.06, release: 0.25 });
    }
    // gentle KS arp
    const arpN = [...ch.stab, ch.stab[0] + 12];
    if (s >= 2) {
      const seq = [0, 1, 2, 3, 2, 1, 3, 2];
      const step = s >= 3 ? 1 : 2;
      for (let e = s >= 3 ? 0 : 1; e < 8; e += step) {
        const t = t0 + e * eighth;
        if (t > guard) continue;
        ks(ctx, t, arpN[seq[e]], { level: 0.2, decayS: 0.85, bright: 0.45, pan: e % 2 ? 0.35 : -0.35 });
      }
    }
  }
  for (const sb of [8, 16, 24, 32]) {
    riser(ctx, sb * bar, 1.25, { level: 0.2 + 0.03 * (sb / 8), f0: 350, f1: 4200 });
    impact(ctx, sb * bar, { level: 0.3 });
  }
  riser(ctx, T, 1.8, { level: 0.34, f0: 300, f1: 5200 });
  // soft button: pickup, then kick + snap + warm Dm strum
  kick(ctx, T - eighth, { level: 0.5, fStart: 135, drive: 1.4 });
  kick(ctx, T, { level: 0.85, fStart: 140, drive: 1.6, ampTau: 0.24 });
  snap(ctx, T, { level: 0.55 });
  strum(ctx, T, [50, 57, 62, 65, 69], { level: 0.38, decayS: 0.9, bright: 0.5, stagger: 0.016, bus: ctx.buses.drums });
  bassNote(ctx, T, 0.18, 38, { level: 0.46, cutoff: 800, bus: ctx.buses.drums });

  ctx.post = {
    duck: { depth: 0.6, dip: 0.006, hold: 0.025, rel: 0.26, amounts: { pad: 1, pulse: 0.55, bass: 0.45, lead: 0.4, fx: 0.3 } },
    delays: { lead: { time: beat * 0.75, feedback: 0.34, damp: 2600, wet: 0.25 } },
    busHp: { pad: 150, pulse: 180, lead: 250, fx: 130, bass: 30 },
    mix: { drums: 0.85, bass: 0.75, pulse: 0.6, pad: 0.56, lead: 0.52, fx: 0.5 },
    mutes: [
      { buses: ['pulse', 'pad', 'lead', 'bass'], t: T - eighth + 0.08, ramp: 0.07 },
      { buses: ['fx'], t: T - 0.015, ramp: 0.012 },
    ],
  };
  ctx.meta = { bpm, key: 'D minor', T };
  return ctx;
}

// --- bed-heavy — E minor, 104 BPM, ~52 s ------------------------------------
// 'Drop In Anything': confident and practical. Chunky syncopated groove
// (extra kick on the and-of-3), on-beat stabs, Em-C-G-D.
function buildHeavy() {
  const bpm = 104, beat = 60 / bpm, bar = 4 * beat, eighth = beat / 2, six = beat / 4;
  const bars = 22;                        // bar 0 = intro build
  const T = bars * bar;                   // 50.77 s
  const ctx = beginTrack(T + 0.68);
  const rnd = makeRng('flowvid2:bed-heavy');

  const CH = [
    { n: 'Em', bass: 28, tones: [0, 3, 7, 10, 12], stab: [55, 59, 64], pad: [40, 47, 52, 55] },
    { n: 'C', bass: 36, tones: [0, 4, 7, 9, 12], stab: [55, 60, 64], pad: [48, 52, 55, 60] },
    { n: 'G', bass: 31, tones: [0, 4, 7, 9, 12], stab: [55, 59, 62], pad: [43, 50, 55, 59] },
    { n: 'D', bass: 38, tones: [0, 4, 7, 10, 12], stab: [57, 62, 66], pad: [50, 54, 57, 62] },
  ];
  const RIFFS = [
    [0, null, 0, null, 0, 0, null, 4],
    [0, null, 0, 2, 0, 0, 3, 4],
    [0, 0, 4, 0, 0, 0, 4, 3],
    [0, null, 0, 4, 0, 0, 2, 3],
  ];
  const plans = [[0, 0, 1, 0], [1, 0, 1, 2], [2, 1, 2, 3], [2, 3, 2, 3], [2, 2, 3, 3]];
  const guard = T - eighth - 0.01;

  // intro build (one bar)
  riser(ctx, bar, bar, { level: 0.5, f0: 260, f1: 6400, curve: 2.4 });
  tickRoll(ctx, 0, bar - 0.02, eighth, { startLvl: 0.05, endLvl: 0.3 });
  for (let q = 0; q < 4; q++) {
    kick(ctx, q * beat, { level: 0.3 + 0.11 * q, fStart: 120, drive: 1.3, clickLvl: 0.15 });
  }
  for (let e = 0; e < 8; e++) {
    bassNote(ctx, e * eighth, eighth * 0.8, 28, { level: 0.3 * (0.5 + 0.5 * e / 8), cutoff: 600, accent: ACC8[e] });
  }
  impact(ctx, bar, { level: 0.62 });

  for (let b = 1; b < bars; b++) {
    const g = b - 1;
    const s = Math.min(4, Math.floor(g / 4));
    const ch = CH[g % 4];
    const t0 = b * bar;

    for (const q of [0, 1, 2, 2.5, 3]) {
      const t = t0 + q * beat;
      if (t > guard) continue;
      kick(ctx, t, { level: q === 2.5 ? 0.58 : 0.86, fStart: 160, drive: 1.9, ampTau: q === 2.5 ? 0.13 : 0.19 });
    }
    for (const q of [1, 3]) {
      const t = t0 + q * beat;
      if (t <= guard) clap(ctx, t, { level: 0.72 });
    }
    if (s >= 3) {
      for (let e = 0; e < 16; e++) {
        const t = t0 + e * six;
        if (t > guard) continue;
        const acc = e % 4 === 0 ? 0.8 : e % 4 === 2 ? 0.6 : 0.38;
        hat(ctx, t, { level: 0.28 * acc, decay: 0.022, pan: e % 2 ? 0.22 : -0.16 });
      }
    } else {
      for (let e = 0; e < 8; e++) {
        const t = t0 + e * eighth;
        if (t > guard) continue;
        hat(ctx, t, { level: 0.26 * HAT8[e], decay: 0.025, pan: e % 2 ? 0.22 : -0.16 });
      }
    }
    if (s >= 1) {
      for (const q of [0.5, 2.5]) {
        const t = t0 + q * beat;
        if (t <= guard) hat(ctx, t, { level: 0.14, open: true, openDecay: 0.11, pan: 0.12 });
      }
    }
    if (s >= 2) {
      for (let e = 2; e < 16; e += 4) {
        const t = t0 + e * six;
        if (t <= guard) shakerHit(ctx, t, { level: 0.085, pan: 0.28 });
      }
    }
    if (rnd() < 0.5) {
      const t = t0 + 3.75 * beat;
      if (t <= guard) tickHit(ctx, t, { level: 0.12, pan: rnd() < 0.5 ? 0.3 : -0.3 });
    }
    // bass: syncopated, locks the and-of-3 with the kick
    const riff = RIFFS[plans[s][g % 4]];
    for (let e = 0; e < 8; e++) {
      const idx = riff[e];
      if (idx === null) continue;
      const t = t0 + e * eighth;
      if (t > guard) continue;
      bassNote(ctx, t, eighth * 0.8, ch.bass + ch.tones[idx], {
        level: 0.44, cutoff: 820 + 80 * s, drive: 1.9, accent: e === 5 ? 1.05 : ACC8[e],
      });
    }
    if (s >= 1) {
      for (const e of [1, 3, 7]) {
        const t = t0 + e * eighth;
        if (t > guard) continue;
        bassNote(ctx, t, eighth * 0.4, ch.bass + 12, { level: 0.26, cutoff: 1100, accent: 0.85 });
      }
    }
    // stabs ON the beats — square-shouldered, practical
    for (let q = 0; q < 4; q++) {
      const t = t0 + q * beat;
      if (t > guard) continue;
      stab(ctx, t, beat * 0.38, ch.stab, {
        level: q === 0 ? 0.42 : 0.35, cutoff: 1400 + 180 * s,
        decayTau: 0.1, sustain: 0.16, pan: q % 2 ? 0.1 : -0.1,
      });
    }
    if (s >= 1) {
      pad2(ctx, t0, bar * 1.01, ch.pad, { level: 0.26, cutoff: 950 + 100 * s, attack: 0.05, release: 0.22 });
    }
    const arpN = [...ch.stab, ch.stab[0] + 12];
    if (s >= 2) {
      const seq = [0, 1, 2, 1, 3, 1, 2, 1];
      for (let e = 0; e < 8; e++) {
        const t = t0 + e * eighth;
        if (t > guard) continue;
        ks(ctx, t, arpN[seq[e]], { level: 0.19 * (e % 2 ? 0.75 : 1), decayS: 0.4, bright: 0.72, pan: e % 2 ? 0.38 : -0.38 });
      }
    }
  }
  for (const gb of [4, 8, 12, 16]) {
    const tB = (gb + 1) * bar;
    riser(ctx, tB, 1.2, { level: 0.24 + 0.04 * (gb / 4), f0: 380, f1: 5000 });
    impact(ctx, tB, { level: 0.38 });
  }
  riser(ctx, T, 1.9, { level: 0.5, f0: 300, f1: 7000 });
  // button: single tight pickup, then the full stop
  stab(ctx, T - eighth, 0.14, [55, 59, 64], { level: 0.44, cutoff: 2800, decayTau: 0.08, sustain: 0, bus: ctx.buses.drums });
  kick(ctx, T - eighth, { level: 0.62 });
  kick(ctx, T, { level: 1.0, ampTau: 0.24 });
  clap(ctx, T, { level: 0.75 });
  stab(ctx, T, 0.26, [55, 59, 64, 67], { level: 0.6, cutoff: 3200, decayTau: 0.22, sustain: 0, bus: ctx.buses.drums });
  bassNote(ctx, T, 0.2, 28, { level: 0.5, cutoff: 850, bus: ctx.buses.drums });

  ctx.post = {
    duck: { depth: 0.75, dip: 0.006, hold: 0.022, rel: 0.24, amounts: { pad: 1, pulse: 0.5, bass: 0.5, lead: 0.4, fx: 0.3 } },
    delays: { lead: { time: beat * 0.5, feedback: 0.28, damp: 2800, wet: 0.16 } },
    busHp: { pad: 155, pulse: 175, lead: 245, fx: 130, bass: 28 },
    mix: { drums: 1.0, bass: 0.76, pulse: 0.8, pad: 0.54, lead: 0.48, fx: 0.55 },
    mutes: [
      { buses: ['pulse', 'pad', 'lead', 'bass'], t: T - eighth + 0.08, ramp: 0.07 },
      { buses: ['fx'], t: T - 0.015, ramp: 0.012 },
    ],
  };
  ctx.meta = { bpm, key: 'E minor', T };
  return ctx;
}

// --- bed-powers — C major, 112 BPM, ~57 s -----------------------------------
// Playful and bright: swung 16th KS plucks, octave-bounce bass, offbeat house
// stabs, pentatonic bloops, one stutter bar for fun, button with a cheeky
// upward bloop.
function buildPowers() {
  const bpm = 112, beat = 60 / bpm, bar = 4 * beat, eighth = beat / 2, six = beat / 4;
  const bars = 26;                        // bars 0-1 = intro
  const T = bars * bar;                   // 55.71 s
  const ctx = beginTrack(T + 0.62);
  const rnd = makeRng('flowvid2:bed-powers');
  const swingAmt = 0.16;
  const sw = (e16) => (e16 % 2 === 1 ? swingAmt * six : 0);

  const CH = [
    { n: 'C', bass: 36, tones: [0, 4, 7, 10, 12], stab: [55, 60, 64], pad: [48, 55, 60, 64], arp: [60, 64, 67, 72, 74] },
    { n: 'G', bass: 31, tones: [0, 4, 7, 10, 12], stab: [55, 59, 62], pad: [43, 50, 55, 59], arp: [55, 59, 62, 67, 69] },
    { n: 'Am', bass: 33, tones: [0, 3, 7, 10, 12], stab: [57, 60, 64], pad: [45, 52, 57, 60], arp: [57, 60, 64, 69, 71] },
    { n: 'F', bass: 29, tones: [0, 4, 7, 9, 12], stab: [57, 60, 65], pad: [41, 48, 53, 57], arp: [53, 57, 60, 65, 67] },
  ];
  const RIFFS = [
    [0, 4, 0, 4, 0, 4, 0, 4],
    [0, 4, 0, 4, 0, 4, 3, 4],
    [0, null, 4, 0, 4, null, 0, 4],
    [0, 0, 4, 4, 0, 0, 3, 4],
  ];
  const plans = [[0, 0, 0, 1], [0, 1, 0, 1], [1, 0, 1, 3], [2, 1, 2, 3], [3, 1, 3, 1], [3, 3, 1, 3]];
  const guard = T - beat - 0.01;
  const PENTA = [72, 74, 76, 79, 81];

  const stutterBar = 17;
  for (let b = 0; b < bars; b++) {
    const isIntro = b < 2;
    const s = isIntro ? 0 : Math.min(5, Math.floor((b - 2) / 4));
    const ch = CH[b % 4];
    const t0 = b * bar;
    const stut = b === stutterBar;

    // drums
    if (!isIntro) {
      if (stut) {
        for (let e = 0; e < 4; e++) {
          kick(ctx, t0 + e * six, { level: 0.4 + 0.13 * e, fStart: 180, drive: 1.9, ampTau: 0.1 });
        }
      } else {
        for (let q = 0; q < 4; q++) {
          const t = t0 + q * beat;
          if (t > guard) continue;
          kick(ctx, t, { level: 0.86, fStart: 175, drive: 2.0, ampTau: 0.17, pitchTau: 0.026 });
        }
      }
      if (!stut) {
        for (const q of [1, 3]) {
          const t = t0 + q * beat;
          if (t <= guard) clap(ctx, t, { level: 0.68, tone: 1350 });
        }
      }
    }
    if (!stut) {
      const dense = !isIntro && s >= 1;
      if (dense) {
        for (let e = 0; e < 16; e++) {
          const t = t0 + e * six + sw(e);
          if (t > guard) continue;
          const acc = e % 4 === 0 ? 0.8 : e % 4 === 2 ? 0.6 : 0.42;
          hat(ctx, t, { level: (isIntro ? 0.14 : 0.28) * acc, decay: 0.02, hpf: 8800, pan: e % 2 ? 0.26 : -0.2 });
        }
      } else {
        for (let e = 1; e < 8; e += 2) {
          const t = t0 + e * eighth;
          if (t > guard) continue;
          hat(ctx, t, { level: isIntro ? 0.16 : 0.26, decay: 0.024, hpf: 8800, pan: e % 4 === 1 ? 0.24 : -0.24 });
        }
      }
      if (!isIntro && s >= 1) {
        for (const q of [0.5, 1.5, 2.5, 3.5]) {
          const t = t0 + q * beat;
          if (t <= guard) hat(ctx, t, { level: 0.15, open: true, openDecay: 0.12, pan: 0.14 });
        }
      }
      if (!isIntro && s >= 2) {
        for (let e = 0; e < 16; e++) {
          const t = t0 + e * six + sw(e);
          if (t > guard) continue;
          shakerHit(ctx, t, { level: 0.09 * (e % 4 === 2 ? 1 : 0.5), pan: 0.32 });
        }
      }
      if (!isIntro && rnd() < 0.55) {
        const t = t0 + (rnd() < 0.5 ? 1.75 : 3.25) * beat;
        if (t <= guard) tickHit(ctx, t, { level: 0.12, tone: 3100, pan: rnd() < 0.5 ? 0.35 : -0.35 });
      }
    }
    // bouncy octave bass
    const riff = stut ? RIFFS[3] : RIFFS[plans[Math.min(5, s + (isIntro ? 0 : 0))][b % 4]];
    for (let e = 0; e < 8; e++) {
      const idx = riff[e];
      if (idx === null) continue;
      const t = t0 + e * eighth;
      if (t > guard) continue;
      if (stut && e < 2) continue;
      bassNote(ctx, t, eighth * 0.75, ch.bass + ch.tones[idx], {
        level: (isIntro ? 0.3 : 0.4), cutoff: 880 + 80 * s, envAmt: 2.6,
        accent: idx === 4 ? 0.9 : ACC8[e],
      });
    }
    // offbeat house stabs
    if (!isIntro && !stut) {
      for (let e = 1; e < 8; e += 2) {
        const t = t0 + e * eighth;
        if (t > guard) continue;
        stab(ctx, t, eighth * 0.5, ch.stab, {
          level: 0.38, cutoff: 1500 + 160 * s, decayTau: 0.09, sustain: 0.14,
          pan: e % 4 === 1 ? 0.16 : -0.16,
        });
      }
    }
    // swung KS plucks — the playful voice
    const seq = [0, 1, 2, 3, 4, 3, 2, 1, 0, 2, 1, 3, 2, 4, 3, 1];
    const step = (isIntro || s === 0) ? 2 : 1;
    for (let e = 0; e < 16; e += step) {
      const t = t0 + e * six + sw(e);
      if (t > guard || (stut && e < 8)) continue;
      ks(ctx, t, ch.arp[seq[e]], {
        level: (isIntro ? 0.19 : 0.22) * (e % 4 === 0 ? 1 : 0.7),
        decayS: 0.32, bright: 0.78, pan: e % 2 ? 0.42 : -0.42,
      });
    }
    // pentatonic bloops
    if (!isIntro && s >= 1 && b % 4 === 3 && !stut) {
      const m0 = PENTA[Math.floor(rnd() * PENTA.length)];
      const t = t0 + 3.5 * beat;
      if (t <= guard) bloop(ctx, t, m0, m0 + 7, { level: 0.17, pan: rnd() < 0.5 ? 0.3 : -0.3 });
    }
    if (!isIntro && s >= 1 && !stut) {
      pad2(ctx, t0, bar * 1.01, ch.pad, { level: 0.23, cutoff: 1100 + 120 * s, attack: 0.04, release: 0.2 });
    }
    if (stut) riser(ctx, (b + 1) * bar, 1.3, { level: 0.42, f0: 400, f1: 6800 });
  }
  riser(ctx, 2 * bar, 2 * bar, { level: 0.5, f0: 240, f1: 6600, curve: 2.4 });
  toneRise(ctx, 2 * bar, 1.6, { f0: 262, f1: 523, level: 0.1 });
  impact(ctx, 2 * bar, { level: 0.6 });
  for (const sb of [6, 10, 14, 22]) {
    riser(ctx, sb * bar, 1.15, { level: 0.24 + 0.03 * (sb / 4), f0: 420, f1: 5600 });
    impact(ctx, sb * bar, { level: 0.36 });
  }
  impact(ctx, (stutterBar + 1) * bar, { level: 0.5 });
  riser(ctx, T, 2.0, { level: 0.5, f0: 320, f1: 7400 });
  // button: da-da-DUM + cheeky bloop up
  const CStab = [55, 60, 64];
  stab(ctx, T - beat, 0.14, CStab, { level: 0.42, cutoff: 2800, decayTau: 0.08, sustain: 0, bus: ctx.buses.drums });
  kick(ctx, T - beat, { level: 0.7 });
  stab(ctx, T - beat / 2, 0.14, CStab, { level: 0.48, cutoff: 3200, decayTau: 0.08, sustain: 0, bus: ctx.buses.drums });
  kick(ctx, T, { level: 1.0, ampTau: 0.22 });
  clap(ctx, T, { level: 0.75, tone: 1350 });
  stab(ctx, T, 0.26, [60, 64, 67, 72], { level: 0.62, cutoff: 3800, decayTau: 0.2, sustain: 0, bus: ctx.buses.drums });
  bassNote(ctx, T, 0.18, 36, { level: 0.48, cutoff: 900, bus: ctx.buses.drums });
  bloop(ctx, T + 0.02, 72, 84, { level: 0.2, pan: 0.1, bus: ctx.buses.drums });

  ctx.post = {
    duck: { depth: 0.8, dip: 0.006, hold: 0.02, rel: 0.22, amounts: { pad: 1, pulse: 0.6, bass: 0.55, lead: 0.5, fx: 0.3 } },
    delays: { lead: { time: beat * 0.75, feedback: 0.3, damp: 3600, wet: 0.2 } },
    busHp: { pad: 165, pulse: 185, lead: 250, fx: 135, bass: 32 },
    mix: { drums: 0.95, bass: 0.7, pulse: 0.75, pad: 0.5, lead: 0.62, fx: 0.55 },
    mutes: [
      { buses: ['pulse', 'pad', 'lead', 'bass'], t: T - beat + 0.1, ramp: 0.08 },
      { buses: ['fx'], t: T - 0.015, ramp: 0.012 },
    ],
  };
  ctx.meta = { bpm, key: 'C major', T };
  return ctx;
}

// --- bed-share — F major, 100 BPM, ~46 s ------------------------------------
// Warm but forward: KS arps and strums over a soft four-on-the-floor,
// F-Dm-Bb-C, Bb-C lift, resolving on a rung Fmaj9 (warm button, short ring).
function buildShare() {
  const bpm = 100, beat = 60 / bpm, bar = 4 * beat, eighth = beat / 2, six = beat / 4;
  const bars = 19;
  const T = bars * bar;                   // 45.6 s
  const ctx = beginTrack(T + 1.15);
  const rnd = makeRng('flowvid2:bed-share');

  const CH = {
    F: { bass: 29, tones: [0, 4, 7, 9, 12], stab: [57, 60, 65], pad: [41, 48, 53, 57], arp: [53, 57, 60, 65, 67] },
    Dm: { bass: 38, tones: [0, 3, 7, 10, 12], stab: [57, 62, 65], pad: [50, 53, 57, 62], arp: [50, 53, 57, 62, 64] },
    Bb: { bass: 34, tones: [0, 4, 7, 9, 12], stab: [58, 62, 65], pad: [46, 53, 58, 62], arp: [53, 58, 62, 65, 67] },
    C: { bass: 36, tones: [0, 4, 7, 10, 12], stab: [55, 60, 64], pad: [48, 55, 60, 64], arp: [48, 55, 60, 64, 67] },
  };
  const seqNames = [];
  for (let c = 0; c < 4; c++) seqNames.push('F', 'Dm', 'Bb', 'C');
  seqNames.push('Bb', 'C', 'C');          // 19 bars, V held into the resolve
  const RIFFS = [
    [0, null, null, 2, null, null, 0, null],
    [0, null, 2, null, 3, null, 2, 4],
    [0, null, 2, 3, 4, 3, 2, 0],
  ];
  const guard = T - eighth - 0.01;

  for (let b = 0; b < bars; b++) {
    const s = Math.min(2, Math.floor(b / 8));
    const ch = CH[seqNames[b]];
    const t0 = b * bar;
    const build = b === 18;

    for (let q = 0; q < 4; q++) {
      const t = t0 + q * beat;
      if (t > guard) continue;
      kick(ctx, t, { level: 0.7, fStart: 120, drive: 1.3, clickLvl: 0.18, ampTau: 0.23 });
    }
    if (build) {
      for (const q of [2.5, 3.5]) {
        const t = t0 + q * beat;
        if (t <= guard) kick(ctx, t, { level: 0.45, fStart: 120, drive: 1.25, ampTau: 0.14 });
      }
    }
    if (s >= 1) {
      for (const q of [1, 3]) {
        const t = t0 + q * beat;
        if (t <= guard) snap(ctx, t, { level: 0.38 });
      }
    }
    for (let e = 1; e < 8; e += 2) {
      const t = t0 + e * eighth;
      if (t > guard) continue;
      hat(ctx, t, { level: 0.17, decay: 0.024, hpf: 8200, pan: e % 4 === 1 ? 0.2 : -0.2 });
    }
    if (b >= 8) {
      for (let e = 2; e < 16; e += 4) {
        const t = t0 + e * six;
        if (t <= guard) shakerHit(ctx, t, { level: 0.075, pan: 0.26 });
      }
    }
    if (b >= 12) {
      for (const q of [1.5, 3.5]) {
        const t = t0 + q * beat;
        if (t <= guard) hat(ctx, t, { level: 0.09, open: true, openDecay: 0.09, pan: 0.1 });
      }
    }
    // warm moving bass
    const riff = RIFFS[build ? 2 : s];
    for (let e = 0; e < 8; e++) {
      const idx = riff[e];
      if (idx === null) continue;
      const t = t0 + e * eighth;
      if (t > guard) continue;
      bassNote(ctx, t, eighth * 0.9, ch.bass + ch.tones[idx], {
        level: 0.42, cutoff: 680 + 60 * s, envAmt: 1.6, drive: 1.4, accent: ACC8[e],
      });
    }
    // KS arp — the main voice, present from bar 0
    const seq = [0, 1, 2, 3, 4, 3, 2, 1];
    for (let e = 0; e < 8; e++) {
      const t = t0 + e * eighth;
      if (t > guard) continue;
      ks(ctx, t, ch.arp[seq[e]], {
        level: 0.24 * (e % 2 ? 0.78 : 1), decayS: 1.0, bright: 0.5,
        pan: e % 2 ? 0.36 : -0.36,
      });
    }
    // strummed comps
    if (s >= 1 && !build) {
      for (const q of [1.5, 3.5]) {
        const t = t0 + q * beat;
        if (t > guard) continue;
        strum(ctx, t, ch.stab, { level: 0.18, decayS: 0.6, bright: 0.45, stagger: 0.014 });
      }
    }
    pad2(ctx, t0, bar * 1.01, ch.pad, { level: 0.27, cutoff: 820 + 80 * s, attack: 0.07, release: 0.3 });
  }
  for (const sb of [8, 16]) {
    riser(ctx, sb * bar, 1.2, { level: 0.18 + 0.04 * (sb / 8), f0: 320, f1: 3800 });
    impact(ctx, sb * bar, { level: 0.26 });
  }
  riser(ctx, T, 1.6, { level: 0.3, f0: 300, f1: 4600 });
  // warm resolve: soft kick + Fmaj9 strum, ringing out (short, not a fade)
  kick(ctx, T, { level: 0.72, fStart: 115, drive: 1.3, ampTau: 0.26 });
  bassNote(ctx, T, 0.5, 29, { level: 0.46, cutoff: 600, bus: ctx.buses.drums });
  strum(ctx, T, [53, 57, 60, 64, 67], { level: 0.42, decayS: 1.25, bright: 0.5, stagger: 0.02, bus: ctx.buses.drums });
  pad2(ctx, T, 0.7, [41, 48, 53, 57, 64], { level: 0.15, cutoff: 900, attack: 0.02, release: 0.45, bus: ctx.buses.drums });

  ctx.post = {
    duck: { depth: 0.5, dip: 0.006, hold: 0.025, rel: 0.3, amounts: { pad: 1, pulse: 0.5, bass: 0.4, lead: 0.35, fx: 0.3 } },
    delays: { lead: { time: beat * 0.75, feedback: 0.36, damp: 2400, wet: 0.28 } },
    busHp: { pad: 150, pulse: 175, lead: 235, fx: 125, bass: 30 },
    mix: { drums: 0.8, bass: 0.7, pulse: 0.5, pad: 0.6, lead: 0.66, fx: 0.45 },
    mutes: [
      { buses: ['pulse', 'pad', 'lead', 'bass'], t: T - eighth + 0.09, ramp: 0.08 },
      { buses: ['fx'], t: T - 0.015, ramp: 0.012 },
    ],
  };
  ctx.meta = { bpm, key: 'F major', T };
  return ctx;
}

const BEDS = {
  'bed-teaser': { build: buildTeaser },
  'bed-tutorial': { build: buildTutorial },
  'bed-heavy': { build: buildHeavy },
  'bed-powers': { build: buildPowers },
  'bed-share': { build: buildShare },
};

// ------------------------------------------------- legacy: sting-ambient ---
// The shipped sting-ambient.wav is KEPT AS-IS (owner brief). The original v1
// generators below reproduce it bit-identically when explicitly requested
// (`node synthesize.mjs sting`); they are not part of the default render.

function padChord(L, R, o) {
  const {
    t0, dur, notes, rnd,
    level = 0.17, attack = 1.6, release = 3.0,
    cutoff = 1200, detuneCents = 6,
    lfoRate = 0.09, lfoDepth = 0.12, pan = 0.35,
  } = o;
  const N = L.length;
  const i0 = Math.max(0, Math.floor(t0 * SR));
  const i1 = Math.min(N, Math.ceil((t0 + dur + release) * SR));
  const nn = notes.length;
  for (let k = 0; k < nn; k++) {
    const f = typeof notes[k] === 'string' ? hz(notes[k]) : notes[k];
    const det = detuneCents * (0.7 + 0.6 * rnd());
    const dt1 = cents(f, det) / SR;
    const dt2 = cents(f, -det) / SR;
    const dt3 = f / SR;
    let p1 = rnd(), p2 = rnd(), p3 = rnd();
    const fc = Math.min(cutoff * (1 + 0.22 * k), 5200);
    const a = 1 - Math.exp(-TAU * fc / SR);
    let lp1 = 0, lp2 = 0;
    const lfoPh = rnd() * TAU;
    const side = (k % 2 === 0 ? -1 : 1) * pan * (0.6 + 0.4 * rnd());
    const gl = 0.7071 * (1 - side * 0.5);
    const gr = 0.7071 * (1 + side * 0.5);
    const noteLvl = (level / Math.sqrt(nn)) * (k === 0 ? 1.15 : 1) * (1 - 0.07 * k);
    for (let i = i0; i < i1; i++) {
      const tl = i / SR - t0;
      let env;
      if (tl < attack) { const x = tl / attack; env = x * x; }
      else if (tl <= dur) env = 1;
      else { const x = (tl - dur) / release; env = x >= 1 ? 0 : (1 - x) * (1 - x); }
      if (env <= 0) continue;
      env *= 1 + lfoDepth * Math.sin(TAU * lfoRate * tl + lfoPh);
      p1 += dt1; if (p1 >= 1) p1 -= 1;
      p2 += dt2; if (p2 >= 1) p2 -= 1;
      p3 += dt3; if (p3 >= 1) p3 -= 1;
      const saw1 = 2 * p1 - 1 - polyblep(p1, dt1);
      const saw2 = 2 * p2 - 1 - polyblep(p2, dt2);
      const x = 0.35 * (saw1 + saw2) + 0.45 * Math.sin(TAU * p3);
      lp1 += a * (x - lp1);
      lp2 += a * (lp1 - lp2);
      const s = lp2 * env * noteLvl;
      L[i] += s * gl;
      R[i] += s * gr;
    }
  }
}

function subNote(L, R, { t0, dur, note, level = 0.1, attack = 0.5, release = 0.8 }) {
  const f = typeof note === 'string' ? hz(note) : note;
  const dt = f / SR;
  const i0 = Math.max(0, Math.floor(t0 * SR));
  const i1 = Math.min(L.length, Math.ceil((t0 + dur + release) * SR));
  let p = 0;
  for (let i = i0; i < i1; i++) {
    const tl = i / SR - t0;
    let env;
    if (tl < attack) { const x = tl / attack; env = x * x; }
    else if (tl <= dur) env = 1;
    else { const x = (tl - dur) / release; env = x >= 1 ? 0 : (1 - x) * (1 - x); }
    if (env <= 0) continue;
    p += dt; if (p >= 1) p -= 1;
    const s = Math.tanh(1.4 * Math.sin(TAU * p)) * env * level;
    L[i] += s * 0.7071;
    R[i] += s * 0.7071;
  }
}

function blip(L, R, o) {
  const {
    t, note, level = 0.04, attack = 0.006, decay = 0.22,
    cutoff = 1100, pan = 0, harmonics = [1, 0.25, 0.1],
  } = o;
  const f = typeof note === 'string' ? hz(note) : note;
  const i0 = Math.max(0, Math.floor(t * SR));
  const i1 = Math.min(L.length, Math.ceil((t + attack + decay * 6) * SR));
  const a = 1 - Math.exp(-TAU * Math.min(cutoff, 6000) / SR);
  let lp = 0;
  const gl = 0.7071 * (1 - pan * 0.5);
  const gr = 0.7071 * (1 + pan * 0.5);
  let p = 0;
  const dt = f / SR;
  for (let i = i0; i < i1; i++) {
    const tl = i / SR - t;
    const env = Math.min(tl / attack, 1) * Math.exp(-tl / decay);
    p += dt; if (p >= 1) p -= 1;
    const ph = TAU * p;
    let x = 0;
    for (let h = 0; h < harmonics.length; h++) x += harmonics[h] * Math.sin(ph * (h + 1));
    lp += a * (x - lp);
    const s = lp * env * level;
    L[i] += s * gl;
    R[i] += s * gr;
  }
}

function shimmer(L, R, o) {
  const {
    t0, dur, notes, rnd,
    level = 0.03, detuneCents = 5, attack = 2.5, release = 3.0,
    tremRate = 0.45, spread = 0.7,
  } = o;
  const i0 = Math.max(0, Math.floor(t0 * SR));
  const i1 = Math.min(L.length, Math.ceil((t0 + dur + release) * SR));
  for (let k = 0; k < notes.length; k++) {
    const f = typeof notes[k] === 'string' ? hz(notes[k]) : notes[k];
    const dt1 = cents(f, detuneCents * (0.6 + 0.8 * rnd())) / SR;
    const dt2 = cents(f, -detuneCents * (0.6 + 0.8 * rnd())) / SR;
    let p1 = rnd(), p2 = rnd();
    const trPh = rnd() * TAU;
    const trR = tremRate * (0.8 + 0.4 * rnd());
    const side = (k % 2 === 0 ? -1 : 1) * spread;
    const gl = 0.7071 * (1 - side * 0.5);
    const gr = 0.7071 * (1 + side * 0.5);
    const lvl = level / Math.sqrt(notes.length);
    const atk = attack * (0.85 + 0.3 * rnd());
    for (let i = i0; i < i1; i++) {
      const tl = i / SR - t0;
      let env;
      if (tl < atk) { const x = tl / atk; env = x * x; }
      else if (tl <= dur) env = 1;
      else { const x = (tl - dur) / release; env = x >= 1 ? 0 : (1 - x) * (1 - x); }
      if (env <= 0) continue;
      env *= 0.65 + 0.35 * Math.sin(TAU * trR * tl + trPh);
      p1 += dt1; if (p1 >= 1) p1 -= 1;
      p2 += dt2; if (p2 >= 1) p2 -= 1;
      const s = (Math.sin(TAU * p1) + Math.sin(TAU * p2)) * 0.5 * env * lvl;
      L[i] += s * gl;
      R[i] += s * gr;
    }
  }
}

function reverb(L, R, o = {}) {
  const { wet = 0.15, decay = 0.78, damp = 0.35, predelay = 0.02 } = o;
  const N = L.length;
  const scale = SR / 44100;
  const combBase = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apBase = [556, 441, 341, 225];
  const pd = Math.max(1, Math.round(predelay * SR));
  for (let ch = 0; ch < 2; ch++) {
    const X = ch === 0 ? L : R;
    const off = ch === 0 ? 0 : 23;
    const nc = combBase.length;
    const cBuf = [], cLen = new Int32Array(nc), cIdx = new Int32Array(nc);
    const cStore = new Float64Array(nc);
    for (let c = 0; c < nc; c++) {
      cLen[c] = Math.round(combBase[c] * scale) + off;
      cBuf.push(new Float32Array(cLen[c]));
    }
    const na = apBase.length;
    const aBuf = [], aLen = new Int32Array(na), aIdx = new Int32Array(na);
    for (let c = 0; c < na; c++) {
      aLen[c] = Math.round(apBase[c] * scale) + off;
      aBuf.push(new Float32Array(aLen[c]));
    }
    const pre = new Float32Array(pd);
    let pidx = 0;
    for (let i = 0; i < N; i++) {
      const dry = X[i];
      const inp = pre[pidx];
      pre[pidx] = dry;
      pidx++; if (pidx >= pd) pidx = 0;
      let acc = 0;
      for (let c = 0; c < nc; c++) {
        const buf = cBuf[c];
        const out = buf[cIdx[c]];
        cStore[c] = out * (1 - damp) + cStore[c] * damp;
        buf[cIdx[c]] = inp * 0.03 + cStore[c] * decay;
        cIdx[c]++; if (cIdx[c] >= cLen[c]) cIdx[c] = 0;
        acc += out;
      }
      for (let c = 0; c < na; c++) {
        const buf = aBuf[c];
        const bo = buf[aIdx[c]];
        const out = -acc + bo;
        buf[aIdx[c]] = acc + bo * 0.5;
        aIdx[c]++; if (aIdx[c] >= aLen[c]) aIdx[c] = 0;
        acc = out;
      }
      X[i] = dry + acc * wet;
    }
  }
}

/** v1 mastering: DC-block, fades, peak-normalize to -6 dBFS, apply gain. */
function legacyFinish(L, R, { fadeIn = 1.5, fadeOut = 4.0, gainDb = 0, peakRef = 0.5 }) {
  const N = L.length;
  let x1l = 0, y1l = 0, x1r = 0, y1r = 0;
  const Rk = 0.9965;
  for (let i = 0; i < N; i++) {
    let y = L[i] - x1l + Rk * y1l; x1l = L[i]; y1l = y; L[i] = y;
    y = R[i] - x1r + Rk * y1r; x1r = R[i]; y1r = y; R[i] = y;
  }
  const nIn = Math.min(N, Math.floor(fadeIn * SR));
  for (let i = 0; i < nIn; i++) {
    const g = Math.sin((i / nIn) * Math.PI / 2) ** 2;
    L[i] *= g; R[i] *= g;
  }
  const nOut = Math.min(N, Math.floor(fadeOut * SR));
  for (let i = 0; i < nOut; i++) {
    const g = Math.sin(((i + 1) / nOut) * Math.PI / 2) ** 2;
    const j = N - 1 - i;
    L[j] *= g; R[j] *= g;
  }
  let peak = 0;
  for (let i = 0; i < N; i++) {
    if (Number.isNaN(L[i]) || Number.isNaN(R[i])) throw new Error('NaN in render');
    const al = Math.abs(L[i]); if (al > peak) peak = al;
    const ar = Math.abs(R[i]); if (ar > peak) peak = ar;
  }
  if (!(peak > 1e-6)) throw new Error('silent render');
  const g = (peakRef / peak) * 10 ** (gainDb / 20);
  for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; }
}

// sting-ambient — Fmaj9, rubato (v1, unchanged).
function buildSting(L, R, rnd) {
  padChord(L, R, {
    t0: 0, dur: 3.6, notes: ['C3', 'F3', 'A3', 'E4', 'G4'], rnd,
    level: 0.2, attack: 2.4, release: 3.0, cutoff: 1500, detuneCents: 7,
    lfoRate: 0.25, lfoDepth: 0.08,
  });
  subNote(L, R, { t0: 0.2, dur: 3.4, note: 'F2', level: 0.12, attack: 1.6, release: 2.2 });
  shimmer(L, R, { t0: 0.8, dur: 2.8, notes: ['A5', 'C6', 'G5'], rnd, level: 0.05, attack: 1.9, release: 2.8, detuneCents: 7, tremRate: 0.55 });
  shimmer(L, R, { t0: 1.6, dur: 2.0, notes: ['E6', 'G6'], rnd, level: 0.03, attack: 1.6, release: 2.4, detuneCents: 9, tremRate: 0.4 });
  blip(L, R, { t: 2.2, note: 'C5', level: 0.022, attack: 0.01, decay: 0.5, cutoff: 2400, pan: 0.2, harmonics: [1] });
  pingPong(L, R, { time: 0.42, feedback: 0.35, damp: 2600, wet: 0.16 });
  reverb(L, R, { wet: 0.32, decay: 0.87, damp: 0.3, predelay: 0.03 });
}

// ------------------------------------------------------------------ main ---

let OUTDIR = DIR;

async function renderBed(name) {
  const t = Date.now();
  const ctx = BEDS[name].build();
  const { L, R, stats } = finalize(name, ctx);
  const out = path.join(OUTDIR, name + '.wav');
  await writeWav(out, L, R);
  console.log(
    `${name}.wav  ${stats.durS.toFixed(2)}s  ${ctx.meta.bpm} BPM  ${ctx.meta.key}  ` +
    `internal ${stats.lufs.toFixed(2)} LUFS  sample-peak ${stats.peakDb.toFixed(1)} dBFS  ` +
    `(${((Date.now() - t) / 1000).toFixed(1)}s)`,
  );
}

async function renderSting() {
  const t = Date.now();
  const dur = 8;
  const N = Math.round(dur * SR);
  const Lb = new Float32Array(N);
  const Rb = new Float32Array(N);
  const rnd = makeRng('flowvid:sting-ambient');
  buildSting(Lb, Rb, rnd);
  legacyFinish(Lb, Rb, { fadeIn: 1.5, fadeOut: 2.2, gainDb: -6.0 });
  const out = path.join(OUTDIR, 'sting-ambient.wav');
  await writeWav(out, Lb, Rb);
  console.log(`sting-ambient.wav  ${dur}s  legacy v1 path  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

function resolveName(a) {
  if (BEDS[a]) return a;
  if (BEDS['bed-' + a]) return 'bed-' + a;
  if (a === 'sting' || a === 'sting-ambient') return 'sting-ambient';
  throw new Error(`unknown track: ${a} (have: ${Object.keys(BEDS).join(', ')}, sting)`);
}

const args = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--outdir=')) OUTDIR = path.resolve(a.slice('--outdir='.length));
  else args.push(a);
}
const names = args.length ? args.map(resolveName) : Object.keys(BEDS);
for (const name of names) {
  if (name === 'sting-ambient') await renderSting();
  else await renderBed(name);
}
console.log('done.');
