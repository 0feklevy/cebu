// Extract the verbatim narration lines from the five film scripts into lines.json.
// The scripts are the single source of truth (post-gate, locked); this parser reads their
// markdown tables so narration, captions, and overlay timing all derive from one place.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '../scripts');

const films = [
  { film: 1, file: 'SCRIPT-1-TEASER.md' },
  { film: 2, file: 'SCRIPT-2-TUTORIAL.md' },
  { film: 3, file: 'SCRIPT-3-HEAVY-SIM.md' },
  { film: 4, file: 'SCRIPT-4-VIEWER-POWERS.md' },
  { film: 5, file: 'SCRIPT-5-SHARE.md' },
];

// The two in-film VIEWER lines (spoken by a distinct voice, not the narrator).
const viewerLines = [
  { film: 1, scene: '3b-viewer', text: 'Why does it move in eight-nanometer steps?' },
  { film: 4, scene: '3b-viewer', text: "Why doesn't the moon crash into the earth?" },
];

function parseTimeRange(t) {
  // "0:04–0:14" → { t0: 4, t1: 14 }
  const m = t.match(/(\d+):(\d+(?:\.\d+)?)\s*[–-]\s*(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { t0: +m[1] * 60 + +m[2], t1: +m[3] * 60 + +m[4] };
}

const out = [];
for (const { film, file } of films) {
  const md = readFileSync(join(SCRIPTS, file), 'utf8');
  for (const line of md.split('\n')) {
    // Table rows: | # | t | NARRATION | ON SCREEN |
    const m = line.match(/^\|\s*(\d+[abc]?)\s*\|\s*([^|]+)\|\s*([^|]+)\|/);
    if (!m) continue;
    const scene = m[1];
    const time = parseTimeRange(m[2]);
    let text = m[3].trim();
    if (!time) continue;
    if (text.startsWith('∅')) continue;             // narrator yields — no clip
    // strip markdown emphasis; keep punctuation (TTS pacing depends on it)
    text = text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    out.push({ film, scene, role: 'narrator', t0: time.t0, t1: time.t1, text });
  }
}
out.push(...viewerLines.map(v => ({ ...v, role: 'viewer', t0: null, t1: null })));

mkdirSync(join(HERE, 'audio'), { recursive: true });
writeFileSync(join(HERE, 'lines.json'), JSON.stringify(out, null, 2));

const perFilm = {};
for (const l of out) perFilm[l.film] = (perFilm[l.film] ?? 0) + 1;
const words = out.filter(l => l.role === 'narrator').reduce((n, l) => n + l.text.split(' ').length, 0);
console.log(JSON.stringify({ lines: out.length, perFilm, narratorWords: words,
  chars: out.reduce((n, l) => n + l.text.length, 0) }, null, 2));
