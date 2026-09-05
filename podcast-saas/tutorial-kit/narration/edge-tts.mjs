// Shared Edge-TTS plumbing for the REVIEW-PHASE narration (free, keyless Microsoft Edge neural
// voices). Owner ruling 2026-09-05: synthesized voice for the review pass; ElevenLabs (the product
// path, run-narration.sh) replaces it after sign-off. Used by synthesize-edge.mjs and audition.mjs.
//
// What the Edge Read Aloud endpoint actually honors — MEASURED 2026-09-05 (41 probe requests):
//   • <prosody rate= pitch= volume=> wrapping the whole line: YES. rate "+15%" → 12.9% shorter;
//     pitch "+5%"/"+2st" changes the audio (same timing). Rate is a duration-model change, not a
//     resample, so it does not chipmunk by itself; pitch shifts formants and can.
//   • <break>, <emphasis>, <mstts:express-as style=>, <say-as>, <sub>, nested <prosody>,
//     <mstts:silence>: NO. The server closes the socket without turn.end for every one.
//   • en-US-DavisNeural / en-US-JasonNeural: NOT served here (same socket close). The 17 en-US
//     voices that are: Andrew, Brian, Christopher, Eric, Guy, Roger, Steffan (m); Aria, Ava, Emma,
//     Jenny, Michelle, Ana (f); + Andrew/Brian/Ava/Emma -Multilingual.
//   • Punctuation cannot lengthen a pause: "Touch it..." pauses exactly as long as "Touch it."
//     (863ms on Guy), and ". —" adds nothing over ".". Old-generation voices (Guy/Aria/Jenny/
//     Christopher/Eric/Michelle) hard-code ~870ms after every sentence; the newer conversational
//     voices (Andrew/Brian/Ava/Emma) ~400ms; Roger/Steffan ~650ms.
//
// So the four beats of "Touch it. Ask it. Steer it. — Flow Video." are cut the way an editor cuts
// them: the service streams WordBoundary metadata (10ms-accurate word offsets) alongside the audio;
// alignPunctuation() maps each spoken word back to the punctuation that follows it in the script,
// and tightenPauses() resizes the sentence / question / colon / beat / brand / ellipsis / dash gaps
// in the decoded PCM to the configured beat lengths (PACE below). Only silence is removed or
// inserted — the cut point is the middle of the measured silent span, with the same clearance on
// both sides; where a voice ran two words together (Guy and Brian on " — ") the beat is dropped in
// at the quietest 5ms of the word boundary with 6ms fades — and the speech itself is never
// time-stretched, so there is nothing to chipmunk.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TTS_PKG = '/private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/tts/package.json';
const req = createRequire(pathToFileURL(TTS_PKG));
const { MsEdgeTTS, OUTPUT_FORMAT } = req('msedge-tts');

export const SAMPLE_RATE = 24000;
export const MP3_BITRATE = '96k';

/** Beat lengths in ms, by the punctuation that follows a word in the script. `trailer` is the
 *  product-trailer read; `calm` is the audiobook cadence the owner rejected, kept for A/B; `raw`
 *  leaves every gap exactly as the voice spoke it. A value of 0 leaves THAT class as spoken.
 *    sentence  "."  "!"        question "?"        colon ":"
 *    beat      ". —"           a full stop AND a dash: the scripts' long performed beat
 *                              ("let go. — Watch gravity fight for it.")
 *    brand     ". — Flow Video"  the same mark when the brand follows — the final hit
 *    ellipsis  "…"  ". …"      the scripts' performed pause ("Go ahead… I'll wait." / "…Generate.")
 *    dash      " — "           the scripts' short performed breath ("Simple UI — only your buttons")
 *    lead/tail                 silence kept before the first / after the last word            */
export const PACE = {
  trailer: { sentence: 420, question: 500, colon: 320, beat: 560, brand: 720, ellipsis: 620, dash: 250, lead: 80, tail: 200 },
  calm:    { sentence: 650, question: 700, colon: 450, beat: 750, brand: 900, ellipsis: 800, dash: 300, lead: 100, tail: 250 },
  raw:     null,
};

// ---------------------------------------------------------------- synthesis

let guarded = false;
function guardProcess() {
  // msedge-tts parses every socket frame with a bare regex; an unexpected frame throws inside the
  // ws handler, which would take the whole run down. Log THAT and let the per-request timeout fail
  // the one clip. Anything else is our bug — surface it and fail loudly (a swallowed error once
  // let audition.mjs exit 0 after doing a tenth of its work).
  if (guarded) return;
  guarded = true;
  process.on('uncaughtException', (e) => {
    if (String(e?.stack ?? e).includes('msedge-tts')) { console.error('[edge-tts] socket-layer error, clip will time out:', String(e).slice(0, 160)); return; }
    console.error(e);
    process.exit(1);
  });
}

export function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildSsml(voice, text, { rate = '+0%', pitch = '+0Hz', volume = '+0%' } = {}) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">` +
    `<voice name="${voice}"><prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${escapeXml(text)}</prosody></voice></speak>`;
}

/**
 * Synthesize one line. Returns the MP3 bytes plus the word boundaries the service streamed with
 * them: [{ text, t0, dur }] in seconds. Retries transient socket drops.
 */
export async function synthesize(voice, text, prosody = {}, { timeoutMs = 30000, retries = 3 } = {}) {
  guardProcess();
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
        { wordBoundaryEnabled: true, sentenceBoundaryEnabled: false });
      const { audioStream, metadataStream } = tts.rawToStream(buildSsml(voice, text, prosody));
      const chunks = [], meta = [];
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
        audioStream.on('data', (c) => chunks.push(c));
        metadataStream?.on('data', (c) => { try { meta.push(...JSON.parse(c.toString()).Metadata); } catch { /* partial frame */ } });
        audioStream.on('end', () => { clearTimeout(t); resolve(); });
        audioStream.on('error', (e) => { clearTimeout(t); reject(e); });
      });
      const mp3 = Buffer.concat(chunks);
      if (mp3.length < 1000) throw new Error(`only ${mp3.length} bytes of audio`);
      const words = meta.filter((m) => m.Type === 'WordBoundary')
        .map((m) => ({ text: m.Data.text.Text, t0: m.Data.Offset / 1e7, dur: m.Data.Duration / 1e7 }));
      return { mp3, words };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 700 * attempt));
    } finally {
      tts.close?.();
    }
  }
  throw lastErr;
}

let servedCache = null;
/** ShortNames the Edge endpoint actually serves (one HTTP call, cached). Null if the list is unreachable. */
export async function listServedVoices() {
  if (servedCache) return servedCache;
  try {
    const voices = await new MsEdgeTTS().getVoices();
    servedCache = voices.map((v) => v.ShortName);
  } catch { servedCache = null; }
  return servedCache;
}

/** Fail fast, with the served en-US list, when a requested voice is not on this endpoint
 *  (Davis/Jason are the usual suspects: Azure-only, and the socket just closes). */
export async function assertServed(voices) {
  const served = await listServedVoices();
  if (!served) { console.warn('[edge-tts] could not fetch the voice list; skipping the served-voice check'); return; }
  const missing = voices.filter((v) => !served.includes(v));
  if (!missing.length) return;
  const enUS = served.filter((v) => v.startsWith('en-US-')).map((v) => v.replace('en-US-', '').replace('Neural', '')).sort().join(', ');
  throw new Error(`not served by the Edge Read Aloud endpoint: ${missing.join(', ')}. en-US voices it does serve: ${enUS}`);
}

// ---------------------------------------------------------------- PCM plumbing

function ff(args, input) {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

export function decodeToPcm(mp3) {
  const b = ff(['-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'], mp3);
  const even = b.length - (b.length % 2);
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + even));
}

export function encodePcm(pcm) {
  return ff(['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
    '-codec:a', 'libmp3lame', '-b:a', MP3_BITRATE, '-f', 'mp3', 'pipe:1'],
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

const ms2s = (ms) => Math.round(SAMPLE_RATE * ms / 1000);
const s2ms = (samples) => Math.round(samples * 1000 / SAMPLE_RATE);

/** Short-window RMS envelope in dBFS. */
export function envelope(pcm, winMs = 5) {
  const win = ms2s(winMs);
  const n = Math.ceil(pcm.length / win);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = i * win, end = Math.min(pcm.length, (i + 1) * win); j < end; j++) { const v = pcm[j] / 32768; s += v * v; c++; }
    db[i] = c ? 10 * Math.log10(s / c + 1e-12) : -120;
  }
  return { db, win };
}

/** Runs of speech [startSample, endSample], merging runs separated by silence < minGapMs. */
export function speechSpans(pcm, { thr = -45, minGapMs = 120, winMs = 5 } = {}) {
  const { db, win } = envelope(pcm, winMs);
  const raw = [];
  let start = -1;
  for (let i = 0; i <= db.length; i++) {
    const loud = i < db.length && db[i] > thr;
    if (loud && start < 0) start = i;
    if (!loud && start >= 0) { raw.push([start * win, Math.min(pcm.length, i * win)]); start = -1; }
  }
  const minGap = ms2s(minGapMs);
  const spans = [];
  for (const s of raw) {
    if (spans.length && s[0] - spans[spans.length - 1][1] < minGap) spans[spans.length - 1][1] = s[1];
    else spans.push([s[0], s[1]]);
  }
  return spans;
}

/** Silences between speech spans, in ms, plus lead-in and tail. */
export function paceStats(pcm, wordCount) {
  const spans = speechSpans(pcm);
  const dur = pcm.length / SAMPLE_RATE;
  if (!spans.length) return { dur, lead: dur * 1000, tail: 0, gaps: [], speechSec: 0, wpmOverall: 0, wpmArticulated: 0 };
  const gaps = [];
  for (let i = 0; i < spans.length - 1; i++) gaps.push(s2ms(spans[i + 1][0] - spans[i][1]));
  const speechSec = spans.reduce((n, [a, b]) => n + (b - a), 0) / SAMPLE_RATE;
  return {
    dur,
    lead: s2ms(spans[0][0]),
    tail: s2ms(pcm.length - spans[spans.length - 1][1]),
    gaps,
    speechSec,
    wpmOverall: wordCount ? (wordCount / dur) * 60 : 0,
    wpmArticulated: wordCount && speechSec ? (wordCount / speechSec) * 60 : 0,
  };
}

// ---------------------------------------------------------------- script ↔ speech alignment

const norm = (s) => s.replace(/[-'’`"“”.]/g, '').toLowerCase();

/**
 * For each spoken word (from the WordBoundary stream) return the punctuation that follows it in
 * the script text (`''` if none). A lone punctuation token such as "—" is folded into the previous
 * word's trail, so "Steer it. — Flow Video." yields ". —" after "it". Returns null when the spoken
 * words cannot be walked through the text (then the caller leaves the line untouched).
 */
export function alignPunctuation(text, words) {
  const tokens = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/);
    const core = norm(m[2]);
    if (!core) { if (tokens.length) tokens[tokens.length - 1].trail += ' ' + tok; continue; }
    // Leading punctuation ("…Count along") belongs to the pause BEFORE this word.
    if (m[1] && tokens.length) tokens[tokens.length - 1].trail += ' ' + m[1];
    tokens.push({ core, trail: m[3] });
  }
  const out = [];
  let ti = 0, pos = 0;
  for (const w of words) {
    const wn = norm(w.text);
    if (!wn) { out.push(''); continue; }
    while (ti < tokens.length && pos >= tokens[ti].core.length) { ti++; pos = 0; }
    if (ti >= tokens.length) return null;
    const core = tokens[ti].core;
    if (core.slice(pos, pos + wn.length) !== wn) return null;
    pos += wn.length;
    out.push(pos >= core.length ? tokens[ti].trail : '');
  }
  return out;
}

/** `next` = the next two spoken words, so ". —" can tell the brand hit from an ordinary beat. */
export function classifyGap(trail, next = []) {
  if (/…/.test(trail)) return 'ellipsis';                    // "flock… now" · "scatter. … Gorgeous" · "powers. …Count"
  if (/[.!?]\s*["”]?\s*[—–]/.test(trail)) {                  // "Steer it. — Flow Video." · "let go. — Watch gravity"
    return /^flow$/i.test(next[0] ?? '') && /^video$/i.test(next[1] ?? '') ? 'brand' : 'beat';
  }
  if (/\?/.test(trail)) return 'question';
  if (/[.!]/.test(trail)) return 'sentence';
  if (/:/.test(trail)) return 'colon';
  if (/[—–]/.test(trail)) return 'dash';                     // "Simple UI — just the buttons"
  return null;                                               // comma / quote / nothing: as spoken
}

// ---------------------------------------------------------------- the pause editor

function silenceNearest(spans, a, b) {
  // The silent span between consecutive speech spans that overlaps [a,b] the most.
  let best = null, bestOverlap = 0;
  for (let i = 0; i < spans.length - 1; i++) {
    const sa = spans[i][1], sb = spans[i + 1][0];
    const overlap = Math.min(sb, b) - Math.max(sa, a);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = { index: i, sa, sb }; }
  }
  return best;
}

function splice(pcm, plan) {
  // plan: [{ from, to, insert?, fade? }] sorted, non-overlapping. Removes [from,to), inserts
  // `insert` zero samples at `from`. A 3ms linear crossfade smooths every removal joint; an
  // insert flagged `fade` (placed at an energy minimum rather than in true silence) gets a 6ms
  // fade-out before and fade-in after the inserted silence.
  const XF = ms2s(3), FADE = ms2s(6);
  const pieces = [];
  const fades = [];
  let cursor = 0;
  for (const e of plan) {
    pieces.push({ pcm: pcm.subarray(cursor, e.from), xf: false });
    if (e.insert) pieces.push({ pcm: new Int16Array(e.insert), xf: false, fade: !!e.fade });
    cursor = e.to;
    pieces.push({ pcm: null, xf: e.to > e.from }); // marker: next piece joins across a removal
  }
  pieces.push({ pcm: pcm.subarray(cursor), xf: false });
  const total = pieces.reduce((n, p) => n + (p.pcm ? p.pcm.length : 0), 0);
  const out = new Int16Array(total);
  let w = 0, pendingXf = false;
  for (const p of pieces) {
    if (!p.pcm) { pendingXf = p.xf; continue; }
    let src = p.pcm;
    if (pendingXf && w >= XF && src.length > XF) {
      for (let i = 0; i < XF; i++) {
        const t = i / XF;
        out[w - XF + i] = Math.round(out[w - XF + i] * (1 - t) + src[i] * t);
      }
      src = src.subarray(XF);
    }
    if (p.fade) fades.push({ at: w, len: src.length });
    out.set(src, w);
    w += src.length;
    pendingXf = false;
  }
  for (const f of fades) {
    for (let i = 0; i < FADE; i++) {
      const t = i / FADE;
      const before = f.at - FADE + i, after = f.at + f.len + i;
      if (before >= 0) out[before] = Math.round(out[before] * (1 - t));
      if (after < w) out[after] = Math.round(out[after] * t);
    }
  }
  return out.subarray(0, w);
}

function energyMinimum(pcm, a, b) {
  // The quietest 5ms window inside [a,b] — where an editor would drop a breath between two words
  // the voice ran together. Returns the sample position of that window's centre.
  const { db, win } = envelope(pcm, 5);
  const i0 = Math.max(0, Math.floor(a / win)), i1 = Math.min(db.length - 1, Math.ceil(b / win));
  let best = i0;
  for (let i = i0; i <= i1; i++) if (db[i] < db[best]) best = i;
  return best * win + Math.floor(win / 2);
}

/**
 * Resize the pauses of a synthesized line to `gaps` (a PACE entry). Returns the edited PCM and a
 * log of what was done. `words` is the WordBoundary list; `text` the script line.
 */
export function tightenPauses(pcm, words, text, gaps) {
  const log = [];
  if (!gaps) return { pcm, log: ['pace=raw — untouched'] };
  const spans = speechSpans(pcm);
  if (!spans.length) return { pcm, log: ['no speech detected — untouched'] };
  const plan = [];
  const SLOP = ms2s(40);

  const leadSil = spans[0][0];
  if (gaps.lead && leadSil > ms2s(gaps.lead) + SLOP) plan.push({ from: 0, to: leadSil - ms2s(gaps.lead), kind: 'lead' });
  const lastEnd = spans[spans.length - 1][1];
  if (gaps.tail && pcm.length - lastEnd > ms2s(gaps.tail) + SLOP) plan.push({ from: lastEnd + ms2s(gaps.tail), to: pcm.length, kind: 'tail' });

  const punct = alignPunctuation(text, words);
  if (!punct) log.push('WARN: spoken words do not align with the script text — inner pauses left as spoken');
  const used = new Set();
  if (punct) {
    for (let i = 0; i < words.length - 1; i++) {
      const kind = classifyGap(punct[i], [words[i + 1]?.text, words[i + 2]?.text]);
      if (!kind || !gaps[kind]) continue;                              // 0 / unset = as spoken
      const target = ms2s(gaps[kind]);
      const a = ms2s((words[i].t0 + words[i].dur) * 1000), b = ms2s(words[i + 1].t0 * 1000);
      const sil = silenceNearest(spans, a - ms2s(80), b + ms2s(80));
      if (!sil || used.has(sil.index)) {
        // The voice ran the words together (typical for " — " on Guy/Brian): no silent span to
        // resize, so drop the beat at the quietest point of the word boundary, with fades.
        const at = energyMinimum(pcm, Math.max(0, a - ms2s(60)), Math.min(pcm.length, b + ms2s(60)));
        plan.push({ from: at, to: at, insert: target, fade: true, kind });
        log.push(`"${words[i].text}" ${kind} run-on→${gaps[kind]}ms (inserted at energy minimum)`);
        continue;
      }
      used.add(sil.index);
      const len = sil.sb - sil.sa;
      if (Math.abs(len - target) <= SLOP) { log.push(`"${words[i].text}" ${kind} ${s2ms(len)}ms ok`); continue; }
      const mid = sil.sa + Math.floor(len / 2);
      if (len > target) {
        const cut = len - target;
        plan.push({ from: mid - Math.floor(cut / 2), to: mid - Math.floor(cut / 2) + cut, kind });
        log.push(`"${words[i].text}" ${kind} ${s2ms(len)}→${gaps[kind]}ms (cut)`);
      } else {
        plan.push({ from: mid, to: mid, insert: target - len, kind });
        log.push(`"${words[i].text}" ${kind} ${s2ms(len)}→${gaps[kind]}ms (padded)`);
      }
    }
  }
  plan.sort((x, y) => x.from - y.from);
  for (let i = 1; i < plan.length; i++) if (plan[i].from < plan[i - 1].to) return { pcm, log: [...log, 'WARN: overlapping edits — line left untouched'] };
  if (!plan.length) return { pcm, log: [...log, 'nothing to do'] };
  return { pcm: splice(pcm, plan), log };
}

// ---------------------------------------------------------------- measurement of a finished file

export function measureFile(path) {
  const dur = +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).stdout.toString().trim();
  const st = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path,
    '-af', 'astats=measure_perchannel=none:measure_overall=RMS_level+Peak_level,ebur128=peak=none', '-f', 'null', '-']).stderr.toString();
  // ebur128 logs a running line per 100ms frame and the real figures in a Summary at the end, so
  // take the LAST match of each (the first one is the first frame's -70 LUFS / 0 LU).
  const last = (re) => { let m, v = null; while ((m = re.exec(st))) v = +m[1]; return v; };
  return {
    dur,
    rms: last(/RMS level dB:\s*(-?[\d.]+)/g),
    peak: last(/Peak level dB:\s*(-?[\d.]+)/g),
    lufs: last(/I:\s*(-?[\d.]+) LUFS/g),
    lra: last(/LRA:\s*(-?[\d.]+) LU/g),
  };
}

/** Join MP3 parts (paths or buffers) with `gapMs` of silence between them into one MP3 at `outPath`. */
export function concatMp3(parts, outPath, gapMs = 600) {
  const pcms = parts.map((p) => decodeToPcm(typeof p === 'string' ? readFileSync(p) : p));
  const gap = new Int16Array(ms2s(gapMs));
  const total = pcms.reduce((n, p) => n + p.length, 0) + gap.length * (pcms.length - 1);
  const out = new Int16Array(total);
  let w = 0;
  pcms.forEach((p, i) => { out.set(p, w); w += p.length; if (i < pcms.length - 1) { w += gap.length; } });
  ff(['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', MP3_BITRATE, '-y', outPath],
    Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  return outPath;
}

export const wordCount = (text) => text.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t)).length;
