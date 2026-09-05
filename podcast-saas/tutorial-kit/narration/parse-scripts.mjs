// Extract the verbatim narration lines from the five film scripts into lines.json (+ films.json).
// The scripts are the single source of truth (post-gate, locked); this parser reads their
// markdown tables so narration, captions, and overlay timing all derive from one place.
//
// v3 tables carry a KIND column (VIDEO | LIVE-WINDOW <sim> [(cont.)]) ahead of NARRATION, so
// columns are located by HEADER NAME, never by position. A beat is silent ONLY when its narration
// cell starts with ∅ — narration spoken OVER a live window is still narration and gets a clip.
// The in-film viewer question is read from the ∅ beat's ON SCREEN cell (its first quoted "…?")
// rather than from a copy kept here, so a script rewrite cannot leave a stale question behind.
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

function parseTimeRange(t) {
  // "0:04–0:14" → { t0: 4, t1: 14 }
  const m = t.match(/(\d+):(\d+(?:\.\d+)?)\s*[–-]\s*(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { t0: +m[1] * 60 + +m[2], t1: +m[3] * 60 + +m[4] };
}

function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function columnMap(cells) {
  // Header row → { scene, time, kind, narration, screen } column indices.
  const map = {};
  cells.forEach((c, i) => {
    const n = c.toLowerCase();
    if (n === '#') map.scene = i;
    else if (n === 't') map.time = i;
    else if (n.startsWith('kind')) map.kind = i;
    else if (n.startsWith('narration')) map.narration = i;
    else if (n.startsWith('on screen')) map.screen = i;
  });
  return map.scene != null && map.time != null && map.narration != null ? map : null;
}

function parseKind(raw) {
  // "LIVE-WINDOW kinesin (cont.)" → { kind: 'LIVE-WINDOW', window: 'kinesin', cont: true }
  if (!raw) return { kind: null, window: null, cont: false };
  const m = raw.match(/^(VIDEO|LIVE-WINDOW)\s*([A-Za-z0-9_-]+)?\s*(\(cont\.?\))?/i);
  if (!m) return { kind: raw, window: null, cont: false };
  return { kind: m[1].toUpperCase(), window: m[2] ?? null, cont: !!m[3] };
}

function filmMeta(md, film, file) {
  const h1 = md.split('\n').find((l) => l.startsWith('# ')) ?? '';
  const title = h1.match(/"([^"]+)"/)?.[1] ?? null;
  const version = h1.match(/·\s*(v[\d.]+)/)?.[1] ?? null;
  const tm = h1.match(/target ~(\d+)(?::(\d+))?s?/);
  const targetSec = tm ? (tm[2] != null ? +tm[1] * 60 + +tm[2] : +tm[1]) : null;
  return { film, file, title, version, targetSec };
}

const out = [];
const meta = [];
for (const { film, file } of films) {
  const md = readFileSync(join(SCRIPTS, file), 'utf8');
  const fm = filmMeta(md, film, file);
  let cols = null;
  let words = 0, silent = 0, viewer = 0, beats = 0;
  for (const line of md.split('\n')) {
    const cells = splitRow(line);
    if (!cells) continue;
    if (cells[0] === '#') { cols = columnMap(cells); continue; }
    if (!cols) continue;
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;       // the |---|---| separator
    const scene = cells[cols.scene];
    if (!/^\d+[abc]?$/.test(scene ?? '')) continue;
    const time = parseTimeRange(cells[cols.time] ?? '');
    if (!time) continue;
    const { kind, window, cont } = parseKind(cols.kind != null ? cells[cols.kind] : null);
    let text = (cells[cols.narration] ?? '').trim();
    const screen = cols.screen != null ? (cells[cols.screen] ?? '') : '';
    beats++;
    if (text.startsWith('∅')) {
      // Narrator silent. The exchange's spoken question lives in the ON SCREEN cell.
      silent++;
      const q = screen.match(/["“]([^"”]*\?)["”]/);
      if (q) {
        viewer++;
        out.push({ film, scene: `${scene}-viewer`, role: 'viewer', kind, window, t0: time.t0, t1: time.t1, text: q[1].trim() });
      }
      continue;
    }
    // strip markdown emphasis; keep punctuation (TTS pacing and the pause editor depend on it)
    text = text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    words += text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
    out.push({ film, scene, role: 'narrator', kind, window, cont, t0: time.t0, t1: time.t1, text });
  }
  if (!cols) throw new Error(`${file}: no table header row found`);
  meta.push({ ...fm, beats, narratorLines: beats - silent, silentBeats: silent, viewerLines: viewer, words });
}

mkdirSync(join(HERE, 'audio'), { recursive: true });
writeFileSync(join(HERE, 'lines.json'), JSON.stringify(out, null, 2));
writeFileSync(join(HERE, 'films.json'), JSON.stringify(meta, null, 2));

const perFilm = {};
for (const l of out) perFilm[l.film] = (perFilm[l.film] ?? 0) + 1;
console.log(JSON.stringify({
  lines: out.length,
  perFilm,
  narratorWords: meta.reduce((n, f) => n + f.words, 0),
  viewerLines: out.filter((l) => l.role === 'viewer').map((l) => `f${l.film}-s${l.scene}: ${l.text}`),
  chars: out.reduce((n, l) => n + l.text.length, 0),
  films: meta,
}, null, 2));
