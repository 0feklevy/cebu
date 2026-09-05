// REVIEW-PHASE narration: free Microsoft Edge neural voices (no key). Owner ruling 2026-09-05: a
// synthesized voice for the review pass — a confident, energetic US product-trailer read, not an
// audiobook — and ElevenLabs (the product path, run-narration.sh) replaces it after sign-off.
// Writes into narration/audio/, the assembler's REAL (non --scratch) source.
//
//   node synthesize-edge.mjs [--force] [--only f1-s10,f4-s5-viewer] [--out audio]
//        [--narrator en-US-AndrewNeural] [--rate +12%] [--pitch +0Hz]
//        [--viewer en-US-EmmaNeural] [--viewer-rate +0%] [--viewer-pitch +0Hz]
//        [--pace trailer|calm|raw] [--gap-sentence 420] [--gap-question 500] [--gap-colon 320]
//        [--gap-beat 560] [--gap-brand 720] [--gap-ellipsis 620] [--gap-dash 250] [--gap-lead 80] [--gap-tail 200]
//
// Defaults are the AUDITION.md pick (narration/audition/*.mp3 — the owner picks by ear).
// Why there is a pause editor at all: the Edge endpoint rejects <break>, <emphasis> and speaking
// styles, and the older voices hard-code ~870ms after every sentence (the "stuck" the owner heard),
// so "Touch it. Ask it. Steer it. — Flow Video." lands as four beats only because the gaps are cut
// to [sentence, sentence, brand] AFTER synthesis, in the decoded audio, silence only — see
// edge-tts.mjs. Any --gap-* set to 0 leaves that punctuation exactly as the voice spoke it.
// Voices not served by the endpoint (en-US-DavisNeural, en-US-JasonNeural) fail fast with a clear error.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, assertServed, decodeToPcm, encodePcm, tightenPauses, paceStats, wordCount, PACE } from './edge-tts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };

const cfg = {
  narrator: opt('--narrator', 'en-US-AndrewNeural'),
  rate: opt('--rate', '+12%'),
  pitch: opt('--pitch', '+0Hz'),
  viewer: opt('--viewer', 'en-US-EmmaNeural'),
  viewerRate: opt('--viewer-rate', '+0%'),
  viewerPitch: opt('--viewer-pitch', '+0Hz'),
  pace: opt('--pace', 'trailer'),
  out: opt('--out', 'audio'),
};
if (!(cfg.pace in PACE)) { console.error(`--pace must be one of: ${Object.keys(PACE).join(' | ')}`); process.exit(2); }
const gaps = PACE[cfg.pace] ? { ...PACE[cfg.pace] } : null;
for (const a of args) {
  const m = a.match(/^--gap-([a-z]+)$/);
  if (!m) continue;
  if (!gaps) { console.error(`${a} has no effect with --pace raw`); process.exit(2); }
  const v = Number(opt(a));
  if (!Number.isFinite(v) || v < 0) { console.error(`${a} needs a non-negative number of ms`); process.exit(2); }
  gaps[m[1]] = v;
}
const force = flag('--force');
const only = opt('--only', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

const lines = JSON.parse(readFileSync(join(HERE, 'lines.json'), 'utf8'));
const films = existsSync(join(HERE, 'films.json')) ? JSON.parse(readFileSync(join(HERE, 'films.json'), 'utf8')) : [];
const OUT = join(HERE, cfg.out);
mkdirSync(OUT, { recursive: true });
const PAD_AFTER = 0.5; // assemble-film.mjs: scene = max(slot, VO + 0.5s)

console.log(`narrator=${cfg.narrator} ${cfg.rate} ${cfg.pitch} · viewer=${cfg.viewer} ${cfg.viewerRate} ${cfg.viewerPitch} · pace=${cfg.pace}${gaps ? ' ' + JSON.stringify(gaps) : ''} → ${OUT}`);
try { await assertServed([cfg.narrator, cfg.viewer]); } catch (e) { console.error(e.message); process.exit(2); }

const report = [];
let made = 0, kept = 0, failed = 0;
for (const l of lines) {
  const id = `f${l.film}-s${l.scene}`;
  if (only && !only.includes(id)) continue;
  const out = join(OUT, `${id}.mp3`);
  const words = wordCount(l.text);
  const slot = l.t0 != null && l.t1 != null ? l.t1 - l.t0 : null;
  const row = { id, film: l.film, scene: l.scene, role: l.role, kind: l.kind ?? null, words, slot };
  if (existsSync(out) && !force) {
    const st = paceStats(decodeToPcm(readFileSync(out)), words);
    kept++;
    report.push({ ...row, kept: true, dur: st.dur, rawDur: null, wpm: st.wpmOverall, gaps: st.gaps, over: slot != null ? Math.max(0, st.dur + PAD_AFTER - slot) : null, warn: [] });
    continue;
  }
  const isViewer = l.role === 'viewer';
  const voice = isViewer ? cfg.viewer : cfg.narrator;
  const prosody = isViewer ? { rate: cfg.viewerRate, pitch: cfg.viewerPitch } : { rate: cfg.rate, pitch: cfg.pitch };
  try {
    const { mp3, words: spoken } = await synthesize(voice, l.text, prosody);
    const raw = decodeToPcm(mp3);
    const rawStats = paceStats(raw, words);
    const { pcm, log } = tightenPauses(raw, spoken, l.text, gaps);
    writeFileSync(out, encodePcm(pcm));
    const st = paceStats(pcm, words);
    const over = slot != null ? Math.max(0, st.dur + PAD_AFTER - slot) : null;
    const warn = log.filter((x) => x.startsWith('WARN'));
    made++;
    report.push({ ...row, kept: false, dur: st.dur, rawDur: rawStats.dur, wpm: st.wpmOverall, gaps: st.gaps, over, warn });
    console.log(`✓ ${id.padEnd(14)} ${l.role.padEnd(8)} ${rawStats.dur.toFixed(2)}s → ${st.dur.toFixed(2)}s  ${String(Math.round(st.wpmOverall)).padStart(3)} wpm  slot ${slot ?? '—'}s${over ? `  OVER by ${over.toFixed(1)}s` : ''}  gaps [${st.gaps.join(',')}]${warn.length ? '  ' + warn.join('; ') : ''}`);
  } catch (e) {
    failed++;
    report.push({ ...row, failed: true, error: String(e?.message ?? e).slice(0, 160) });
    console.error(`✗ ${id}: ${String(e?.message ?? e).slice(0, 160)}`);
  }
}

// ---------------------------------------------------------------- totals
const byFilm = {};
for (const r of report) {
  const f = (byFilm[r.film] ??= { film: r.film, clips: 0, narratorSec: 0, viewerSec: 0, words: 0, slotSec: 0, over: 0, overClips: [], failed: 0 });
  f.clips++;
  if (r.failed) { f.failed++; continue; }
  if (r.role === 'viewer') f.viewerSec += r.dur; else { f.narratorSec += r.dur; f.words += r.words; f.slotSec += r.slot ?? 0; }
  if (r.over) { f.over += r.over; f.overClips.push(`${r.id} +${r.over.toFixed(1)}s`); }
}
const fm = (n) => films.find((x) => x.film === n) ?? {};
const filmRows = Object.values(byFilm).map((f) => {
  const m = fm(f.film);
  const wpm = f.narratorSec ? (f.words / f.narratorSec) * 60 : 0;
  return `| ${f.film} | ${m.title ?? ''} | ${f.clips} | ${f.narratorSec.toFixed(1)} | ${f.viewerSec ? f.viewerSec.toFixed(1) : '—'} | ${f.words} | ${wpm.toFixed(0)} | ${m.targetSec ?? '—'} | ${f.slotSec.toFixed(0)} | ${f.overClips.length ? f.overClips.join(', ') : 'none'} |`;
});
const clipRows = report.map((r) => r.failed
  ? `| ${r.id} | ${r.role} | ${r.kind ?? ''} | ${r.words} | FAILED | | | ${r.slot ?? '—'} | | ${r.error} |`
  : `| ${r.id} | ${r.role} | ${r.kind ?? ''} | ${r.words} | ${r.rawDur != null ? r.rawDur.toFixed(2) : '(kept)'} | ${r.dur.toFixed(2)} | ${Math.round(r.wpm)} | ${r.slot ?? '—'} | ${r.over ? '+' + r.over.toFixed(1) : ''} | [${r.gaps.join(', ')}]${r.warn.length ? ' ' + r.warn.join('; ') : ''} |`);

// A partial run (--only) is a probe, not the record: leave the note of the last full run alone.
if (!only) writeFileSync(join(HERE, 'EDGE-VOICE-NOTE.md'), [
  '# Review-phase narration — Edge neural voices (free, keyless)',
  '',
  `Run: ${new Date().toISOString()} · narrator=${cfg.narrator} rate ${cfg.rate} pitch ${cfg.pitch} · viewer=${cfg.viewer} rate ${cfg.viewerRate} pitch ${cfg.viewerPitch}`,
  `Pace: ${cfg.pace}${gaps ? ' — ' + Object.entries(gaps).map(([k, v]) => `${k} ${v}ms`).join(' · ') : ''} · output ${cfg.out}/`,
  `Clips: ${made} synthesized, ${kept} kept, ${failed} failed.`,
  '',
  'These are REVIEW-PASS voices (owner ruling 2026-09-05). Production narration switches to ElevenLabs via',
  'run-narration.sh --force once the local key is fixed and the owner signs off. Voice choice and rate:',
  'see AUDITION.md. "over" = seconds the clip (+0.5s assembler pad) exceeds its script slot; the assembler',
  'stretches that scene, so a film longer than its target is explained here, not in the edit.',
  '',
  '| film | title | clips | narration s | viewer s | words | wpm | target s | slots s | clips over slot |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...filmRows,
  '',
  '| clip | role | kind | words | raw s | edited s | wpm | slot s | over | pauses after edit (ms) |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...clipRows,
  '',
].join('\n'));

if (only) console.log('(partial run — EDGE-VOICE-NOTE.md left as the record of the last full run)');
console.log('\nper film:');
for (const f of Object.values(byFilm)) {
  const m = fm(f.film);
  console.log(`  film ${f.film} ${(m.title ?? '').padEnd(24)} ${String(f.clips).padStart(2)} clips  narration ${f.narratorSec.toFixed(1).padStart(5)}s${f.viewerSec ? ` + viewer ${f.viewerSec.toFixed(1)}s` : ''}  ${f.words} words → ${f.narratorSec ? Math.round((f.words / f.narratorSec) * 60) : 0} wpm  target ${m.targetSec ?? '—'}s  slots ${f.slotSec}s${f.overClips.length ? `  OVER: ${f.overClips.join(', ')}` : ''}${f.failed ? `  FAILED ${f.failed}` : ''}`);
}
console.log(JSON.stringify({ made, kept, failed, narratorSec: +Object.values(byFilm).reduce((n, f) => n + f.narratorSec, 0).toFixed(1) }));
if (failed) process.exit(1);
