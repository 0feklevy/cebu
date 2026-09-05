#!/usr/bin/env node
// ---------------------------------------------------------------------------
// synthesize.mjs — ORIGINAL music beds for the five FlowVid tutorial films
//
// Every sound in these files is synthesized from first principles by this
// script at render time: sine / polyBLEP-saw oscillators, seeded-PRNG noise,
// envelopes, one-pole filters, a ping-pong feedback delay and a small
// Freeverb-style comb/allpass reverb. There are NO samples, NO third-party
// loops or presets, and NO quoted melodies — license-clean by construction;
// commercial use unrestricted.
//
// Style: modern minimal SaaS scoring. Warm add9 pad chords in the I–V–vi–IV
// family with slow attacks, a soft filtered pulse at 92–104 BPM, occasional
// detuned high-sine shimmer, nothing harder than a soft noise tick, and no
// melody lines — these beds sit 12–18 dB under a voiceover.
//
// Usage:
//   node synthesize.mjs                 # render all six deliverables
//   node synthesize.mjs teaser sting    # render a subset
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

// Per-track make-up gain in dB, calibrated so ffmpeg ebur128 integrated
// loudness of each rendered file lands on target: -32 LUFS for the beds
// (they sit under -19 LUFS narration), -24 LUFS for the sting (plays alone).
// Values are (target − measured) from the -6 dBFS peak-normalized first pass
// and are baked in so `node synthesize.mjs` reproduces the deliverables.
const TRACK_GAIN_DB = {
  'bed-teaser': -14.2,   // measured -17.8 LUFS at -6 dBFS peak -> -32
  'bed-tutorial': -15.1, // measured -16.9 -> -32
  'bed-heavy': -14.8,    // measured -17.2 -> -32
  'bed-powers': -14.8,   // measured -17.2 -> -32
  'bed-share': -15.2,    // measured -16.8 -> -32
  'sting-ambient': -6.0, // measured -18.0 -> -24
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
const octUp = (f, min = 120) => { while (f < min) f *= 2; return f; };

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

// ------------------------------------------------------------ generators ---

/**
 * Warm pad chord: per note, two detuned polyBLEP saws + a sine, through a
 * 2-pole one-pole-cascade lowpass, slow attack/release, slow amp LFO,
 * alternating gentle pan. `notes` entries are note names or raw Hz.
 */
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

/** Soft sub bass: gently saturated sine, centered. */
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

/**
 * One soft pulse/pluck: a few sine harmonics through a lowpass with a fast
 * attack and exponential decay. The building block for the momentum pulse
 * and the (texture-only) arpeggio in bed-powers.
 */
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

/** Shimmer: detuned high sine pairs, slow swell, slow tremolo, wide pan. */
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

/** Softest percussion allowed: a tiny band-filtered noise tick. */
function tick(L, R, { t, rnd, level = 0.028, tone = 5000, decay = 0.012, pan = 0 }) {
  const i0 = Math.max(0, Math.floor(t * SR));
  const i1 = Math.min(L.length, i0 + Math.floor(0.06 * SR));
  const aLp = 1 - Math.exp(-TAU * Math.min(tone, 9000) / SR);
  const aHp = 1 - Math.exp(-TAU * 1800 / SR);
  let lp = 0, hpTrack = 0;
  const gl = 0.7071 * (1 - pan * 0.5);
  const gr = 0.7071 * (1 + pan * 0.5);
  for (let i = i0; i < i1; i++) {
    const tl = (i - i0) / SR;
    const env = Math.exp(-tl / decay);
    const w = rnd() * 2 - 1;
    hpTrack += aHp * (w - hpTrack);
    const hp = w - hpTrack;
    lp += aLp * (hp - lp);
    const s = lp * env * level * 2.5;
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

/** Freeverb-style reverb: 8 damped combs + 4 allpasses per channel. */
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

// --------------------------------------------------------------- mastering ---

/** DC-block, fade in/out, peak-normalize to -6 dBFS, apply calibrated gain. */
function finish(L, R, { fadeIn = 1.5, fadeOut = 4.0, gainDb = 0, peakRef = 0.5 }) {
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
  // after peak-normalize the peak sits at peakRef (-6.02 dBFS); gainDb shifts it
  return { rawMixPeakDb: 20 * Math.log10(peak), outPeakDb: 20 * Math.log10(peakRef) + gainDb };
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

// bed-teaser — C major, 100 BPM. Optimistic and forward: add9 pads one chord
// per bar over C–G–Am–F, 8th-note pulse, soft ticks, a build from ~72% (extra
// octave pad + shimmer + offbeat sparkle), then a held Cadd9 resolve tail.
function buildTeaser(L, R, rnd) {
  const beat = 60 / 100;
  const bar = 4 * beat; // 2.4 s
  const chords = {
    C: { bass: 'C2', notes: ['C3', 'G3', 'D4', 'E4'] },
    G: { bass: 'G1', notes: ['B2', 'D3', 'G3', 'D4'] },
    Am: { bass: 'A1', notes: ['A2', 'C3', 'E3', 'B3'] },
    F: { bass: 'F2', notes: ['A2', 'C3', 'F3', 'C4'] },
  };
  const prog = ['C', 'G', 'Am', 'F'];
  const finalBar = 28;
  for (let b = 0; b < finalBar; b++) {
    const ch = chords[prog[b % 4]];
    padChord(L, R, {
      t0: b * bar - 0.05, dur: bar, notes: ch.notes, rnd,
      level: 0.16, attack: 0.9, release: 2.2, cutoff: 1400, detuneCents: 6,
      lfoRate: 0.1, lfoDepth: 0.1,
    });
    subNote(L, R, { t0: b * bar, dur: bar, note: ch.bass, level: 0.11, attack: 0.4, release: 0.6 });
  }
  // octave pad layer through the build
  for (let b = 24; b < finalBar; b++) {
    const ch = chords[prog[b % 4]];
    padChord(L, R, {
      t0: b * bar, dur: bar, notes: ch.notes.map((x) => hz(x) * 2), rnd,
      level: 0.05, attack: 1.4, release: 2.5, cutoff: 2600, detuneCents: 8,
    });
  }
  // forward 8th-note pulse
  for (let b = 1; b < finalBar; b++) {
    const ch = chords[prog[b % 4]];
    const root = octUp(hz(ch.bass));
    for (let e = 0; e < 8; e++) {
      const accent = e % 4 === 0 ? 1.25 : e % 2 === 0 ? 1.0 : 0.8;
      blip(L, R, {
        t: b * bar + e * beat / 2, note: root,
        level: 0.045 * accent, decay: 0.2, cutoff: 1100,
        pan: e % 2 ? 0.18 : -0.18, harmonics: [1, 0.25, 0.1],
      });
    }
    if (b >= 24) {
      for (let e = 1; e < 8; e += 2) {
        blip(L, R, {
          t: b * bar + e * beat / 2, note: root * 2,
          level: 0.02, decay: 0.14, cutoff: 2000,
          pan: e % 4 === 1 ? 0.35 : -0.35, harmonics: [1],
        });
      }
    }
  }
  // soft ticks: backbeat, then every beat in the build
  for (let b = 8; b < finalBar; b++) {
    const qs = b >= 24 ? [0, 1, 2, 3] : [1, 3];
    for (const q of qs) {
      tick(L, R, {
        t: b * bar + q * beat, rnd,
        level: b >= 24 ? 0.034 : 0.027, tone: 5200, decay: 0.014,
        pan: q % 2 ? 0.22 : -0.22,
      });
    }
  }
  shimmer(L, R, { t0: 12 * bar, dur: 8 * bar, notes: ['G5', 'E6'], rnd, level: 0.018, attack: 4, release: 4 });
  shimmer(L, R, { t0: 24 * bar, dur: 4 * bar, notes: ['C6', 'G5', 'E6'], rnd, level: 0.035, attack: 2.5, release: 3, tremRate: 0.5 });
  // resolve tail
  const tF = finalBar * bar; // 67.2 s
  const C = chords.C;
  padChord(L, R, { t0: tF, dur: 6.5, notes: C.notes, rnd, level: 0.18, attack: 1.2, release: 4.5, cutoff: 1500 });
  padChord(L, R, { t0: tF, dur: 6.0, notes: C.notes.map((x) => hz(x) * 2), rnd, level: 0.045, attack: 2.5, release: 4.5, cutoff: 2800 });
  subNote(L, R, { t0: tF, dur: 6.5, note: 'C2', level: 0.11, attack: 0.6, release: 2.5 });
  shimmer(L, R, { t0: tF + 0.5, dur: 4.5, notes: ['E6', 'C6'], rnd, level: 0.03, attack: 2.2, release: 3.5 });
  blip(L, R, { t: tF, note: 'C3', level: 0.05, decay: 0.5, cutoff: 900, harmonics: [1, 0.3] });
  pingPong(L, R, { time: beat * 0.75, feedback: 0.32, damp: 2800, wet: 0.16 });
  reverb(L, R, { wet: 0.17, decay: 0.78, damp: 0.35, predelay: 0.02 });
}

// bed-tutorial — F major, 92 BPM. The calm workhorse: two-bar add9 pads over
// F–C–Dm–Bb, a barely-there quarter pulse, one faint late shimmer. Steady.
function buildTutorial(L, R, rnd) {
  const beat = 60 / 92;
  const bar = 4 * beat; // 2.6087 s
  const chords = {
    F: { bass: 'F2', notes: ['A2', 'C3', 'F3', 'C4'] },
    C: { bass: 'C2', notes: ['G2', 'C3', 'E3', 'G3'] },
    Dm: { bass: 'D2', notes: ['A2', 'D3', 'F3', 'A3'] },
    Bb: { bass: 'Bb1', notes: ['Bb2', 'D3', 'F3', 'Bb3'] },
  };
  const prog = ['F', 'C', 'Dm', 'Bb'];
  const lastBar = 48;
  for (let b = 0; b < lastBar; b += 2) {
    const ch = chords[prog[(b / 2) % 4]];
    padChord(L, R, {
      t0: b * bar - 0.05, dur: 2 * bar, notes: ch.notes, rnd,
      level: 0.17, attack: 1.9, release: 3.2, cutoff: 1000, detuneCents: 5,
      lfoRate: 0.07, lfoDepth: 0.1,
    });
    subNote(L, R, { t0: b * bar, dur: 2 * bar, note: ch.bass, level: 0.1, attack: 0.7, release: 1.0 });
  }
  for (let b = 2; b < lastBar; b++) {
    const ch = chords[prog[Math.floor(b / 2) % 4]];
    const root = octUp(hz(ch.bass));
    for (let q = 0; q < 4; q++) {
      blip(L, R, {
        t: b * bar + q * beat, note: root,
        level: q === 0 ? 0.034 : 0.026, decay: 0.26, cutoff: 800,
        pan: q % 2 ? 0.12 : -0.12, harmonics: [1, 0.2],
      });
    }
  }
  shimmer(L, R, { t0: 40 * bar, dur: 8 * bar, notes: ['A5', 'C6'], rnd, level: 0.015, attack: 5, release: 4, tremRate: 0.35 });
  const tF = lastBar * bar; // 125.2 s
  const F = chords.F;
  padChord(L, R, { t0: tF, dur: 8, notes: F.notes, rnd, level: 0.18, attack: 2.0, release: 5, cutoff: 1100 });
  subNote(L, R, { t0: tF, dur: 8, note: 'F2', level: 0.1, attack: 0.8, release: 2.5 });
  shimmer(L, R, { t0: tF + 1, dur: 5, notes: ['C6', 'F5'], rnd, level: 0.02, attack: 2.5, release: 4 });
  pingPong(L, R, { time: beat * 0.75, feedback: 0.28, damp: 2400, wet: 0.11 });
  reverb(L, R, { wet: 0.15, decay: 0.77, damp: 0.4, predelay: 0.025 });
}

// bed-heavy — A minor, 96 BPM. Darker and techy for the WebGL-sim film:
// low-cutoff pads over Am–F–C–G, an A+E fifth drone, squarish 8th pulse with
// 16th ghosts, offbeat ticks, F–G–Am cadence into the tail.
function buildHeavy(L, R, rnd) {
  const beat = 60 / 96;
  const bar = 4 * beat; // 2.5 s
  const chords = {
    Am: { bass: 'A1', notes: ['A2', 'C3', 'E3', 'B3'] },
    F: { bass: 'F2', notes: ['A2', 'C3', 'F3', 'C4'] },
    C: { bass: 'C2', notes: ['G2', 'C3', 'E3', 'G3'] },
    G: { bass: 'G1', notes: ['G2', 'B2', 'D3', 'G3'] },
  };
  const seq = [];
  for (let c = 0; c < 3; c++) seq.push('Am', 'F', 'C', 'G');
  seq.push('Am', 'F', 'G'); // 15 chords x 2 bars = 30 bars
  seq.forEach((name, ix) => {
    const ch = chords[name];
    const t0 = ix * 2 * bar;
    padChord(L, R, {
      t0: t0 - 0.05, dur: 2 * bar, notes: ch.notes, rnd,
      level: 0.17, attack: 1.3, release: 2.8, cutoff: 820, detuneCents: 8,
      lfoRate: 0.11, lfoDepth: 0.14,
    });
    subNote(L, R, { t0, dur: 2 * bar, note: ch.bass, level: 0.13, attack: 0.5, release: 0.8 });
  });
  // slow fifth drone underneath everything
  padChord(L, R, {
    t0: 0, dur: 76, notes: ['A2', 'E3'], rnd,
    level: 0.045, attack: 6, release: 5, cutoff: 600, detuneCents: 4,
    lfoRate: 0.05, lfoDepth: 0.2,
  });
  for (let b = 2; b < 30; b++) {
    const ch = chords[seq[Math.floor(b / 2)]];
    const root = octUp(hz(ch.bass));
    for (let e = 0; e < 8; e++) {
      blip(L, R, {
        t: b * bar + e * beat / 2, note: root,
        level: e % 4 === 0 ? 0.05 : 0.038, attack: 0.004, decay: 0.16, cutoff: 900,
        pan: e % 2 ? 0.15 : -0.15, harmonics: [1, 0.45, 0.28, 0.12],
      });
    }
    if (b >= 8) {
      for (let e = 0; e < 4; e++) {
        blip(L, R, {
          t: b * bar + e * beat + beat * 0.75, note: root * 2,
          level: 0.018, decay: 0.09, cutoff: 1400,
          pan: e % 2 ? -0.3 : 0.3, harmonics: [1, 0.3],
        });
        tick(L, R, { t: b * bar + e * beat + beat / 2, rnd, level: 0.026, tone: 4200, decay: 0.011, pan: e % 2 ? 0.25 : -0.25 });
      }
    }
  }
  shimmer(L, R, { t0: 16 * bar, dur: 8 * bar, notes: ['E5', 'C6'], rnd, level: 0.016, attack: 5, release: 4, tremRate: 0.3 });
  const tF = 30 * bar; // 75 s
  padChord(L, R, { t0: tF, dur: 5.5, notes: chords.Am.notes, rnd, level: 0.18, attack: 1.3, release: 4, cutoff: 950 });
  subNote(L, R, { t0: tF, dur: 5.5, note: 'A1', level: 0.13, attack: 0.5, release: 2 });
  shimmer(L, R, { t0: tF + 0.5, dur: 3.5, notes: ['E6', 'A5'], rnd, level: 0.022, attack: 2, release: 3.5 });
  pingPong(L, R, { time: beat * 0.5, feedback: 0.38, damp: 2200, wet: 0.2 });
  reverb(L, R, { wet: 0.13, decay: 0.74, damp: 0.45, predelay: 0.015 });
}

// bed-powers — D major, 104 BPM. Bright and playful: add9 pads over D–A–Bm–G,
// a gentle 1-5-8-5 sine-pluck texture (accompaniment, not melody), light
// quarter pulse, present shimmer, soft backbeat ticks.
function buildPowers(L, R, rnd) {
  const beat = 60 / 104;
  const bar = 4 * beat; // 2.3077 s
  const chords = {
    D: { bass: 'D2', notes: ['D3', 'F#3', 'A3', 'E4'] },
    A: { bass: 'A1', notes: ['C#3', 'E3', 'A3', 'B3'] },
    Bm: { bass: 'B1', notes: ['B2', 'D3', 'F#3', 'C#4'] },
    G: { bass: 'G1', notes: ['B2', 'D3', 'G3', 'A3'] },
  };
  const seq = ['D', 'A', 'Bm', 'G', 'D', 'A', 'Bm', 'G', 'D', 'A', 'Bm', 'G', 'D', 'A']; // 14 x 2 bars
  seq.forEach((name, ix) => {
    const ch = chords[name];
    const t0 = ix * 2 * bar;
    padChord(L, R, {
      t0: t0 - 0.05, dur: 2 * bar, notes: ch.notes, rnd,
      level: 0.15, attack: 1.0, release: 2.6, cutoff: 1700, detuneCents: 6,
      lfoRate: 0.12, lfoDepth: 0.12,
    });
    subNote(L, R, { t0, dur: 2 * bar, note: ch.bass, level: 0.09, attack: 0.5, release: 0.8 });
  });
  // playful 1-5-8-5 pluck texture on 8ths
  for (let b = 4; b < 28; b++) {
    const ch = chords[seq[Math.floor(b / 2)]];
    const root = octUp(hz(ch.bass), 180);
    const pat = [root, root * 1.5, root * 2, root * 1.5, root, root * 1.5, root * 2, root * 1.5];
    for (let e = 0; e < 8; e++) {
      blip(L, R, {
        t: b * bar + e * beat / 2, note: pat[e],
        level: (e % 4 === 0 ? 0.034 : 0.026) * (0.9 + 0.2 * rnd()),
        attack: 0.004, decay: 0.16, cutoff: 2400,
        pan: e % 2 ? 0.3 : -0.3, harmonics: [1, 0.18],
      });
    }
  }
  for (let b = 1; b < 28; b++) {
    const ch = chords[seq[Math.floor(b / 2)]];
    const root = octUp(hz(ch.bass));
    for (let q = 0; q < 4; q++) {
      blip(L, R, {
        t: b * bar + q * beat, note: root,
        level: q === 0 ? 0.032 : 0.024, decay: 0.2, cutoff: 900,
        pan: 0, harmonics: [1, 0.2],
      });
    }
  }
  for (let b = 12; b < 28; b++) {
    for (const q of [1, 3]) {
      tick(L, R, { t: b * bar + q * beat, rnd, level: 0.02, tone: 6000, decay: 0.01, pan: q === 1 ? 0.3 : -0.3 });
    }
  }
  shimmer(L, R, { t0: 8 * bar, dur: 16 * bar, notes: ['E6', 'A5', 'F#6'], rnd, level: 0.02, attack: 4, release: 4, tremRate: 0.5 });
  const tF = 28 * bar; // 64.6 s
  const D = chords.D;
  padChord(L, R, { t0: tF, dur: 5.5, notes: D.notes, rnd, level: 0.16, attack: 1.2, release: 4, cutoff: 1800 });
  padChord(L, R, { t0: tF, dur: 5, notes: D.notes.map((x) => hz(x) * 2), rnd, level: 0.04, attack: 2.2, release: 4, cutoff: 3000 });
  subNote(L, R, { t0: tF, dur: 5.5, note: 'D2', level: 0.09, attack: 0.5, release: 2 });
  blip(L, R, { t: tF, note: 'D5', level: 0.03, decay: 0.4, cutoff: 2600, harmonics: [1] });
  shimmer(L, R, { t0: tF + 0.4, dur: 4, notes: ['F#6', 'D6', 'A5'], rnd, level: 0.028, attack: 1.8, release: 3.4 });
  pingPong(L, R, { time: beat * 0.75, feedback: 0.3, damp: 3200, wet: 0.18 });
  reverb(L, R, { wet: 0.16, decay: 0.76, damp: 0.32, predelay: 0.02 });
}

// bed-share — G major, 92 BPM. The warm closer: Em–C–G–D twice, then a
// IV–V lift into a long held Gadd9 with shimmer — resolving, generous tail.
function buildShare(L, R, rnd) {
  const beat = 60 / 92;
  const bar = 4 * beat; // 2.6087 s
  const chords = {
    Em: { bass: 'E2', notes: ['B2', 'E3', 'G3', 'B3'] },
    C: { bass: 'C2', notes: ['C3', 'E3', 'G3', 'D4'] },
    G: { bass: 'G1', notes: ['D3', 'G3', 'A3', 'B3'] },
    D: { bass: 'D2', notes: ['A2', 'D3', 'F#3', 'A3'] },
  };
  const seq = ['Em', 'C', 'G', 'D', 'Em', 'C', 'G', 'D', 'C', 'D']; // 10 x 2 bars
  seq.forEach((name, ix) => {
    const ch = chords[name];
    const t0 = ix * 2 * bar;
    padChord(L, R, {
      t0: t0 - 0.05, dur: 2 * bar, notes: ch.notes, rnd,
      level: 0.17, attack: 1.7, release: 3.2, cutoff: 1250, detuneCents: 5,
      lfoRate: 0.08, lfoDepth: 0.11,
    });
    subNote(L, R, { t0, dur: 2 * bar, note: ch.bass, level: 0.11, attack: 0.6, release: 1.0 });
  });
  for (let b = 2; b < 20; b++) {
    const ch = chords[seq[Math.floor(b / 2)]];
    const root = octUp(hz(ch.bass));
    for (let q = 0; q < 4; q++) {
      blip(L, R, {
        t: b * bar + q * beat, note: root,
        level: q === 0 ? 0.034 : 0.025, decay: 0.24, cutoff: 850,
        pan: q % 2 ? 0.14 : -0.14, harmonics: [1, 0.2],
      });
    }
  }
  shimmer(L, R, { t0: 12 * bar, dur: 8 * bar, notes: ['B5', 'D6'], rnd, level: 0.02, attack: 4.5, release: 4, tremRate: 0.4 });
  const tF = 20 * bar; // 52.2 s
  const G = chords.G;
  padChord(L, R, { t0: tF, dur: 9.5, notes: G.notes, rnd, level: 0.18, attack: 1.8, release: 5.5, cutoff: 1350 });
  padChord(L, R, { t0: tF + 0.5, dur: 8.5, notes: G.notes.map((x) => hz(x) * 2), rnd, level: 0.04, attack: 3, release: 5, cutoff: 2600 });
  subNote(L, R, { t0: tF, dur: 9.5, note: 'G1', level: 0.11, attack: 0.8, release: 3 });
  shimmer(L, R, { t0: tF + 1, dur: 6, notes: ['D6', 'G5', 'B5'], rnd, level: 0.03, attack: 2.5, release: 4, tremRate: 0.35 });
  pingPong(L, R, { time: beat * 0.75, feedback: 0.28, damp: 2600, wet: 0.12 });
  reverb(L, R, { wet: 0.2, decay: 0.8, damp: 0.35, predelay: 0.025 });
}

// sting-ambient — Fmaj9, rubato. A standalone ambient swell for the demo
// project's A2 track: pad bloom + sub + two staggered shimmer layers + one
// soft high touch, into a long reverb tail. Beautiful alone.
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

const TRACKS = {
  'bed-teaser': { dur: 80, fadeOut: 4.0, targetLufs: -32, build: buildTeaser },
  'bed-tutorial': { dur: 140, fadeOut: 4.0, targetLufs: -32, build: buildTutorial },
  'bed-heavy': { dur: 85, fadeOut: 4.0, targetLufs: -32, build: buildHeavy },
  'bed-powers': { dur: 78, fadeOut: 4.0, targetLufs: -32, build: buildPowers },
  'bed-share': { dur: 70, fadeOut: 4.0, targetLufs: -32, build: buildShare },
  'sting-ambient': { dur: 8, fadeOut: 2.2, targetLufs: -24, build: buildSting },
};

// ------------------------------------------------------------------ main ---

async function renderTrack(name) {
  const spec = TRACKS[name];
  const t = Date.now();
  const N = Math.round(spec.dur * SR);
  const Lb = new Float32Array(N);
  const Rb = new Float32Array(N);
  const rnd = makeRng('flowvid:' + name);
  spec.build(Lb, Rb, rnd);
  const gainDb = TRACK_GAIN_DB[name] ?? 0;
  const { rawMixPeakDb, outPeakDb } = finish(Lb, Rb, { fadeIn: 1.5, fadeOut: spec.fadeOut, gainDb });
  const out = path.join(DIR, name + '.wav');
  await writeWav(out, Lb, Rb);
  console.log(
    `${name}.wav  ${spec.dur}s  raw-mix-peak ${rawMixPeakDb.toFixed(1)} dB  ` +
    `out-peak ${outPeakDb.toFixed(1)} dBFS  gain ${gainDb >= 0 ? '+' : ''}${gainDb} dB  ` +
    `(${((Date.now() - t) / 1000).toFixed(1)}s)`,
  );
}

function resolveName(a) {
  if (TRACKS[a]) return a;
  if (TRACKS['bed-' + a]) return 'bed-' + a;
  if (a === 'sting') return 'sting-ambient';
  throw new Error(`unknown track: ${a} (have: ${Object.keys(TRACKS).join(', ')})`);
}

const args = process.argv.slice(2);
const names = args.length ? args.map(resolveName) : Object.keys(TRACKS);
for (const name of names) await renderTrack(name);
console.log('done.');
