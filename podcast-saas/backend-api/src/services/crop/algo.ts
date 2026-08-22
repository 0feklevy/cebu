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

/**
 * v1.0 — the shipped skin/saliency/motion pipeline as of the D-16 speech-correlation fix.
 * v1.1 — gender gap-fill deleted, AV gate expressed in null-σ units, null-energy floor for
 *        subject-free shots, adaptive shot detection.
 */
const VERSIONS: Record<CropAlgo, string> = {
  v1: 'v1.1',
  v2: 'v2.0',
};

/**
 * Is there an algorithm behind the `v2` label yet?
 *
 * There is not, and saying so here is the whole point. `CROP_ALGO=v2` is documented below as a
 * shipped-dark rollout lever, but NOTHING in `backend-api/src` branches on `cropAlgo()` — grep it.
 * v1 and v2 are one code path wearing two labels, which the field eval demonstrated by scoring
 * both at an identical mIoU of 0.5089 across 390 hand-labelled frames.
 *
 * Flip this to `true` in the same commit that adds the branch. Until then it is what stops the
 * trap described on `cropAlgo` below.
 */
const V2_IMPLEMENTED = false;

/**
 * The active algorithm. Defaults to v1: v2 carries a new dependency and a new failure mode,
 * so it ships dark and is turned on per-environment (§4.6 of the upgrade plan), and rolling
 * back is an env flip rather than a deploy.
 *
 * ── WHY AN UNIMPLEMENTED v2 IS IGNORED RATHER THAN HONOURED ───────────────────────────────────
 * `algoVersion()` feeds `sourceHash`, deliberately, so that a genuine algorithm fix reaches videos
 * that already have a crop. That makes the version stamp expensive to change: setting
 * `CROP_ALGO=v2` today would alter every `crop_source_hash`, mark every `ready` row stale, and
 * recompute the ENTIRE catalogue — to produce byte-identical output, because no code reads the
 * selection. An env flip documented as a cheap rollback lever would in fact be a full reprocess
 * for zero change, with nothing warning and nothing failing.
 *
 * So an unimplemented v2 is REFUSED, loudly, and v1 is used. The alternative — throwing — would
 * turn a stray environment variable into a production outage, which is a worse answer than
 * ignoring it and saying so on every call site that matters.
 */
export function cropAlgo(): CropAlgo {
  if (process.env.CROP_ALGO === 'v2' && !V2_IMPLEMENTED) return 'v1';
  return process.env.CROP_ALGO === 'v2' ? 'v2' : 'v1';
}

/**
 * Whether the environment is asking for an algorithm that does not exist.
 *
 * Separate from `cropAlgo()` because that runs inside `sourceHash` on every crop and must stay
 * quiet. This is for the one place that should be loud: startup, once.
 */
export function cropAlgoMisconfigured(): string | null {
  if (process.env.CROP_ALGO === 'v2' && !V2_IMPLEMENTED) {
    return 'CROP_ALGO=v2 is set, but no v2 algorithm is implemented — nothing in the crop pipeline '
      + 'branches on the selection. It is being IGNORED and v1 used instead. Honouring it would '
      + 'change the algorithm version stamp, invalidate every stored crop hash and recompute the '
      + 'entire catalogue to produce identical output. Unset the variable.';
  }
  return null;
}

/** Version stamp for `algo`, defaulting to whichever algorithm is currently selected. */
export function algoVersion(algo: CropAlgo = cropAlgo()): string {
  return VERSIONS[algo];
}
