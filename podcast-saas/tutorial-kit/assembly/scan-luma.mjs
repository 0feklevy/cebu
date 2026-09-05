// Where does a take actually have a picture? Prints the average luma of one frame per second, so an
// EDL `in` can be chosen from the footage instead of guessed — the offsets that produced a
// mostly-black first cut were all guesses that had outlived the take they were measured against.
//
//   node assembly/scan-luma.mjs <shotId|path> [stepSec]
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = process.argv[2];
const step = Number(process.argv[3] ?? 1);
if (!arg) { console.error('usage: scan-luma.mjs <shotId|path> [stepSec]'); process.exit(1); }

const manifestPath = join(KIT, 'captures/out/MANIFEST.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const resolve = () => {
  if (arg.includes('/')) return arg.startsWith('/') ? arg : join(KIT, arg);
  if (manifest[arg]?.file && existsSync(manifest[arg].file)) return manifest[arg].file;
  for (const ext of ['.webm', '.mp4']) {
    const p = join(KIT, 'captures/out', arg + ext);
    if (existsSync(p)) return p;
  }
  return null;
};
const file = resolve();
if (!file) { console.error(`no such shot or file: ${arg}`); process.exit(1); }

const dur = Number(execSync(`ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${file}"`).toString().trim());
console.log(`${file}\n${dur.toFixed(2)}s — average luma per ${step}s (a real UI frame is well over 24; below that is a load flash or a poster)\n`);
for (let t = 0; t < dur - 0.05; t += step) {
  const s = spawnSync('ffmpeg', ['-hide_banner', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1',
    '-vf', 'signalstats,metadata=print', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).stderr ?? '';
  const y = Number((s.match(/YAVG=([\d.]+)/) ?? [])[1] ?? NaN);
  const bar = Number.isFinite(y) ? '█'.repeat(Math.min(40, Math.round(y / 4))) : '';
  console.log(`  ${t.toFixed(1).padStart(6)}s  ${Number.isFinite(y) ? y.toFixed(1).padStart(6) : '     -'}  ${bar}${Number.isFinite(y) && y < 24 ? '  ← dark' : ''}`);
}
