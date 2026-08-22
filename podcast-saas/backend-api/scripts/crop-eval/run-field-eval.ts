/**
 * Score the crop pipeline on REAL, HAND-LABELLED footage — P0.3.
 *
 *   pnpm --filter backend-api eval:crop:field
 *
 * The counterpart to `run-eval.ts`, and the distinction is the whole point. That one scores
 * SYNTHETIC fixtures: flat-shaded discs that measure whether a change moved the defect it claimed
 * to move. Its numbers are not field accuracy and the fixtures file says so in its header. This
 * one scores the real thing, and its number is the only one a P2.8 go/no-go may quote.
 *
 * It reads every `labels/*.labels.json` written by `annotate.html`, finds the video each was made
 * from, runs the actual pipeline over it, and compares frame by frame against what a human said.
 *
 * ── IT REFUSES MORE THAN IT SCORES, ON PURPOSE ────────────────────────────────────────────────
 * A wrong number here is worse than no number because it is quotable — it ends the argument it
 * should have started. So a clip whose video is missing, whose hash does not match the one
 * labelled, or whose labelling is unfinished is REFUSED BY NAME rather than averaged in. The
 * refusals are printed, because "seven of your files were rejected and here is why" is actionable
 * and a silently smaller sample is not.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCropSource, ffmpegSource } from '../../src/services/crop/cropProcessor.js';
import { algoVersion, cropAlgo, type CropAlgo } from '../../src/services/crop/algo.js';
import { parseLabelFile, labelFileIssues, labelHalfWidth } from '../../src/services/crop/eval/labels.js';
import { scoreClip, aggregate, byCategory, type ClipScore } from '../../src/services/crop/eval/metrics.js';
import { admitClips, fieldVerdict, type FieldClip, type Refusal } from '../../src/services/crop/eval/fieldEval.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LABELS_DIR = join(HERE, 'labels');
const RESULTS_DIR = join(HERE, 'results');
/** Where the videos live. Beside their labels by default; override for a large corpus. */
const CLIPS_DIR = process.env.CROP_FIELD_CLIPS ?? LABELS_DIR;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function load(): { clips: FieldClip[]; unreadable: Refusal[] } {
  if (!existsSync(LABELS_DIR)) return { clips: [], unreadable: [] };
  const clips: FieldClip[] = [];
  const unreadable: Refusal[] = [];

  for (const name of readdirSync(LABELS_DIR).filter((f) => f.endsWith('.labels.json'))) {
    const path = join(LABELS_DIR, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      // A malformed file is two hours of someone's work that will not parse. It is reported by
      // NAME rather than skipped, because the alternative is a quietly smaller sample.
      unreadable.push({ clipId: name, code: 'no_labels', reason: `not valid JSON: ${(e as Error).message}` });
      continue;
    }
    const issues = labelFileIssues(raw);
    if (issues.length > 0) {
      unreadable.push({ clipId: name, code: 'no_labels', reason: `label file is invalid: ${issues.join('; ')}` });
      continue;
    }
    const clip = parseLabelFile(raw);
    const videoPath = existsSync(join(CLIPS_DIR, clip.source.file)) ? join(CLIPS_DIR, clip.source.file) : null;
    clips.push({
      clip,
      videoPath,
      // Hashed only when the file exists, so a missing video is reported as missing rather than
      // as a hash mismatch — the two send the owner to different places.
      actualSha256: videoPath ? sha256(videoPath) : null,
    });
  }
  return { clips, unreadable };
}

async function main(): Promise<number> {
  // VALIDATED, not cast. `CropAlgo` is 'v1' | 'v2'; an unrecognised value used to sail through
  // the cast and produce `field-yunet@undefined.json` — a report filed under a version that does
  // not exist, which is unfindable later and looks like a real result now.
  const requested = process.env.CROP_ALGO ?? cropAlgo();
  if (requested !== 'v1' && requested !== 'v2') {
    console.error(`CROP_ALGO must be v1 or v2 (got ${JSON.stringify(requested)})`);
    return 1;
  }
  const algo: CropAlgo = requested;
  const { clips, unreadable } = load();
  const { admitted, refused } = admitClips(clips);
  const allRefused = [...unreadable, ...refused];

  const scores: ClipScore[] = [];
  for (const c of admitted) {
    const half = labelHalfWidth(c.clip.width, c.clip.height);
    const { keyframes } = await processCropSource(c.clip.id, // THE PRODUCTION SOURCE, not a test double. The whole claim of a field number is that it
    // measures what a user's video goes through, and a bespoke decode here would measure
    // something adjacent to it.
    ffmpegSource(c.videoPath!));
    scores.push(scoreClip(c.clip, keyframes, half));
  }

  const verdict = fieldVerdict(admitted.length, allRefused.length);
  const report = {
    kind: 'field' as const,
    algo,
    algo_version: algoVersion(algo),
    // FIRST FIELD IN THE FILE, so a reader who screenshots the top of it cannot miss what the
    // number is allowed to claim.
    caveat: verdict.caveat,
    quotable: verdict.quotable,
    clips: scores,
    overall: scores.length ? aggregate(scores) : null,
    by_category: scores.length ? byCategory(scores) : null,
    refused: allRefused,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = resolve(RESULTS_DIR, `field-${algo}@${algoVersion(algo)}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(`\n${verdict.caveat}\n`);
  for (const r of allRefused) console.log(`  refused  ${r.clipId}: ${r.reason}`);
  if (report.overall) console.log(`\n  overall  ${JSON.stringify(report.overall)}`);
  console.log(`\n  written  ${out}\n`);

  // EXIT NON-ZERO WHEN NOTHING WAS SCORED. A run that produces no measurement and exits 0 is one
  // that a CI step, or a person in a hurry, reads as a pass.
  return admitted.length === 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
