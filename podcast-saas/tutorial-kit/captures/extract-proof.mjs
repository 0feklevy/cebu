// Cut 3 proof frames per shot out of the recorded webms, at each shot's key beats.
// Reads out/MANIFEST.json (shot → webm) and out/beats/<id>.json (beat name → sec into the shot),
// writes out/proof/<id>-{1,2,3}.png. Usage: node extract-proof.mjs [shotId ...]
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const PROOF = join(OUT, 'proof');
mkdirSync(PROOF, { recursive: true });

// Per-shot: three [beatName(s), offsetSec] picks. First existing beat name wins.
const PICKS = {
  'f2-s2a-new-project': [[['dialog'], 0.5], [['titled'], -0.3], [['editor'], 0.5]],
  'f2-s2b-library-drop': [[['drop1'], -0.5], [['cards1'], 0.5], [['cards2'], 1.5]],
  'f2-s3-mark-section': [[['v1-ready'], 0.3], [['dragged'], -0.6], [['editor-open'], 0.5]],
  'f2-s4-this-moment': [[['prompt-typed'], -0.4], [['switches-on'], 0.2], [['generated'], 1.5]],
  'f2-s5-preview-run': [[['preview-tab'], 0.3], [['run'], 3], [['played'], -0.3]],
  'f2-s6-layers': [[['broll-box'], 1.2], [['audio-on-a2'], 1], [['choice-point', 'branching-open'], 1]],
  'f2-s8-share': [[['permalink-typed'], -0.4], [['published'], 0.8], [['podcast-building', 'rows-hovered'], 0.8]],
  'f3-s2-heavy-drop': [[['dropped'], -0.5], [['dropped'], 2.2], [['card'], 1.5]],
  'f3-s3-simple-ui': [[['this-moment'], 0.3], [['simple-ui-on'], 0.2], [['collapsed-controls'], -0.3]],
  'f3-s4-iteration': [[['advanced-open'], 0.3], [['followup-typed'], -0.4], [['last-generation', 'generated'], 1.5]],
};

const manifest = JSON.parse(readFileSync(join(OUT, 'MANIFEST.json'), 'utf8'));
const onlyIds = process.argv.slice(2);

for (const [id, entry] of Object.entries(manifest)) {
  if (onlyIds.length && !onlyIds.includes(id)) continue;
  if (!entry.file || !existsSync(entry.file)) { console.log(`${id}: no webm (${entry.error ?? 'missing'})`); continue; }
  const beatsPath = join(OUT, 'beats', `${id}.json`);
  const beats = existsSync(beatsPath) ? JSON.parse(readFileSync(beatsPath, 'utf8')) : [];
  const at = (names) => { for (const n of names) { const b = beats.find((x) => x.name === n); if (b) return b.sec; } return null; };
  const picks = PICKS[id] ?? [[[], 1], [[], 5], [[], 9]];
  picks.forEach(([names, off], i) => {
    let t = at(names);
    if (t == null) t = 1 + i * 4; // no beat recorded — spread guesses
    t = Math.max(0.2, t + off);
    const png = join(PROOF, `${id}-${i + 1}.png`);
    const grab = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, '-frames:v', '1', png], { stdio: 'pipe' });
    try {
      grab(['-ss', String(t), '-i', entry.file]);
      if (!existsSync(png) || statSync(png).size === 0) throw new Error('empty');
    } catch {
      try { grab(['-sseof', '-0.5', '-i', entry.file]); console.log(`${id}-${i + 1}: t=${t}s past EOF, took last frame`); }
      catch (e) { console.log(`${id}-${i + 1}: FAILED (${String(e).slice(0, 80)})`); return; }
    }
    console.log(`${id}-${i + 1}: ${t.toFixed(1)}s -> ${png}`);
  });
}
