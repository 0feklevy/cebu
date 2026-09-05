// Assemble one film: captures + infographic overlay + narration + music → H.264 1080p MP4.
// Usage: node assemble-film.mjs <film#> [--scratch] [--skip-overlay]
//   --scratch      use narration/audio-scratch (macOS say) instead of narration/audio — TIMING CUTS ONLY
//
// The film's REAL timeline is derived here: each scene starts no earlier than its script slot
// and runs at least as long as its VO clip (+pad). The derived timeline re-times the overlay
// cue sheet, so type always lands on the spoken beat regardless of TTS pacing drift.
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, '..');
const film = Number(process.argv[2]);
if (!film || film < 1 || film > 5) { console.error('usage: assemble-film.mjs <1..5>'); process.exit(1); }
const useScratch = process.argv.includes('--scratch');
const skipOverlay = process.argv.includes('--skip-overlay');
// --vo-dir <dir>: assemble against another narration folder (e.g. narration/audio-edge, the keyless
// fallback) — for structural checks of a cut while the real voice is still being produced.
const voDirArg = (() => { const i = process.argv.indexOf('--vo-dir'); return i > -1 ? process.argv[i + 1] : null; })();

const FF = 'ffmpeg';
const OUT = join(HERE, 'out');
const WORK = join(HERE, 'work', `film${film}`);
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

const probe = (f) => Number(execSync(
  `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${f}"`,
).toString().trim());

// ── 1. the scene list + VO clips ──────────────────────────────────────────────────────────────
const allLines = JSON.parse(readFileSync(join(KIT, 'narration/lines.json'), 'utf8')).filter(l => l.film === film);
const lines = allLines.filter(l => l.role === 'narrator');
// The in-film viewer's spoken question (a ∅ beat): its scene id is `<beat>-viewer`; it is mixed at
// that beat's start (+0.4 s so it never lands on the cut) and the bed drops under it (`silence`).
const viewerLines = allLines.filter(l => l.role === 'viewer');
const voDir = voDirArg
  ? (voDirArg.startsWith('/') ? voDirArg : join(KIT, voDirArg))
  : join(KIT, useScratch ? 'narration/audio-scratch' : 'narration/audio');

// ── 1b. THE VOICE GATE ────────────────────────────────────────────────────────────────────────
// A clip is trusted by FILENAME, and that is how a wrong film ships with exit code 0: a missing
// file silently becomes a silent scene, and a clip whose script line was rewritten after it was
// cut still has the right name while saying the wrong words. Both happened — the v3.2 rewrite
// left 17 of 48 clips contradicting lines.json, and nothing complained. So: every narrator and
// viewer line must have a file, and where the synthesizer left a MANIFEST.json the stored text
// must still equal the line. `--no-vo-check` exists for a deliberate structural dry-run and says
// so loudly; it is never how a deliverable is built.
const skipVoCheck = process.argv.includes('--no-vo-check');
const clipPath = (l) => join(voDir, `f${film}-s${l.scene}.mp3`);
{
  const manifestPath = join(voDir, 'MANIFEST.json');
  const voManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const clipRecord = (id) => {
    if (!voManifest) return null;
    if (Array.isArray(voManifest)) return voManifest.find((c) => c.id === id || c.clipId === id) ?? null;
    if (Array.isArray(voManifest.clips)) return voManifest.clips.find((c) => c.id === id || c.clipId === id) ?? null;
    return voManifest[id] ?? null;
  };
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const missing = [], drifted = [];
  for (const l of allLines) {
    const id = `f${film}-s${l.scene}`;
    if (!existsSync(clipPath(l))) { missing.push(id); continue; }
    const rec = clipRecord(id);
    if (rec && norm(rec.text) !== norm(l.text)) {
      drifted.push(`${id}\n      clip: ${norm(rec.text).slice(0, 90)}\n      line: ${norm(l.text).slice(0, 90)}`);
    }
  }
  if (missing.length || drifted.length) {
    const report = [
      missing.length ? `  MISSING (${missing.length}): ${missing.join(', ')}` : null,
      drifted.length ? `  TEXT DRIFT (${drifted.length}) — the script was rewritten after these were cut:\n    ${drifted.join('\n    ')}` : null,
      `  voice dir: ${voDir}`,
      voManifest ? null : '  (no MANIFEST.json in this voice dir — text identity was NOT checked, only existence)',
    ].filter(Boolean).join('\n');
    if (skipVoCheck) console.error(`\n!! VOICE GATE BYPASSED (--no-vo-check) — this film does not say its script:\n${report}\n`);
    else throw new Error(`film ${film}: the voice does not match the script.\n${report}\n  Re-synthesize (narration/synthesize-elevenlabs.mjs --force), or pass --no-vo-check for a structural dry-run.`);
  }
}

// EDL: scene → visual source. { scene, source: <path|shotId>, mode: 'fit'|'loop'|'hold', in?: sec }
const edl = JSON.parse(readFileSync(join(HERE, 'edl', `film${film}.json`), 'utf8'));
const manifest = existsSync(join(KIT, 'captures/out/MANIFEST.json'))
  ? JSON.parse(readFileSync(join(KIT, 'captures/out/MANIFEST.json'), 'utf8')) : {};
// BEATS, NOT NUMBERS. Every shot records the timestamps of its own moments to
// captures/out/beats/<shotId>.json, so a cut says WHICH MOMENT it wants ("atBeat": "generate") and
// the offset is read from the take that is actually on disk. Hand-written seconds are measured
// against one recording and silently outlive it — that is how beats ended up landing on an idle
// editor and a page-load flash. `beatLead` is how long before the moment the cut starts (0.4s by
// default, so the gesture is not already underway on the first frame).
const beatsOf = (shotId) => {
  const p = join(KIT, 'captures/out/beats', `${shotId}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};
const beatSec = (shotId, beatName, lead = 0.4) => {
  const beats = beatsOf(shotId);
  const hit = beats?.find((b) => b.name === beatName);
  if (!hit) {
    throw new Error(`shot ${shotId}: no beat named "${beatName}" (it records ${beats ? beats.map(b => b.name).join(', ') : 'no beats at all'}) — ` +
      `name a beat the shot actually marks, or fall back to a literal \`in\``);
  }
  return Math.max(0, hit.sec - lead);
};

const resolveSource = (cut) => {
  const attempt = (s) => {
    if (!s) return null;
    if (s.includes('/')) {
      const p = s.startsWith('/') ? s : join(KIT, s);
      return existsSync(p) ? p : null;
    }
    // A shot is also discoverable by convention. A failed RE-shoot overwrites its manifest entry
    // with an error record and takes the `file` of the perfectly good take with it — which then
    // cascades, because that take is another beat's fallback. The bytes on disk outlive the record.
    if (manifest[s]?.file && existsSync(manifest[s].file)) return manifest[s].file;
    for (const ext of ['.webm', '.mp4']) {
      const byName = join(KIT, 'captures/out', s + ext);
      if (existsSync(byName)) return byName;
    }
    return null;
  };
  const primary = attempt(cut.source);
  const got = primary ?? attempt(cut.fallback);
  if (!got) throw new Error(`EDL scene ${cut.scene}: neither source (${cut.source}) nor fallback resolves`);
  // `in` describes the intended shot; a stand-in has its own timing (`fallbackIn`), because an
  // offset tuned for a 45 s legacy capture is the wrong frame of the 8 s reshoot that replaces it.
  return { path: got, usedFallback: primary === null };
};

// ── 2. derive the real timeline ───────────────────────────────────────────────────────────────
// Silent beats (∅ scenes, e.g teaser 3b) exist in the EDL but not in narrator lines: carry them
// from the EDL's declared slot.
const timeline = [];
let cursor = 0;
// Quantized to whole frames: a scene boundary between frames makes every later cut land a fraction
// early or late, and the drift accumulates across ten scenes into a visible slip against the VO.
const q = (x) => Math.round(x * 30) / 30;
const isWindowCut = (cut, line) => (cut.kind ?? line?.kind ?? 'VIDEO') === 'LIVE-WINDOW';
for (const [i, cut] of edl.cuts.entries()) {
  const line = lines.find(l => l.scene === cut.scene);
  const slot = cut.slot ?? (line ? [line.t0, line.t1] : null);
  if (!slot) throw new Error(`scene ${cut.scene}: no slot in EDL and no narration line`);
  const voFile = line ? clipPath(line) : null;
  const voDur = voFile && existsSync(voFile) ? probe(voFile) : 0;
  const start = q(Math.max(cursor, slot[0]));
  const minDur = slot[1] - slot[0];
  // The LAST beat of a live window gets a wider tail: the auto-return riser starts a second before
  // the window closes, and a line still being spoken under it reads as the film talking over itself.
  const next = edl.cuts[i + 1];
  const lastOfWindow = isWindowCut(cut, line)
    && !(next && isWindowCut(next, lines.find(l => l.scene === next.scene)));
  const pad = cut.padAfter ?? (lastOfWindow ? 1.5 : 0.5);
  // voDelay holds the line off the cut (return beats); it is part of what the scene must contain,
  // or the pad silently absorbs it and the next cut lands on the last syllable.
  const dur = q(Math.max(minDur, (cut.voDelay ?? 0) + voDur + pad));
  timeline.push({ scene: cut.scene, start, dur, voFile: voDur ? voFile : null, voDur, cut });
  cursor = start + dur;
}
const total = q(cursor);
// LIVE WINDOWS FOLLOW THE CUT. A window is the run of consecutive LIVE-WINDOW beats naming the same
// sim, timed on the DERIVED timeline rather than the script's slot, so the seeded section
// (seeding/build-template.mjs reads these), the music duck below and the picture agree to the frame.
const windows = [];
for (const t of timeline) {
  const line = lines.find(l => l.scene === t.scene);
  const kind = t.cut.kind ?? line?.kind ?? 'VIDEO';
  const sim = line?.window ?? t.cut.window ?? null;
  if (kind !== 'LIVE-WINDOW' || !sim) continue;
  const end = Number((t.start + t.dur).toFixed(2));
  const last = windows[windows.length - 1];
  if (last && last.sim === sim && Math.abs(last.end - t.start) < 0.05) { last.end = end; last.scenes.push(t.scene); }
  else windows.push({ sim, start: Number(t.start.toFixed(2)), end, scenes: [t.scene] });
}
writeFileSync(join(WORK, 'timeline.json'), JSON.stringify({ film, total, windows, timeline }, null, 2));

// ── 3. per-scene video normalization → concat ─────────────────────────────────────────────────
// CREATIVE-DIRECTION v3 R4: never clone a frame. A scene may carry `sources: [..]` (sub-cuts
// split evenly across the scene — the montage grammar) and a too-short source is CUT to the next
// sub-source or looped when it's motion footage, never frozen.
const VF = 'scale=1920:1080:force_original_aspect_ratio=decrease,' +
  'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0f17,fps=30,setsar=1';
// PUNCH-IN. Editor panels (Library, the Generate mini model card, the share sheet) are a fifth of the
// frame — ~12 px type at 1080p. `zoom: { cx, cy, scale }` crops a `1/scale` window centred at the
// fractional point (cx, cy) of the source and scales it back up, so a note like "punch-in 2.0× on
// the card" is a number in the EDL rather than a reshoot.
const zoomFilter = (z) => {
  if (!z || !(z.scale > 1)) return '';
  const s = Number(z.scale), cx = Number(z.cx ?? 0.5), cy = Number(z.cy ?? 0.5);
  return `crop=iw/${s}:ih/${s}:(iw-iw/${s})*${cx}:(ih-ih/${s})*${cy},`;
};
function renderPart(src, dur, inSec, loop, out, zoom) {
  // An `in` past the end of the source produces an EMPTY file, and an empty file probes as NaN —
  // which compared false against every threshold and sailed through as "fine". Offsets are tuned
  // against one take and outlive it, so the offset is fitted to the source that is actually here.
  const srcDur = probe(src);
  if (Number.isFinite(srcDur) && !loop && inSec + dur > srcDur) {
    inSec = Math.max(0, srcDur - dur);
  }
  // LOOPING RESPECTS THE IN-POINT. `-ss` before `-i` seeks once and `-stream_loop` then replays the
  // WHOLE file, so a looped sub-cut jumped back to frame 0 — the shot the EDL deliberately avoided.
  // The tail from `inSec` is cut first, and that is what repeats.
  let input = src;
  if (loop && inSec) {
    input = out.replace(/\.mp4$/, '.seg.mp4');
    execFileSync(FF, ['-y', '-loglevel', 'error', '-ss', String(inSec), '-i', src, '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', input]);
  }
  const inArg = !loop && inSec ? ['-ss', String(inSec)] : [];
  const loopArg = loop ? ['-stream_loop', '-1'] : [];
  execFileSync(FF, ['-y', '-loglevel', 'error', ...loopArg, ...inArg, '-i', input,
    '-t', String(dur), '-vf', zoomFilter(zoom) + VF, '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out]);
  const got = probe(out);
  return Number.isFinite(got) ? got : 0;
}
const FILL_TOLERANCE = 0.09;   // ~2.5 frames: container rounding, not a missing shot
const parts = [];
for (const t of timeline) {
  const subs = Array.isArray(t.cut.sources) && t.cut.sources.length
    ? t.cut.sources
    : [{ source: t.cut.source, fallback: t.cut.fallback, in: t.cut.in, mode: t.cut.mode, zoom: t.cut.zoom }];
  const each = t.dur / subs.length;
  subs.forEach((sub, i) => {
    const { path: src, usedFallback } = resolveSource({ scene: `${t.scene}.${i}`, source: sub.source, fallback: sub.fallback ?? t.cut.fallback });
    const part = join(WORK, `scene-${t.scene}-${i}.mp4`);
    const zoom = sub.zoom ?? t.cut.zoom;
    const lead = sub.beatLead ?? t.cut.beatLead ?? 0.4;
    const shotId = usedFallback ? (sub.fallback ?? t.cut.fallback) : (sub.source ?? t.cut.source);
    const beatName = usedFallback ? (sub.fallbackAtBeat ?? t.cut.fallbackAtBeat) : (sub.atBeat ?? t.cut.atBeat);
    const inSec = beatName && !String(shotId).includes('/')
      ? beatSec(shotId, beatName, lead)
      : usedFallback ? (sub.fallbackIn ?? t.cut.fallbackIn ?? sub.in ?? 0) : (sub.in ?? 0);
    // A source that cannot fill its slot is looped (motion keeps moving) — never frame-cloned.
    // The retry used to loop ANY short source: a UI capture that ran out replayed its own gesture,
    // and worse, a part that stayed short shifted every later scene early against the voice, which
    // the old 0.25 s tolerance let through silently. Now the fill is asserted.
    // LOOPING IS FOR PLATES, NOT FOR SHOTS. The retry used to promote ANY short source to a loop,
    // so a VIDEO beat whose take could not fill its slot shipped as a strobe — film 1's ask beat
    // repeated 0.7 s of footage five times and the build said nothing. A shot that is too short is
    // a shot problem; only a source explicitly marked `mode: "loop"` (the simulation plates, whose
    // motion is continuous by construction) may repeat.
    const mayLoop = sub.mode === 'loop' || t.cut.mode === 'loop';
    let got = renderPart(src, each, inSec, mayLoop, part, zoom);
    if (got < each - FILL_TOLERANCE && mayLoop) got = renderPart(src, each, inSec, true, part, zoom);
    if (!(got >= each - FILL_TOLERANCE)) {
      throw new Error(`scene ${t.scene}.${i}: ${basename(src)} yields ${got.toFixed(2)}s of the ${each.toFixed(2)}s it must fill ` +
        `(in=${inSec.toFixed(2)}) — shorten the beat, add a sub-cut, point it at a longer take, or mark it mode:"loop" ` +
        `if it is a plate whose motion may repeat`);
    }
    parts.push({ file: part, scene: `${t.scene}.${i}`, src });
  });
}
// THE OPENING FRAME IS THE FILM. An `in` offset tuned against one take lands on the next take's
// page-load flash — white, or black, or a paused poster — and a contact sheet of the first cut was
// mostly black frames. Every part's first frame is measured; a dark one is named, and a dark FIRST
// frame of the film (the thumbnail, and a viewer's whole first impression) stops the build.
// FLATNESS, not brightness. A page-load flash is a flat white field and a missing take is a flat
// black one, but a solar system is legitimately dark and a light UI is legitimately bright — judging
// by average luma alone rejected a real shot of space and would have kept a blank white page. What
// both failures share is that the frame has no CONTENT: its darkest and brightest pixels are almost
// the same. That is what is measured.
const firstFrameSpread = (file) => {
  const s = spawnSync(FF, ['-hide_banner', '-i', file, '-frames:v', '1', '-vf', 'signalstats,metadata=print',
    '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).stderr ?? '';
  const num = (k) => { const m2 = s.match(new RegExp(`${k}=([\\d.]+)`)); return m2 ? Number(m2[1]) : null; };
  // YMIN/YMAX, not the YLOW/YHIGH percentiles: a starfield is 90% empty space, so its percentile
  // spread is as flat as a blank page while its actual range is the full 0-255. Sparse bright
  // content is exactly what a simulation plate is made of.
  const lo = num('YMIN'), hi = num('YMAX'), avg = num('YAVG');
  return lo === null || hi === null ? null : { spread: hi - lo, avg };
};
const FLAT_SPREAD = 40;
const flatParts = [];
for (const p of parts) {
  // No exemption. The black plate used to be excused here, which is exactly why 23 seconds of black
  // in the teaser never tripped a check that existed to catch black.
  const f = firstFrameSpread(p.file);
  if (f && f.spread < FLAT_SPREAD) {
    flatParts.push({ scene: p.scene, text: `${p.scene} (spread ${f.spread.toFixed(0)}, luma ${f.avg?.toFixed(0)}) ${basename(p.src)}` });
  }
}
if (flatParts.length) {
  console.error(`\n!! film ${film}: ${flatParts.length} cut(s) open on a featureless frame — a page-load flash or a missing take:\n   ` +
    flatParts.map(f => f.text).join('\n   ') + `\n   Pick the \`in\` from the footage: node assembly/scan-luma.mjs <shotId>\n`);
  if (flatParts.some(f => f.scene === `${edl.cuts[0].scene}.0`)) {
    throw new Error(`film ${film}: the FIRST frame of the film has no picture in it. That frame is the thumbnail ` +
      `and the viewer's first impression — fix scene ${edl.cuts[0].scene}'s source or \`in\` before building.`);
  }
}
writeFileSync(join(WORK, 'concat.txt'), parts.map(p => `file '${p.file}'`).join('\n'));
const base = join(WORK, 'base.mp4');
execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
  '-i', join(WORK, 'concat.txt'), '-c', 'copy', base]);

// ── 4. audio: VO at scene starts + music bed → loudnorm ───────────────────────────────────────
const BEDS = { 1: 'bed-teaser.wav', 2: 'bed-tutorial.wav', 3: 'bed-heavy.wav', 4: 'bed-powers.wav', 5: 'bed-share.wav' };
const bed = join(KIT, 'music', BEDS[film]);
// Voice placements: each narrator clip at its beat's start (+ the cut's optional `voDelay`, so a
// return line does not hit on frame 0 of the cut), each viewer question at its ∅ beat's start + 0.4.
const voScenes = timeline.filter(t => t.voFile).map(t => ({ file: t.voFile, at: t.start + (t.cut.voDelay ?? 0) }));
for (const v of viewerLines) {
  const hostScene = String(v.scene).replace(/-viewer$/, '');
  const t = timeline.find(x => String(x.scene) === hostScene);
  const f = clipPath(v);
  if (t && existsSync(f)) voScenes.push({ file: f, at: t.start + 0.4 });
}
// A bed shorter than its film ends the picture in silence — exactly under the end card, which is
// the one place the music is supposed to land. `atrim` never noticed; this does.
{
  const bedDur = probe(bed);
  if (bedDur < total) {
    throw new Error(`film ${film}: ${BEDS[film]} is ${bedDur.toFixed(2)}s but the film is ${total.toFixed(2)}s — ` +
      `the last ${(total - bedDur).toFixed(2)}s would play silent. Regenerate the bed longer (music/generate-elevenlabs.mjs).`);
  }
}
// Sound effects. Levels are set HERE rather than in the files: the pack is normalized to −20 LUFS
// integrated, which on a 0.4 s click means a −2.7 dBFS peak — louder than the narrator. `gain` is dB.
const SFX_DIR = join(KIT, 'music/sfx');
const SFX_GAIN_DB = {
  'riser-1200ms.wav': 3, 'chime-generate.wav': -6, 'ui-click.wav': -18,
  'type-burst.wav': -20, 'whoosh-in.wav': -12, 'whoosh-out.wav': -12,
};
const sfxPlacements = [];
const riser = join(SFX_DIR, 'riser-1200ms.wav');
// One riser per window, crested on the auto-return. At end−1.2 it finished before the picture came
// back AND overlapped the last spoken line; end−1.0 with the wider window tail (see the timeline)
// puts the crest on the cut.
// The riser's crest is ~0.45 s from its end, so placing the file at end-1.0 crested half a second
// BEFORE the picture came back and was already decaying at the return. It lands on the cut now.
if (existsSync(riser)) for (const w of windows) sfxPlacements.push({ file: riser, at: Math.max(0, w.end - 0.55) });
for (const t of timeline) {
  for (const s of t.cut.sfx ?? []) {
    const f = s.file.startsWith('/') ? s.file : join(KIT, s.file);
    if (existsSync(f)) sfxPlacements.push({ file: f, at: t.start + (s.at ?? 0), gain: s.gain });
  }
}
for (const s of sfxPlacements) s.gain = s.gain ?? SFX_GAIN_DB[basename(s.file)] ?? 0;
// v3 grammar, corrected. The bed does not CUT DEAD inside a live window — a dead track under a
// running film reads as broken audio, and the film IS still running under the simulation. It goes
// behind the glass: the direct signal ducks away over 300 ms and a low-passed copy stays at −11 dB,
// so the drop is still an event and the room is still alive. The ∅ ask beat is the one true cut.
// Windows are the cut's own (derived above); the layout's are the fallback for a film with no
// LIVE-WINDOW beats.
const LAYOUT = JSON.parse(readFileSync(join(KIT, 'seeding/layout-v3.json'), 'utf8'));
const layoutWindowsFor = (n) => {
  if (n === 1) return LAYOUT.demo.windows;
  if (n === 2) return LAYOUT.tutorial.windows;
  return (LAYOUT.niche.find((x) => x.film === n)?.windows) ?? [];
};
const wins = windows.length
  ? windows.map((w) => [w.start, w.end])
  : layoutWindowsFor(film).map((w) => w.window);
const silences = timeline.filter(t => t.cut.silence).map(t => [t.start, t.start + t.dur]);
// The player takes ~125 ms to detect the crossing and 200 ms to fade the sim in, so the duck starts
// 100 ms late and takes 300 ms — the music moves WITH the picture rather than ahead of it.
const RAMP = 0.30, LEAD = 0.10;
const envelope = (spans) => spans.length
  ? `min(1,${spans.map(([a, b]) =>
      `min(1,max(0,(t-${(a + LEAD).toFixed(2)})/${RAMP}))*min(1,max(0,(${b.toFixed(2)}-t)/${RAMP}))`,
    ).join('+')})`
  : null;
const W = envelope(wins), S = envelope(silences);
const dry = `${W ? `(1-${W})` : '1'}${S ? `*(1-0.97*${S})` : ''}`;
const wet = W ? `0.28*${W}${S ? `*(1-0.97*${S})` : ''}` : null;
const fc = [];
// A short declick only. The beds are 10–22 s longer than their films and end on a composed button
// hit that the trim cannot reach, so a long fade would be pretending; 0.6 s just stops it cleanly.
const tail = `afade=t=out:st=${(total - 0.6).toFixed(2)}:d=0.6`;
if (wet) {
  fc.push(`[0:a]atrim=0:${total},asplit=2[bd][bw]`);
  fc.push(`[bd]volume=eval=frame:volume='${dry}',${tail}[bdry]`);
  fc.push(`[bw]lowpass=f=1400,volume=eval=frame:volume='${wet}',${tail}[bwet]`);
  fc.push(`[bdry][bwet]amix=inputs=2:normalize=0[bed]`);
} else {
  fc.push(`[0:a]atrim=0:${total}${S ? `,volume=eval=frame:volume='${dry}'` : ''},${tail}[bed]`);
}
const runFF = (args) => {
  const r = spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').slice(-1500)}`);
  return r.stderr || '';
};
const ebur = (file) => {
  const s = runFF(['-hide_banner', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const t2 = s.slice(s.lastIndexOf('Integrated loudness'));
  const num = (re) => { const m2 = t2.match(re); return m2 ? Number(m2[1]) : null; };
  return { I: num(/I:\s*(-?[\d.]+)\s*LUFS/), LRA: num(/LRA:\s*(-?[\d.]+)\s*LU/), peak: num(/Peak:\s*(-?[\d.]+)\s*dBFS/) };
};

// THE VOICE BUS, summed and levelled before the music ever sees it.
//
// Speech carries 14–21 dB of crest, so no amount of linear gain puts it at −19 LUFS under a −3 dBTP
// ceiling — the narration clips ship uniform and quiet by design, and the peaks are controlled HERE,
// once, on the summed voice. That is what a real ad mix does, and it is a different thing from the
// master-bus `loudnorm` this chain used to run: a limiter on the voice shapes the voice, while a
// dynamic process on the master re-shapes the balance between voice and music — which is the mix
// itself, made and then undone.
const voxFile = join(WORK, 'vox.wav');
const voxFc = voScenes.map((v, i) =>
  `[${i}:a]aformat=channel_layouts=stereo:sample_rates=48000,adelay=${Math.round(v.at * 1000)}:all=1[v${i}]`);
voxFc.push(`${voScenes.map((_, i) => `[v${i}]`).join('')}amix=inputs=${voScenes.length}:normalize=0[vox]`);
execFileSync(FF, ['-y', '-loglevel', 'error', ...voScenes.flatMap(v => ['-i', v.file]),
  '-filter_complex', voxFc.join(';'), '-map', '[vox]', '-t', String(total),
  '-c:a', 'pcm_s24le', '-ar', '48000', voxFile]);
// −8 rather than −6: the ceiling on the voice IS the headroom the master gets, and two more dB
// there buys the whole film two dB of level without any dynamics on the master bus.
const VOICE_TARGET_I = -19, VOICE_CEIL_DBFS = -8;
const voxBefore = ebur(voxFile);
const voxGain = VOICE_TARGET_I - (voxBefore.I ?? VOICE_TARGET_I);

const inputs = ['-i', bed, '-i', voxFile, ...sfxPlacements.flatMap(s => ['-i', s.file])];
// Gain to the voice target, then one gentle ceiling on the summed voice: attack fast enough to
// catch a plosive, release slow enough not to breathe. Everything under it is untouched.
fc.push(`[1:a]volume=${voxGain.toFixed(2)}dB,` +
  `alimiter=limit=${(10 ** (VOICE_CEIL_DBFS / 20)).toFixed(4)}:level=0:attack=5:release=60[vox]`);
sfxPlacements.forEach((s, i) => {
  fc.push(`[${i + 2}:a]aformat=channel_layouts=stereo:sample_rates=48000,volume=${s.gain}dB,` +
    `adelay=${Math.round(s.at * 1000)}:all=1[sfx${i}]`);
});
fc.push(`${['[bed]', '[vox]', ...sfxPlacements.map((_, i) => `[sfx${i}]`)].join('')}` +
  `amix=inputs=${2 + sfxPlacements.length}:normalize=0[mix]`);
const raw = join(WORK, 'audio-raw.wav');
execFileSync(FF, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', fc.join(';'),
  '-map', '[mix]', '-t', String(total), '-c:a', 'pcm_s24le', '-ar', '48000', raw]);

// ── MASTER: measure, then one static gain. ────────────────────────────────────────────────────
// Target is the web level the product's own podcast edition uses, −16 LUFS with a −2 dBTP ceiling.
// The lift is a plain `volume` computed from the measured integrated loudness — a number, applied
// to every sample equally — so the balance built above (bed 11 dB behind the glass, voice on top)
// arrives at the master intact. The previous chain asked a single-pass `loudnorm` for the same
// thing and got a compressor: it lifted the ducked windows 3–7 dB and pushed the bed up whenever
// the narrator stopped, which is precisely the mix being undone after it was made.
const TARGET_I = -16, CEILING_DBTP = -2;
const before = ebur(raw);
if (before.I === null) throw new Error('could not measure the raw mix');
// Headroom decides the gain: never push the peak past the ceiling to reach the loudness target.
// When the two disagree the peak wins and the shortfall is REPORTED, not compressed away.
const wantGain = TARGET_I - before.I;
const peakRoom = CEILING_DBTP - (before.peak ?? 0);
const gainDb = Math.min(wantGain, peakRoom);
const mixed = join(WORK, 'audio.m4a');
runFF(['-y', '-hide_banner', '-i', raw, '-af',
  `volume=${gainDb.toFixed(2)}dB,alimiter=limit=${(10 ** (CEILING_DBTP / 20)).toFixed(4)}:level=0`,
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', mixed]);
const after = ebur(mixed);
const loudness = {
  target_I: TARGET_I, ceiling_dbtp: CEILING_DBTP, raw: before, gain_db: Number(gainDb.toFixed(2)),
  voice: { measured_I: voxBefore.I, gain_db: Number(voxGain.toFixed(2)), target_I: VOICE_TARGET_I, ceiling_dbfs: VOICE_CEIL_DBFS },
  delivered: after, shortfall_db: Number((TARGET_I - (after.I ?? TARGET_I)).toFixed(2)),
};
// A shortfall now means something specific: the voice bus could not carry the film to target even
// after its own levelling, i.e. the bed is doing too much of the work or the clips are unusually
// peaky. Say it in numbers rather than reaching for a compressor.
if (Math.abs(loudness.shortfall_db) > 2.0) {
  console.error(`\n!! film ${film}: master lands at ${after.I} LUFS, ${loudness.shortfall_db} LU off the ${TARGET_I} target ` +
    `(mix ${before.I} LUFS, peak ${before.peak} dBFS — ${peakRoom.toFixed(1)} dB of headroom; ` +
    `voice bus measured ${voxBefore.I} and was lifted ${voxGain.toFixed(1)} dB).\n`);
}
// The limiter is meant to catch stray peaks, not to reshape the film. If it flattened more than a
// dynamic unit of range, it did the compressing this chain exists to avoid.
if (before.LRA !== null && after.LRA !== null && before.LRA - after.LRA > 1.0) {
  throw new Error(`film ${film}: the limiter squashed the range (LRA ${before.LRA} → ${after.LRA} LU). ` +
    `Lower the source levels instead of the ceiling.`);
}

// ── 5. overlay: re-time cues → render → composite ─────────────────────────────────────────────
let withOverlay = base;
if (!skipOverlay) {
  const cueFile = join(KIT, 'overlay/scenes', `film${film}.json`);
  const cues = JSON.parse(readFileSync(cueFile, 'utf8'));
  const sceneStart = Object.fromEntries(timeline.map(t => [String(t.scene), t.start]));
  const sceneEnd = Object.fromEntries(timeline.map(t => [String(t.scene), t.start + t.dur]));
  for (const c of cues.scenes ?? cues) {
    if (c.anchorScene != null) {
      const s0 = sceneStart[String(c.anchorScene)];
      if (s0 != null) c.t0 = s0 + (c.anchorOffset ?? 0);
      if (c.holdToSceneEnd) c.dur = Math.max(0.5, sceneEnd[String(c.anchorScene)] - c.t0);
    }
  }
  if (cues.total != null) cues.total = total;
  const retimed = join(WORK, 'overlay-cues.json');
  writeFileSync(retimed, JSON.stringify(cues, null, 2));
  const ovl = join(WORK, 'overlay.webm');
  execFileSync('node', [join(KIT, 'overlay/render-overlay.mjs'), retimed, ovl], { stdio: 'inherit' });
  withOverlay = join(WORK, 'composited.mp4');
  execFileSync(FF, ['-y', '-loglevel', 'error', '-i', base, '-i', ovl, '-filter_complex',
    '[1:v]colorkey=0x00FF00:0.30:0.10,despill=type=green[ov];[0:v][ov]overlay=shortest=0[v]',
    '-map', '[v]', '-t', String(total), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', withOverlay]);
}

// ── 6. mux + QC stills ────────────────────────────────────────────────────────────────────────
const final = join(OUT, `film${film}${useScratch ? '.SCRATCH' : ''}.mp4`);
execFileSync(FF, ['-y', '-loglevel', 'error', '-i', withOverlay, '-i', mixed,
  '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', final]);
mkdirSync(join(OUT, 'qc'), { recursive: true });
// Contact frames on the beats that decide whether the cut works: the open, each window's first and
// last second (what the viewer sees behind the live simulation), and the end card.
const stills = [['open', 0.6], ...windows.flatMap((w, i) => [
  [`w${i + 1}-in`, w.start + 0.5], [`w${i + 1}-out`, Math.max(0, w.end - 0.5)],
]), ['mid', total * 0.5], ['end', Math.max(0, total - 1.2)]];
for (const [name, at] of stills) {
  execFileSync(FF, ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', final,
    '-frames:v', '1', join(OUT, 'qc', `film${film}-${name}.png`)]);
}
// Measured on the DELIVERED file — the muxed master, not the mix that went into it.
const measured = ebur(final);

// STAMP THE TIMELINE WITH THE BYTES IT DESCRIBES. The seeder reads `windows` from here and uploads
// `filmN.mp4` from there; nothing tied the two together, so a stale timeline silently seeded window
// times belonging to a different cut. The hash and duration make that mismatch loud.
const sha = createHash('sha256').update(readFileSync(final)).digest('hex');
writeFileSync(join(WORK, 'timeline.json'), JSON.stringify({
  film, total, windows, output: final, sha256: sha, voDir, loudness, measured, timeline,
}, null, 2));
console.log(JSON.stringify({ film, total: Number(total.toFixed(2)), final, sha256: sha.slice(0, 12),
  loudness: { target_I: TARGET_I, gain_db: loudness.gain_db, delivered: measured },
  windows, voDir: voDir.replace(KIT + '/', ''),
  scenes: timeline.map(t => ({ s: t.scene, at: Number(t.start.toFixed(2)), dur: Number(t.dur.toFixed(2)) })) }, null, 2));
