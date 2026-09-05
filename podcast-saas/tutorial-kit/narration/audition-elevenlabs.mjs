// ElevenLabs narrator audition — small (~2k chars), measured, no ears. Renders the teaser hook
// (f1-s2), the four-beat close (f1-s10) and the longest film-2 tutorial line with each narrator
// candidate on eleven_multilingual_v2, the two best-labelled candidates again on eleven_v3, and the
// film-4 viewer question with the viewer candidates. Every clip gets the same film context
// (previous_text / next_text) production will send, so the numbers are the numbers the films get.
//
//   node audition-elevenlabs.mjs --auth <path/to/el-auth.json> [--out audition-el] [--force]
//
// Outputs (narration/audition-el/): <Voice>-<model>-<line>.mp3, measurements.json, and the tables
// of ../AUDITION-EL.md (the pick and its reasoning are written by hand under the tables).
// Idempotent: existing clips are measured, not re-bought, unless --force.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  loadAuth, ttsRequest, fetchSubscription, measureFile, wordsFromAlignment, checkBeats, settingsFor,
  contextFor, wordCount, voiceName, modelShort, ElevenLabsError, BEAT_CHECKS, clipId, VOICES,
} from './synthesize-elevenlabs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const force = flag('--force');
const OUT = isAbsolute(opt('--out', 'audition-el')) ? opt('--out') : join(HERE, opt('--out', 'audition-el'));
mkdirSync(OUT, { recursive: true });

const byName = (n) => Object.entries(VOICES).find(([, v]) => v.name === n)[0];
const V2 = { model: 'eleven_multilingual_v2', stability: 0.45, similarity: 0.8, style: 0.4, boost: true, speed: 1.05 };
const V3 = { model: 'eleven_v3', stability: 0.5, similarity: 0.8, style: 0.4, boost: true, speed: null };
const NARRATORS_V2 = ['Liam', 'Brian', 'Eric', 'Adam', 'Bill', 'Sarah'];
const NARRATORS_V3 = ['Liam', 'Brian'];
const VIEWERS_V2 = ['Sarah', 'Bella'];
// The refit ceiling, on the default candidate: does Liam reach the pace floor at the speed the
// synthesizer is allowed to use? (At 1.05 the hook measured 144 wpm — under the 150 floor.)
const SPEED_VARIANTS = [{ voice: 'Liam', speed: 1.12 }];

// ---------------------------------------------------------------- the lines (from lines.json, verbatim)
const lines = JSON.parse(readFileSync(join(HERE, 'lines.json'), 'utf8'));
const at = (film, scene) => lines.findIndex((l) => l.film === film && String(l.scene) === String(scene));
const f2 = lines.map((l, i) => ({ l, i })).filter((x) => x.l.film === 2 && x.l.role === 'narrator').sort((a, b) => b.l.text.length - a.l.text.length)[0];
const LINES = {
  hook: at(1, '2'),
  close: at(1, '10'),
  tutorial: f2.i,
  viewer: lines.findIndex((l) => l.role === 'viewer'),
};
for (const [k, i] of Object.entries(LINES)) if (i < 0) { console.error(`line "${k}" not found in lines.json`); process.exit(2); }
const spoken = (l) => l.text;

let auth;
try { auth = loadAuth(opt('--auth', null)); } catch (e) { console.error(e.message); process.exit(2); }
const fatal = (e) => { console.error(`\n✗ ${e.message}\n  stopping.`); process.exit(1); };
let subBefore = null;
try { subBefore = await fetchSubscription(auth); } catch (e) { if (e.fatal) fatal(e); throw e; }
if (subBefore) console.log(`quota before: ${subBefore.used}/${subBefore.limit} (${subBefore.remaining} remaining)`);

const measPath = join(OUT, 'measurements.json');
const prior = existsSync(measPath) ? JSON.parse(readFileSync(measPath, 'utf8')) : { takes: [] };
const takes = [];
let charsSent = 0, requests = 0;

async function take(voiceName_, preset, lineKey, { speed = preset.speed, tag = '' } = {}) {
  const voiceId = byName(voiceName_);
  const idx = LINES[lineKey];
  const l = lines[idx];
  const file = join(OUT, `${voiceName_}-${modelShort(preset.model)}${tag}-${lineKey}.mp3`);
  const ctx = contextFor(lines, idx, spoken);
  const words = wordCount(l.text);
  let words_ = null, requestId = null, characterCost = null, endpoint = null, voiceSettings = null;
  if (existsSync(file) && !force) {
    const old = prior.takes.find((t) => t.file === file);
    words_ = old?.words ?? null; requestId = old?.requestId ?? null; characterCost = old?.characterCost ?? null; endpoint = old?.endpoint ?? 'kept'; voiceSettings = old?.voiceSettings ?? null;
  } else {
    voiceSettings = settingsFor(preset.model, { stability: preset.stability, similarity: preset.similarity, style: preset.style, boost: preset.boost, speed: speed ?? 1.0 });
    let r;
    try {
      r = await ttsRequest(auth, { voiceId, text: l.text, modelId: preset.model, voiceSettings, ...ctx });
    } catch (e) {
      if (e instanceof ElevenLabsError && e.fatal) fatal(e);
      console.error(`✗ ${voiceName_} ${modelShort(preset.model)} ${lineKey}: ${e.message}`);
      takes.push({ voice: voiceName_, voiceId, model: preset.model, line: lineKey, file, failed: true, error: e.message.slice(0, 200) });
      return;
    }
    requests++; charsSent += l.text.length;
    writeFileSync(file, r.mp3);
    words_ = wordsFromAlignment(r.alignment); requestId = r.requestId; characterCost = r.characterCost; endpoint = r.endpoint;
  }
  const m = measureFile(file);
  const speechSec = Math.max(0.05, m.dur - m.lead - m.tail - m.innerGaps.reduce((n, g) => n + g / 1000, 0));
  const beats = lineKey === 'close' ? checkBeats(words_, m, BEAT_CHECKS['f1-s10'].beats) : null;
  // wpm on the clip as delivered, and on the clip with its lead/tail silence cut to what a refit
  // trim keeps (80/200ms) — the figure comparable to the Edge audition, which measured after trimming.
  const trimmedDur = m.dur - Math.max(0, m.lead - 0.08) - Math.max(0, m.tail - 0.2);
  const t = {
    voice: voiceName_, voiceId, labels: VOICES[voiceId].labels, model: preset.model, line: lineKey, clip: clipId(l), text: l.text, file,
    tag, speed: voiceSettings?.speed ?? null,
    voiceSettings, endpoint, requestId, characterCost, chars: l.text.length, nWords: words,
    dur: m.dur, wpm: +((words / m.dur) * 60).toFixed(0), trimmedDur: +trimmedDur.toFixed(2), trimmedWpm: +((words / trimmedDur) * 60).toFixed(0), articWpm: +((words / speechSec) * 60).toFixed(0),
    rms: m.rms, peak: m.peak, truePeak: m.truePeak, lufs: m.lufs, lra: m.lra, lead: m.lead, tail: m.tail, innerGaps: m.innerGaps,
    beats, words: words_,
  };
  takes.push(t);
  console.log(`  ${`${voiceName_}-${modelShort(preset.model)}${tag}-${lineKey}`.padEnd(40)} ${m.dur.toFixed(2)}s  ${String(t.wpm).padStart(3)} wpm (trimmed ${t.trimmedWpm}, artic ${t.articWpm})  rms ${m.rms} peak ${m.peak} tp ${m.truePeak}  lufs ${m.lufs} lra ${m.lra}  lead/tail ${Math.round(m.lead * 1000)}/${Math.round(m.tail * 1000)}  gaps [${m.innerGaps.join(',')}]${beats ? `  beats ${beats.ok ? 'OK' : 'RUN-ON'} ${JSON.stringify(beats.beats.map((b) => b.silenceMs ?? '?'))}` : ''}${endpoint === 'kept' ? '  (kept)' : ''}`);
}

for (const v of NARRATORS_V2) { console.log(`\n${v} · ${V2.model}`); for (const k of ['hook', 'tutorial', 'close']) await take(v, V2, k); }
for (const { voice, speed } of SPEED_VARIANTS) { console.log(`\n${voice} · ${V2.model} · speed ${speed}`); for (const k of ['hook', 'tutorial', 'close']) await take(voice, V2, k, { speed, tag: `-speed${speed}` }); }
for (const v of NARRATORS_V3) { console.log(`\n${v} · ${V3.model}`); for (const k of ['hook', 'tutorial', 'close']) await take(v, V3, k); }
console.log(`\nviewer question · ${V2.model} · speed 1.0`);
for (const v of VIEWERS_V2) await take(v, V2, 'viewer', { speed: 1.0 });

let subAfter = null;
try { subAfter = await fetchSubscription(auth); } catch { /* below */ }
const quotaDelta = subBefore && subAfter ? subAfter.used - subBefore.used : null;
const ccSum = takes.reduce((n, t) => n + (t.characterCost ?? 0), 0);
console.log(`\n${requests} requests · ${charsSent} chars sent · Σ character-cost ${ccSum}${quotaDelta != null ? ` · quota moved ${quotaDelta}` : ''}${subAfter ? ` · remaining ${subAfter.remaining}` : ''}`);

writeFileSync(measPath, JSON.stringify({
  date: new Date().toISOString(), presets: { V2, V3 }, lines: Object.fromEntries(Object.entries(LINES).map(([k, i]) => [k, { clip: clipId(lines[i]), text: lines[i].text, words: wordCount(lines[i].text), chars: lines[i].text.length }])),
  requests, charsSent, characterCostSum: ccSum, quotaBefore: subBefore, quotaAfter: subAfter, quotaDelta, takes,
}, null, 2));

// ---------------------------------------------------------------- AUDITION-EL.md tables
const ok = takes.filter((t) => !t.failed);
const combined = [];
const T = (v, m, k, tag = '') => ok.find((t) => t.voice === v && t.model === m && t.line === k && (t.tag ?? '') === tag);
const fmt = (x, d = 1) => (x == null ? '—' : Number(x).toFixed(d));
const narratorRows = [];
const cells = [
  ...NARRATORS_V2.map((v) => ({ v, preset: V2, tag: '', label: `${modelShort(V2.model)} @${V2.speed}` })),
  ...SPEED_VARIANTS.map(({ voice, speed }) => ({ v: voice, preset: V2, tag: `-speed${speed}`, label: `${modelShort(V2.model)} @${speed}` })),
  ...NARRATORS_V3.map((v) => ({ v, preset: V3, tag: '', label: modelShort(V3.model) })),
];
for (const { v, preset, tag, label } of cells) {
  const h = T(v, preset.model, 'hook', tag), tu = T(v, preset.model, 'tutorial', tag), c = T(v, preset.model, 'close', tag);
  if (!h || !tu || !c) { narratorRows.push(`| ${v} | ${label} | FAILED | | | | | | | | | | |`); continue; }
  const lra = (h.lra + tu.lra + c.lra) / 3, tp = Math.max(h.truePeak, tu.truePeak, c.truePeak), lufs = (h.lufs + tu.lufs + c.lufs) / 3;
  narratorRows.push(`| ${v} | ${label} | ${fmt(h.dur, 2)} | **${h.wpm}** / ${h.trimmedWpm} | ${h.articWpm} | ${fmt(tu.dur, 2)} | **${tu.wpm}** / ${tu.trimmedWpm} | ${tu.articWpm} | ${fmt(c.dur, 2)} (${c.wpm}) | ${c.beats?.ok ? 'OK' : 'RUN-ON'} [${(c.beats?.beats ?? []).slice(1).map((b) => b.silenceMs ?? '?').join(', ')}] | ${fmt(lufs)} | **${fmt(lra)}** (${fmt(h.lra)}/${fmt(tu.lra)}/${fmt(c.lra)}) | ${fmt(tp)} |`);
}
// One file per candidate (hook · tutorial · close, 0.7s apart): the thing to LISTEN to, and the only
// honest LRA here — loudness range needs 3s windows, so a 4–8s clip cannot show a range.
const combinedRows = [];
for (const { v, preset, tag, label } of cells) {
  const parts = ['hook', 'tutorial', 'close'].map((k) => T(v, preset.model, k, tag)).filter(Boolean);
  if (parts.length !== 3) continue;
  const file = join(OUT, `${v}-${modelShort(preset.model)}${tag}.mp3`);
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...parts.flatMap((p) => ['-i', p.file]), '-filter_complex',
    '[0:a]apad=pad_dur=0.7[a0];[1:a]apad=pad_dur=0.7[a1];[a0][a1][2:a]concat=n=3:v=0:a=1[out]', '-map', '[out]',
    '-codec:a', 'libmp3lame', '-b:a', '128k', file], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`combined ${file}: ${r.stderr.slice(0, 200)}`); continue; }
  const m = measureFile(file);
  const nWords = parts.reduce((n, p) => n + p.nWords, 0);
  const speech = m.dur - 1.4;
  const entry = { voice: v, model: preset.model, tag, label, file, dur: m.dur, words: nWords, wpm: Math.round((nWords / speech) * 60), lufs: m.lufs, lra: m.lra, truePeak: m.truePeak, rms: m.rms };
  combined.push(entry);
  combinedRows.push(`| ${v} | ${label} | \`${file.split('/').pop()}\` | ${fmt(m.dur, 2)} | ${entry.wpm} | ${fmt(m.lufs)} | **${fmt(m.lra)}** | ${fmt(m.truePeak)} |`);
}
writeFileSync(measPath, JSON.stringify({ ...JSON.parse(readFileSync(measPath, 'utf8')), combined }, null, 2));

const clipRows = ok.map((t) => `| \`${t.file.split('/').pop()}\` | ${t.clip} | ${t.nWords} | ${fmt(t.dur, 2)} | ${t.wpm} | ${t.trimmedWpm} | ${t.articWpm} | ${fmt(t.rms)} | ${fmt(t.peak)} | ${fmt(t.truePeak)} | ${fmt(t.lufs)} | ${fmt(t.lra)} | ${Math.round(t.lead * 1000)} / ${Math.round(t.tail * 1000)} | [${t.innerGaps.join(', ')}] | ${t.beats ? (t.beats.beats ?? []).map((b) => `${b.beat}${b.gapMs != null ? ` ${b.gapMs}/${b.silenceMs}` : ''}`).join(' · ') : ''} |`);
const v3Rows = [];
for (const v of NARRATORS_V3) for (const k of ['hook', 'tutorial', 'close']) {
  const a = T(v, V2.model, k), b = T(v, V3.model, k);
  if (!a || !b) continue;
  const ratio = b.dur / a.dur;
  const clean = b.dur >= 0.4 && ratio <= 3 && Math.abs(ratio - 1) <= 0.2;
  v3Rows.push(`| ${v} | ${k} | ${fmt(a.dur, 2)} | ${fmt(b.dur, 2)} | ${fmt(ratio, 2)} | ${a.wpm} → ${b.wpm} | ${fmt(a.lra)} → ${fmt(b.lra)} | ${k === 'close' ? `${a.beats?.ok ? 'OK' : 'run-on'} → ${b.beats?.ok ? 'OK' : 'run-on'}` : ''} | ${clean ? 'clean' : (Math.abs(ratio - 1) > 0.2 ? 'OUTSIDE ±20%' : 'suspect')} |`);
}
const viewerRows = VIEWERS_V2.map((v) => { const t = T(v, V2.model, 'viewer'); return t ? `| ${v} | ${t.labels} | ${fmt(t.dur, 2)} | ${t.wpm} | ${fmt(t.rms)} | ${fmt(t.truePeak)} | ${fmt(t.lufs)} | ${fmt(t.lra)} |` : `| ${v} | | FAILED | | | | | |`; });

const md = [
  '# Narrator audition — ElevenLabs premade voices',
  '',
  `Generated ${new Date().toISOString()} by \`narration/audition-elevenlabs.mjs\`. **Nobody who wrote this could hear the clips**;`,
  'every column is a measurement (ffprobe / ffmpeg astats / ebur128 / silencedetect) or the vendor\'s own label. Clips in',
  '`narration/audition-el/<Voice>-<model>-<line>.mp3`, raw as delivered (no trims, no pause editing — unlike the Edge audition,',
  'ElevenLabs speaks the punctuation itself). Each clip was rendered with the SAME previous_text/next_text the film sends.',
  '',
  `Lines (verbatim from lines.json): hook = f1-s2 "${lines[LINES.hook].text}" (${wordCount(lines[LINES.hook].text)} words) ·`,
  `tutorial = f2-s${lines[LINES.tutorial].scene}, the longest film-2 line, "${lines[LINES.tutorial].text}" (${wordCount(lines[LINES.tutorial].text)} words) ·`,
  `close = f1-s10 "${lines[LINES.close].text}" (${wordCount(lines[LINES.close].text)} words) · viewer = f4-s5-viewer "${lines[LINES.viewer].text}".`,
  '',
  `Settings — v2 (\`${V2.model}\`): stability ${V2.stability} · similarity ${V2.similarity} · style ${V2.style} · speaker boost · speed ${V2.speed}.`,
  `v3 (\`${V3.model}\`): stability ${V3.stability} (natural preset) · similarity ${V3.similarity} · style ${V3.style} · speaker boost · no speed (v3 ignores it). Viewer: v2, speed 1.0.`,
  `Spend: ${requests} requests, ${charsSent} chars sent${quotaDelta != null ? `, quota counter moved ${quotaDelta}` : ''}${ccSum ? `, Σ character-cost headers ${ccSum}` : ''}${subAfter ? ` — ${subAfter.remaining} chars remaining` : ''}.`,
  '',
  '## Criteria (a kinetic US SaaS trailer, imperative lines)',
  '',
  '1. **Pace** — overall wpm (words ÷ clip length). Hook target 165–185, never under 150; the tutorial line is the sustained-pace check.',
  '   "artic." = words ÷ time actually speaking (clip minus lead, tail and every silence ≥150ms at −35dB) — the voice\'s tempo apart from its pauses.',
  '2. **Dynamic range** — LRA (loudness range, LU) per clip: 6–12 reads as expressive, under 4 flat. Averaged over the three lines, with the three shown.',
  '3. **No clipping** — true peak (ebur128) must stay under 0 dBFS; astats sample peak alongside.',
  '4. **Four beats** — the close must break into "Touch it." / "Ask it." / "Steer it." / "Flow Video.": the gap before each beat after the first',
  '   must register as a silence ≥150ms at −35dB (silencedetect), located by the word alignment the API returns.',
  '5. **Label fit** — confident / energetic for a marketing read, not comforting: Liam *energetic, confident, social media, young* · Brian *deep, resonant,',
  '   classy* · Eric *smooth, trustworthy* · Adam *dominant, firm* · Bill *advertisement, older, crisp* · Sarah *mature, reassuring, confident, TV*.',
  '6. **eleven_v3 sanity** — v3 is the expressive model but can hallucinate on short lines: a v3 clip counts as clean only if its length is within',
  '   ±20% of the same voice\'s v2 clip, never under 0.4s, never 3× too long.',
  '',
  '## Narrators',
  '',
  'wpm is shown **as delivered** / trimmed (lead cut to ≤80ms, tail to ≤200ms — what a refit trim keeps, and the figure the Edge',
  'audition reported). ElevenLabs clips start on the word (lead 0 on every clip here) and carry a 0–0.9s tail.',
  '',
  '| voice | model @speed | hook s | hook wpm / trimmed | artic. | tutorial s | tut. wpm / trimmed | artic. | close s (wpm) | close beats (silence ms before Ask / Steer / Flow) | LUFS | LRA mean (h/t/c) | true peak dBFS |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...narratorRows,
  '',
  '## One file per candidate — hook · tutorial · close, 0.7s apart (listen to these)',
  '',
  'LRA measured over the ~17s of the three lines together — the only loudness-range figure here with enough audio under it.',
  'wpm = 43 words ÷ (length − the two 0.7s joins).',
  '',
  '| voice | model @speed | file | s | wpm | LUFS | LRA (LU) | true peak dBFS |',
  '|---|---|---|---|---|---|---|---|',
  ...combinedRows,
  '',
  '## eleven_v3 against eleven_multilingual_v2 @1.05, same voice, same line',
  '',
  'v3 refuses previous_text / next_text (HTTP 400 unsupported_model, measured), so its clips are rendered without film context.',
  '',
  '| voice | line | v2 s | v3 s | ratio | wpm v2 → v3 | LRA v2 → v3 | beats | verdict |',
  '|---|---|---|---|---|---|---|---|---|',
  ...v3Rows,
  '',
  '## Viewer question (f4-s5-viewer, v2, speed 1.0)',
  '',
  '| voice | labels | s | wpm | RMS dBFS | true peak | LUFS | LRA |',
  '|---|---|---|---|---|---|---|---|',
  ...viewerRows,
  '',
  '## Every clip',
  '',
  '| file | clip | words | s | wpm | trimmed wpm | artic. | RMS dBFS | peak | true peak | LUFS | LRA | lead / tail ms | inner silences ≥150ms (ms) | beats: gap by alignment / silence (ms) |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...clipRows,
  '',
].join('\n');
writeFileSync(join(HERE, 'AUDITION-EL.md'), md);
console.log(`wrote ${join(HERE, 'AUDITION-EL.md')} and ${measPath}`);
if (takes.some((t) => t.failed)) process.exit(1);
