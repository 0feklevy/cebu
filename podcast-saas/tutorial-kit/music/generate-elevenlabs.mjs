#!/usr/bin/env node
// ---------------------------------------------------------------------------
// generate-elevenlabs.mjs — the five Welcome-film music beds + the SFX pack,
// generated with ElevenLabs Music v1 (POST /v1/music) and ElevenLabs Sound
// Generation (POST /v1/sound-generation), then normalized with ffmpeg.
//
// Usage:
//   node generate-elevenlabs.mjs --auth <path to JSON {"xi_api_key": "..."}>
//        [--only bed-teaser,ui-click | beds | sfx]   subset, comma-separated
//        [--takes 2]                make sure at least N takes exist per bed
//                                   (selection always considers every take on disk)
//        [--mode prompt|plan|auto]  how NEW takes are requested (default prompt;
//                                   auto = odd takes prompt, even takes plan)
//        [--force]                  re-request raw audio even if takes/ has it
//        [--concurrency 2]          parallel API requests
//        [--dry-run]                print the requests, call nothing
//
// The key is read from the --auth file only: never printed, never written,
// never placed on a command line. Keep that file outside the repo.
//
// Outputs (all inside this directory; every .wav/.mp3 here is gitignored):
//   takes/<bed>-take<N>.mp3           raw API audio — kept, so a re-run without
//                                     --force re-normalizes without spending credits
//   takes/<bed>-take<N>.request.json  the exact request body (provenance)
//   takes/<bed>-take<N>.wav           normalized candidate (-27 LUFS, 48 kHz/2ch/24-bit)
//   takes/sfx-<name>.mp3              raw SFX audio (+ .request.json)
//   takes/report.json                 every measurement, the choice, credits consumed
//   bed-*.wav                         the chosen take — what assembly/assemble-film.mjs reads
//   sfx/<name>.wav                    normalized SFX (-20 LUFS target, peak-safe)
//
// Selection (per bed, by measurement, no listening required):
//   disqualify: body (non-silent length) < film + 3 s · internal silence > 1 s
//               (silencedetect -40 dB) inside the audible film + 3 s · true peak
//               > -1 dBTP · loudnorm not linear · integrated outside -27 ± 0.5
//   then prefer: LRA inside 3..9 LU (10 pts per LU outside) and a body that also
//   survives a 2 s re-time (20 pts per second SHORT of film + 3 + 2; being long
//   is never penalized — the assembler trims).
//
// Length: the model treats the requested length as a ceiling and lands its
// ending early. Measured 2026-09-05 — prompt mode fills 84–97 % of
// music_length_ms (a 48 000 ms request: 48.0 s of file, music over at 40.3 s);
// composition-plan mode is WORSE despite exact section durations (an 88 s plan
// stopped at 58 s; a 62 s plan went silent 55–60 s before its flourish). So
// prompt takes request 1.25× the table length and new takes default to prompt
// mode; plan mode stays available (--mode plan) and requests the table length.
// Trailing digital silence is cut from the normalized WAV (0.3 s kept), so a
// file's duration is its musical length.
//
// Drop alignment: a bed with `dropAt` (the teaser: 4.0 s, its first live
// window's open) has its head trimmed so the kick's first sustained arrival
// (detected below 150 Hz) lands at that time — the generator renders "a
// 2-second riser" as 6–8 s, and the assembler has no offset. Everything before
// the drop but the riser's last `dropAt` seconds is cut. Keep this in step with
// seeding/layout-v3.json: the drop must land ON the window's open, because the
// assembler ducks the bed −97 % from that instant.
//
// API fields the service refused (2026-09-05): `force_instrumental` together
// with `composition_plan` (422 naming the field; accepted with `prompt`), and
// composition_plan sections outside 3 000–120 000 ms.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// =========================================================================
// THE TABLE — prompts, lengths, plans. Edit here, nowhere else.
// =========================================================================

// Film lengths = the assembler's own derived totals (assembly/work/film*/timeline.json).
// Films 2–5 read 86.71 / 53.10 / 59.19 / 45.45 s and have been stable since 13:31.
// FILM 1 IS VOLATILE: it was re-derived three times during this session (59.25 →
// 62.93 → 61.90 s within an hour, while its scenes were being re-cut), so its
// entry carries the LARGEST value observed, not the latest — the gate must not
// be tuned to a number that is still moving. Re-read the timelines before
// trusting these; `--dry-run` prints what the table currently believes.
// The VO is about to be re-recorded and will move each total again, so every bed
// is ≥ 3 s longer than its film (and selection prefers ≥ 5 s — see VO_DRIFT) and
// the assembler trims it (atrim=0:total) — the trim must never reach silence.
const NO_VOCALS = 'Instrumental only, no vocals, no singing, no spoken word. No lo-fi hip hop, no ukulele, no acoustic guitar, not corporate stock music. Clear downbeats throughout.';
// The generator masters flat (round 1: LRA 0.5–2.2 LU, momentary loudness pinned to one value
// for a whole minute). The brief wants 3–9 LU of movement, so every prompt spells the arc out.
const NEVER_SILENT = 'Drums and bass keep going in every section — never a dropout, never a breakdown to silence — right up to the final hit.';

const BEDS = [
  {
    // dropAt tracks film 1's FIRST live window, which is where the assembler ducks the bed −97 %:
    // the drop has to land ON the window's open, not before it. layout-v3.json moved that window
    // from [2,10] to [4,12] in the v3.1 re-cut, so the drop moved 2 s later with it.
    name: 'bed-teaser', film: 1, title: 'Touch This Video', filmLen: 62.93, lengthMs: 66000, dropAt: 4.0,
    bpm: 120, key: 'A minor',
    character: 'Punchy, kinetic opener: riser into a confident drop at 0:04 (film 1\'s first live window), momentum lift every 8 bars, big open montage energy 0:35–0:45, hard clean button ending (no fade).',
    prompt: 'Punchy, kinetic modern electronic music for a tech product launch film — the energy of an Apple, Linear or Figma launch video. ' +
      '120 BPM, key of A minor, dark-bright. Four-on-the-floor kick with a driving sidechained synth bass, tight claps and hi-hats, punchy filtered synth stabs, wide analog chords. ' +
      'Structure: opens with a 2-second noise riser and pitch sweep with no drums, then a confident drop exactly at 0:02 where the kick and bass hit together; ' +
      'momentum lifts every 8 bars with added layers; a big, open, high-energy section from 0:35 to 0:45 with wide chords and full percussion; ' +
      'then back to the driving groove, ending with a hard clean button hit on the downbeat — a sudden stop, no fade-out. ' +
      'Dynamics: the first groove after the drop is smaller and quieter (kick, bass and one filtered stab); every 8-bar lift adds a layer and more loudness, so the energy clearly grows into the wide-open peak at 0:35–0:45, which is the loudest part. ' +
      NEVER_SILENT + ' ' + NO_VOCALS,
    plan: {
      positive_global_styles: ['modern electronic launch-film music', 'tech house', '120 bpm', 'key of A minor', 'four-on-the-floor kick',
        'driving sidechained synth bass', 'punchy filtered synth stabs', 'wide analog chords', 'tight claps and hi-hats', 'punchy modern production',
        'clear downbeats', 'instrumental'],
      negative_global_styles: ['vocals', 'singing', 'rap', 'spoken word', 'lo-fi hip hop', 'ukulele', 'acoustic guitar', 'corporate stock music',
        'slow tempo', 'fade out', 'reverb wash'],
      sections: [
        // The API floors a section at 3000 ms (422 otherwise), so the plan's riser is 3 s; the
        // prompt take asks for the brief's 2 s literally. Film 1's first live window opens at 0:02
        // and ducks the bed −97 % until 0:10, so the drop itself is under the window either way.
        { section_name: 'Riser', duration_ms: 3000, lines: [],
          positive_local_styles: ['noise riser', 'rising pitch sweep', 'filtered white noise build', 'no drums', 'tension'],
          negative_local_styles: ['kick drum', 'bassline', 'melody'] },
        { section_name: 'Drop', duration_ms: 13000, lines: [],
          positive_local_styles: ['confident drop on the downbeat', 'kick and bass hit together', 'one filtered synth stab', 'smaller quieter groove', 'four-on-the-floor'],
          negative_local_styles: ['riser', 'breakdown', 'silence', 'dropout'] },
        { section_name: 'Build', duration_ms: 19000, lines: [],
          positive_local_styles: ['momentum lift every 8 bars', 'layers added progressively', 'getting louder', 'brighter hi-hats', 'arpeggiated synth', 'steady driving groove'],
          negative_local_styles: ['breakdown', 'dropout', 'silence'] },
        { section_name: 'Open peak', duration_ms: 14000, lines: [],
          positive_local_styles: ['big open high-energy section', 'loudest part', 'wide chords', 'full percussion', 'maximum energy', 'euphoric lift'],
          negative_local_styles: ['breakdown', 'minimal', 'quiet', 'silence'] },
        { section_name: 'Final drive and button', duration_ms: 17000, lines: [],
          positive_local_styles: ['driving groove', 'final momentum lift', 'hard clean button ending', 'final hit on the downbeat', 'sudden stop', 'no fade out'],
          negative_local_styles: ['fade out', 'long reverb tail', 'slow down', 'ritardando', 'silence', 'dropout'] },
      ],
    },
  },
  {
    name: 'bed-tutorial', film: 2, title: 'Make Yours', filmLen: 86.71, lengthMs: 90000,
    bpm: 100, key: 'D minor',
    character: 'Driving but narration-friendly: bass and drums lead, sparse mids so the voice sits on top, section lift every 8 bars, soft button ending.',
    // Round-1/2 prompt takes (takes 1, 3, 4) all put a silent bar or an 8 s breakdown at ~55 % of the
    // piece — the classic pre-finale drop-out. The bed plays under a narrator, so continuity beats
    // drama here: the prompt now leads with "continuous" and asks for no drops or breakdowns at all.
    prompt: 'Continuous, driving, narration-friendly modern electronic music bed for a software tutorial film — a steady evolving groove that can run under a narrator for 90 seconds. ' +
      '100 BPM, key of D minor. Bass and drums lead: a moving eighth-note synth bass with a steady four-on-the-floor kick, tight hi-hats and soft claps; ' +
      'sparse midrange so a voice can sit on top — no lead melody, only short rhythmic plucks and low filtered chords. ' +
      'Structure: the groove is established from the first beat and never stops; every 8 bars one layer is added or swapped (plucks, then filtered pads, then brighter hats) so it keeps evolving, ' +
      'a fuller final stretch, and a soft button ending — one clean final hit with a short ring, no long fade-out. ' +
      'Continuity is essential: no drops, no breakdowns, no silent bar, no pause before the final section — the kick and bass play through every single bar from the first beat to the final hit. ' +
      NO_VOCALS,
    plan: {
      positive_global_styles: ['modern electronic music bed for a software tutorial', '100 bpm', 'key of D minor', 'four-on-the-floor kick',
        'moving eighth-note synth bass leads', 'tight hi-hats', 'soft claps', 'sparse midrange', 'voice-friendly', 'driving', 'clean production', 'instrumental'],
      negative_global_styles: ['vocals', 'singing', 'lead melody', 'busy midrange', 'lo-fi hip hop', 'ukulele', 'corporate stock music', 'fade out'],
      sections: [
        { section_name: 'Groove in', duration_ms: 19000, lines: [],
          positive_local_styles: ['groove from the first beat', 'kick and bass lead', 'minimal layers', 'short rhythmic plucks'],
          negative_local_styles: ['intro silence', 'slow build'] },
        { section_name: 'Lift one', duration_ms: 19000, lines: [],
          positive_local_styles: ['add rhythmic synth plucks', 'low filtered chords', 'section lift'],
          negative_local_styles: ['lead melody'] },
        { section_name: 'Lift two', duration_ms: 19000, lines: [],
          positive_local_styles: ['brighter hi-hats', 'filtered pads open up', 'more energy', 'steady drive'],
          negative_local_styles: ['breakdown'] },
        { section_name: 'Lift three', duration_ms: 19000, lines: [],
          positive_local_styles: ['peak layer', 'full groove', 'still voice-friendly', 'clear downbeats'],
          negative_local_styles: ['screaming leads', 'dense midrange'] },
        { section_name: 'Soft button', duration_ms: 14000, lines: [],
          positive_local_styles: ['drive to the end', 'soft button ending', 'clean final hit with a short ring', 'no long fade out'],
          negative_local_styles: ['long fade out', 'slow down'] },
      ],
    },
  },
  {
    name: 'bed-heavy', film: 3, title: 'Drop In Anything', filmLen: 53.10, lengthMs: 57000,
    bpm: 108, key: 'E minor',
    character: 'Confident and practical: chunky groove, lift every 8 bars, fuller peak 0:36–0:48, tight button ending.',
    prompt: 'Confident, practical, chunky modern electronic groove for a product feature film. 108 BPM, key of E minor. ' +
      'Heavy four-on-the-floor kick with an extra kick on the and-of-3, chunky square-shouldered synth bass, tight claps and hats, short on-beat synth chord stabs, subtle risers into each section. ' +
      'Structure: groove from the first beat, a momentum lift every 8 bars, a fuller peak section from 0:36 to 0:48, then a tight clean button ending — one final hit on the downbeat and a sudden stop, no fade-out. ' +
      'Dynamics: the opening groove is stripped back and quieter (kick, chunky bass, one stab under a low-pass filter); every lift adds a layer and more loudness, so the energy clearly grows to the peak, which is the loudest part. ' +
      NEVER_SILENT + ' ' + NO_VOCALS,
    plan: {
      positive_global_styles: ['confident practical modern electronic groove', '108 bpm', 'key of E minor', 'heavy four-on-the-floor kick', 'chunky synth bass',
        'tight claps and hats', 'short on-beat synth chord stabs', 'punchy', 'clear downbeats', 'instrumental'],
      negative_global_styles: ['vocals', 'singing', 'lo-fi hip hop', 'ukulele', 'corporate stock music', 'fade out', 'ambient wash'],
      sections: [
        { section_name: 'Chunky groove', duration_ms: 19000, lines: [],
          positive_local_styles: ['groove from the first beat', 'chunky bass and kick', 'square-shouldered stabs'],
          negative_local_styles: ['intro silence', 'slow build'] },
        { section_name: 'Lift', duration_ms: 19000, lines: [],
          positive_local_styles: ['momentum lift', 'extra percussion layer', 'subtle riser into the lift', 'brighter stabs'],
          negative_local_styles: ['breakdown'] },
        { section_name: 'Peak', duration_ms: 12000, lines: [],
          positive_local_styles: ['fuller peak section', 'all layers', 'maximum drive'],
          negative_local_styles: ['minimal', 'quiet'] },
        { section_name: 'Tight button', duration_ms: 7000, lines: [],
          positive_local_styles: ['tight clean button ending', 'final hit on the downbeat', 'sudden stop', 'no fade out'],
          negative_local_styles: ['fade out', 'long reverb tail'] },
      ],
    },
  },
  {
    name: 'bed-powers', film: 4, title: 'Viewer Superpowers', filmLen: 59.19, lengthMs: 63000,
    bpm: 114, key: 'C major',
    character: 'Playful, bright, plucky and energetic: hook from the first beat, lift every 8 bars, peak 0:42–0:54, button ending with a small upward flourish.',
    prompt: 'Playful, bright, energetic modern electronic music for a fun product feature film. 114 BPM, key of C major. ' +
      'Bouncy four-on-the-floor kick, octave-bouncing synth bass, bright plucky synths and pizzicato-style synth plucks, snappy claps and crisp hats, cheerful synth stabs with occasional pitch-bend bloops. ' +
      'Structure: the hook is in from the first beat, a momentum lift every 8 bars, a fuller peak section from 0:42 to 0:54, then a button ending with a quick small upward synth flourish on the final hit and a clean stop, no fade-out. ' +
      'Dynamics: the opening is lighter and quieter (kick, bouncing bass and the pluck hook); every lift adds a layer and more loudness, so the energy clearly grows to the peak, which is the loudest part. ' +
      NEVER_SILENT + ' ' + NO_VOCALS,
    plan: {
      positive_global_styles: ['playful bright energetic modern electronic music', '114 bpm', 'key of C major', 'bouncy four-on-the-floor kick', 'octave-bouncing synth bass',
        'bright plucky synths', 'pizzicato-style synth plucks', 'snappy claps', 'crisp hats', 'cheerful synth stabs', 'clear downbeats', 'instrumental'],
      negative_global_styles: ['vocals', 'singing', 'dark mood', 'lo-fi hip hop', 'ukulele', 'corporate stock music', 'fade out'],
      sections: [
        { section_name: 'Bright open', duration_ms: 6000, lines: [],
          positive_local_styles: ['plucky synth hook from the first beat', 'kick from the first beat', 'bright and playful'],
          negative_local_styles: ['intro silence', 'slow build'] },
        { section_name: 'Groove', duration_ms: 19000, lines: [],
          positive_local_styles: ['bouncy groove', 'plucks and bass interplay', 'pitch-bend bloops'],
          negative_local_styles: ['breakdown'] },
        { section_name: 'Lift', duration_ms: 18000, lines: [],
          positive_local_styles: ['momentum lift', 'brighter', 'more layers', 'hand claps'],
          negative_local_styles: ['breakdown'] },
        { section_name: 'Peak', duration_ms: 12000, lines: [],
          positive_local_styles: ['fuller peak section', 'all layers', 'joyful energy'],
          negative_local_styles: ['minimal', 'quiet'] },
        { section_name: 'Button with flourish', duration_ms: 8000, lines: [],
          positive_local_styles: ['button ending', 'quick small upward synth flourish on the final hit', 'clean stop', 'no fade out'],
          negative_local_styles: ['fade out', 'long reverb tail', 'slow down'] },
      ],
    },
  },
  {
    name: 'bed-share', film: 5, title: 'One Link, Three Doors', filmLen: 45.45, lengthMs: 49000,
    bpm: 100, key: 'F major',
    character: 'Warm but forward: plucked/arpeggiated synths over a soft four-on-the-floor, a lift every 8 bars, resolves cleanly on a final chord with a short ring.',
    prompt: 'Warm but forward modern electronic music for a product film about sharing. 100 BPM, key of F major. ' +
      'Plucked and arpeggiated synths (warm pluck arps, gentle strummed synth chords), a soft steady four-on-the-floor kick, round warm bass, light hats and soft claps. ' +
      'Structure: arpeggio and pulse from the first beat, a momentum lift every 8 bars getting brighter and fuller, then the final progression resolves cleanly on a sustained final chord with a short natural ring — a clean stop, no long fade-out. ' +
      'Dynamics: the opening is intimate and quieter (arpeggio, soft kick, warm bass); every lift adds a layer and more loudness, so the energy clearly grows to the final section, which is the fullest and loudest. ' +
      NEVER_SILENT + ' ' + NO_VOCALS,
    plan: {
      positive_global_styles: ['warm but forward modern electronic music', '100 bpm', 'key of F major', 'plucked synth arpeggios', 'gentle strummed synth chords',
        'soft steady four-on-the-floor kick', 'round warm bass', 'light hats', 'soft claps', 'clear downbeats', 'instrumental'],
      negative_global_styles: ['vocals', 'singing', 'lo-fi hip hop', 'ukulele', 'corporate stock music', 'long fade out', 'sad mood'],
      sections: [
        { section_name: 'Warm arp open', duration_ms: 19000, lines: [],
          positive_local_styles: ['arpeggio and pulse from the first beat', 'warm plucks', 'steady kick'],
          negative_local_styles: ['intro silence', 'slow build'] },
        { section_name: 'Lift', duration_ms: 19000, lines: [],
          positive_local_styles: ['momentum lift', 'brighter and fuller', 'strummed chords', 'forward motion'],
          negative_local_styles: ['breakdown'] },
        { section_name: 'Resolve', duration_ms: 11000, lines: [],
          positive_local_styles: ['final progression', 'resolves cleanly on a sustained final chord', 'short natural ring', 'clean stop', 'no long fade out'],
          negative_local_styles: ['long fade out', 'slow down', 'ritardando'] },
      ],
    },
  },
];

// SFX — tasteful and quiet; the films must never feel overwhelming.
// duration_seconds is what we ask the API for (its floor is 0.5 s); `seconds`
// is the exact length the file is trimmed to.
const SFX = [
  { name: 'ui-click', seconds: 0.4, influence: 0.6,
    prompt: 'A single soft, modern app UI click — one short clean gentle tap, subtle, dry, no reverb, no echo.' },
  { name: 'whoosh-in', seconds: 0.7, influence: 0.5,
    prompt: 'A quick, light, airy whoosh swishing in — soft air movement rising into place, short, clean, no impact, no rumble.' },
  { name: 'whoosh-out', seconds: 0.7, influence: 0.5,
    prompt: 'A quick, light, airy whoosh swishing away — soft air movement falling off and disappearing, short, clean, no impact, no rumble.' },
  { name: 'riser-1200ms', seconds: 1.2, influence: 0.5,
    prompt: 'A short tonal noise riser: a smooth filtered noise sweep rising in pitch for one second, ending on a soft gentle hit — tasteful, cinematic, not loud, no long tail.' },
  // Two rolls (influence 0.6 and 0.85, wording counting the notes) both came back as ONE bell note
  // ringing out — the sound model does not render "two notes" from text. So the second note is made
  // from the first: a copy pitched a fifth up (resample ratio 2^(7/12)) enters 220 ms later.
  { name: 'chime-generate', seconds: 0.9, influence: 0.85,
    prompt: 'A success chime made of exactly two short bell notes played one after the other, "ding-ding", the second note higher than the first (a fifth up). Two separate clean glassy synth-bell notes, bright and pleasant, modern app notification, short tails, no reverb wash.',
    compose: '[0:a]asetrate=48000*1.4983,aresample=48000,adelay=220|220[hi];[0:a][hi]amix=inputs=2:normalize=0[out]' },
  { name: 'type-burst', seconds: 1.5, influence: 0.6,
    prompt: 'A quick mechanical keyboard typing burst — fast tactile keystrokes for one and a half seconds, close-miked, clean, no room echo.' },
];

// Targets
const BED_LUFS = -27; // integrated, ±0.5 — the assembler mixes -19 LUFS VO on top
const BED_TP = -1;    // dBTP ceiling
const SFX_LUFS = -20;
const SFX_TP = -1;
const LRA_OK = [3, 9]; // LU — movement, but steady under speech
// The films are re-timed whenever the VO is re-cut, and each re-cut has moved a total by a second
// or two. A bed LONGER than its film costs nothing (the assembler trims at the film's length); a
// bed that ends early is fatal and cannot be fixed without regenerating. So the length term
// penalizes only a SHORTFALL against filmLen + 3 + VO_DRIFT, never being long: selection must not
// prefer a take that merely clears today's gate over one that survives the next re-time.
const VO_DRIFT = 2;
const MODEL = 'music_v1';
const API = 'https://api.elevenlabs.io';

// =========================================================================
// CLI
// =========================================================================
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const AUTH = opt('--auth', null);
const TAKES_N = Math.max(1, Number(opt('--takes', 2)) || 2);
const MODE = opt('--mode', 'prompt');
const FORCE = flag('--force');
const DRY = flag('--dry-run');
const CONCURRENCY = Math.max(1, Number(opt('--concurrency', 2)) || 2);
const ONLY = (opt('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const wantBed = (b) => !ONLY.length || ONLY.includes('beds') || ONLY.includes(b.name);
const wantSfx = (s) => !ONLY.length || ONLY.includes('sfx') || ONLY.includes(s.name);
if (!['auto', 'prompt', 'plan'].includes(MODE)) { console.error('--mode must be auto|prompt|plan'); process.exit(2); }
const SECTION_MS = [3000, 120000]; // /v1/music validation limits for composition_plan.sections[].duration_ms (422 outside)
for (const b of BEDS) {
  const sum = b.plan.sections.reduce((a, s) => a + s.duration_ms, 0);
  if (sum !== b.lengthMs) { console.error(`${b.name}: plan sections sum to ${sum} ms, table says ${b.lengthMs} ms`); process.exit(2); }
  const bad = b.plan.sections.find((s) => s.duration_ms < SECTION_MS[0] || s.duration_ms > SECTION_MS[1]);
  if (bad) { console.error(`${b.name}: section "${bad.section_name}" is ${bad.duration_ms} ms; the API accepts ${SECTION_MS[0]}–${SECTION_MS[1]} ms`); process.exit(2); }
  if (b.lengthMs / 1000 < b.filmLen + 3) { console.error(`${b.name}: requested ${b.lengthMs} ms is not ≥ film ${b.filmLen} s + 3 s`); process.exit(2); }
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TAKES = path.join(DIR, 'takes');
const SFX_DIR = path.join(DIR, 'sfx');
const REPORT = path.join(TAKES, 'report.json');

function bin(name) {
  for (const c of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) if (existsSync(c)) return c;
  return name;
}
const FFMPEG = bin('ffmpeg');
const FFPROBE = bin('ffprobe');

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

// =========================================================================
// ElevenLabs API (the key never leaves `key`)
// =========================================================================
const rejectedFields = []; // { endpoint, field, status, detail }

function readKey() {
  if (!AUTH) { console.error('missing --auth <path>'); process.exit(2); }
  const k = JSON.parse(readFileSync(AUTH, 'utf8')).xi_api_key;
  if (!k || typeof k !== 'string') { console.error('auth file has no xi_api_key'); process.exit(2); }
  return k;
}

async function subscription(key) {
  try {
    const r = await fetch(`${API}/v1/user/subscription`, { headers: { 'xi-api-key': key } });
    if (!r.ok) return { error: r.status };
    const j = await r.json();
    return { tier: j.tier, character_count: j.character_count, character_limit: j.character_limit };
  } catch (e) { return { error: String(e.message || e) }; }
}

async function postAudio(endpoint, body, query, key) {
  const qs = Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
  const r = await fetch(`${API}${endpoint}${qs}`, {
    method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const ctype = r.headers.get('content-type') || '';
  if (r.ok && /audio|octet/.test(ctype)) return { status: r.status, ctype, buf: Buffer.from(await r.arrayBuffer()) };
  return { status: r.status, ctype, text: await r.text() };
}

// Request audio, dropping whichever optional field the service rejects (and
// recording that it did). 429/5xx are retried with backoff.
async function requestAudio(endpoint, baseBody, optionalBody, baseQuery, optionalQuery, key) {
  let body = { ...baseBody, ...optionalBody };
  let query = { ...baseQuery, ...optionalQuery };
  const optB = Object.keys(optionalBody), optQ = Object.keys(optionalQuery);
  for (let attempt = 0; attempt < 10; attempt++) {
    const t0 = Date.now();
    const r = await postAudio(endpoint, body, query, key);
    if (r.buf) return { ...r, body, query, seconds: (Date.now() - t0) / 1000 };
    const txt = r.text || '';
    if (r.status === 429 || r.status >= 500) { log(`    ${endpoint} → ${r.status}, retrying in ${5 * (attempt + 1)} s`); await sleep(5000 * (attempt + 1)); continue; }
    // A 4xx: drop an optional field only when the error names it. Anything else
    // (a plan-validation error, say) is about the base request — surface it.
    const badB = optB.find((f) => f in body && txt.includes(f));
    const badQ = optQ.find((f) => f in query && txt.includes(f));
    if (badB) { rejectedFields.push({ endpoint, field: badB, status: r.status, detail: txt.slice(0, 300) }); log(`    ${endpoint} rejected body field "${badB}" (${r.status}) — retrying without it`); delete body[badB]; continue; }
    if (badQ) { rejectedFields.push({ endpoint, field: `?${badQ}=${query[badQ]}`, status: r.status, detail: txt.slice(0, 300) }); log(`    ${endpoint} rejected query "${badQ}" (${r.status}) — retrying without it`); delete query[badQ]; continue; }
    throw new Error(`${endpoint} ${r.status} ${r.ctype}: ${txt.slice(0, 600)}`);
  }
  throw new Error(`${endpoint}: gave up after retries`);
}

const HQ = { output_format: 'mp3_44100_192' }; // creator tier and up; dropped automatically if refused
const PROMPT_LENGTH_FACTOR = 1.25; // prompt mode under-fills its ceiling (see header)
const promptRequestMs = (bed) => Math.min(300000, Math.round(bed.lengthMs * PROMPT_LENGTH_FACTOR / 1000) * 1000);

async function requestMusic(bed, mode, key) {
  // force_instrumental is accepted with `prompt` but refused (422) next to `composition_plan`
  // — a plan whose sections carry no `lines` is instrumental by construction.
  const base = mode === 'plan'
    ? { composition_plan: bed.plan, model_id: MODEL }
    : { prompt: bed.prompt, music_length_ms: promptRequestMs(bed), model_id: MODEL };
  return requestAudio('/v1/music', base, mode === 'plan' ? {} : { force_instrumental: true }, {}, HQ, key);
}

async function requestSfx(s, key) {
  const base = { text: s.prompt, duration_seconds: Math.max(0.5, s.seconds), prompt_influence: s.influence };
  return requestAudio('/v1/sound-generation', base, {}, {}, HQ, key);
}

// =========================================================================
// ffmpeg / ffprobe
// =========================================================================
function ff(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ffmpeg ${args.join(' ')}\n${(r.stderr || '').slice(-2000)}`);
  return r.stderr || '';
}
function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout || '{}');
  const s = (j.streams || [])[0] || {};
  return { duration: Number(j.format?.duration ?? 0), codec: s.codec_name, rate: Number(s.sample_rate), channels: Number(s.channels) };
}

/** silencedetect → [{start, end, dur}] (a trailing silence with no end runs to EOF). */
function silences(file, thresholdDb, minDur, pre = '') {
  const err = ff(['-i', file, '-af', `${pre}silencedetect=n=${thresholdDb}dB:d=${minDur}`, '-f', 'null', '-']);
  const out = []; let cur = null;
  for (const line of err.split('\n')) {
    let m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) { cur = { start: Math.max(0, Number(m[1])) }; continue; }
    m = line.match(/silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (m && cur) { cur.end = Number(m[1]); cur.dur = Number(m[2]); out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Leading digital silence (seconds) to trim so the bed starts on frame 0 at full level. */
function leadingSilence(file) {
  const s = silences(file, -50, 0.01).find((x) => x.start <= 0.02);
  return s && s.end != null ? s.end : 0;
}

function lastJson(stderr) {
  const a = stderr.lastIndexOf('{'), b = stderr.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON block in ffmpeg output');
  return JSON.parse(stderr.slice(a, b + 1));
}

/** loudnorm pass 1: measure. */
function loudnormMeasure(file, pre, I, TP) {
  return lastJson(ff(['-i', file, '-af', `${pre}loudnorm=I=${I}:TP=${TP}:LRA=40:print_format=json`, '-f', 'null', '-']));
}
/** loudnorm pass 2: apply with the measured values, linear=true, back to 48 kHz stereo 24-bit. */
function loudnormApply(file, pre, m, I, TP, out) {
  const f = `${pre}loudnorm=I=${I}:TP=${TP}:LRA=40:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json,aresample=48000`;
  return lastJson(ff(['-i', file, '-af', f, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', out]));
}

/** ffmpeg ebur128 summary (+ the 100 ms momentary-loudness track for a profile). */
function ebur(file, pre = '') {
  const err = ff(['-i', file, '-af', `${pre}ebur128=peak=true`, '-f', 'null', '-']);
  const sum = err.slice(err.lastIndexOf('Summary:'));
  const num = (re) => { const m = sum.match(re); return m ? Number(m[1]) : NaN; };
  const frames = [];
  for (const line of err.split('\n')) {
    const m = line.match(/\bt:\s*(-?[\d.]+)\s+TARGET:.*?\bM:\s*(-?[\d.]+)/);
    if (m) frames.push([Number(m[1]), Number(m[2])]);
  }
  return {
    I: num(/I:\s*(-?[\d.]+) LUFS/), LRA: num(/LRA:\s*(-?[\d.]+) LU/), TP: num(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+) dBFS/),
    summary: sum.trim().split('\n').map((l) => '      ' + l.trim()).join('\n'), frames,
  };
}

/**
 * Time of the first sustained arrival at level: the first 100 ms frame whose momentary loudness is
 * within 2.5 LU of `refI` (the signal's integrated loudness) and stays there for 8 of the next 10
 * frames. Fed the low-passed signal, that is the moment the kick lands. ebur128's 400 ms window
 * reports ~0.3 s late, which is compensated.
 */
function onsetTime(frames, refI) {
  const thr = refI - 2.5;
  for (let i = 0; i < frames.length - 10; i++) {
    if (frames[i][1] < thr) continue;
    let ok = 0;
    for (let j = 1; j <= 10; j++) if (frames[i + j][1] >= thr) ok++;
    if (ok >= 8) return Math.max(0, frames[i][0] - 0.3);
  }
  return 0;
}

/** Momentary-loudness profile, one figure per `bucket` seconds (power-averaged). */
function profile(frames, bucket = 2) {
  const acc = new Map();
  for (const [t, M] of frames) {
    if (!(M > -70)) continue;
    const k = Math.floor(t / bucket);
    const a = acc.get(k) || { p: 0, n: 0 }; a.p += 10 ** (M / 10); a.n++; acc.set(k, a);
  }
  return [...acc.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, a]) => `${k * bucket}s:${Math.round(10 * Math.log10(a.p / a.n))}`).join(' ');
}

/** Body analysis on a normalized WAV: non-silent length, head, internal gaps > 1 s (silencedetect -40 dB). */
function body(file, duration) {
  const s = silences(file, -40, 0.5);
  const head = s.find((x) => x.start <= 0.02);
  const tail = s.find((x) => x.end == null || x.end >= duration - 0.05);
  const bodyEnd = tail ? tail.start : duration;
  const gaps = s.filter((x) => x !== head && x !== tail && (x.dur ?? 0) > 1.0).map((x) => ({ start: r2(x.start), end: r2(x.end), dur: r2(x.dur) }));
  return { headSilence: head ? r2(head.end - head.start) : 0, bodyEnd: r2(bodyEnd), tailSilence: r2(duration - bodyEnd), gaps };
}

// =========================================================================
// Beds
// =========================================================================
function takeMode(i) { return MODE === 'auto' ? (i % 2 === 1 ? 'prompt' : 'plan') : MODE; }

/** Every take of a bed present on disk (raw + request), in take order. */
function takesOnDisk(bed) {
  const re = new RegExp(`^${bed.name}-take(\\d+)\\.mp3$`);
  return readdirSync(TAKES).map((f) => f.match(re)).filter(Boolean).map((m) => Number(m[1]))
    .filter((i) => existsSync(path.join(TAKES, `${bed.name}-take${i}.request.json`))).sort((a, b) => a - b);
}

async function fetchTake(bed, i, key) {
  const raw = path.join(TAKES, `${bed.name}-take${i}.mp3`);
  const reqFile = path.join(TAKES, `${bed.name}-take${i}.request.json`);
  if (!FORCE && existsSync(raw) && existsSync(reqFile)) { log(`  ${bed.name} take ${i}: reusing ${path.relative(DIR, raw)}`); return; }
  let mode = takeMode(i);
  log(`  ${bed.name} take ${i}: requesting /v1/music (${mode}, ${mode === 'plan' ? bed.lengthMs : promptRequestMs(bed)} ms) …`);
  let r;
  try { r = await requestMusic(bed, mode, key); } catch (e) {
    if (mode !== 'plan') throw e;
    rejectedFields.push({ endpoint: '/v1/music', field: 'composition_plan (this plan)', status: 'error', detail: String(e.message).slice(0, 300) });
    log(`    plan request failed (${String(e.message).slice(0, 160)}) — falling back to prompt mode for this take`);
    mode = 'prompt'; r = await requestMusic(bed, mode, key);
  }
  writeFileSync(raw, r.buf);
  writeFileSync(reqFile, JSON.stringify({ endpoint: '/v1/music', query: r.query, body: r.body, mode, requested_at: new Date().toISOString(),
    response_content_type: r.ctype, response_bytes: r.buf.length, response_seconds: r2(r.seconds) }, null, 2));
  log(`    ← ${r.ctype}, ${(r.buf.length / 1024).toFixed(0)} KB in ${r.seconds.toFixed(1)} s`);
}

function normalizeTake(bed, i) {
  const raw = path.join(TAKES, `${bed.name}-take${i}.mp3`);
  const req = JSON.parse(readFileSync(path.join(TAKES, `${bed.name}-take${i}.request.json`), 'utf8'));
  const out = path.join(TAKES, `${bed.name}-take${i}.wav`);
  const rawInfo = probe(raw);
  let headTrim = leadingSilence(raw);          // digital silence: always dropped
  let dropOnset = null;
  if (bed.dropAt != null) {                    // riser length → exactly dropAt seconds before the kick lands
    // Detect the drop in the kick/bass band: a riser carries no sub, a four-on-the-floor drop is all
    // sub. (Broadband loudness fires on the riser's own crest — measured 0.9 s early on take 3.)
    const lo = ebur(raw, 'lowpass=f=150,');
    dropOnset = r2(onsetTime(lo.frames, lo.I));
    if (dropOnset - bed.dropAt > headTrim) headTrim = dropOnset - bed.dropAt;
  }
  const pre = headTrim > 0.1 ? `atrim=start=${headTrim.toFixed(3)},asetpts=PTS-STARTPTS,` : '';
  const m1 = loudnormMeasure(raw, pre, BED_LUFS, BED_TP);
  const m2 = loudnormApply(raw, pre, m1, BED_LUFS, BED_TP, out);
  let info = probe(out);
  let b = body(out, info.duration);
  const tailCut = b.tailSilence > 0.5 ? r2(b.tailSilence - 0.3) : 0;
  if (tailCut > 0) { // drop trailing digital silence, keep 0.3 s of it (sample-exact PCM cut, no re-encode)
    const tmp = out + '.cut.wav';
    ff(['-i', out, '-t', (b.bodyEnd + 0.3).toFixed(3), '-c:a', 'copy', tmp]);
    copyFileSync(tmp, out); unlinkSync(tmp);
    info = probe(out); b = body(out, info.duration);
  }
  const e = ebur(out);
  const requestedMs = req.body.music_length_ms ?? (req.body.composition_plan?.sections ?? []).reduce((a, s) => a + s.duration_ms, 0);
  const t = {
    take: i, mode: req.mode, requestedMs, raw: path.relative(DIR, raw), wav: path.relative(DIR, out),
    rawDuration: r2(rawInfo.duration), headTrimmed: r2(headTrim > 0.1 ? headTrim : 0), rawDropOnset: dropOnset, tailCut,
    raw_I: Number(m1.input_i), raw_TP: Number(m1.input_tp), raw_LRA: Number(m1.input_lra),
    normalization: m2.normalization_type,
    duration: r2(info.duration), rate: info.rate, channels: info.channels, codec: info.codec,
    I: e.I, TP: e.TP, LRA: e.LRA, ...b, profile: profile(e.frames), ebur: e.summary,
  };
  // score
  const reasons = []; let dq = 0;
  // The assembler trims the bed at the film's length, so only the first filmLen + 3 s can ever be
  // heard: a gap that starts after that (the generator's pre-finale pause) is reported, not fatal.
  const heard = bed.filmLen + 3;
  const gapsHeard = t.gaps.filter((g) => g.start < heard);
  t.gapsBeyondFilm = t.gaps.filter((g) => g.start >= heard);
  if (t.bodyEnd < heard) { dq++; reasons.push(`body ${t.bodyEnd} s < film ${bed.filmLen} s + 3 s margin`); }
  if (gapsHeard.length) { dq++; reasons.push(`silence gap(s) > 1 s inside the audible ${heard.toFixed(1)} s: ${gapsHeard.map((g) => `${g.start}–${g.end}`).join(', ')}`); }
  if (t.gapsBeyondFilm.length) reasons.push(`(gap after the film's end, never heard: ${t.gapsBeyondFilm.map((g) => `${g.start}–${g.end}`).join(', ')})`);
  if (t.TP > BED_TP + 0.05) { dq++; reasons.push(`true peak ${t.TP} dBTP > ${BED_TP}`); }
  if (t.normalization !== 'linear') { dq++; reasons.push(`loudnorm fell back to ${t.normalization} mode`); }
  if (Math.abs(t.I - BED_LUFS) > 0.5) { dq++; reasons.push(`integrated ${t.I} LUFS is outside ${BED_LUFS} ± 0.5`); }
  const lraPen = r2(Math.max(0, LRA_OK[0] - t.LRA, t.LRA - LRA_OK[1]));
  const safeLen = r2(heard + VO_DRIFT);
  const shortfall = r2(Math.max(0, safeLen - t.bodyEnd)); // 0 for any take longer than it needs to be
  if (shortfall > 0) reasons.push(`${shortfall} s short of the ${safeLen} s drift-safe length (clears today's ${heard.toFixed(1)} s gate, not a ${VO_DRIFT} s re-time)`);
  t.score = { total: r2(dq * 1000 + lraPen * 10 + shortfall * 20), disqualifiers: dq, lraPenalty: lraPen, safeLength: safeLen, shortfall, reasons };
  return t;
}

// =========================================================================
// SFX
// =========================================================================
async function fetchSfx(s, key) {
  const raw = path.join(TAKES, `sfx-${s.name}.mp3`);
  const reqFile = path.join(TAKES, `sfx-${s.name}.request.json`);
  if (!FORCE && existsSync(raw) && existsSync(reqFile)) { log(`  sfx ${s.name}: reusing ${path.relative(DIR, raw)}`); return; }
  log(`  sfx ${s.name}: requesting /v1/sound-generation (${Math.max(0.5, s.seconds)} s) …`);
  const r = await requestSfx(s, key);
  writeFileSync(raw, r.buf);
  writeFileSync(reqFile, JSON.stringify({ endpoint: '/v1/sound-generation', query: r.query, body: r.body, requested_at: new Date().toISOString(),
    response_content_type: r.ctype, response_bytes: r.buf.length, response_seconds: r2(r.seconds) }, null, 2));
  log(`    ← ${r.ctype}, ${(r.buf.length / 1024).toFixed(0)} KB in ${r.seconds.toFixed(1)} s`);
}

function normalizeSfx(s) {
  const raw = path.join(TAKES, `sfx-${s.name}.mp3`);
  const trimmed = path.join(TAKES, `sfx-${s.name}.trim.wav`);
  const out = path.join(SFX_DIR, `${s.name}.wav`);
  const rawInfo = probe(raw);
  let src = raw;
  if (s.compose) { // optional sound-design step on the generated material (see the table)
    src = path.join(TAKES, `sfx-${s.name}.composed.wav`);
    ff(['-i', raw, '-filter_complex', s.compose, '-map', '[out]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', src]);
  }
  const lead = leadingSilence(src);
  const fadeAt = Math.max(0, s.seconds - 0.02);
  ff(['-i', src, '-af', `atrim=start=${lead.toFixed(3)}:end=${(lead + s.seconds).toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=${fadeAt.toFixed(3)}:d=0.02,aresample=48000`,
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', trimmed]);
  // Integrated loudness of a sub-second clip: measure with 2 s of silence padded on (the gate ignores it).
  const m = ebur(trimmed, 'apad=pad_dur=2,');
  const gainLufs = SFX_LUFS - m.I, gainPeak = SFX_TP - m.TP;
  const gain = Math.min(gainLufs, gainPeak); // peak-safe linear gain, no limiter on transients
  ff(['-i', trimmed, '-af', `volume=${gain.toFixed(2)}dB`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', out]);
  const info = probe(out);
  const v = ebur(out, 'apad=pad_dur=2,');
  return {
    name: s.name, file: path.relative(DIR, out), raw: path.relative(DIR, raw), requestedSeconds: Math.max(0.5, s.seconds), rawDuration: r2(rawInfo.duration),
    leadingTrimmed: r2(lead), duration: r2(info.duration), rate: info.rate, channels: info.channels, codec: info.codec,
    gainDb: r2(gain), peakLimited: gainPeak < gainLufs, I: v.I, TP: v.TP, LRA: v.LRA, ebur: v.summary, prompt: s.prompt, influence: s.influence,
    compose: s.compose ?? null,
  };
}

// =========================================================================
// main
// =========================================================================
async function pool(jobs, n) {
  const q = [...jobs];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await q.shift()(); }));
}

async function main() {
  const beds = BEDS.filter(wantBed), sfx = SFX.filter(wantSfx);
  if (DRY) {
    for (const b of beds) {
      log(`\n## ${b.name} — film ${b.film} "${b.title}" · film ${b.filmLen} s · request ${b.lengthMs} ms · ${b.bpm} BPM · ${b.key}`);
      log(`PROMPT: ${b.prompt}`);
      log(`PLAN: ${JSON.stringify(b.plan)}`);
    }
    for (const s of sfx) log(`\n## sfx ${s.name} · ${s.seconds} s (request ${Math.max(0.5, s.seconds)} s, influence ${s.influence})\n${s.prompt}`);
    return;
  }
  const key = readKey();
  mkdirSync(TAKES, { recursive: true });
  mkdirSync(SFX_DIR, { recursive: true });
  const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : { beds: {}, sfx: {}, runs: [] };
  const before = await subscription(key);
  log(`ElevenLabs ${before.tier ?? '?'} · credits used before: ${before.character_count ?? '?'} / ${before.character_limit ?? '?'}`);

  // Phase 1: raw audio (parallel, cached unless --force)
  log(`\n== Phase 1: raw audio (${beds.length} beds × ${TAKES_N} takes, ${sfx.length} sfx; concurrency ${CONCURRENCY})`);
  const jobs = [];
  for (const b of beds) for (let i = 1; i <= TAKES_N; i++) jobs.push(() => fetchTake(b, i, key));
  for (const s of sfx) jobs.push(() => fetchSfx(s, key));
  await pool(jobs, CONCURRENCY);

  // Phase 2: normalize, measure, choose
  log(`\n== Phase 2: normalize (beds → ${BED_LUFS} LUFS two-pass linear, TP ≤ ${BED_TP}; sfx → ${SFX_LUFS} LUFS peak-safe)`);
  for (const b of beds) {
    log(`\n${b.name} — film ${b.film} "${b.title}", film ${b.filmLen} s, requested ${b.lengthMs / 1000} s, ${b.bpm} BPM ${b.key}`);
    const takes = [];
    for (const i of takesOnDisk(b)) {
      const t = normalizeTake(b, i);
      takes.push(t);
      log(`  take ${i} [${t.mode}, asked ${t.requestedMs} ms]  raw ${t.rawDuration}s (I ${t.raw_I}, TP ${t.raw_TP}, LRA ${t.raw_LRA})  →  ${t.duration}s body ${t.bodyEnd}s` +
        `  I ${t.I} LUFS  TP ${t.TP} dBTP  LRA ${t.LRA} LU  ${t.normalization}  head-trim ${t.headTrimmed}s${t.rawDropOnset != null ? ` (drop was at ${t.rawDropOnset}s)` : ''} tail-cut ${t.tailCut}s gaps ${t.gaps.length}` +
        `  score ${t.score.total}${t.score.reasons.length ? '  ✗ ' + t.score.reasons.join('; ') : ''}`);
      log(`    profile(M, 2 s): ${t.profile}`);
    }
    const chosen = [...takes].sort((x, y) => x.score.total - y.score.total || x.take - y.take)[0];
    if (chosen.score.disqualifiers) log(`  !! every take of ${b.name} is disqualified — shipping the least bad one; request another take (--takes ${TAKES_N + 1})`);
    const finalFile = path.join(DIR, `${b.name}.wav`);
    copyFileSync(path.join(DIR, chosen.wav), finalFile);
    const fe = ebur(finalFile), fi = probe(finalFile);
    log(`  → chose take ${chosen.take} (${chosen.mode}) → ${path.relative(DIR, finalFile)}  ${fi.duration.toFixed(2)} s ${fi.rate} Hz ${fi.channels} ch ${fi.codec}`);
    log(`    ffmpeg ebur128 (${b.name}.wav):\n${fe.summary}`);
    report.beds[b.name] = {
      film: b.film, title: b.title, filmLen: b.filmLen, requestedMs: b.lengthMs, bpm: b.bpm, key: b.key, character: b.character, prompt: b.prompt, plan: b.plan,
      takes, chosen: chosen.take, chosenMode: chosen.mode,
      final: { file: `${b.name}.wav`, duration: r2(fi.duration), rate: fi.rate, channels: fi.channels, codec: fi.codec, I: fe.I, TP: fe.TP, LRA: fe.LRA, bodyEnd: chosen.bodyEnd },
    };
  }
  if (sfx.length) log('');
  for (const s of sfx) {
    const r = normalizeSfx(s);
    report.sfx[s.name] = r;
    log(`sfx/${s.name}.wav  ${r.duration}s (asked ${s.seconds}s; raw ${r.rawDuration}s, lead trimmed ${r.leadingTrimmed}s)  I ${r.I} LUFS  TP ${r.TP} dBTP  gain ${r.gainDb} dB${r.peakLimited ? ' (peak-limited: −1 dBTP ceiling reached before −20 LUFS)' : ''}`);
    log(`    ffmpeg ebur128 (padded +2 s for the gate):\n${r.ebur}`);
  }

  const after = await subscription(key);
  const used = (after.character_count != null && before.character_count != null) ? after.character_count - before.character_count : null;
  report.runs.push({ at: new Date().toISOString(), only: ONLY, takes: TAKES_N, mode: MODE, force: FORCE, creditsBefore: before, creditsAfter: after, creditsUsed: used, rejectedFields });
  report.rejectedFields = [...(report.rejectedFields || []), ...rejectedFields];
  report.generatedWith = { music: `ElevenLabs Music v1 (POST /v1/music, model_id ${MODEL})`, sfx: 'ElevenLabs Sound Generation (POST /v1/sound-generation)', account: `${after.tier ?? before.tier ?? '?'} tier` };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));

  log(`\n== Summary`);
  log(`| File | Duration | Body | Integrated | True peak | LRA | BPM | Take |`);
  log(`|---|---|---|---|---|---|---|---|`);
  for (const b of beds) {
    const R = report.beds[b.name], f = R.final;
    log(`| ${f.file} | ${f.duration.toFixed(2)} s | ${f.bodyEnd} s | ${f.I.toFixed(1)} LUFS | ${f.TP.toFixed(1)} dBTP | ${f.LRA.toFixed(1)} LU | ${b.bpm} | ${R.chosen} (${R.chosenMode}) |`);
  }
  for (const s of sfx) {
    const r = report.sfx[s.name];
    log(`| sfx/${s.name}.wav | ${r.duration.toFixed(2)} s | — | ${r.I.toFixed(1)} LUFS | ${r.TP.toFixed(1)} dBTP | — | — | — |`);
  }
  log(`\ncredits used this run: ${used ?? 'unknown'} (${before.character_count ?? '?'} → ${after.character_count ?? '?'} of ${after.character_limit ?? '?'})`);
  if (rejectedFields.length) log(`API fields rejected: ${rejectedFields.map((r) => `${r.endpoint} ${r.field} (${r.status})`).join('; ')}`);
  else log('API fields rejected: none');
  log(`report: ${path.relative(DIR, REPORT)}`);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
