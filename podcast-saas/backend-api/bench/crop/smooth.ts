/*
 * D-16 regression bench — step response of the crop trajectory.
 *
 * Prints the step-response and peak-travel tables from
 * `.audit-ledger/vertical-crop-investigation.md` §2/BUG-3. Pure CPU.
 *
 * Baseline before the switch-aware smoother: 17.4% of the travel had already happened
 * 1.2s BEFORE the switch (the crop drifting off whoever was still talking), and only
 * 54.1% at the switch itself.
 *
 * The player-EMA figures at the end describe `client-web`'s useCropOverlay and are NOT
 * affected by anything in this package — they are printed to keep the two halves of the
 * problem visible together.
 */
import { smoothKeyframes } from '../../src/services/crop/smoother.js';
const SI = 0.25, N = 400;                      // 100 s at 4 fps
const A = 0.30, B = 0.70;                      // two head positions
const mk = (f: (i: number) => number) => Array.from({length: N}, (_, i) => ({ t: +(i*SI).toFixed(3), x: f(i) }));

// 1) STEP: A until 50 s, then B  (debounce already committed)
const step = smoothKeyframes(mk(i => i < 200 ? A : B), [0], 1.2, SI);
const at = (sec: number) => step[Math.round(sec/SI)].x;
const frac = (sec: number) => +(((at(sec) - A) / (B - A)) * 100).toFixed(1);
console.log('STEP response (0% = still on A, 100% = fully on B); switch at t=50.00');
for (const d of [-3, -2.4, -1.2, -0.5, 0, 0.5, 1.2, 2.4, 3.6]) {
  console.log(`  t=50${d>=0?'+':''}${d}s -> ${frac(50+d)}% of the way to B  (x=${at(50+d).toFixed(3)})`);
}

// 2) SHORT TURNS: B speaks for D seconds inside A, how far does the crop actually travel?
console.log('\nPEAK travel for a turn of length D (100% = speaker actually framed):');
for (const D of [1, 2, 3, 4, 5, 6, 8, 10]) {
  const n = Math.round(D / SI), s = 200;
  const out = smoothKeyframes(mk(i => (i >= s && i < s + n) ? B : A), [0], 1.2, SI);
  const peak = Math.max(...out.map(k => k.x));
  console.log(`  D=${D}s -> peak ${(((peak - A)/(B - A))*100).toFixed(1)}%  (x=${peak.toFixed(3)}; head at ${B})`);
}

// 3) player EMA (alpha 0.06 per rAF) settling time
console.log('\nplayer EMA alpha=0.06 (useCropOverlay.ts:153) settling from 0.5 to a target:');
for (const hz of [60, 120, 30]) {
  let x = 0, n = 0;
  while (x < 0.632 && n < 10000) { x += (1 - x) * 0.06; n++; }
  console.log(`  ${hz}Hz: tau=${(n/hz).toFixed(2)}s  ->  95% settle ~${(3*n/hz).toFixed(2)}s`);
}
