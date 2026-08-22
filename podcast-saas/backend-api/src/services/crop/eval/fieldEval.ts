/**
 * Scoring the crop on REAL footage — the half of P0.3 that did not exist.
 *
 * The annotation tool (`scripts/crop-eval/annotate.html`) has shipped for a while, and so has the
 * label parser. Nothing turned the resulting files into a NUMBER: `run-eval.ts` scores the
 * synthetic fixtures and only those. So the owner could have spent two hours labelling clips and
 * had nothing to run them through — which is the worst possible discovery to make afterwards.
 *
 * ── EVERY RULE BELOW IS A REFUSAL, AND THAT IS DELIBERATE ─────────────────────────────────────
 * This module produces the only number the P2.8 go/no-go may quote. A wrong number here is worse
 * than no number, because it is quotable: it ends the argument it should have started. The
 * README's own words are that an ambiguous convention "does not produce noisy data, it produces
 * confidently wrong data". So each way of being confidently wrong is refused by name rather than
 * averaged into the score.
 */
import type { LabelledClip } from './labels.js';

/** A label file paired with the video it was made from. */
export interface FieldClip {
  clip: LabelledClip;
  /** Absolute path to the video, or null when it could not be found. */
  videoPath: string | null;
  /** sha256 of the video actually on disk, or null when it was not read. */
  actualSha256: string | null;
}

export interface Refusal {
  clipId: string;
  reason: string;
  /** Machine-readable, so a report can group them without parsing prose. */
  code: 'no_video' | 'sha_mismatch' | 'unfinished' | 'no_labels' | 'zero_duration';
}

export interface Admission {
  admitted: FieldClip[];
  refused: Refusal[];
}

/**
 * Which labelled clips may be scored.
 *
 * Four ways a label file can be worthless, each of which produces a plausible number if averaged
 * in rather than refused:
 *
 *  - **The video is missing.** Nothing to run the pipeline over.
 *  - **The video's hash does not match the one labelled.** This is the dangerous one: the pipeline
 *    runs happily against a DIFFERENT video and every frame is compared to ground truth for
 *    footage it never saw. The score is precise, reproducible and meaningless.
 *  - **The labelling is unfinished.** The tool carries the previous frame's value forward as the
 *    next frame's default, which is what makes a static shot quick — and what makes an abandoned
 *    file look complete. `confirmedFrames` is the count a human actually looked at.
 *  - **There are no labels at all**, or the clip has no duration to sample.
 */
export function admitClips(clips: readonly FieldClip[]): Admission {
  const admitted: FieldClip[] = [];
  const refused: Refusal[] = [];

  for (const c of clips) {
    const id = c.clip.id;
    if (!c.videoPath) {
      refused.push({ clipId: id, code: 'no_video', reason: `the video named in the label file (${c.clip.source.file}) was not found` });
      continue;
    }
    // Only when BOTH hashes are known. A label file recorded without one is older than the field,
    // not falsified, and refusing it would discard honest work for a missing field rather than a
    // wrong one.
    if (c.clip.source.sha256 && c.actualSha256 && c.clip.source.sha256 !== c.actualSha256) {
      refused.push({
        clipId: id,
        code: 'sha_mismatch',
        reason: 'the video on disk is not the one that was labelled — scoring it would compare the pipeline to ground truth for footage it never saw',
      });
      continue;
    }
    if (c.clip.labels.length === 0) {
      refused.push({ clipId: id, code: 'no_labels', reason: 'the label file contains no frames' });
      continue;
    }
    if (c.clip.durationSec <= 0) {
      refused.push({ clipId: id, code: 'zero_duration', reason: 'the clip has no duration to sample' });
      continue;
    }
    if (c.clip.confirmedFrames < c.clip.labels.length) {
      refused.push({
        clipId: id,
        code: 'unfinished',
        reason: `labelling is unfinished — ${c.clip.confirmedFrames} of ${c.clip.labels.length} frames were actually reviewed; the rest are carried-forward defaults, not ground truth`,
      });
      continue;
    }
    admitted.push(c);
  }

  return { admitted, refused };
}

/**
 * How many clips a field number is allowed to rest on.
 *
 * P0.3 asks for 20–50. Below that the per-category breakdown has single-digit sample sizes and the
 * aggregate is dominated by whichever clip happened to be hardest, so the number moves for reasons
 * that have nothing to do with the algorithm. Twelve is the floor at which a report may be QUOTED;
 * fewer still runs, and still prints, but is labelled provisional rather than silently treated as
 * a result.
 */
export const MIN_QUOTABLE_CLIPS = 12;

export interface FieldVerdict {
  /** May this report be quoted in a go/no-go? */
  quotable: boolean;
  /** Said plainly, for the top of the report. Never absent. */
  caveat: string;
}

/**
 * What a report is allowed to claim.
 *
 * Returns a caveat even when the answer is yes, because a report with no caveat line is one whose
 * limits a reader has to reconstruct — and the single most repeated mistake in this project's crop
 * history is a synthetic-fixture score being quoted as field accuracy.
 */
export function fieldVerdict(admittedCount: number, refusedCount: number): FieldVerdict {
  if (admittedCount === 0) {
    return {
      quotable: false,
      caveat:
        refusedCount > 0
          ? `NO CLIPS SCORED. All ${refusedCount} label file(s) were refused — see the refusals below. This report contains no measurement.`
          : 'NO CLIPS SCORED. No label files were found. This report contains no measurement.',
    };
  }
  if (admittedCount < MIN_QUOTABLE_CLIPS) {
    return {
      quotable: false,
      caveat:
        `PROVISIONAL — ${admittedCount} clip(s), below the ${MIN_QUOTABLE_CLIPS} this report needs before it may be quoted. ` +
        'Per-category figures rest on single-digit samples and move for reasons unrelated to the algorithm.',
    };
  }
  return {
    quotable: true,
    caveat:
      `Field accuracy over ${admittedCount} hand-labelled clip(s)` +
      (refusedCount > 0 ? `, with ${refusedCount} refused (listed below).` : '.'),
  };
}
