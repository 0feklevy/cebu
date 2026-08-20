/*
 * Crop eval harness — the number every change to src/services/crop has to move.
 *
 *   pnpm --filter backend-api eval:crop                 # score the current algorithm
 *   pnpm --filter backend-api eval:crop -- --algo centre
 *   pnpm --filter backend-api eval:crop -- --compare results/v1@v1.0.json
 *   pnpm --filter backend-api eval:crop -- --write      # refresh the committed baseline
 *
 * It drives the REAL pipeline — the same SceneAnalyzer, shot detection, head model, AV
 * correlation, debounce and smoother production runs — over deterministic synthetic clips,
 * through the CropSource seam so no ffmpeg, no media files and no network are involved.
 * Read the header of src/services/crop/eval/fixtures.ts before quoting any score from it:
 * the clips are synthetic, and what they measure is mechanisms, not catalogue accuracy.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCropSource, type CropSource } from '../../src/services/crop/cropProcessor.js';
import { algoVersion, type CropAlgo } from '../../src/services/crop/algo.js';
import { evalClips, cropHalfWidth, type EvalClip } from '../../src/services/crop/eval/fixtures.js';
import { scoreClip, aggregate, byCategory, type ClipScore, type EvalReport } from '../../src/services/crop/eval/metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, 'results');

type Algo = CropAlgo | 'centre';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Feed the pipeline a fixture's frames and PCM instead of an ffmpeg decode. */
function fixtureSource(clip: EvalClip): CropSource {
  return {
    probe: async () => ({ width: clip.width, height: clip.height, durationSec: clip.durationSec }),
    audio: async () => clip.audio(),
    frames: async (_w, _h, _fps, onFrame) => {
      const n = Math.round(clip.durationSec * clip.sampleFps);
      for (let i = 0; i < n; i++) onFrame(clip.frame(i), i);
    },
  };
}

async function run(algo: Algo, only?: string): Promise<{ report: EvalReport; ms: Record<string, number> }> {
  const clips = evalClips().filter((c) => !only || c.id === only);
  const scores: ClipScore[] = [];
  const ms: Record<string, number> = {};

  for (const clip of clips) {
    const half = cropHalfWidth(clip.width, clip.height);
    const t0 = Date.now();
    const keyframes = algo === 'centre'
      ? clip.labels.map((l) => ({ t: l.t, x: 0.5 }))
      : (await withAlgo(algo, () => processCropSource(clip.id, fixtureSource(clip)))).keyframes;
    ms[clip.id] = Date.now() - t0;
    scores.push(scoreClip(clip, keyframes, half));
  }

  return {
    report: {
      algo,
      algo_version: algo === 'centre' ? 'baseline' : algoVersion(algo),
      clips: scores,
      overall: aggregate(scores),
      by_category: byCategory(scores),
    },
    ms,
  };
}

/** Run `fn` with CROP_ALGO pinned, so one invocation can score both algorithms. */
async function withAlgo<T>(algo: CropAlgo, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CROP_ALGO;
  process.env.CROP_ALGO = algo;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CROP_ALGO; else process.env.CROP_ALGO = prev;
  }
}

function table(report: EvalReport, ms: Record<string, number>): string {
  const head = ['clip', 'category', 'mIoU', 'IoU@.5', 'outFrame', 'attrib', 'jitter', 'travel/s', 'clamp', 'ms'];
  const rows = report.clips.map((s) => [
    s.clip_id, s.category,
    s.m_iou.toFixed(3), s.iou_at_50.toFixed(3), s.out_of_frame.toFixed(3),
    s.attribution === null ? '—' : s.attribution.toFixed(3),
    s.jitter.toFixed(5), s.travel_per_sec.toFixed(4), s.pinned_at_clamp.toFixed(3),
    String(ms[s.clip_id] ?? 0),
  ]);
  const o = report.overall;
  rows.push(['OVERALL', '', o.m_iou.toFixed(3), o.iou_at_50.toFixed(3), o.out_of_frame.toFixed(3),
    o.attribution === null ? '—' : o.attribution.toFixed(3),
    o.jitter.toFixed(5), o.travel_per_sec.toFixed(4), o.pinned_at_clamp.toFixed(3), '']);

  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i])).join('  ');
  return [line(head), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(line)].join('\n');
}

function delta(now: EvalReport, before: EvalReport): string {
  const keys: Array<[keyof typeof now.overall, 'up' | 'down']> = [
    ['m_iou', 'up'], ['iou_at_50', 'up'], ['out_of_frame', 'down'],
    ['attribution', 'up'], ['jitter', 'down'], ['travel_per_sec', 'down'], ['pinned_at_clamp', 'down'],
  ];
  const lines = [`vs ${before.algo} (${before.algo_version}):`];
  for (const [k, better] of keys) {
    const a = before.overall[k] as number | null;
    const b = now.overall[k] as number | null;
    if (a === null || b === null) continue;
    const d = b - a;
    const mark = Math.abs(d) < 1e-9 ? '=' : (d > 0) === (better === 'up') ? '+' : '!';
    lines.push(`  ${mark} ${String(k).padEnd(15)} ${a.toFixed(4)} -> ${b.toFixed(4)}  (${d >= 0 ? '+' : ''}${d.toFixed(4)})`);
  }
  return lines.join('\n');
}

const algo = (arg('algo') ?? process.env.CROP_ALGO ?? 'v1') as Algo;
const { report, ms } = await run(algo, arg('clip'));

console.log(table(report, ms));
console.log();

const compare = arg('compare');
if (compare) {
  const path = resolve(HERE, compare);
  if (existsSync(path)) console.log(delta(report, JSON.parse(readFileSync(path, 'utf8')) as EvalReport));
  else console.error(`compare: ${path} does not exist`);
  console.log();
}

const json = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv.includes('--write')) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = join(RESULTS_DIR, `${algo}@${report.algo_version}.json`);
  writeFileSync(out, json);
  console.error(`wrote ${out}`);
} else {
  process.stdout.write(json);
}
