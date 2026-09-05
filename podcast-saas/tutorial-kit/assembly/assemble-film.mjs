// Assemble one film: captures + infographic overlay + narration + music → H.264 1080p MP4.
// Usage: node assemble-film.mjs <film#> [--scratch] [--skip-overlay]
//   --scratch      use narration/audio-scratch (macOS say) instead of narration/audio — TIMING CUTS ONLY
//
// The film's REAL timeline is derived here: each scene starts no earlier than its script slot
// and runs at least as long as its VO clip (+pad). The derived timeline re-times the overlay
// cue sheet, so type always lands on the spoken beat regardless of TTS pacing drift.
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, '..');
const film = Number(process.argv[2]);
if (!film || film < 1 || film > 5) { console.error('usage: assemble-film.mjs <1..5>'); process.exit(1); }
const useScratch = process.argv.includes('--scratch');
const skipOverlay = process.argv.includes('--skip-overlay');

const FF = 'ffmpeg';
const OUT = join(HERE, 'out');
const WORK = join(HERE, 'work', `film${film}`);
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

const probe = (f) => Number(execSync(
  `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${f}"`,
).toString().trim());

// ── 1. the scene list + VO clips ──────────────────────────────────────────────────────────────
const lines = JSON.parse(readFileSync(join(KIT, 'narration/lines.json'), 'utf8'))
  .filter(l => l.film === film && l.role === 'narrator');
const voDir = join(KIT, useScratch ? 'narration/audio-scratch' : 'narration/audio');

// EDL: scene → visual source. { scene, source: <path|shotId>, mode: 'fit'|'loop'|'hold', in?: sec }
const edl = JSON.parse(readFileSync(join(HERE, 'edl', `film${film}.json`), 'utf8'));
const manifest = existsSync(join(KIT, 'captures/out/MANIFEST.json'))
  ? JSON.parse(readFileSync(join(KIT, 'captures/out/MANIFEST.json'), 'utf8')) : {};
const resolveSource = (cut) => {
  const attempt = (s) => {
    if (!s) return null;
    if (s.includes('/')) {
      const p = s.startsWith('/') ? s : join(KIT, s);
      return existsSync(p) ? p : null;
    }
    return manifest[s]?.file ?? null;
  };
  const got = attempt(cut.source) ?? attempt(cut.fallback);
  if (!got) throw new Error(`EDL scene ${cut.scene}: neither source (${cut.source}) nor fallback resolves`);
  return got;
};

// ── 2. derive the real timeline ───────────────────────────────────────────────────────────────
// Silent beats (∅ scenes, e.g teaser 3b) exist in the EDL but not in narrator lines: carry them
// from the EDL's declared slot.
const timeline = [];
let cursor = 0;
for (const cut of edl.cuts) {
  const line = lines.find(l => l.scene === cut.scene);
  const slot = cut.slot ?? (line ? [line.t0, line.t1] : null);
  if (!slot) throw new Error(`scene ${cut.scene}: no slot in EDL and no narration line`);
  const voFile = line ? join(voDir, `f${film}-s${line.scene}.mp3`) : null;
  const voDur = voFile && existsSync(voFile) ? probe(voFile) : 0;
  const start = Math.max(cursor, slot[0]);
  const minDur = slot[1] - slot[0];
  const dur = Math.max(minDur, voDur + (cut.padAfter ?? 0.5));
  timeline.push({ scene: cut.scene, start, dur, voFile: voDur ? voFile : null, voDur, cut });
  cursor = start + dur;
}
const total = cursor;
writeFileSync(join(WORK, 'timeline.json'), JSON.stringify({ film, total, timeline }, null, 2));

// ── 3. per-scene video normalization → concat ─────────────────────────────────────────────────
const parts = [];
for (const t of timeline) {
  const src = resolveSource(t.cut);
  const part = join(WORK, `scene-${t.scene}.mp4`);
  const inArg = t.cut.in ? ['-ss', String(t.cut.in)] : [];
  const loop = t.cut.mode === 'loop' ? ['-stream_loop', '-1'] : [];
  const vf = 'scale=1920:1080:force_original_aspect_ratio=decrease,' +
    'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0f17,fps=30,setsar=1';
  execFileSync(FF, ['-y', '-loglevel', 'error', ...loop, ...inArg, '-i', src,
    '-t', String(t.dur), '-vf', vf, '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', part]);
  const got = probe(part);
  if (got < t.dur - 0.25) {
    // source shorter than the scene and not looped — hold the last frame to fill
    const held = join(WORK, `scene-${t.scene}-held.mp4`);
    execFileSync(FF, ['-y', '-loglevel', 'error', '-i', part,
      '-vf', `tpad=stop_mode=clone:stop_duration=${(t.dur - got + 0.1).toFixed(2)}`,
      '-t', String(t.dur), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', held]);
    parts.push(held);
  } else parts.push(part);
}
writeFileSync(join(WORK, 'concat.txt'), parts.map(p => `file '${p}'`).join('\n'));
const base = join(WORK, 'base.mp4');
execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
  '-i', join(WORK, 'concat.txt'), '-c', 'copy', base]);

// ── 4. audio: VO at scene starts + music bed → loudnorm ───────────────────────────────────────
const BEDS = { 1: 'bed-teaser.wav', 2: 'bed-tutorial.wav', 3: 'bed-heavy.wav', 4: 'bed-powers.wav', 5: 'bed-share.wav' };
const bed = join(KIT, 'music', BEDS[film]);
const voScenes = timeline.filter(t => t.voFile);
const inputs = ['-i', bed, ...voScenes.flatMap(t => ['-i', t.voFile])];
const fc = [];
fc.push(`[0:a]atrim=0:${total},afade=t=out:st=${(total - 2).toFixed(2)}:d=2[bed]`);
voScenes.forEach((t, i) => {
  fc.push(`[${i + 1}:a]adelay=${Math.round(t.start * 1000)}:all=1[vo${i}]`);
});
const mixIn = ['[bed]', ...voScenes.map((_, i) => `[vo${i}]`)].join('');
fc.push(`${mixIn}amix=inputs=${voScenes.length + 1}:normalize=0,` +
  `alimiter=limit=0.891,loudnorm=I=-19:TP=-1.5:LRA=11[mix]`);
const mixed = join(WORK, 'audio.m4a');
execFileSync(FF, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', fc.join(';'),
  '-map', '[mix]', '-t', String(total), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', mixed]);

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
for (const pct of [0.08, 0.35, 0.6, 0.92]) {
  execFileSync(FF, ['-y', '-loglevel', 'error', '-ss', String((total * pct).toFixed(2)), '-i', final,
    '-frames:v', '1', join(OUT, 'qc', `film${film}-${Math.round(pct * 100)}.png`)]);
}
console.log(JSON.stringify({ film, total: Number(total.toFixed(2)), final,
  scenes: timeline.map(t => ({ s: t.scene, at: Number(t.start.toFixed(2)), dur: Number(t.dur.toFixed(2)) })) }, null, 2));
