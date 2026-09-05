// Acceptance check for the live-window plates: they must be BRIGHT from the first frame and MOVING
// the whole way through — a plate that is black for its first second defeats its own purpose, and a
// static one is just a still under the film.
//
//   node check-plates.mjs
//
// For each plate: duration vs the window's requirement, mean luma at several points, and the mean
// frame-to-frame difference between 1-second-apart samples (0 = frozen).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const REQUIRED = { 'plate-kinesin': 10, 'plate-solar': 10, 'plate-murmuration': 9, 'plate-orbitlab': 14 };

// ffmpeg's metadata=print goes to stderr, so BOTH streams have to be read (see shot-utils meanLuma).
const ff = (args) => {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};
const yavg = (out) => { const m = [...out.matchAll(/YAVG=([\d.]+)/g)].map((x) => Number(x[1])); return m.length ? m[m.length - 1] : null; };

const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f], { encoding: 'utf8' }).trim());
const lumaAt = (f, t, tmp) => {
  const p = join(tmp, `l${String(t).replace('.', '_')}.png`);
  ff(['-v', 'error', '-y', '-ss', String(t), '-i', f, '-frames:v', '1', p]);
  if (!existsSync(p)) return null;
  // -v info, NOT -v error: metadata=print writes at info level, and silencing it makes every
  // measurement null — which an earlier version of this script then reported as a pass.
  return yavg(ff(['-v', 'info', '-i', p, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']));
};
const motionBetween = (f, t1, t2, tmp) => {
  const a = join(tmp, 'a.png'); const b = join(tmp, 'b.png');
  ff(['-v', 'error', '-y', '-ss', String(t1), '-i', f, '-frames:v', '1', a]);
  ff(['-v', 'error', '-y', '-ss', String(t2), '-i', f, '-frames:v', '1', b]);
  if (!existsSync(a) || !existsSync(b)) return null;
  return yavg(ff(['-v', 'info', '-i', a, '-i', b, '-filter_complex',
    'blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']));
};

let bad = 0;
for (const [id, need] of Object.entries(REQUIRED)) {
  const f = join(OUT, `${id}.webm`);
  if (!existsSync(f)) { console.log(`✗ ${id.padEnd(19)} MISSING`); bad++; continue; }
  const tmp = mkdtempSync(join(tmpdir(), 'plate-'));
  try {
    const d = dur(f);
    const pts = [0.15, 1, Math.max(2, d / 2), Math.max(3, d - 0.6)];
    const lumas = pts.map((t) => lumaAt(f, t, tmp));
    const motions = [];
    for (let t = 0.5; t + 1 < d; t += Math.max(1, (d - 1) / 5)) motions.push(motionBetween(f, t, t + 1, tmp));
    // A measurement that did not happen is a FAILURE, never a pass. The first version of this
    // script measured nothing (silenced ffmpeg output), took Math.min of an empty list — Infinity —
    // and printed "all plates pass" over four unexamined files.
    const gotL = lumas.filter((x) => x != null), gotM = motions.filter((x) => x != null);
    const measured = gotL.length === lumas.length && gotM.length === motions.length && gotM.length > 0;
    const minL = gotL.length ? Math.min(...gotL) : null;
    const minM = gotM.length ? Math.min(...gotM) : null;
    const okDur = d >= need, okLuma = measured && minL >= 6, okMotion = measured && minM >= 0.8;
    if (!measured) console.log(`  ! ${id}: could not measure ${lumas.length - gotL.length} luma / ${motions.length - gotM.length} motion samples`);
    const flag = okDur && okLuma && okMotion ? '✓' : '✗';
    if (flag === '✗') bad++;
    console.log(`${flag} ${id.padEnd(19)} ${d.toFixed(2)}s (need ${need}s)${okDur ? '' : ' TOO SHORT'}  luma[${lumas.map((x) => (x == null ? '?' : x.toFixed(1))).join(' ')}]${okLuma ? '' : ' TOO DARK'}  motion[${motions.map((x) => (x == null ? '?' : x.toFixed(1))).join(' ')}]${okMotion ? '' : ' TOO STATIC'}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
console.log(bad ? `\n${bad} plate(s) need attention` : '\nall plates pass: long enough, bright from the first frame, moving throughout');
