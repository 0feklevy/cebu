/*
 * D-16 regression bench — does a committed speaker turn actually ARRIVE?
 *
 * Prints the table from `.audit-ledger/vertical-crop-investigation.md` §2/BUG-3, driving
 * the real `applyDebounce` + `smoothKeyframes`. Pure CPU: no ffmpeg, no I/O, no fixtures.
 *   pnpm -C podcast-saas --filter backend-api bench:crop
 *
 * Baseline before the switch-aware smoother (what production shipped in v0.1.28):
 *   1.5s turn -> peak 0.487, 409 px miss, speaker OFF-SCREEN
 *   2.0s turn -> peak 0.538, 312 px miss, speaker OFF-SCREEN
 * A 1.0s turn is suppressed by the debounce on purpose and must stay that way.
 *
 * The CI-enforced form of these assertions lives in
 * `src/services/crop/__tests__/speakerTurn.test.ts`; this script is the readable table.
 */
import { smoothKeyframes } from '../../src/services/crop/smoother.js';
import { DebounceState, applyDebounce } from '../../src/services/crop/debounce.js';
const SI = 0.25, N = 480, A = 0.30, B = 0.70;
const HALFWIN = (1080 * (9/16)) / 1920 / 2;               // 0.1582 of frame width
console.log(`9:16 window half-width = ${HALFWIN.toFixed(4)} of frame width = ${(HALFWIN*1920).toFixed(0)} px on 1920`);
console.log('turn | debounce-committed pulse | peak crop x | miss vs head 0.70 | px @1920 | speaker in window?');
for (const D of [1,1.5,2,2.5,3,4,5,6,8]) {
  const s = 200, n = Math.round(D/SI);
  const st = new DebounceState();
  const raw = Array.from({length: N}, (_, i) => {
    const t = i*SI;
    const inTurn = i >= s && i < s+n;
    const key = inTurn ? 'r1' : 'r0';
    const cand = inTurn ? B : A;
    const c = applyDebounce(st, key, t, cand);
    return { t: +t.toFixed(3), x: c ?? (A+B)/2 };
  });
  const out = smoothKeyframes(raw, [0], 1.2, SI);
  const peak = Math.max(...out.map(k => k.x));
  const miss = B - peak;
  console.log(`${String(D).padStart(4)}s | ${(raw.filter(k=>k.x===B).length*SI).toFixed(2)}s | ${peak.toFixed(3)} | ${miss.toFixed(3)} | ${(miss*1920).toFixed(0)} px | ${miss < HALFWIN ? 'yes' : 'NO — off-screen'}`);
}
