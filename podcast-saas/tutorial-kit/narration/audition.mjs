// Voice audition for the review-phase Edge narration. Synthesizes the teaser hook, the longest
// film-2 tutorial line and the four-beat close with every candidate voice × rate, applies the
// pause editor (see edge-tts.mjs), and MEASURES what can be measured. Nobody here can hear: the
// owner picks by ear from audition/*.mp3; this file ranks by proxy and says so.
//   node audition.mjs [--voices a,b] [--rates +8%,+15%] [--primaries a,b] [--pitch +4%]
//                     [--viewer-voices a,b] [--pace trailer|calm|raw]
//                     [--pick en-US-AndrewNeural,+12%] [--pick-viewer en-US-EmmaNeural]
// Outputs (all under narration/audition/):
//   <voice>-<rate>.mp3            hook · tutorial · close, trailer pace (what the films would carry)
//   <voice>-<rate>-raw.mp3        same three lines, pauses exactly as the voice spoke them (A/B)
//   <voice>-+12%-pitch+4%.mp3     primaries only: hook · close with the pitch lifted
//   viewer-<voice>.mp3            the film-4 viewer question, candidates for the second voice
//   pick-<voice>-<rate>.mp3       the default pairing as one file: hook · tutorial · close · viewer question
//   before-*.mp3                  three clips of the rejected take (Guy +4%, no pause editing)
//   parts/                        every individual line, raw and edited
//   measurements.json · ../AUDITION.md
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, decodeToPcm, encodePcm, tightenPauses, paceStats, measureFile, concatMp3, wordCount, PACE } from './edge-tts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'audition');
const PARTS = join(OUT, 'parts');
mkdirSync(PARTS, { recursive: true });

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const short = (v) => v.replace(/^en-US-/, '').replace(/Neural$/, '');

const VOICES = list(opt('--voices', [
  'en-US-GuyNeural', 'en-US-AriaNeural', 'en-US-JennyNeural',          // requested and served
  'en-US-AndrewNeural', 'en-US-BrianNeural',                           // stand-ins for Davis / Jason (not served)
  'en-US-EmmaNeural', 'en-US-AvaNeural', 'en-US-RogerNeural', 'en-US-ChristopherNeural', 'en-US-SteffanNeural', // bench
].join(',')));
const RATES = list(opt('--rates', '+8%,+15%'));
const PRIMARIES = list(opt('--primaries', 'en-US-GuyNeural,en-US-AriaNeural,en-US-JennyNeural,en-US-AndrewNeural,en-US-BrianNeural'));
const PITCH = opt('--pitch', '+4%');
const PITCH_RATE = opt('--pitch-rate', '+12%');
const VIEWER_VOICES = list(opt('--viewer-voices', 'en-US-AvaNeural,en-US-EmmaNeural,en-US-JennyNeural,en-US-AriaNeural,en-US-MichelleNeural'));
const [PICK_VOICE, PICK_RATE] = list(opt('--pick', 'en-US-AndrewNeural,+12%'));
const PICK_VIEWER = opt('--pick-viewer', 'en-US-EmmaNeural');
const paceName = opt('--pace', 'trailer');
const pace = PACE[paceName];

const HOOK = "This looks like a video. It isn't. Go on — touch it.";
const CLOSE = 'Touch it. Ask it. Steer it. — Flow Video.';
const VIEWER_Q = "Why doesn't the moon crash into the earth?";
// Longest film-2 narrator line in lines.json (the v3 scripts) — the sustained-pace stress test.
let TUTORIAL = 'Pick Simulation. Choose your package. Open Generate mini model — and tell it, in plain words, what this moment\'s for:';
let tutorialSource = 'built-in fallback';
try {
  const lines = JSON.parse(readFileSync(join(HERE, 'lines.json'), 'utf8'));
  const f2 = lines.filter((l) => l.film === 2 && l.role === 'narrator').sort((a, b) => b.text.length - a.text.length);
  if (f2.length) { TUTORIAL = f2[0].text; tutorialSource = `lines.json film 2 scene ${f2[0].scene}`; }
} catch { /* keep fallback */ }

const results = { meta: { date: new Date().toISOString(), pace: paceName, gaps: pace, hook: HOOK, tutorial: TUTORIAL, tutorialSource, close: CLOSE, viewerQ: VIEWER_Q }, takes: [], combined: [], pitch: [], viewer: [], before: [] };
const calib = [];

async function take(voice, text, prosody, label) {
  const { mp3, words } = await synthesize(voice, text, prosody);
  const n = wordCount(text);
  const raw = decodeToPcm(mp3);
  const rawStats = paceStats(raw, n);
  const { pcm, log } = tightenPauses(raw, words, text, pace);
  const tight = paceStats(pcm, n);
  const rawPath = join(PARTS, `${label}-raw.mp3`);
  const tightPath = join(PARTS, `${label}.mp3`);
  writeFileSync(rawPath, mp3);
  writeFileSync(tightPath, encodePcm(pcm));
  const metaLead = words.length ? Math.round(words[0].t0 * 1000) : null;
  if (metaLead != null) calib.push({ label, metaLead, pcmLead: rawStats.lead, delta: rawStats.lead - metaLead });
  const r = { label, voice, text: text.slice(0, 60), words: n, prosody, rawPath, tightPath, raw: rawStats, tight, edit: log, measureRaw: measureFile(rawPath), measure: measureFile(tightPath) };
  results.takes.push(r);
  console.log(`  ${label.padEnd(38)} raw ${rawStats.dur.toFixed(2)}s → ${tight.dur.toFixed(2)}s  wpm ${tight.wpmOverall.toFixed(0)} (artic ${tight.wpmArticulated.toFixed(0)})  rms ${r.measure.rms}dB lufs ${r.measure.lufs} lra ${r.measure.lra}  gaps raw[${rawStats.gaps.join(',')}] → [${tight.gaps.join(',')}]`);
  return r;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// ---------------------------------------------------------------- 0. the rejected take (before)
// The rejected take is a historical reference: once copied it is never refreshed from audio/,
// which by then holds the new take.
const AUDIO = join(HERE, 'audio');
for (const f of ['f1-s2.mp3', 'f1-s8.mp3', 'f2-s4.mp3']) {
  const src = join(AUDIO, f);
  const dst = join(OUT, `before-guy+4pct-${f}`);
  if (!existsSync(dst)) { if (!existsSync(src)) continue; copyFileSync(src, dst); }
  const pcm = decodeToPcm(readFileSync(dst));
  const m = measureFile(dst);
  const stats = paceStats(pcm, 0);
  results.before.push({ file: dst, ...m, gaps: stats.gaps, lead: stats.lead, tail: stats.tail });
  console.log(`before ${f}: ${m.dur.toFixed(2)}s rms ${m.rms}dB lufs ${m.lufs} lra ${m.lra} gaps [${stats.gaps.join(',')}]`);
}

// ---------------------------------------------------------------- 1. the matrix
for (const voice of VOICES) {
  for (const rate of RATES) {
    console.log(`\n${voice} @ ${rate}`);
    const tag = `${short(voice)}-${rate}`;
    const hook = await take(voice, HOOK, { rate }, `${tag}-hook`);
    const tut = await take(voice, TUTORIAL, { rate }, `${tag}-tutorial`);
    const close = await take(voice, CLOSE, { rate }, `${tag}-close`);
    const combined = concatMp3([hook.tightPath, tut.tightPath, close.tightPath], join(OUT, `${tag}.mp3`), 700);
    const entry = { voice, rate, file: combined, ...measureFile(combined), parts: [hook.label, tut.label, close.label] };
    if (rate === RATES[0]) {
      entry.rawFile = concatMp3([hook.rawPath, tut.rawPath, close.rawPath], join(OUT, `${tag}-raw.mp3`), 700);
      entry.rawDur = measureFile(entry.rawFile).dur;
    }
    results.combined.push(entry);
  }
}

// ---------------------------------------------------------------- 2. pitch lift on the primaries
console.log(`\npitch ${PITCH} @ ${PITCH_RATE} on primaries`);
for (const voice of PRIMARIES) {
  const tag = `${short(voice)}-${PITCH_RATE}-pitch${PITCH}`;
  const hook = await take(voice, HOOK, { rate: PITCH_RATE, pitch: PITCH }, `${tag}-hook`);
  const close = await take(voice, CLOSE, { rate: PITCH_RATE, pitch: PITCH }, `${tag}-close`);
  const combined = concatMp3([hook.tightPath, close.tightPath], join(OUT, `${tag}.mp3`), 700);
  results.pitch.push({ voice, rate: PITCH_RATE, pitch: PITCH, file: combined, ...measureFile(combined), parts: [hook.label, close.label] });
}

// ---------------------------------------------------------------- 3. the viewer voice
console.log('\nviewer question candidates @ +0%');
for (const voice of VIEWER_VOICES) {
  const r = await take(voice, VIEWER_Q, { rate: '+0%' }, `viewer-${short(voice)}`);
  copyFileSync(r.tightPath, join(OUT, `viewer-${short(voice)}.mp3`));
  results.viewer.push({ voice, file: join(OUT, `viewer-${short(voice)}.mp3`), dur: r.tight.dur, rms: r.measure.rms, lufs: r.measure.lufs, lra: r.measure.lra });
}

// ---------------------------------------------------------------- 4. the pick, as one file
console.log(`\npick: ${PICK_VOICE} @ ${PICK_RATE} + viewer ${PICK_VIEWER}`);
{
  const tag = `pick-${short(PICK_VOICE)}-${PICK_RATE}`;
  const hook = await take(PICK_VOICE, HOOK, { rate: PICK_RATE }, `${tag}-hook`);
  const tut = await take(PICK_VOICE, TUTORIAL, { rate: PICK_RATE }, `${tag}-tutorial`);
  const close = await take(PICK_VOICE, CLOSE, { rate: PICK_RATE }, `${tag}-close`);
  const q = await take(PICK_VIEWER, VIEWER_Q, { rate: '+0%' }, `${tag}-viewer`);
  const file = concatMp3([hook.tightPath, tut.tightPath, close.tightPath, q.tightPath], join(OUT, `${tag}.mp3`), 700);
  results.pick = { voice: PICK_VOICE, rate: PICK_RATE, viewer: PICK_VIEWER, file, ...measureFile(file), parts: [hook.label, tut.label, close.label, q.label] };
}

results.calibration = { n: calib.length, maxAbsDeltaMs: Math.max(...calib.map((c) => Math.abs(c.delta))), medianDeltaMs: median(calib.map((c) => c.delta)) };
writeFileSync(join(OUT, 'measurements.json'), JSON.stringify(results, null, 2));

// ---------------------------------------------------------------- AUDITION.md
const byLabel = Object.fromEntries(results.takes.map((t) => [t.label, t]));
const f1 = (x) => (x == null ? '—' : (+x).toFixed(1));
const f2 = (x) => (x == null ? '—' : (+x).toFixed(2));
const rows = results.combined.map((c) => {
  const [h, t, k] = c.parts.map((p) => byLabel[p]);
  const allWords = h.words + t.words + k.words;
  const speech = h.tight.dur + t.tight.dur + k.tight.dur;
  const rawSpeech = h.raw.dur + t.raw.dur + k.raw.dur;
  const wpm = (allWords / speech) * 60;
  const artic = (allWords / (h.tight.speechSec + t.tight.speechSec + k.tight.speechSec)) * 60;
  const nativeGap = median([...h.raw.gaps, ...t.raw.gaps, ...k.raw.gaps].filter((g) => g >= 300));
  return `| ${short(c.voice)} | ${c.rate} | \`${short(c.voice)}-${c.rate}.mp3\` | ${f2(h.tight.dur)} / ${f2(t.tight.dur)} / ${f2(k.tight.dur)} | ${f2(rawSpeech)} → ${f2(speech)} | ${wpm.toFixed(0)} | ${artic.toFixed(0)} | ${f1(c.rms)} | ${f1(c.lufs)} | ${f1(c.lra)} | ${nativeGap ?? '—'} | [${k.raw.gaps.join(', ')}] → [${k.tight.gaps.join(', ')}] |`;
});
const pitchRows = results.pitch.map((p) => {
  const [h, k] = p.parts.map((x) => byLabel[x]);
  return `| ${short(p.voice)} | ${p.rate} | ${p.pitch} | \`${short(p.voice)}-${p.rate}-pitch${p.pitch}.mp3\` | ${f2(h.tight.dur)} / ${f2(k.tight.dur)} | ${f1(p.rms)} | ${f1(p.lufs)} | ${f1(p.lra)} |`;
});
const viewerRows = results.viewer.map((v) => `| ${short(v.voice)} | \`viewer-${short(v.voice)}.mp3\` | ${f2(v.dur)} | ${f1(v.rms)} | ${f1(v.lufs)} | ${f1(v.lra)} |`);
const beforeRows = results.before.map((b) => `| \`${b.file.split('/').pop()}\` | ${f2(b.dur)} | ${f1(b.rms)} | ${f1(b.lufs)} | ${f1(b.lra)} | [${b.gaps.join(', ')}] |`);
const paceLine = pace ? Object.entries(pace).map(([k, v]) => `${k} ${v}ms`).join(' · ') : 'raw (as spoken)';
const pickHook = byLabel[results.pick.parts[0]], pickTut = byLabel[results.pick.parts[1]], pickClose = byLabel[results.pick.parts[2]], pickQ = byLabel[results.pick.parts[3]];
const andrew8 = results.combined.find((c) => c.voice === 'en-US-AndrewNeural' && c.rate === RATES[0]);
const guy8 = results.combined.find((c) => c.voice === 'en-US-GuyNeural' && c.rate === RATES[0]);

writeFileSync(join(HERE, 'AUDITION.md'), `# Narration voice audition — Edge neural voices (review phase)

Generated ${results.meta.date} by \`narration/audition.mjs\`. **Nobody who wrote this could hear the
clips.** Every column below is a measurement or a documented voice trait; the owner picks by ear from
\`narration/audition/*.mp3\`. Each \`<voice>-<rate>.mp3\` plays the hook, the longest tutorial line and
the four-beat close, in that order, 0.7s apart. \`<voice>-${RATES[0]}-raw.mp3\` is the same read with
the pauses exactly as the voice spoke them — the A/B for what the pause editor does.

Lines: hook = "${HOOK}" · tutorial = ${tutorialSource} (${wordCount(TUTORIAL)} words: "${TUTORIAL}") · close = "${CLOSE}" · viewer question = "${VIEWER_Q}".
Pace preset \`${paceName}\`: ${paceLine}.

## What the endpoint can and cannot do (measured, 41 probe requests)

- **Not served:** \`en-US-DavisNeural\`, \`en-US-JasonNeural\` — the socket closes without audio; they are Azure-only.
  Stand-ins with the same brief (warm confident male / casual younger male): **Andrew**, **Brian** — the newest
  conversational generation Microsoft ships, and the two voices with the tightest native pauses.
- **No inner SSML:** \`<break>\`, \`<emphasis>\`, \`<mstts:express-as style>\`, \`<say-as>\`, \`<sub>\`, nested
  \`<prosody>\` all kill the request. Only the outer \`<prosody rate pitch volume>\` is honored. Punctuation cannot
  lengthen a pause either ("Touch it..." = "Touch it." = 863ms on Guy), a sentence-initial "…" adds nothing, and
  Guy/Brian run straight through " — " (23–91ms of gap).
- **Therefore the beats are edited, not spoken:** the word-boundary metadata the service streams with the audio
  locates every gap; the pause editor resizes the sentence / question / colon / beat / brand / ellipsis / dash gaps
  in the decoded PCM. It removes or inserts *silence only*, cutting in the middle of the measured silent span
  (or, where the voice ran the words together, dropping the beat at the quietest 5ms of the boundary with fades).
  Speech is never time-stretched, so there is no chipmunk path except \`pitch\`, which is why pitch stays ≤ +4% here.
- Word-boundary timeline vs decoded audio: ${results.calibration.n} clips, speech-onset delta median ${results.calibration.medianDeltaMs}ms,
  max |Δ| ${results.calibration.maxAbsDeltaMs}ms (the cuts are placed from the decoded audio; the metadata only says WHICH gap).

## Judgment criteria

1. **Overall wpm** (words ÷ clip length, after pause editing). A US product-trailer read sits around 155–175;
   the scripts were written for "~150 wpm in bursts", and the air lives between beats, not inside a line.
2. **Articulated wpm** (words ÷ time actually speaking) — the voice's intrinsic tempo; short lines inflate it.
   Compare voices on the tutorial line rather than the hook.
3. **Energy proxy:** integrated loudness (LUFS) and RMS (dBFS) — how much level the voice puts out at the same
   volume setting; **LRA** (loudness range, LU) — how much it moves within the read (flat = monotone).
4. **Pause naturalness:** the median sentence gap *as the voice spoke it* (the "native gap"). ~870ms is the
   audiobook cadence the owner rejected; ~400ms is trailer cadence. The close-beats column shows the
   "Touch it. Ask it. Steer it. — Flow Video." gaps before → after the editor (target [420, 420, 720]).
5. **Documented character** (Microsoft's own VoicePersonalities tags): Guy *Passion* · Andrew *Warm, Confident,
   Authentic* · Brian *Approachable, Casual* · Aria *Positive, Confident* · Jenny *Friendly, Considerate* ·
   Emma *Cheerful, Clear* · Ava *Expressive, Friendly* · Roger *Lively* · Christopher *Reliable, Authority* ·
   Steffan *Rational*.
6. **Artifact risk:** rate is a duration-model change (safe to +15%); pitch shifts formants (kept ≤ +4%).

## The rejected take, for reference (Guy, +4%, pauses as spoken)

| clip | dur | RMS dBFS | LUFS | LRA | inner gaps (ms) |
|---|---|---|---|---|---|
${beforeRows.join('\n')}

Whole-film narration of that take: f1 66.7s · f2 121.1s · f3 68.1s · f4 55.8s · f5 50.5s (39 clips, v2.1 scripts).

## Matrix — narrator candidates

dur = hook / tutorial / close after pause editing; "raw → edited" = the three lines' total before → after.

| voice | rate | file | dur h/t/c (s) | raw → edited (s) | wpm | artic. wpm | RMS dBFS | LUFS | LRA | native gap (ms) | close beats raw → edited (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Pitch lift (primaries, hook + close)

| voice | rate | pitch | file | dur h/c (s) | RMS | LUFS | LRA |
|---|---|---|---|---|---|---|---|
${pitchRows.join('\n')}

## Viewer voice (the in-film question, film 4 beat 5), +0%

| voice | file | dur (s) | RMS | LUFS | LRA |
|---|---|---|---|---|---|
${viewerRows.join('\n')}

## Judgment — and the pick

**Default pairing: narrator \`${PICK_VOICE}\` at \`${PICK_RATE}\`, pitch +0Hz · viewer \`${PICK_VIEWER}\` at +0%.**
Hear exactly that as one file: \`pick-${short(PICK_VOICE)}-${PICK_RATE}.mp3\` (hook · tutorial · close · viewer question;
${f2(pickHook.tight.dur)} / ${f2(pickTut.tight.dur)} / ${f2(pickClose.tight.dur)} / ${f2(pickQ.tight.dur)} s, ${f1(results.pick.lufs)} LUFS). It is set as the defaults in
\`synthesize-edge.mjs\`; every film clip in \`audio/\` was made with it.

Why Andrew, over the three requested voices that are served (Guy, Aria, Jenny):

- **The "stuck" is measurable, and it is not the words per minute — it is dead air.** Guy, Aria and Jenny (with
  Christopher, Eric and Michelle) are the older voice generation and hard-code ~${guy8 ? median([...guy8.parts.map((p) => byLabel[p]).flatMap((p) => p.raw.gaps)].filter((g) => g >= 300)) : 900}ms after every
  sentence; the rejected take's gaps were 950–1025ms. Andrew, Brian, Emma and Ava are the current conversational
  generation: ~380–450ms native, and a faster, more varied articulation. On the hook, raw, Andrew takes
  ${andrew8 ? f2(byLabel[andrew8.parts[0]].raw.dur) : '3.2'}s to Guy's ${guy8 ? f2(byLabel[guy8.parts[0]].raw.dur) : '5.5'}s.
- **The editor equalizes the beats, so the old voices become usable — but it cannot change how a voice moves
  inside a sentence.** Andrew has the quickest intrinsic tempo of the candidates (the "talking with your hands
  full" the teaser direction asks for) while its overall pace after editing sits inside the 155–175 trailer band.
  Across the five films at +12% the whole-film pace lands between ~143 and ~172 wpm (per-film figures in
  EDGE-VOICE-NOTE.md; film 4 is the slow one by design — the count-along beats are punctuation-heavy).
- **Davis and Jason — the two the brief named for exactly this quality — are not on the free endpoint.** Andrew is
  Microsoft's own successor to that brief (*Warm, Confident, Authentic*); Brian is the casual one. **Brian is the
  runner-up**: same generation, ~5–10% slower, a shade more relaxed — \`--narrator en-US-BrianNeural\` if Andrew
  reads too keen by ear.
- **Rate +12%, not +15%.** On Andrew the two differ by ~3% in overall wpm because the editor holds the beats
  constant, so the extra speed buys nothing measurable and only costs consonants. If the owner prefers Guy, Aria
  or Jenny by ear, +15% is the right setting for them (\`--narrator en-US-GuyNeural --rate +15%\`).
- **Pitch stays +0Hz.** The +4% lift files are there to hear; the measurements barely move (RMS within 0.5dB), so it
  is a pure taste call — and pitch is the one control on this endpoint that CAN chipmunk.

Why Emma for the viewer: it has to be a different person (Andrew is male; every viewer candidate is female), it has
to cut through mid-video (Emma is the loudest voice in the set by 2–4dB RMS — *Cheerful, Clear*), and the newer
generation asks a question the way a person does rather than reading one. Ava is the alternate
(\`--viewer en-US-AvaNeural\`): softer and warmer.

**The owner picks by ear.** These proxies rank pace, level and dead air; they do not hear timbre, sibilance, or
whether a read smiles. The short list to play: \`pick-${short(PICK_VOICE)}-${PICK_RATE}.mp3\`, then \`Brian-+8%.mp3\`,
then \`Guy-+15%.mp3\` (the requested voice at its best setting), then \`Andrew-+8%-raw.mp3\` against
\`Andrew-+8%.mp3\` to judge the editor itself, then the three \`before-*.mp3\` for what was rejected. To hear a
different pairing on the real lines: \`node synthesize-edge.mjs --force --narrator <voice> --rate <r> --viewer <voice>\`.
`);
console.log(`\nwrote ${join(HERE, 'AUDITION.md')} and ${join(OUT, 'measurements.json')}`);
