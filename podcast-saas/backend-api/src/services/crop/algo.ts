/**
 * Which crop algorithm runs, and the version stamp that lets a fix reach videos that
 * were already processed.
 *
 * Both halves exist because of the same defect. `runCropAnalysis` short-circuits when the
 * row is `ready` and its stored hash still matches, and that hash was built from the SOURCE
 * alone (storage key + size + duration). The source of a published episode never changes,
 * so every improvement to this pipeline was invisible to the entire existing catalogue —
 * including via the Recrop button, which recomputed the identical answer. Folding the
 * algorithm version into the hash input is what makes "we fixed the crop" mean anything for
 * a video that already has one.
 *
 * Bump the version of an algorithm whenever a change to it would produce a different
 * keyframe track. That is the whole contract: a bump makes every `ready` row stale on its
 * next trigger, so it is deliberately a decision, not a build number.
 */

export type CropAlgo = 'v1' | 'v2';

/** v1.0 — the shipped skin/saliency/motion pipeline as of the D-16 speech-correlation fix. */
const VERSIONS: Record<CropAlgo, string> = {
  v1: 'v1.0',
  v2: 'v2.0',
};

/**
 * The active algorithm. Defaults to v1: v2 carries a new dependency and a new failure mode,
 * so it ships dark and is turned on per-environment (§4.6 of the upgrade plan), and rolling
 * back is an env flip rather than a deploy.
 */
export function cropAlgo(): CropAlgo {
  return process.env.CROP_ALGO === 'v2' ? 'v2' : 'v1';
}

/** Version stamp for `algo`, defaulting to whichever algorithm is currently selected. */
export function algoVersion(algo: CropAlgo = cropAlgo()): string {
  return VERSIONS[algo];
}
