// PRODUCTION narration: ElevenLabs premade voices, straight from the REST API (no backend, no env).
// Writes narration/audio/f{film}-s{scene}.mp3 for every entry of lines.json — the assembler's real
// (non --scratch) source; the viewer question's scene is literally "5-viewer", so its file is
// f4-s5-viewer.mp3. The free Edge take that preceded this lives in narration/audio-edge/ (keyless
// fallback; synthesize-edge.mjs regenerates it).
//
//   node synthesize-elevenlabs.mjs --auth <path/to/el-auth.json> [--force] [--only f1-s2,f4-s5-viewer]
//        [--narrator <voiceId>] [--viewer <voiceId>] [--model <id>] [--film-model 1=eleven_v3]
//        [--out audio] [--speed 1.05] [--style 0.4] [--stability 0.45] [--similarity 0.8] [--no-boost]
//        [--no-fit] [--refit] [--retakes 2] [--no-timestamps] [--dry-run]
//
// --refit: leave everything inside tolerance alone; for a clip still over it, keep the existing take
// as the baseline and buy up to --retakes faster takes, keeping the shortest. --force regenerates.
//
// --auth is the ONLY way the key gets in: a JSON file { "xi_api_key": "..." } kept OUTSIDE the repo.
// The key is never logged, never written, never put on a command line. Everything else is defaults
// (the AUDITION-EL.md pick) so `--auth <file> --force` reproduces the shipped set.
//
// What one run does, per line, in lines.json order:
//   1. skip if the mp3 exists (unless --force) — idempotent; kept clips are still measured;
//   2. POST /v1/text-to-speech/{voice}/with-timestamps with previous_text/next_text = the
//      neighbouring lines of the same film and role (prosodic continuity), falling back to the plain
//      endpoint if a model refuses timestamps;
//   3. QC against the script slot: budget = (t1 - t0) - 0.5s (assemble-film.mjs pads every scene
//      by 0.5s and STRETCHES a scene whose VO runs longer). Over budget by > 0.8s → trim to the
//      words (80ms before the first, 200ms after the last, by the API's own alignment — a word can
//      never be cut), then retake faster (speed ≤ 1.12, models that honour speed only; up to two
//      retakes, the shortest take wins), trimming each. --no-fit leaves the raw take.
//   4. the four-beat close ("Touch it. Ask it. Steer it. — Flow Video.") is checked with
//      silencedetect (−35dB, 150ms) at every beat boundary; a run-on is regenerated with the
//      ellipsis punctuation (words unchanged) on v2, or as a fresh take on v3.
// Then: audio/MANIFEST.json (every clip: settings, request id, chars billed, word timings, QC) and
// ELEVENLABS-NOTE.md (the human record) are rewritten, and the remaining quota is printed.
//
// Fails fast on 401 (bad key / quota_exceeded — the API says which), 402 and 429 (after one retry).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.elevenlabs.io';
export const OUTPUT_FORMAT = 'mp3_44100_128';
export const PAD_AFTER = 0.5;        // assemble-film.mjs: scene = max(slot, VO + 0.5s)
export const FIT_TOLERANCE = 0.8;    // seconds over budget that trigger a refit
export const MAX_SPEED = 1.12;       // refit ceiling (API range 0.7–1.2)
export const MAX_RETAKES = 2;        // extra takes for a clip still over tolerance; the shortest take is kept
export const TRIM = { lead: 0.08, tail: 0.2, thresholdDb: -45 };   // what a refit trim keeps
export const BEAT = { noiseDb: -35, minS: 0.15 };                  // silencedetect for the beat check
/** Delivery loudness. The films mix at −19 LUFS (assemble-film.mjs: loudnorm=I=-19:TP=-1.5:LRA=11),
 *  and the raw takes arrive 8 dB apart (narrator ≈ −24.5, the viewer question ≈ −16), so every clip
 *  is normalized here. LINEAR ONLY: a clip that cannot reach the target without the limiter is
 *  normalized to the loudest target its own true peak allows, and says so — never compressed. */
export const LOUDNESS = { targetI: -19.0, targetTP: -3.0, lra: 11, minTargetI: -30, backoffStep: 0.5, maxAttempts: 5 };
/** The film mix target these stems feed. Kept for the record: it is what was originally asked of the
 *  clips, and the reference the crest analysis in ELEVENLABS-NOTE.md is written against. Peaks are
 *  handled on a voice BUS in the assembler (limiting after the voices are summed, before the bed),
 *  so the clips deliver CONSISTENCY and the single downstream gain supplies the level. */
export const MIX_TARGET_I = -19.0;

export const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex');

/** ElevenLabs premade voices (id → name, the vendor's own labels). American English. */
export const VOICES = {
  TX3LPaxmHKxFdv7VOQHJ: { name: 'Liam', labels: 'male · energetic, confident · social media · young' },
  nPczCjzI2devNBz1zQrb: { name: 'Brian', labels: 'male · deep, resonant, classy · social media' },
  cjVigY5qzO86Huf0OWal: { name: 'Eric', labels: 'male · smooth, trustworthy' },
  pNInz6obpgDQGcFmaJgB: { name: 'Adam', labels: 'male · dominant, firm' },
  CwhRBWXzGAHq8TQ4Fs17: { name: 'Roger', labels: 'male · laid-back, resonant' },
  iP95p4xoKVk53GoZ742B: { name: 'Chris', labels: 'male · charming, casual' },
  bIHbv24MWmeRgasZH58o: { name: 'Will', labels: 'male · relaxed optimist' },
  pqHfZKP75CvOlQylNhV4: { name: 'Bill', labels: 'male · advertisement · older, crisp' },
  EXAVITQu4vr4xnSDxMaL: { name: 'Sarah', labels: 'female · mature, reassuring, confident · TV' },
  XrExE9yKIg1WjnnlVkGX: { name: 'Matilda', labels: 'female · knowledgeable, upbeat · educational' },
  FGY2WhTYpPnrIDTdsKH5: { name: 'Laura', labels: 'female · enthusiast, quirky' },
  cgSgspJ2msm6clMCkdW9: { name: 'Jessica', labels: 'female · playful, bright, warm' },
  hpp4J3VqNfWAUOO0d1Us: { name: 'Bella', labels: 'female · professional, bright, warm' },
};
export const voiceName = (id) => VOICES[id]?.name ?? id;
export const modelShort = (id) => id.replace(/^eleven_/, '');
export const modelHonoursSpeed = (id) => !/^eleven_v3/.test(id);
/** eleven_v3 rejects previous_text / next_text (400 unsupported_model, measured 2026-09-05). */
export const modelHonoursContext = (id) => !/^eleven_v3/.test(id);
/** eleven_v3 has three stability presets: 0.0 creative / 0.5 natural / 1.0 robust. */
export const snapV3Stability = (s) => [0, 0.5, 1].reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));

// ---------------------------------------------------------------- the pick (AUDITION-EL.md)
export const DEFAULTS = {
  narrator: 'TX3LPaxmHKxFdv7VOQHJ',   // Liam
  viewer: 'EXAVITQu4vr4xnSDxMaL',     // Sarah
  model: 'eleven_multilingual_v2',
  filmModel: {},                       // per-film override, e.g. { 1: 'eleven_v3' } for the teaser
  stability: 0.45, similarity: 0.8, style: 0.4, boost: true, speed: 1.05,
  viewerSpeed: 1.0,                    // a viewer asking a question is not in trailer tempo
};
/** Spoken-text variants, keyed by clip id — PUNCTUATION ONLY, the words never change. Filled by the
 *  beat check when a close ran together, and kept here so the next run reproduces it. */
export const TEXT_OVERRIDES = {};
/** Per-clip speed the refit settled on (v2-family only); kept so the next run starts there. */
export const SPEED_OVERRIDES = {};
/** Lines whose beats are checked. `beats` = the first word of each beat; every beat after the first
 *  must be preceded by a detected silence ≥ BEAT.minS. */
export const BEAT_CHECKS = {
  'f1-s10': {
    beats: ['Touch', 'Ask', 'Steer', 'Flow'],
    // Punctuation only — the words never change, and the rule is derived from the CURRENT line so a
    // rewritten tagline keeps its beat treatment.
    retryText: (t) => t.replace(/Touch it\.\s*Ask it\.\s*Steer it\.\s*—\s*Flow Video\./,
      'Touch it. … Ask it. … Steer it. … Flow Video.'),
  },
};

// ---------------------------------------------------------------- auth + API
export function loadAuth(path) {
  if (!path) throw new Error('--auth <path> is required: a JSON file { "xi_api_key": "..." } kept outside the repo');
  const p = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let j;
  try { j = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`--auth ${p}: ${e.message}`); }
  if (typeof j.xi_api_key !== 'string' || !j.xi_api_key.trim()) throw new Error(`--auth ${p}: field xi_api_key missing or empty`);
  // Opaque holder: the key lives in a closure so nothing can stringify it by accident.
  const key = j.xi_api_key.trim();
  return { headers: () => ({ 'xi-api-key': key }), toJSON: () => '[auth]', toString: () => '[auth]' };
}

export class ElevenLabsError extends Error {
  constructor(status, detail, { fatal = false } = {}) {
    super(`ElevenLabs HTTP ${status}${detail ? ` — ${detail}` : ''}`);
    this.status = status; this.detail = detail; this.fatal = fatal;
  }
}

/** Human-readable error detail from an API body, without echoing anything but its message. */
function describeError(status, bodyText) {
  let j = null;
  try { j = JSON.parse(bodyText); } catch { /* not JSON */ }
  const d = j?.detail ?? j?.error ?? j?.message ?? null;
  let s;
  if (d == null) s = String(bodyText ?? '').replace(/\s+/g, ' ').trim();
  else if (typeof d === 'string') s = d;
  else if (Array.isArray(d)) s = d.map((x) => `${(x.loc ?? []).join('.')}: ${x.msg ?? JSON.stringify(x)}`).join('; ');
  else s = `${d.status ?? ''}${d.status && d.message ? ': ' : ''}${d.message ?? JSON.stringify(d)}`;
  const hint = status === 401 ? ' (bad key, or quota_exceeded — the status above says which)'
    : status === 402 ? ' (payment required — plan/credits)'
      : status === 429 ? ' (rate limit / too many concurrent requests)' : '';
  return `${s.slice(0, 300)}${hint}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET /v1/user/subscription → { tier, used, limit, remaining, resetIso, status } (null on non-fatal failure). */
export async function fetchSubscription(auth) {
  const r = await fetch(`${API}/v1/user/subscription`, { headers: auth.headers() });
  const t = await r.text();
  if (r.status === 401 || r.status === 402) throw new ElevenLabsError(r.status, describeError(r.status, t), { fatal: true });
  if (!r.ok) return null;
  const j = JSON.parse(t);
  return {
    tier: j.tier, status: j.status, used: j.character_count, limit: j.character_limit,
    remaining: j.character_limit - j.character_count,
    resetIso: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : null,
  };
}

/**
 * One text-to-speech request. Returns { mp3, alignment|null, requestId, characterCost, endpoint }.
 * Timestamps first (character alignment rides along with the audio); a model that refuses the
 * with-timestamps endpoint falls back to the plain one. 401/402: fatal. 429: one retry, then fatal.
 * 5xx: three retries.
 */
export async function ttsRequest(auth, { voiceId, text, modelId, voiceSettings, previousText, nextText, timestamps = true, outputFormat = OUTPUT_FORMAT }) {
  const body = { text, model_id: modelId, voice_settings: voiceSettings };
  let withContext = modelHonoursContext(modelId);
  if (withContext && previousText) body.previous_text = previousText;
  if (withContext && nextText) body.next_text = nextText;
  let useTs = timestamps, retried429 = false, tried5xx = 0;
  for (;;) {
    const url = `${API}/v1/text-to-speech/${voiceId}${useTs ? '/with-timestamps' : ''}?output_format=${outputFormat}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...auth.headers(), 'content-type': 'application/json', accept: useTs ? 'application/json' : 'audio/mpeg' },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const requestId = r.headers.get('request-id') ?? null;
      const cc = r.headers.get('character-cost');
      const characterCost = cc != null && cc !== '' ? Number(cc) : null;
      const endpoint = `${useTs ? 'with-timestamps' : 'plain'}${withContext ? '' : ' (no context)'}`;
      if (useTs) {
        const j = await r.json();
        return { mp3: Buffer.from(j.audio_base64, 'base64'), alignment: j.alignment ?? null, requestId, characterCost, endpoint, withContext };
      }
      return { mp3: Buffer.from(await r.arrayBuffer()), alignment: null, requestId, characterCost, endpoint, withContext };
    }
    const detail = describeError(r.status, await r.text());
    if (r.status === 401 || r.status === 402) throw new ElevenLabsError(r.status, detail, { fatal: true });
    if (r.status === 429) {
      if (retried429) throw new ElevenLabsError(429, detail, { fatal: true });
      retried429 = true;
      const ra = Number(r.headers.get('retry-after')) || 3;
      console.warn(`  429 — waiting ${ra}s once, then failing fast`);
      await sleep(ra * 1000);
      continue;
    }
    if (r.status >= 500) {
      if (++tried5xx <= 3) { await sleep(1500 * tried5xx); continue; }
      throw new ElevenLabsError(r.status, detail);
    }
    if (withContext && /previous_text|next_text/.test(detail)) {
      // A model that refuses context (v3 does, and says so): drop it and go again.
      console.warn(`  context refused (${r.status} ${detail.slice(0, 120)}) — retrying without previous_text/next_text`);
      withContext = false; delete body.previous_text; delete body.next_text;
      continue;
    }
    if (useTs) {
      // 4xx on with-timestamps: the model may not serve alignment — try the plain endpoint once.
      console.warn(`  with-timestamps refused (${r.status} ${detail.slice(0, 120)}) — plain endpoint`);
      useTs = false;
      continue;
    }
    throw new ElevenLabsError(r.status, detail);
  }
}

// ---------------------------------------------------------------- measurement (ffmpeg / ffprobe)
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error) throw r.error;
  return r;
}

/**
 * Everything the QC needs from one file, in one ffmpeg pass: duration (ffprobe, the same figure the
 * assembler uses), astats RMS/peak, ebur128 integrated loudness / LRA / true peak, and the
 * silencedetect list (noise −35dB, ≥150ms) → lead-in, tail, inner gaps.
 */
export function measureFile(path, { noiseDb = BEAT.noiseDb, minS = BEAT.minS } = {}) {
  const dur = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).stdout.trim());
  const st = run('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af',
    `astats=measure_perchannel=none:measure_overall=RMS_level+Peak_level,ebur128=peak=true,silencedetect=noise=${noiseDb}dB:d=${minS}`,
    '-f', 'null', '-']).stderr;
  const last = (re) => { let m, v = null; while ((m = re.exec(st))) v = Number(m[1]); return v; };
  const silences = [];
  let open = null;
  for (const m of st.matchAll(/silence_(start|end): (-?[\d.]+)(?: \| silence_duration: (-?[\d.]+))?/g)) {
    if (m[1] === 'start') open = Number(m[2]);
    else if (open != null) { silences.push({ start: open, end: Number(m[2]), dur: Number(m[3] ?? (Number(m[2]) - open)) }); open = null; }
  }
  if (open != null) silences.push({ start: open, end: dur, dur: dur - open, unterminated: true });
  const lead = silences.length && silences[0].start <= 0.01 ? silences[0].end : 0;
  const lastS = silences[silences.length - 1];
  const tail = lastS && (lastS.unterminated || dur - lastS.end <= 0.03) && lastS.start > 0.01 ? dur - lastS.start : 0;
  const inner = silences.filter((s) => !(s.start <= 0.01) && !(s === lastS && tail > 0));
  return {
    dur,
    rms: last(/RMS level dB:\s*(-?[\d.]+)/g),
    peak: last(/Peak level dB:\s*(-?[\d.]+)/g),
    truePeak: last(/Peak:\s*(-?[\d.]+) dBFS/g),
    lufs: last(/I:\s*(-?[\d.]+) LUFS/g),
    lra: last(/LRA:\s*(-?[\d.]+) LU/g),
    lead: +lead.toFixed(3), tail: +tail.toFixed(3),
    silences,
    innerGaps: inner.map((s) => Math.round(s.dur * 1000)),
  };
}

/** Trim leading / trailing silence only (keeps TRIM.lead / TRIM.tail of it). One re-encode. */
export function trimSilence(path, { lead = TRIM.lead, tail = TRIM.tail, thresholdDb = TRIM.thresholdDb } = {}) {
  const tmp = `${path}.trim.mp3`;
  const af = `silenceremove=start_periods=1:start_threshold=${thresholdDb}dB:start_silence=${lead}:detection=peak,` +
    `areverse,silenceremove=start_periods=1:start_threshold=${thresholdDb}dB:start_silence=${tail}:detection=peak,areverse`;
  const r = run('ffmpeg', ['-y', '-v', 'error', '-i', path, '-af', af, '-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', tmp]);
  if (r.status !== 0) { try { unlinkSync(tmp); } catch { /* none */ } throw new Error(`ffmpeg trim failed: ${r.stderr.slice(0, 200)}`); }
  renameSync(tmp, path);
}

/**
 * Trim a clip to its words: from TRIM.lead before the first word to TRIM.tail after the last, by the
 * alignment the API returned — so "never cut a word" holds by construction. Without alignment, falls
 * back to silenceremove. Returns what was done; a trim that would save under 50ms is skipped.
 */
export function trimClip(path, { words, dur }) {
  if (!words?.length) { trimSilence(path); return { method: 'silenceremove' }; }
  const start = Math.max(0, words[0].t0 - TRIM.lead);
  const end = Math.min(dur, words[words.length - 1].t1 + TRIM.tail);
  if (dur - (end - start) < 0.05) return { method: 'alignment', start: 0, end: dur, skipped: true };
  const tmp = `${path}.trim.mp3`;
  const r = run('ffmpeg', ['-y', '-v', 'error', '-i', path, '-af', `atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS`,
    '-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', tmp]);
  if (r.status !== 0) { try { unlinkSync(tmp); } catch { /* none */ } throw new Error(`ffmpeg atrim failed: ${r.stderr.slice(0, 200)}`); }
  renameSync(tmp, path);
  return { method: 'alignment', start: +start.toFixed(3), end: +end.toFixed(3) };
}

// ---------------------------------------------------------------- loudness (two-pass loudnorm)
/** The last JSON object ffmpeg's loudnorm printed on stderr. */
function parseLoudnormJson(stderr) {
  const blocks = stderr.match(/\{[^{}]*\}/g);
  if (!blocks) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    try { const j = JSON.parse(blocks[i]); if (j.input_i != null || j.output_i != null) return j; } catch { /* not it */ }
  }
  return null;
}
const numOr = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

/** Pass 1: measure the file against the target. Returns loudnorm's own measurement JSON. */
export function loudnormMeasure(path, { targetI, targetTP, lra } = LOUDNESS) {
  const r = run('ffmpeg', ['-hide_banner', '-nostats', '-i', path,
    '-af', `loudnorm=I=${targetI}:TP=${targetTP}:LRA=${lra}:print_format=json`, '-f', 'null', '-']);
  const j = parseLoudnormJson(r.stderr);
  if (!j) throw new Error(`loudnorm pass 1 printed no JSON for ${path}: ${r.stderr.slice(-200)}`);
  return j;
}

/** Pass 2: apply the measurement at `targetI`, linear only. Returns loudnorm's output JSON (which
 *  carries normalization_type) without keeping the file unless `commit`. */
function loudnormApply(path, measured, { targetI, targetTP, lra }, commit) {
  const tmp = `${path}.norm.mp3`;
  const af = `loudnorm=I=${targetI}:TP=${targetTP}:LRA=${lra}` +
    `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}` +
    `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=json`;
  const r = run('ffmpeg', ['-y', '-hide_banner', '-nostats', '-i', path, '-af', af,
    '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '128k', tmp]);
  const j = r.status === 0 ? parseLoudnormJson(r.stderr) : null;
  if (r.status !== 0 || !j) { try { unlinkSync(tmp); } catch { /* none */ } throw new Error(`loudnorm pass 2 failed for ${path}: ${r.stderr.slice(-200)}`); }
  if (commit && j.normalization_type === 'linear') renameSync(tmp, path);
  else try { unlinkSync(tmp); } catch { /* none */ }
  return j;
}

/**
 * Normalize one clip to `targetI` LUFS with true peak ≤ `targetTP`, LINEAR ONLY.
 *
 * Linear normalization is a single gain, so it cannot both hit a loudness target and hold a peak
 * ceiling when the clip's crest factor exceeds (targetTP − targetI): ffmpeg then silently switches
 * to `dynamic`, which is a limiter — a compressed take. Instead of shipping that, the target is
 * backed off to the loudest value this clip's own true peak allows (input_i + targetTP − input_tp),
 * and the result records how far short of −19 it landed and why.
 *
 * Returns { targetI, achievedI, tp, type, backedOff, shortfall, attempts, input } — or, if no linear
 * pass could be achieved at all, { failed: true } with the file left untouched.
 */
export function normalizeLoudness(path, opts = {}) {
  const cfg = { ...LOUDNESS, ...opts };
  const attempts = [];
  let target = cfg.targetI;
  for (let n = 0; n < cfg.maxAttempts; n++) {
    const measured = loudnormMeasure(path, { ...cfg, targetI: target });
    const inputI = numOr(measured.input_i, null), inputTP = numOr(measured.input_tp, null);
    const out = loudnormApply(path, measured, { ...cfg, targetI: target }, true);
    attempts.push({ target, type: out.normalization_type, inputI, inputTP, outputI: numOr(out.output_i, null), outputTP: numOr(out.output_tp, null) });
    if (out.normalization_type === 'linear') {
      return {
        targetI: target, achievedI: numOr(out.output_i, null), tp: numOr(out.output_tp, null),
        type: 'linear', gainDb: inputI != null ? +(target - inputI).toFixed(2) : null,
        backedOff: target !== cfg.targetI, shortfall: +(target - cfg.targetI).toFixed(2),
        input: { i: inputI, tp: inputTP, lra: numOr(measured.input_lra, null) }, attempts,
      };
    }
    // Dynamic: the gain to `target` would push the true peak past the ceiling. The most this clip
    // can take linearly is input_i + (targetTP − input_tp); step below it and try again.
    if (inputI == null || inputTP == null) break;
    const headroom = Math.floor((inputI + (cfg.targetTP - inputTP)) * 10) / 10;
    const next = Math.min(headroom, target - cfg.backoffStep);
    if (!Number.isFinite(next) || next < cfg.minTargetI || next >= target) break;
    target = +next.toFixed(1);
  }
  return { failed: true, attempts, targetI: cfg.targetI };
}

export const wordCount = (text) => text.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t)).length;

/**
 * Character alignment → words: [{ text, t0, t1, trail, gapAfterMs }]. t0/t1 span the word's
 * alphanumerics; punctuation-only tokens ("—") fold into the previous word's trail, so the gap
 * before "Touch" in "live. — Touch it." is measured from the end of "live" to the start of "Touch".
 */
export function wordsFromAlignment(al) {
  if (!al?.characters?.length) return null;
  const words = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur.t0 == null) { if (words.length) words[words.length - 1].trail += ' ' + cur.text; }
    else words.push(cur);
    cur = null;
  };
  al.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { flush(); return; }
    if (!cur) cur = { text: '', t0: null, t1: null, trail: '' };
    cur.text += ch;
    if (/[A-Za-z0-9]/.test(ch)) {
      if (cur.t0 == null) cur.t0 = al.character_start_times_seconds[i];
      cur.t1 = al.character_end_times_seconds[i];
      cur.trail = '';
    } else if (cur.t0 != null) cur.trail += ch;
  });
  flush();
  for (let i = 0; i < words.length; i++) {
    words[i].t0 = +words[i].t0.toFixed(3); words[i].t1 = +words[i].t1.toFixed(3);
    words[i].gapAfterMs = i < words.length - 1 ? Math.round((words[i + 1].t0 - words[i].t1) * 1000) : null;
  }
  return words;
}

/**
 * Beat check for a close like "Touch it. Ask it. Steer it. — Flow Video.": for each beat word find
 * the gap before it (alignment) and the silencedetect silence covering that boundary. `ok` = every
 * beat after the first sits behind a detected silence ≥ BEAT.minS. Without alignment the check
 * degrades to counting inner silences.
 */
export function checkBeats(words, measure, beatWords) {
  const norm = (s) => s.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const need = beatWords.length - 1;
  if (!words) {
    const n = measure.innerGaps.filter((g) => g >= BEAT.minS * 1000).length;
    return { ok: n >= need, method: 'silence-count', innerSilences: n, need, beats: [] };
  }
  const beats = [];
  let from = 0;
  for (const b of beatWords) {
    const i = words.findIndex((w, k) => k >= from && norm(w.text) === norm(b));
    if (i < 0) { beats.push({ beat: b, missing: true }); continue; }
    from = i + 1;
    const prev = words[i - 1];
    const gapMs = prev ? Math.round((words[i].t0 - prev.t1) * 1000) : null;
    const sil = prev ? measure.silences.find((s) => s.end > prev.t1 - 0.05 && s.start < words[i].t0 + 0.05) : null;
    beats.push({ beat: b, after: prev ? `${prev.text}${prev.trail}` : null, gapMs, silenceMs: sil ? Math.round(sil.dur * 1000) : 0 });
  }
  const inter = beats.slice(1);
  const ok = inter.length === need && inter.every((x) => !x.missing && x.silenceMs >= BEAT.minS * 1000);
  return { ok, method: 'alignment+silencedetect', need, beats };
}

/**
 * Set-wide linear normalization: ONE loudness for every clip, chosen as the loudest target the most
 * peak-constrained clip in the set can still reach linearly (or a target you name). Per-clip
 * back-off (the default) maximizes each clip on its own and therefore spreads the set out by
 * whatever its worst transients dictate; this trades absolute level for a narration track that sits
 * at one level, which is what a mix wants. Still linear — nothing is compressed.
 */
export function uniformTarget(recs, targetTP) {
  const head = recs
    .filter((r) => r?.measure?.lufs != null && r.measure.tp != null)
    .map((r) => ({ id: r.id, i: r.measure.lufs, tp: r.measure.tp, max: +(r.measure.lufs + (targetTP - r.measure.tp)).toFixed(2) }))
    .sort((a, b) => a.max - b.max);
  return { target: head.length ? Math.floor(head[0].max * 10) / 10 : null, constrainedBy: head.slice(0, 3) };
}

// ---------------------------------------------------------------- the CLI
function parseArgs(argv) {
  const args = argv.slice(2);
  const flag = (n) => args.includes(n);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
  const num = (n, d) => { const v = opt(n, null); if (v == null) return d; const x = Number(v); if (!Number.isFinite(x)) { console.error(`${n} needs a number`); process.exit(2); } return x; };
  const filmModel = { ...DEFAULTS.filmModel };
  for (const kv of (opt('--film-model', '') || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [f, m] = kv.split('=');
    if (!f || !m) { console.error('--film-model wants film=model_id[,film=model_id]'); process.exit(2); }
    filmModel[Number(f)] = m;
  }
  return {
    auth: opt('--auth', null),
    force: flag('--force'),
    only: opt('--only', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null,
    narrator: opt('--narrator', DEFAULTS.narrator),
    viewer: opt('--viewer', DEFAULTS.viewer),
    model: opt('--model', null),           // null = DEFAULTS.model unless a per-film model applies
    filmModel,
    out: opt('--out', 'audio'),
    stability: num('--stability', DEFAULTS.stability),
    similarity: num('--similarity', DEFAULTS.similarity),
    style: num('--style', DEFAULTS.style),
    boost: !flag('--no-boost') && DEFAULTS.boost,
    speed: num('--speed', DEFAULTS.speed),
    fit: !flag('--no-fit'),
    refit: flag('--refit'),
    retakes: num('--retakes', MAX_RETAKES),
    timestamps: !flag('--no-timestamps'),
    dryRun: flag('--dry-run'),
    verify: flag('--verify'),
    normalize: !flag('--no-normalize'),
    targetI: num('--target-lufs', LOUDNESS.targetI),
    targetTP: num('--target-tp', LOUDNESS.targetTP),
    keepDrift: flag('--keep-drift'),
    uniform: opt('--uniform', null),   // "auto" | a LUFS number — one level for the whole set
  };
}

/**
 * The assembler's gate. Fails (exit 1) when any line of lines.json has no mp3, no manifest record,
 * or a manifest whose textSha1 no longer matches the line — i.e. the script moved and the audio did
 * not. Needs no key. Orphans and un-normalized clips are reported but do not fail the gate.
 */
export function verifySet({ lines, manifest, OUT, targetI }) {
  const problems = [];
  const warnings = [];
  const notLinear = [], backedOff = [], overSlot = [], offPolicy = [];
  const policy = manifest.loudness ?? null;
  for (const l of lines) {
    const id = clipId(l);
    const file = join(OUT, `${id}.mp3`);
    const rec = manifest.clips[id];
    const want = sha1(l.text);
    if (!existsSync(file)) problems.push({ id, kind: 'MISSING FILE', detail: file });
    if (!rec) { problems.push({ id, kind: 'NO MANIFEST ENTRY', detail: 'never synthesized, or the manifest was lost' }); continue; }
    const have = rec.textSha1 ?? sha1(rec.scriptText ?? rec.text);
    if (have !== want) {
      problems.push({ id, kind: 'TEXT DRIFT', detail: `manifest ${have.slice(0, 8)} ≠ lines.json ${want.slice(0, 8)}`,
        was: rec.scriptText ?? rec.text, now: l.text });
    }
    if (rec.normalized?.type !== 'linear') notLinear.push(id);
    else if (rec.normalized.backedOff) backedOff.push(rec);
    if (rec.over > FIT_TOLERANCE) overSlot.push(`${id} +${rec.over.toFixed(2)}s`);
    if (policy?.mode === 'uniform' && rec.measure?.lufs != null && Math.abs(rec.measure.lufs - policy.targetI) > 0.8) offPolicy.push(`${id} ${rec.measure.lufs}`);
  }
  const ids = new Set(lines.map(clipId));
  for (const id of Object.keys(manifest.clips)) if (!ids.has(id)) warnings.push(`orphan manifest entry (no line in lines.json): ${id}`);
  // One line each, not one per clip — this runs as a gate.
  if (notLinear.length) warnings.push(`NOT linearly normalized (${notLinear.length}): ${notLinear.join(', ')}`);
  if (policy?.mode === 'uniform') {
    warnings.push(offPolicy.length
      ? `off the uniform ${policy.targetI} LUFS policy (${offPolicy.length}): ${offPolicy.join(', ')} — re-level with --uniform auto`
      : `loudness: all ${lines.length} clips on the uniform ${policy.targetI} LUFS / TP ≤ ${policy.targetTP} dBTP policy`);
  }
  if (backedOff.length && policy?.mode !== 'uniform') {
    const worst = backedOff.map((r) => Math.abs(r.normalized.shortfall)).sort((a, b) => b - a)[0];
    warnings.push(`${backedOff.length}/${lines.length} clips normalized below ${targetI} LUFS (true-peak ceiling; worst ${worst.toFixed(1)} dB short) — see ELEVENLABS-NOTE.md "Loudness"`);
  }
  if (overSlot.length) warnings.push(`over slot budget by >${FIT_TOLERANCE}s (the assembler stretches these scenes): ${overSlot.join(', ')}`);
  return { problems, warnings };
}

/** voice_settings for a model: v3 gets a stability preset and no speed. */
export function settingsFor(modelId, { stability, similarity, style, boost, speed }) {
  const v = { stability, similarity_boost: similarity, style, use_speaker_boost: boost };
  if (modelHonoursSpeed(modelId)) v.speed = speed;
  else v.stability = snapV3Stability(stability);
  return v;
}

/** previous_text / next_text: the neighbouring lines of the same film AND role. */
export function contextFor(lines, idx, spokenText) {
  const l = lines[idx];
  let prev = null, next = null;
  for (let i = idx - 1; i >= 0; i--) if (lines[i].film === l.film && lines[i].role === l.role) { prev = lines[i]; break; }
  for (let i = idx + 1; i < lines.length; i++) if (lines[i].film === l.film && lines[i].role === l.role) { next = lines[i]; break; }
  return { previousText: prev ? spokenText(prev) : null, nextText: next ? spokenText(next) : null };
}

export const clipId = (l) => `f${l.film}-s${l.scene}`;

async function main() {
  const cfg = parseArgs(process.argv);
  const lines = JSON.parse(readFileSync(join(HERE, 'lines.json'), 'utf8'));
  const films = existsSync(join(HERE, 'films.json')) ? JSON.parse(readFileSync(join(HERE, 'films.json'), 'utf8')) : [];
  const OUT = isAbsolute(cfg.out) ? cfg.out : join(HERE, cfg.out);
  mkdirSync(OUT, { recursive: true });
  // The CANONICAL manifest lives beside lines.json, not inside audio/ — audio/ is gitignored, and a
  // gate whose evidence is ignored is only half a gate: on a fresh checkout --verify must still know
  // what each clip is supposed to say. A mirror stays inside the audio dir for convenience.
  const canonicalPath = isAbsolute(cfg.out) ? join(OUT, 'MANIFEST.json') : join(HERE, `${basename(cfg.out)}-manifest.json`);
  const mirrorPath = join(OUT, 'MANIFEST.json');
  const readManifest = () => {
    for (const p of [canonicalPath, mirrorPath]) if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    return { clips: {}, runs: [] };
  };
  const manifest = readManifest();
  manifest.clips ??= {}; manifest.runs ??= [];
  const saveManifest = () => {
    const json = JSON.stringify(manifest, null, 2);
    writeFileSync(canonicalPath, json);
    if (mirrorPath !== canonicalPath) writeFileSync(mirrorPath, json);
  };
  // (canonicalPath is the manifest path; saveManifest() writes it and the mirror)

  // Loudness policy of the SET, remembered in the manifest. Without this, a later drift run would
  // quietly re-normalize kept clips per-clip and land new ones somewhere else, undoing a uniform
  // pass — the set has to stay at one level across runs, not just within one run.
  const policy = manifest.loudness ?? null;
  const targetIExplicit = process.argv.includes('--target-lufs');
  const effTargetI = (!targetIExplicit && policy?.mode === 'uniform') ? policy.targetI : cfg.targetI;
  const effTargetTP = (!process.argv.includes('--target-tp') && policy?.targetTP != null) ? policy.targetTP : cfg.targetTP;
  cfg.targetI = effTargetI; cfg.targetTP = effTargetTP;
  if (policy?.mode === 'uniform' && !cfg.uniform && !cfg.verify) {
    console.log(`loudness policy: uniform ${policy.targetI} LUFS / TP ≤ ${policy.targetTP} dBTP (from the manifest — new and kept clips are held to it)`);
  }

  const modelFor = (l) => cfg.model ?? cfg.filmModel[l.film] ?? DEFAULTS.model;
  const spokenText = (l) => TEXT_OVERRIDES[clipId(l)] ?? l.text;
  const speedFor = (l) => (l.role === 'viewer' ? DEFAULTS.viewerSpeed : (SPEED_OVERRIDES[clipId(l)] ?? cfg.speed));
  const loud = { targetI: cfg.targetI, targetTP: cfg.targetTP, lra: LOUDNESS.lra, minTargetI: LOUDNESS.minTargetI, backoffStep: LOUDNESS.backoffStep, maxAttempts: LOUDNESS.maxAttempts };

  // ---------------------------------------------------------------- --uniform (local, no key)
  if (cfg.uniform) {
    const recs = lines.map((l) => manifest.clips[clipId(l)]).filter(Boolean);
    const auto = uniformTarget(recs, cfg.targetTP);
    const target = cfg.uniform === 'auto' ? auto.target : Number(cfg.uniform);
    if (!Number.isFinite(target)) { console.error('--uniform wants "auto" or a LUFS number'); process.exit(2); }
    console.log(`uniform pass → ${target} LUFS / TP ≤ ${cfg.targetTP} dBTP for all ${recs.length} clips` +
      `${cfg.uniform === 'auto' ? ` (auto: the most constrained clips are ${auto.constrainedBy.map((h) => `${h.id} ${h.max}`).join(', ')})` : ''}`);
    let worst = 0, failed = [];
    for (const l of lines) {
      const id = clipId(l);
      const rec = manifest.clips[id];
      const file = join(OUT, `${id}.mp3`);
      if (!rec || !existsSync(file)) { console.error(`  skip ${id}: no clip`); continue; }
      const n = normalizeLoudness(file, { ...loud, targetI: target });
      const m = measureFile(file);
      rec.normalized = { ...normRecord(n, { ...cfg, targetI: target }), uniform: true };
      rec.dur = m.dur; rec.slot = l.t1 - l.t0; rec.budget = +(rec.slot - PAD_AFTER).toFixed(2); rec.over = +(m.dur - rec.budget).toFixed(2);
      rec.measure = { ...rec.measure, rms: m.rms, peak: m.peak, truePeak: m.truePeak, tp: m.truePeak, lufs: m.lufs, lra: m.lra, lead: m.lead, tail: m.tail, innerGaps: m.innerGaps };
      if (BEAT_CHECKS[id]) rec.beats = checkBeats(rec.words, m, BEAT_CHECKS[id].beats);
      if (n.failed || n.backedOff) failed.push(`${id} (${n.failed ? 'no linear pass' : `only ${n.targetI}`})`);
      worst = Math.max(worst, Math.abs(m.lufs - target));
      console.log(`  ${id.padEnd(13)} ${describeNorm(n, m)}`);
    }
    // The set's level is now policy: later runs (drift re-synthesis included) hold new clips to it.
    manifest.loudness = { mode: 'uniform', targetI: target, targetTP: cfg.targetTP, auto: cfg.uniform === 'auto', at: new Date().toISOString() };
    saveManifest();
    const lufs = lines.map((l) => manifest.clips[clipId(l)]?.measure?.lufs).filter((x) => x != null);
    console.log(`\nmeasured spread now ${(Math.max(...lufs) - Math.min(...lufs)).toFixed(1)} dB (${Math.min(...lufs)} … ${Math.max(...lufs)} LUFS); worst deviation from target ${worst.toFixed(1)} dB${failed.length ? `\ncould not reach the uniform target: ${failed.join(', ')}` : '\nevery clip reached the uniform target linearly'}`);
    writeNote(join(HERE, 'ELEVENLABS-NOTE.md'), { cfg, manifest, lines, films, runStat: { at: new Date().toISOString(), made: 0, kept: lines.length, failed: 0, requests: 0, charsBilled: 0, characterCostHeader: 0, uniform: target }, subAfter: null, OUT });
    return;
  }

  // ---------------------------------------------------------------- --verify (no key needed)
  if (cfg.verify) {
    const { problems, warnings } = verifySet({ lines, manifest, OUT, targetI: cfg.targetI });
    for (const w of warnings) console.log(`  note  ${w}`);
    if (!problems.length) {
      console.log(`✓ verify: ${lines.length}/${lines.length} clips present, and every manifest textSha1 matches lines.json.`);
      return;
    }
    console.error(`✗ verify: ${problems.length} problem(s) — the audio does not match the scripts.\n`);
    for (const p of problems) {
      console.error(`  ${p.kind.padEnd(18)} ${p.id}`);
      if (p.was != null) { console.error(`    was: ${JSON.stringify(p.was)}`); console.error(`    now: ${JSON.stringify(p.now)}`); }
      else console.error(`    ${p.detail}`);
    }
    console.error(`\n  Fix: node synthesize-elevenlabs.mjs --auth <file>   (a plain run re-synthesizes exactly the drifted and missing clips)`);
    process.exit(1);
  }

  const plan = lines.map((l, idx) => ({ l, idx, id: clipId(l) })).filter((p) => !cfg.only || cfg.only.includes(p.id));
  if (cfg.only) {
    const unknown = cfg.only.filter((id) => !plan.some((p) => p.id === id));
    if (unknown.length) { console.error(`--only: no such clip(s): ${unknown.join(', ')}`); process.exit(2); }
  }
  const modelsUsed = [...new Set(plan.map((p) => modelFor(p.l)))];
  console.log(`narrator=${voiceName(cfg.narrator)} (${cfg.narrator}) · viewer=${voiceName(cfg.viewer)} (${cfg.viewer}) · model=${modelsUsed.join(' / ')}${Object.keys(cfg.filmModel).length ? ' film-model ' + JSON.stringify(cfg.filmModel) : ''}`);
  console.log(`settings stability ${cfg.stability} · similarity ${cfg.similarity} · style ${cfg.style} · boost ${cfg.boost} · speed ${cfg.speed} (viewer ${DEFAULTS.viewerSpeed}) · fit ${cfg.fit ? `on (>${FIT_TOLERANCE}s over → trim, speed ≤ ${MAX_SPEED})` : 'off'} → ${OUT}`);

  // A clip whose manifest text no longer matches lines.json is stale: the script moved under the
  // audio. A plain run re-synthesizes exactly those (plus anything missing) — no --force needed.
  const staleOf = (l) => {
    const rec = manifest.clips[clipId(l)];
    if (!rec) return null;
    const have = rec.textSha1 ?? sha1(rec.scriptText ?? rec.text);
    return have === sha1(l.text) ? null : { was: rec.scriptText ?? rec.text, now: l.text };
  };
  const drifted = cfg.keepDrift ? [] : plan.filter((p) => existsSync(join(OUT, `${p.id}.mp3`)) && staleOf(p.l));
  if (drifted.length) {
    console.log(`\ntext drift — ${drifted.length} clip(s) no longer say their line (manifest textSha1 ≠ lines.json); re-synthesizing:`);
    for (const { l, id } of drifted) {
      const d = staleOf(l);
      console.log(`  ${id}\n    was: ${JSON.stringify(d.was)}\n    now: ${JSON.stringify(d.now)}`);
    }
    console.log('');
  }
  const isStale = (p) => drifted.some((d) => d.id === p.id);

  if (cfg.dryRun) {
    let chars = 0;
    for (const p of plan) {
      const { l, idx, id } = p;
      const text = spokenText(l);
      const ctx = contextFor(lines, idx, spokenText);
      const exists = existsSync(join(OUT, `${id}.mp3`));
      const will = cfg.force || !exists || isStale(p);
      if (will) chars += text.length;
      console.log(`${will ? (isStale(p) ? 'DRIFT' : 'MAKE ') : 'keep '} ${id.padEnd(13)} ${l.role.padEnd(8)} ${modelShort(modelFor(l)).padEnd(15)} ${String(text.length).padStart(3)}ch  slot ${l.t1 - l.t0}s  prev=${ctx.previousText ? '"' + ctx.previousText.slice(0, 24) + '…"' : '—'} next=${ctx.nextText ? '"' + ctx.nextText.slice(0, 24) + '…"' : '—'}`);
    }
    console.log(`dry run: ${plan.length} clips in plan, ${chars} chars would be billed`);
    return;
  }

  let auth;
  try { auth = loadAuth(cfg.auth); } catch (e) { console.error(e.message); process.exit(2); }
  const fatal = (e) => { console.error(`\n✗ ${e.message}\n  stopping — nothing else will succeed with this key/quota.`); process.exit(1); };
  let subBefore = null;
  try { subBefore = await fetchSubscription(auth); } catch (e) { if (e.fatal) fatal(e); throw e; }
  if (subBefore) console.log(`quota before: ${subBefore.used}/${subBefore.limit} chars used (${subBefore.remaining} remaining) · tier ${subBefore.tier} · resets ${subBefore.resetIso ?? '—'}`);

  const runStat = { at: new Date().toISOString(), made: 0, kept: 0, failed: 0, requests: 0, charsBilled: 0, characterCostHeader: 0, drifted: drifted.map((d) => d.id) };
  const report = [];
  const normStat = [];

  for (const p of plan) {
    const { l, idx, id } = p;
    const out = join(OUT, `${id}.mp3`);
    const slot = l.t1 - l.t0;
    const budget = +(slot - PAD_AFTER).toFixed(2);
    const words = wordCount(l.text);
    const stale = isStale(p);
    // --refit: an existing clip that is still over tolerance becomes the baseline take and only
    // gets faster retakes (shortest wins) — no fresh first take, nothing inside tolerance touched.
    const existing = manifest.clips[id] ?? null;
    const refitting = cfg.refit && !cfg.force && !stale && existsSync(out) && existing?.words?.length && existing.over > FIT_TOLERANCE && modelHonoursSpeed(existing.modelId);
    if (existsSync(out) && !cfg.force && !refitting && !stale) {
      // Kept: no purchase. Still normalize if it has not been normalized to the current target, and
      // re-run the slot QC afterwards — the loudnorm re-encode can change the duration.
      let m = measureFile(out);
      const needsNorm = cfg.normalize && !(existing?.normalized?.type === 'linear' && existing.normalized.requestedI === cfg.targetI && existing.normalized.requestedTP === cfg.targetTP);
      if (needsNorm) {
        const n = normalizeLoudness(out, loud);
        m = measureFile(out);
        if (existing) {
          existing.normalized = normRecord(n, cfg);
          (existing.actions ??= []).push(normAction(n, cfg));
          normStat.push({ id, n });
        }
        console.log(`· ${id.padEnd(13)} normalized ${describeNorm(n, m)}${m.dur - budget > 0 ? `  budget ${budget}s OVER ${(m.dur - budget).toFixed(2)}s` : ''}`);
      }
      // Always re-seat the record against the CURRENT line: the scripts move the slots as well as
      // the words, so a clip that never changed can still fall out of a shrunken budget.
      if (existing) {
        existing.dur = m.dur; existing.slot = slot; existing.budget = budget; existing.over = +(m.dur - budget).toFixed(2);
        existing.measure = { ...existing.measure, rms: m.rms, peak: m.peak, truePeak: m.truePeak, tp: m.truePeak, lufs: m.lufs, lra: m.lra, lead: m.lead, tail: m.tail, innerGaps: m.innerGaps };
        existing.textSha1 ??= sha1(existing.scriptText ?? existing.text);
        if (BEAT_CHECKS[id]) existing.beats = checkBeats(existing.words, m, BEAT_CHECKS[id].beats);
      }
      runStat.kept++;
      report.push({ id, l, kept: true, rec: existing, m, dur: m.dur, slot, budget, over: +(m.dur - budget).toFixed(2), words, actions: existing?.actions ?? [] });
      continue;
    }
    const isViewer = l.role === 'viewer';
    const voiceId = refitting ? existing.voiceId : (isViewer ? cfg.viewer : cfg.narrator);
    const modelId = refitting ? existing.modelId : modelFor(l);
    const ctx = contextFor(lines, idx, spokenText);
    let text = refitting ? existing.text : spokenText(l);
    let speed = refitting ? (existing.voiceSettings?.speed ?? speedFor(l)) : speedFor(l);
    const actions = refitting ? [...(existing.actions ?? []), `--refit pass`] : [];
    let charsBilled = refitting ? (existing.charsBilled ?? 0) : 0, attempts = refitting ? (existing.attempts ?? 0) : 0, lastReq = null;
    if (refitting) lastReq = { words: existing.words, voiceSettings: existing.voiceSettings, text: existing.text, requestId: existing.requestId, characterCost: existing.characterCost, endpoint: existing.endpoint };

    const synth = async (why) => {
      const voiceSettings = settingsFor(modelId, { stability: cfg.stability, similarity: cfg.similarity, style: cfg.style, boost: cfg.boost, speed });
      const r = await ttsRequest(auth, { voiceId, text, modelId, voiceSettings, ...ctx, timestamps: cfg.timestamps });
      attempts++; runStat.requests++;
      charsBilled += text.length; runStat.charsBilled += text.length;
      if (r.characterCost != null) runStat.characterCostHeader += r.characterCost;
      writeFileSync(out, r.mp3);
      lastReq = { ...r, voiceSettings, text, words: wordsFromAlignment(r.alignment) };
      if (why) actions.push(why);
      return measureFile(out);
    };

    // Trim the current take to its words (lead 80ms / tail 200ms); logs what it saved.
    const trimTake = (m) => {
      const before = m.dur;
      const how = trimClip(out, { words: lastReq.words, dur: m.dur });
      const after = measureFile(out);
      actions.push(how.skipped ? `trim: nothing to cut (${before.toFixed(2)}s)` : `trim by ${how.method} ${before.toFixed(2)}→${after.dur.toFixed(2)}s`);
      return after;
    };

    try {
      let m = refitting ? measureFile(out) : await synth(null);
      const rawDur = refitting ? (existing.rawDur ?? m.dur) : m.dur;
      // --- fit to the slot: trim first (free, words untouched), then retake faster (speed ≤ MAX_SPEED)
      //     and trim again, keeping the SHORTEST take — v2 takes vary ±20% in length between
      //     generations, more than the speed setting moves them, so a retake can come out longer.
      if (cfg.fit && m.dur - budget > FIT_TOLERANCE) {
        if (!refitting) m = trimTake(m);
        let retakes = 0;
        while (m.dur - budget > FIT_TOLERANCE && modelHonoursSpeed(modelId) && retakes < cfg.retakes) {
          const best = { bytes: readFileSync(out), m, req: lastReq, speed };
          const want = Math.min(MAX_SPEED, Math.ceil(speed * (m.dur / Math.max(budget, 0.5)) * 100) / 100);
          if (want > speed) speed = want;
          retakes++;
          m = await synth(`retake ${retakes} at speed ${speed} (+${text.length} chars)`);
          m = trimTake(m);
          if (m.dur >= best.m.dur) {
            writeFileSync(out, best.bytes); m = best.m; lastReq = best.req;
            actions.push(`retake ${retakes} not shorter — kept the ${best.m.dur.toFixed(2)}s take`);
          }
        }
      }
      // --- beat check for the four-beat close
      let beats = refitting ? (existing.beats ?? null) : null;
      const bc = BEAT_CHECKS[id];
      if (bc && !refitting) {
        beats = checkBeats(lastReq.words, m, bc.beats);
        if (!beats.ok) {
          const first = beats;
          const punctuated = typeof bc.retryText === 'function' ? bc.retryText(text) : bc.retryText;
          if (modelHonoursSpeed(modelId) && punctuated && punctuated !== text) {
            text = punctuated;
            m = await synth(`beats ran on [${first.beats.map((b) => b.silenceMs ?? '?').join(',')}]ms → re-synth with ellipsis punctuation (words unchanged, +${text.length} chars)`);
          } else {
            m = await synth(`beats ran on [${first.beats.map((b) => b.silenceMs ?? '?').join(',')}]ms → fresh take (+${text.length} chars)`);
          }
          beats = checkBeats(lastReq.words, m, bc.beats);
          if (beats.ok) actions.push('beats OK on retake'); else actions.push(`beats STILL run on [${beats.beats.map((b) => b.silenceMs ?? '?').join(',')}]ms`);
        }
      }
      // --- delivery loudness, then the slot QC and the beat check AGAIN on the final file: the
      //     loudnorm re-encode can shift the duration, and a gain change moves the −35dB silence
      //     floor the beat check reads.
      let normalized = null;
      if (cfg.normalize) {
        const n = normalizeLoudness(out, loud);
        normalized = normRecord(n, cfg);
        actions.push(normAction(n, cfg));
        normStat.push({ id, n });
        const beforeDur = m.dur;
        m = measureFile(out);
        if (Math.abs(m.dur - beforeDur) > 0.02) actions.push(`duration after normalize ${beforeDur.toFixed(2)}→${m.dur.toFixed(2)}s`);
        if (bc) {
          const after = checkBeats(lastReq.words, m, bc.beats);
          if (beats?.ok && !after.ok) actions.push(`WARNING: beats regressed after normalization [${after.beats.map((b) => b.silenceMs ?? '?').join(',')}]ms`);
          beats = after;
        }
      }
      const over = +(m.dur - budget).toFixed(2);
      manifest.clips[id] = {
        id, film: l.film, scene: l.scene, role: l.role, kind: l.kind ?? null,
        voiceId, voice: voiceName(voiceId), modelId, voiceSettings: lastReq.voiceSettings,
        text: lastReq.text, scriptText: lastReq.text === l.text ? undefined : l.text, textSha1: sha1(l.text), chars: lastReq.text.length, charsBilled, attempts,
        characterCost: lastReq.characterCost, requestId: lastReq.requestId, endpoint: lastReq.endpoint,
        previousText: ctx.previousText, nextText: ctx.nextText,
        dur: m.dur, rawDur, slot, budget, over, actions, normalized,
        measure: { rms: m.rms, peak: m.peak, truePeak: m.truePeak, tp: m.truePeak, lufs: m.lufs, lra: m.lra, lead: m.lead, tail: m.tail, innerGaps: m.innerGaps },
        words: lastReq.words, beats, generatedAt: refitting ? existing.generatedAt : new Date().toISOString(), refitAt: refitting ? new Date().toISOString() : undefined,
      };
      runStat.made++;
      report.push({ id, l, kept: false, rec: manifest.clips[id], m, dur: m.dur, rawDur, slot, budget, over, words, actions, beats });
      const wpm = Math.round((words / m.dur) * 60);
      console.log(`✓ ${id.padEnd(13)} ${l.role.padEnd(8)} ${modelShort(modelId).padEnd(15)} ${rawDur.toFixed(2)}s${m.dur !== rawDur ? ` → ${m.dur.toFixed(2)}s` : ''}  ${String(wpm).padStart(3)} wpm  budget ${budget}s${over > 0 ? `  OVER ${over.toFixed(2)}s` : ''}  ${m.lufs} LUFS  TP ${m.truePeak}${beats ? `  beats ${beats.ok ? 'OK' : 'RUN-ON'} ${JSON.stringify(beats.beats.map((b) => b.silenceMs ?? '?'))}` : ''}${actions.length ? '\n    ' + actions.join('\n    ') : ''}`);
    } catch (e) {
      if (e instanceof ElevenLabsError && e.fatal) fatal(e);
      runStat.failed++;
      report.push({ id, l, failed: true, error: String(e?.message ?? e).slice(0, 200), words, slot, budget, actions });
      console.error(`✗ ${id}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    // MANIFEST after every clip: a run killed half-way still leaves a truthful record.
    saveManifest();
  }

  let subAfter = null;
  try { subAfter = await fetchSubscription(auth); } catch { /* reported below */ }
  runStat.quotaDelta = subBefore && subAfter ? subAfter.used - subBefore.used : null;
  runStat.remaining = subAfter?.remaining ?? null;
  manifest.loudness ??= { mode: 'per-clip', targetI: cfg.targetI, targetTP: cfg.targetTP, at: new Date().toISOString() };
  manifest.runs.push({ ...runStat, only: cfg.only, force: cfg.force, refit: cfg.refit, narrator: cfg.narrator, viewer: cfg.viewer, models: modelsUsed, loudness: manifest.loudness.mode });
  // A clip made or re-made in this run must sit at the set's level. If one could not get there
  // (too quiet AND too peaky to lift), the SET needs re-levelling — say so loudly.
  if (manifest.loudness.mode === 'uniform') {
    const off = report.filter((r) => !r.failed && r.m?.lufs != null && Math.abs(r.m.lufs - manifest.loudness.targetI) > 0.8)
      .map((r) => `${r.id} ${r.m.lufs} LUFS`);
    if (off.length) console.warn(`\n! ${off.length} clip(s) are off the uniform ${manifest.loudness.targetI} LUFS policy: ${off.join(', ')}\n  re-level the set:  node synthesize-elevenlabs.mjs --uniform auto`);
  }
  saveManifest();

  // ---------------------------------------------------------------- totals + the note
  const byFilm = summarize(report);
  const fm = (n) => films.find((x) => x.film === n) ?? {};
  console.log('\nper film:');
  for (const f of Object.values(byFilm)) {
    const meta = fm(f.film);
    console.log(`  film ${f.film} ${(meta.title ?? '').padEnd(24)} ${String(f.clips).padStart(2)} clips  narration ${f.narratorSec.toFixed(1).padStart(5)}s${f.viewerSec ? ` + viewer ${f.viewerSec.toFixed(1)}s` : ''}  ${f.words} words → ${f.narratorSec ? Math.round((f.words / f.narratorSec) * 60) : 0} wpm  target ${meta.targetSec ?? '—'}s  slots ${f.slotSec}s  chars ${f.chars}${f.overClips.length ? `  OVER budget: ${f.overClips.join(', ')}` : ''}${f.failed ? `  FAILED ${f.failed}` : ''}`);
  }
  console.log(`\n${runStat.made} synthesized (${runStat.requests} requests), ${runStat.kept} kept, ${runStat.failed} failed · chars sent this run ${runStat.charsBilled}${runStat.characterCostHeader ? ` · character-cost headers Σ ${runStat.characterCostHeader}` : ''}${runStat.quotaDelta != null ? ` · quota moved by ${runStat.quotaDelta}` : ''}`);
  if (subAfter) console.log(`quota after: ${subAfter.used}/${subAfter.limit} used — ${subAfter.remaining} chars remaining (resets ${subAfter.resetIso ?? '—'})`);
  else console.log('quota after: (subscription endpoint did not answer)');

  writeNote(join(HERE, 'ELEVENLABS-NOTE.md'), { cfg, manifest, lines, films, runStat, subAfter, OUT });
  if (runStat.failed) process.exit(1);
}

/** The manifest's record of one normalization. */
function normRecord(n, cfg) {
  return n.failed
    ? { type: 'FAILED', requestedI: cfg.targetI, requestedTP: cfg.targetTP, attempts: n.attempts }
    : { type: n.type, requestedI: cfg.targetI, requestedTP: cfg.targetTP, targetI: n.targetI, achievedI: n.achievedI, tp: n.tp, gainDb: n.gainDb, backedOff: n.backedOff, shortfall: n.shortfall, input: n.input, at: new Date().toISOString() };
}
const normAction = (n, cfg) => (n.failed
  ? `loudnorm FAILED — no linear pass at or below ${cfg.targetI} LUFS; clip left as delivered`
  : `loudnorm linear ${n.input.i} → ${n.achievedI} LUFS (gain ${n.gainDb > 0 ? '+' : ''}${n.gainDb} dB, TP ${n.tp} dBTP)${n.backedOff ? `; target backed off ${Math.abs(n.shortfall).toFixed(1)} dB from ${cfg.targetI} — the true-peak ceiling ${cfg.targetTP} dBTP allows no more gain linearly` : ''}`);
const describeNorm = (n, m) => (n.failed
  ? `FAILED (no linear pass) — left at ${m.lufs} LUFS`
  : `${n.input.i} → ${n.achievedI} LUFS (file measures ${m.lufs}), TP ${n.tp} (file ${m.truePeak})${n.backedOff ? `  BACKED OFF to ${n.targetI} (peak ceiling)` : ''}`);

function summarize(report) {
  const byFilm = {};
  for (const r of report) {
    const f = (byFilm[r.l.film] ??= { film: r.l.film, clips: 0, narratorSec: 0, viewerSec: 0, words: 0, slotSec: 0, chars: 0, overClips: [], failed: 0 });
    f.clips++;
    if (r.failed) { f.failed++; continue; }
    f.chars += r.rec?.charsBilled ?? 0;
    if (r.l.role === 'viewer') f.viewerSec += r.dur; else { f.narratorSec += r.dur; f.words += r.words; f.slotSec += r.slot; }
    if (r.over > 0) f.overClips.push(`${r.id} +${r.over.toFixed(2)}s`);
  }
  return byFilm;
}

/** ELEVENLABS-NOTE.md — regenerated from the full manifest on every run, so a partial (--only)
 *  run still leaves a complete, current record. */
function writeNote(path, { cfg, manifest, lines, films, runStat, subAfter, OUT }) {
  const fm = (n) => films.find((x) => x.film === n) ?? {};
  const recs = lines.map((l) => manifest.clips[clipId(l)]).filter(Boolean);
  const byFilm = {};
  for (const r of recs) {
    const f = (byFilm[r.film] ??= { film: r.film, clips: 0, narratorSec: 0, viewerSec: 0, words: 0, slotSec: 0, chars: 0, over: [], models: new Set() });
    f.clips++; f.chars += r.charsBilled ?? r.chars; f.models.add(modelShort(r.modelId));
    if (r.role === 'viewer') f.viewerSec += r.dur; else { f.narratorSec += r.dur; f.words += wordCount(r.scriptText ?? r.text); f.slotSec += r.slot; }
    if (r.over > 0) f.over.push(`${r.id} +${r.over.toFixed(2)}s${r.over > FIT_TOLERANCE ? ' (>tolerance)' : ''}`);
  }
  const voicesUsed = [...new Set(recs.map((r) => `${r.voice} \`${r.voiceId}\` (${r.role})`))];
  const modelsUsed = [...new Set(recs.map((r) => r.modelId))];
  const totalChars = recs.reduce((n, r) => n + (r.charsBilled ?? r.chars), 0);
  const missing = lines.filter((l) => !manifest.clips[clipId(l)] || !existsSync(join(OUT, `${clipId(l)}.mp3`)));
  const refit = recs.filter((r) => r.actions?.length);
  const beatRec = recs.find((r) => r.beats);
  const settingsBy = {};
  for (const r of recs) settingsBy[`${r.role} · ${modelShort(r.modelId)}`] ??= r.voiceSettings;

  const stillOver = recs.filter((r) => r.over > FIT_TOLERANCE);
  const normed = recs.filter((r) => r.normalized);
  const linear = normed.filter((r) => r.normalized.type === 'linear');
  const backedOff = linear.filter((r) => r.normalized.backedOff);
  const atTarget = linear.filter((r) => !r.normalized.backedOff);
  const notLinear = normed.filter((r) => r.normalized.type !== 'linear');
  const lufsAll = recs.map((r) => r.measure.lufs).filter((x) => x != null);
  const tpAll = recs.map((r) => r.measure.tp ?? r.measure.truePeak).filter((x) => x != null);
  const narr = recs.filter((r) => r.role !== 'viewer').map((r) => r.measure.lufs);
  const view = recs.filter((r) => r.role === 'viewer').map((r) => r.measure.lufs);
  const mean = (a) => (a.length ? a.reduce((n, x) => n + x, 0) / a.length : null);
  const crest = recs.map((r) => ({ id: r.id, c: +((r.measure.tp ?? r.measure.truePeak) - r.measure.lufs).toFixed(1) })).sort((a, b) => b.c - a.c);
  const uniform = uniformTarget(recs, cfg.targetTP);
  const pol = manifest.loudness ?? { mode: 'per-clip', targetI: cfg.targetI, targetTP: cfg.targetTP };
  const spread = +(Math.max(...lufsAll) - Math.min(...lufsAll)).toFixed(1);
  const signed = (x) => `${x > 0 ? '+' : ''}${x.toFixed(1)}`;
  const ceilingTable = [
    '| true-peak ceiling | loudest uniform target every clip can reach linearly |',
    '|---|---|',
    ...[-3, -2, -1, -0.5].map((tp) => `| ${tp} dBTP | ${Math.floor(Math.min(...recs.map((r) => r.measure.lufs + (tp - (r.measure.tp ?? r.measure.truePeak)))) * 10) / 10} LUFS |`),
    '',
  ];
  const whyNotMixTarget = [
    `**Why the clips are not at the ${MIX_TARGET_I} LUFS mix target.** Linear normalization is one gain, so it can only hit a loudness`,
    `target if the clip's crest factor (true peak − integrated) fits under (ceiling − target). This narration measures`,
    `**${crest[crest.length - 1].c}–${crest[0].c} dB of crest** (median ${crest[Math.floor(crest.length / 2)].c}; worst ${crest.slice(0, 3).map((c) => `${c.id} ${c.c}`).join(', ')}) — ElevenLabs delivers speech with big plosive`,
    `transients over a gated-average loudness. Putting every clip at ${MIX_TARGET_I} LUFS linearly would need a ceiling of`,
    `${MIX_TARGET_I} + ${crest[0].c} = **${signed(MIX_TARGET_I + crest[0].c)} dBTP** — peaks above 0 dBFS. So **${MIX_TARGET_I} LUFS is unreachable by linear gain on this`,
    'material at any peak ceiling**; the only route would be the loudnorm limiter, i.e. a dynamic process reshaping each clip.',
    '',
    'That is why the level is handled downstream instead: the assembler limits the **voice bus** — after the voices are summed,',
    'before the bed — which is what an ad mix does, and it keeps the voice/music balance intact. These clips therefore deliver',
    '**consistency**, and one measured static gain downstream supplies the level. Do not chase a hotter target here.',
    '',
    'What a ceiling would buy, worst-case clip, uniform across all 48:',
    '',
    ...ceilingTable,
  ];
  const loudnessSection = !normed.length ? ['## Loudness', '', '- not normalized (`--no-normalize`).', ''] : pol.mode === 'uniform' ? [
    '## Loudness — delivery level',
    '',
    `**Policy: uniform ${pol.targetI} LUFS integrated, true peak ≤ ${pol.targetTP} dBTP, two-pass \`loudnorm\`, linear only.**`,
    'Owner ruling 2026-09-05: consistency over level. One level for every clip, because the assembler applies a single measured',
    'static gain to the whole film — a spread between clips would become a voice that jumps from beat to beat, while a uniform',
    'set just moves that one number. The target is `--uniform auto`: the loudest level the most peak-constrained clip in the set',
    'can still reach with a pure gain, so no clip is ever compressed to keep up with the others.',
    '',
    `- **${linear.length}/${normed.length} clips normalized linearly** (\`normalization_type: linear\` asserted on the second pass)${notLinear.length ? `; **${notLinear.length} could NOT**: ${notLinear.map((r) => r.id).join(', ')}` : '; none fell back to `dynamic`, so nothing is compressed'}.`,
    `- Measured on the files: **${Math.min(...lufsAll)} … ${Math.max(...lufsAll)} LUFS — spread ${spread} dB**, true peak max **${Math.max(...tpAll)} dBTP** (ceiling ${pol.targetTP}); nothing clips.`,
    `- Narrator mean **${mean(narr).toFixed(1)}** LUFS vs viewer **${view[0]}** — a **${Math.abs(view[0] - mean(narr)).toFixed(1)} dB** gap, from **8.4 dB** on the raw takes.`,
    `- The level is set by the most constrained clips (${uniform.constrainedBy.map((h) => h.id).join(', ')}); every other clip was attenuated to meet them.`,
    '',
    'The policy is stored in the manifest (`loudness`), so later runs hold new clips to it — a drift re-synthesis lands at the',
    'same level instead of quietly re-levelling the set. A clip that cannot reach it is reported and asks for a re-level:',
    '',
    '```',
    'node narration/synthesize-elevenlabs.mjs --uniform auto                 # re-level the whole set (local, no key, no spend)',
    'node narration/synthesize-elevenlabs.mjs --uniform -22 --target-tp -1   # a hotter set if the bus ever wants it',
    '```',
    '',
    ...whyNotMixTarget,
  ] : [
    '## Loudness — delivery level',
    '',
    `Per-clip target: **${cfg.targetI} LUFS, true peak ≤ ${cfg.targetTP} dBTP, linear only** — a clip that can only get there through the`,
    'limiter is backed off instead of compressed.',
    '',
    `- **${linear.length}/${normed.length} normalized linearly**${notLinear.length ? `; **${notLinear.length} could NOT**: ${notLinear.map((r) => r.id).join(', ')}` : '; none fell back to `dynamic`'}.`,
    `- **${atTarget.length} reached ${cfg.targetI} LUFS**; **${backedOff.length} backed off** to what their own true peak allows.`,
    `- Measured: **${Math.min(...lufsAll)} … ${Math.max(...lufsAll)} LUFS** (spread ${spread} dB), true peak max **${Math.max(...tpAll)} dBTP**.`,
    '',
    `**This spreads the set by ${spread} dB** — each clip sits wherever its worst transient lets it. For a mix, prefer one level for the`,
    `whole track: \`--uniform auto\` (this set: ${uniform.target} LUFS, all linear).`,
    '',
    ...whyNotMixTarget,
  ];
  const md = [
    '# Production narration — ElevenLabs',
    '',
    `Last run: ${runStat.at} · \`synthesize-elevenlabs.mjs\` · ${runStat.made} synthesized, ${runStat.kept} kept, ${runStat.failed} failed · ${lines.length} lines in lines.json, ${recs.length} on record${missing.length ? ` · **MISSING: ${missing.map(clipId).join(', ')}**` : ''}`,
    '',
    'The pick and the audition behind it: `AUDITION-EL.md`. The same files, made by the free Edge voices, are the fallback',
    '(`audio-edge/`, see the end). Nobody who produced this could hear it; every number below is a measurement.',
    '',
    '## Runs (this manifest)',
    '',
    '| when | scope | synthesized | requests | chars sent | vendor ledger (character-cost Σ) |',
    '|---|---|---|---|---|---|',
    ...manifest.runs.map((r) => `| ${r.at} | ${r.only ? r.only.join(', ') : 'all'}${r.force ? ' --force' : ''}${r.refit ? ' --refit' : ''} | ${r.made} | ${r.requests} | ${r.charsBilled} | ${r.characterCostHeader || '—'} |`),
    '',
    '## Voices, model, settings',
    '',
    ...voicesUsed.map((v) => `- ${v}`),
    `- model: ${modelsUsed.map((m) => `\`${m}\``).join(', ')}${Object.entries(cfg.filmModel).length ? ` — per film: ${Object.entries(cfg.filmModel).map(([f, m]) => `film ${f} → \`${m}\``).join(', ')}` : ''}`,
    ...Object.entries(settingsBy).map(([k, v]) => `- voice_settings (${k}): \`${JSON.stringify(v)}\``),
    `- output \`${OUTPUT_FORMAT}\`; previous_text / next_text = neighbouring lines of the same film and role; endpoint ${[...new Set(recs.map((r) => r.endpoint))].join(' / ')}`,
    Object.keys(TEXT_OVERRIDES).length ? `- spoken-text (punctuation-only) overrides: ${Object.entries(TEXT_OVERRIDES).map(([k, v]) => `${k} → "${v}"`).join('; ')}` : '- spoken text = lines.json text for every clip (no punctuation overrides needed)',
    '',
    '## Per film',
    '',
    '"narration s" is the sum of the clips as the assembler measures them (ffprobe). "over" = seconds a clip runs',
    `past its budget (slot − ${PAD_AFTER}s pad); the assembler stretches that scene, so a film longer than its target`,
    `is explained here, not in the edit. Clips over by more than ${FIT_TOLERANCE}s were refit (see below).`,
    '',
    '| film | title | clips | narration s | viewer s | words | wpm | target s | slots s | model | chars sent (incl. retakes) | clips over budget |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...Object.values(byFilm).map((f) => { const m = fm(f.film); return `| ${f.film} | ${m.title ?? ''} | ${f.clips} | ${f.narratorSec.toFixed(1)} | ${f.viewerSec ? f.viewerSec.toFixed(1) : '—'} | ${f.words} | ${f.narratorSec ? Math.round((f.words / f.narratorSec) * 60) : 0} | ${m.targetSec ?? '—'} | ${f.slotSec} | ${[...f.models].join('+')} | ${f.chars} | ${f.over.length ? f.over.join(', ') : 'none'} |`; }),
    '',
    `Characters of text sent for the current set: **${totalChars}** (every attempt counted, incl. retakes; ${recs.reduce((n, r) => n + (r.attempts ?? 1), 0)} generations for ${recs.length} clips). This run: ${runStat.charsBilled} chars sent${runStat.quotaDelta != null ? `, quota counter moved ${runStat.quotaDelta}` : ''}${runStat.characterCostHeader ? `, Σ character-cost headers ${runStat.characterCostHeader}` : ''}.`,
    subAfter ? `Quota after this run: ${subAfter.used}/${subAfter.limit} used, **${subAfter.remaining} remaining** (tier ${subAfter.tier}, resets ${subAfter.resetIso ?? '—'}).` : 'Quota after this run: not readable.',
    '',
    'How the vendor meters this (measured 2026-09-05): every response carries a `character-cost` header, and `/v1/history` records',
    'exactly that figure per generation — ≈0.55 per character of text sent on this account for these models. The',
    '`/v1/user/subscription` counter is batch-updated (it read 289 at the start of the session while the history already held ~12k of',
    'earlier use on the same key) and the key is shared, so the counter cannot meter one run; the ledger can.',
    '',
    '## Over-slot clips and what was done',
    '',
    `Rule: a clip more than ${FIT_TOLERANCE}s over its budget is trimmed to its words (80ms before the first, 200ms after the last, by the`,
    `alignment the API returns — never a word), then retaken faster (speed ≤ ${MAX_SPEED}), each take trimmed, the shortest kept.`,
    'Nothing inside tolerance is touched, so most clips carry the 0.2–0.9s tail the voice delivered; the assembler pads 0.5s anyway.',
    '',
    refit.length ? refit.map((r) => `- **${r.id}** (${r.rawDur?.toFixed(2)}s raw → ${r.dur.toFixed(2)}s, budget ${r.budget}s, now ${r.over > 0 ? `+${r.over.toFixed(2)}s over` : 'inside'}): ${r.actions.join(' · ')}`).join('\n') : '- none — every clip landed inside its budget + tolerance on the first take, no trims, no retakes',
    '',
    stillOver.length
      ? [`**Still over tolerance after the procedure:** ${stillOver.map((r) => `${r.id} +${r.over.toFixed(2)}s`).join(', ')}. The assembler stretches those scenes by`,
        'that much. Cause, measured: the voice\'s pauses at the punctuation, not its words —',
        ...stillOver.map((r) => `${r.id}: ${r.measure.innerGaps.length} inner pauses totalling ${(r.measure.innerGaps.reduce((n, g) => n + g, 0) / 1000).toFixed(1)}s of the ${r.dur.toFixed(2)}s ([${r.measure.innerGaps.join(', ')}] ms) for ${wordCount(r.scriptText ?? r.text)} words in a ${r.budget}s budget.`),
        'Tightening those inner pauses (silence only, as the Edge pipeline did) would bring them inside; it is not done here because the',
        'brief allows lead/tail trims and faster retakes only. `--refit --retakes N` buys more takes for exactly these clips.'].join('\n')
      : '**Every clip is inside its budget + tolerance.**',
    '',
    ...loudnessSection,
    '## What the measurements can and cannot say',
    '',
    '- **LRA is not meaningful on a single clip.** ebur128\'s loudness range uses 3s short-term windows; on the 1–3s clips it reports 0 or',
    '  ~20 LU — artifacts, not the audio (their word timings are clean). Read LRA on the assembled film, or on the audition\'s combined',
    '  files (Liam v2: 2.3 LU over 19s).',
    '- **True peak** is held under the ceiling on every clip by the normalization pass above: no clipping.',
    '- **eleven_v3** was auditioned and not adopted: two of six clips fell outside ±20% of the v2 length (both closes, 1.23–1.28×), it',
    '  refuses previous_text/next_text (HTTP 400), and it ignores speed — no lever for an over-slot clip. It is the one expressive',
    '  read measured (LRA 7.1 vs 2.3): `--film-model 1=eleven_v3` if the owner wants it for the teaser, at a timing cost.',
    '',
    '## The four-beat close (f1-s10)',
    '',
    beatRec
      ? [`Spoken text: "${beatRec.text}" · method ${beatRec.beats.method} · **${beatRec.beats.ok ? 'FOUR DISTINCT BEATS' : 'RUN-ON'}**`, '',
        '| beat | preceded by | gap by alignment (ms) | silence detected −35dB (ms) |', '|---|---|---|---|',
        ...(beatRec.beats.beats ?? []).map((b) => `| ${b.beat}${b.missing ? ' (not found)' : ''} | ${b.after ?? '—'} | ${b.gapMs ?? '—'} | ${b.silenceMs ?? '—'} |`),
        '', `All inner silences ≥${BEAT.minS * 1000}ms in the clip: [${beatRec.measure.innerGaps.join(', ')}] ms · lead ${Math.round(beatRec.measure.lead * 1000)}ms · tail ${Math.round(beatRec.measure.tail * 1000)}ms.`].join('\n')
      : 'f1-s10 not on record yet.',
    '',
    '## Every clip',
    '',
    '| clip | role | model | chars sent | raw s | final s | wpm | slot s | budget s | over | LUFS | TP dBTP | norm target | inner gaps ≥150ms (ms) | actions |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...lines.map((l) => {
      const r = manifest.clips[clipId(l)];
      if (!r) return `| ${clipId(l)} | ${l.role} | | | | MISSING | | ${l.t1 - l.t0} | | | | | | | |`;
      const n = r.normalized;
      return `| ${r.id} | ${r.role} | ${modelShort(r.modelId)} | ${r.charsBilled ?? r.chars} | ${r.rawDur?.toFixed(2) ?? ''} | ${r.dur.toFixed(2)} | ${Math.round((wordCount(r.scriptText ?? r.text) / r.dur) * 60)} | ${r.slot} | ${r.budget} | ${r.over > 0 ? '+' + r.over.toFixed(2) : ''} | ${r.measure.lufs} | ${r.measure.tp ?? r.measure.truePeak} | ${n ? (n.type !== 'linear' ? `**${n.type}**` : `${n.targetI}${n.backedOff ? ` (−${Math.abs(n.shortfall).toFixed(1)})` : ''}`) : '—'} | [${r.measure.innerGaps.join(', ')}] | ${r.actions?.join('; ') ?? ''} |`;
    }),
    '',
    '## Regenerating',
    '',
    'With a permanent key in a JSON file OUTSIDE the repo (`{ "xi_api_key": "sk_..." }` — never in the repo, never on a command line):',
    '',
    '```',
    'node narration/synthesize-elevenlabs.mjs --auth /path/to/el-auth.json            # only the clips that are missing',
    'node narration/synthesize-elevenlabs.mjs --auth /path/to/el-auth.json --force    # the whole set, same pick, same settings',
    'node narration/synthesize-elevenlabs.mjs --auth /path/to/el-auth.json --force --only f1-s10   # one clip',
    'node narration/synthesize-elevenlabs.mjs --auth /path/to/el-auth.json --refit --retakes 3     # faster retakes for clips still over tolerance only',
    'node narration/synthesize-elevenlabs.mjs --dry-run                                # the plan and the char cost, no key needed',
    'node narration/synthesize-elevenlabs.mjs --verify                                 # THE GATE: exit 1 if any clip is missing or no longer says its line',
    '```',
    '',
    '**`--verify` is the assembler\'s gate, and it needs no key.** It fails when a line of `lines.json` has no mp3, has no manifest entry,',
    'or when the manifest\'s `textSha1` no longer matches the line — the case where the scripts were rewritten and the audio was not.',
    'A plain run then re-synthesizes exactly those clips (with the NEW neighbours as previous_text/next_text) and nothing else;',
    '`--keep-drift` suppresses that if you want the old audio kept deliberately. Run it before every assemble:',
    '',
    '```',
    'node narration/synthesize-elevenlabs.mjs --verify && node assembly/assemble-film.mjs 1',
    '```',
    '',
    'Then `node assembly/assemble-film.mjs <n>` per film. Flags: `--narrator/--viewer <voiceId>`, `--model <id>`,',
    '`--film-model 1=eleven_v3`, `--speed/--style/--stability/--similarity`, `--no-boost`, `--no-fit`, `--refit`, `--retakes N`, `--out <dir>`.',
    'Any run — full or partial — rewrites this note from `audio/MANIFEST.json`, so it always describes the whole set.',
    'Ids and labels of the premade voices are in `VOICES` at the top of the script; the audition that made this',
    'pick is `AUDITION-EL.md` (clips in `audition-el/`).',
    '',
    '**`narration/audio-manifest.json` is the canonical record** — every clip\'s settings, request id, chars sent, `textSha1`,',
    'word timings from the alignment, loudness and QC measurements, plus the set\'s `loudness` policy. It lives BESIDE `lines.json`,',
    'not inside `audio/`, because `audio/` is gitignored and `--verify` has to work on a fresh checkout; a mirror copy is still',
    'written to `audio/MANIFEST.json` for convenience, and either is read back (canonical wins).',
    '',
    '## Fallback',
    '',
    '`narration/audio-edge/` is the free, keyless Edge-neural take (Andrew +12% / Emma; `synthesize-edge.mjs`,',
    'record in `EDGE-VOICE-NOTE.md`). To assemble with it, point the assembler at it or copy it over `audio/`;',
    'no key, no spend. It is the review-pass voice the owner heard, not the production read.',
    '',
  ].join('\n');
  writeFileSync(path, md);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
