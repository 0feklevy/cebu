// Records the infographic overlay rig (index.html) to a 1920×1080 webm.
//
//   node render-overlay.mjs <scenes.json> <out.webm>
//
// scenes.json: { "total": <seconds>, "scenes": [{ id, type, t0, dur, props }] }
// (a bare array also works — total then falls back to max(t0+dur)).
//
// How the clock stays honest: Playwright starts capturing the moment the page
// exists, so the raw take carries a preroll (navigation + font load) before
// __overlayStart() arms the rig's global clock. During that preroll the page
// paints its exact t=0 frame PLUS a 32px magenta beacon in the top-left
// corner; __overlayStart() removes the beacon in the same task that arms the
// clock. We locate the first beacon-free frame in the raw take by scanning
// the corner's chroma (signalstats UAVG — magenta ≈ 212, any real ground
// ≤ 128) and trim there, so frame 0 of the published webm IS timeline t=0 to
// within one captured frame, no wall-clock guessing involved.
//
// Known limits (fine for this layer, noted for the assembler): Playwright
// records at 25fps VP8 4:2:0; the re-encode below is VP9 crf10 which keeps
// chroma edges clean enough for colorkey compositing.
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Same playwright resolution as captures/record-sim-footage.mjs — the one
// known-good local install with the Chrome channel available.
const req = createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'));
const pw = await import(pathToFileURL(req.resolve('playwright')));
const chromium = pw.chromium ?? pw.default.chromium;

const scenesPath = process.argv[2];
const outPath = process.argv[3];
if (!scenesPath || !outPath) {
  console.error('usage: node render-overlay.mjs <scenes.json> <out.webm>');
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(scenesPath, 'utf8'));
const scenes = Array.isArray(cfg) ? cfg : cfg.scenes;
if (!Array.isArray(scenes) || scenes.length === 0) {
  console.error('scenes.json has no scenes');
  process.exit(1);
}
const total = (!Array.isArray(cfg) && cfg.total) ? cfg.total : Math.max(...scenes.map(s => s.t0 + s.dur));

const here = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(path.join(here, 'index.html')).href;
const ffmpeg = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const ffprobe = existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
const vidDir = mkdtempSync(path.join(tmpdir(), 'overlay-rec-'));

// First frame whose top-left 32×32 corner is no longer the magenta sync
// beacon — that frame is rig-timeline t=0.
function findClockStart(raw) {
  const out = execFileSync(ffprobe, [
    '-v', 'error', '-f', 'lavfi', '-i', `movie=${raw},crop=32:32:0:0,signalstats`,
    '-show_entries', 'frame=pts_time:frame_tags=lavfi.signalstats.UAVG',
    '-of', 'csv=p=0',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let seenBeacon = false;
  for (const line of out.trim().split('\n')) {
    const [pts, uavg] = line.split(',');
    if (uavg === undefined) continue;
    const magenta = parseFloat(uavg) >= 180;
    if (magenta) seenBeacon = true;                    // page is initialized, clock not started
    else if (seenBeacon) return parseFloat(pts);       // first beacon-free frame = t0
    // frames before the beacon ever shows are navigation blanks — skip them
  }
  throw new Error('sync beacon never appeared+disappeared in the recording — did __overlayInit/__overlayStart run?');
}
mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--force-color-profile=srgb'] });
try {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2, // rasterize @2x, downsampled into the 1080p stream — crisper type
    recordVideo: { dir: vidDir, size: { width: 1920, height: 1080 } },
  });
  const tPage = Date.now();               // ≈ when the recording starts
  const p = await ctx.newPage();
  await p.goto(pageUrl, { waitUntil: 'domcontentloaded' });

  const diag = await p.evaluate((c) => window.__overlayInit(c), { scenes, total });
  if (!diag.fontLoaded) console.error('WARN: Bricolage Grotesque did not load — frames are falling back to the system stack');

  await p.waitForTimeout(400);            // bank a few clean t=0 frames as trim slack
  const tStart = Date.now();
  await p.evaluate(() => window.__overlayStart());
  await p.waitForFunction(() => window.__overlayDone === true, null, { timeout: (total + 60) * 1000 });

  const video = p.video();
  await ctx.close();
  const raw = await video.path();

  const clockStart = findClockStart(raw);
  execFileSync(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-i', raw,                            // -ss after -i: frame-accurate decode-seek
    '-ss', clockStart.toFixed(3),
    '-t', String(total),
    '-c:v', 'libvpx-vp9', '-crf', '8', '-b:v', '0',
    '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1',
    '-auto-alt-ref', '0',                 // alt-ref ghosts sharp text during settles
    '-pix_fmt', 'yuv420p', '-an',
    path.resolve(outPath),
  ], { stdio: ['ignore', 'inherit', 'inherit'] });

  console.log(JSON.stringify({
    out: path.resolve(outPath),
    duration: total,
    clockStart: +clockStart.toFixed(3),
    wallPreroll: +((tStart - tPage) / 1000).toFixed(3),
    fontLoaded: diag.fontLoaded,
    scenes: diag.scenes,
  }));
} finally {
  await browser.close();
  rmSync(vidDir, { recursive: true, force: true });
}
