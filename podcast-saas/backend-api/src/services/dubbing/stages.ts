/**
 * What a dub is DOING right now, as a stage, a sentence and a percentage.
 *
 * ── The defect this replaces ──────────────────────────────────────────────────────────────────
 * The creator's panel drew a progress bar from `done / total videos`. Almost every project has one
 * video, so the bar read `0/1` for the entire run — twenty minutes of nothing — and then `1/1`.
 * That is a boolean rendered as a bar: it reports whether the work has finished, which is the one
 * thing the person watching it already knows.
 *
 * The work is not one step. It is: wait for a vendor slot, transcribe the original speech, dub and
 * voice-match it, pull the translated transcript, download the audio, mux it onto the original
 * frames, transcode an HLS rendition. Each of those is a distinct place in `DubbingService`, each
 * takes a different and knowable amount of time, and none of them was written down anywhere.
 *
 * ── Why the percentages are what they are ─────────────────────────────────────────────────────
 * Each stage's `pct` is where the bar STANDS when the stage begins, and the gaps between them are
 * proportional to how long that stage really takes — the two vendor waits together own 74% of the
 * bar because they own most of the wall clock. A bar whose stages are evenly spaced is a lie told
 * with arithmetic: it sprints through the fast half and then appears to hang.
 *
 * ── Why it creeps, and why it can never arrive ────────────────────────────────────────────────
 * Inside a stage there is no signal at all — the vendor reports `dubbing` and nothing else, with no
 * percentage of its own. So the bar advances on elapsed time, asymptotically, toward one point
 * short of the NEXT stage's start and never reaching it. That shape is chosen deliberately: it
 * cannot ever claim a step is done, because only the step finishing can move it there. A frozen
 * bar means "no idea"; this one means "still working, and here is roughly how long that has been".
 *
 * Pure and dependency-free so the arithmetic is testable without a database, a clock or a vendor —
 * this repository has already learned what a test that reads source instead of behaviour is worth.
 */

export interface DubStage {
  readonly key: string;
  /** Present tense, plain language, no jargon — this is read by the person paying for the run. */
  readonly label: string;
  /** Where the bar stands the moment this stage begins. */
  readonly pct: number;
  /**
   * Roughly how long this stage takes, used only to shape the creep inside it. Being wrong here
   * costs a bar that moves too fast or too slow, never a bar that lies about which stage it is in.
   */
  readonly typicalMs: number;
}

/**
 * The pipeline, in order. `queued` is included because waiting for one of the workspace's three
 * vendor slots is a real state a creator can sit in, and showing it as 0% with the reason is much
 * better than showing it as "starting" — one of them is a queue, and the other is a stall.
 */
export const DUB_STAGES: readonly DubStage[] = [
  { key: 'queued',       label: 'Waiting for a free dubbing slot',      pct: 0,  typicalMs: 60_000 },
  { key: 'preparing',    label: 'Preparing the source video',           pct: 4,  typicalMs: 20_000 },
  { key: 'transcribing', label: 'Transcribing the original speech',     pct: 12, typicalMs: 150_000 },
  { key: 'translating',  label: 'Translating and matching the voices',  pct: 45, typicalMs: 420_000 },
  { key: 'captioning',   label: 'Writing the translated captions',      pct: 78, typicalMs: 20_000 },
  { key: 'downloading',  label: 'Downloading the dubbed audio',         pct: 82, typicalMs: 40_000 },
  { key: 'mixing',       label: 'Mixing the new audio onto the video',  pct: 86, typicalMs: 60_000 },
  { key: 'packaging',    label: 'Packaging it for streaming',           pct: 93, typicalMs: 150_000 },
];

export type DubStageKey = (typeof DUB_STAGES)[number]['key'];

const BY_KEY = new Map(DUB_STAGES.map((s) => [s.key, s]));
const INDEX = new Map(DUB_STAGES.map((s, i) => [s.key, i]));

/** Whether a string is a stage this pipeline can actually be in. */
export function isDubStage(key: string | null | undefined): boolean {
  return typeof key === 'string' && BY_KEY.has(key);
}

export interface DubProgress {
  /** The stage key, or a terminal pseudo-stage: `completed`, `failed`, `stale`. */
  stage: string;
  label: string;
  /** 0–100, integer. */
  percent: number;
  /** True while the run is still moving, which is what tells a client whether to keep polling. */
  active: boolean;
}

/**
 * How far along one dub is.
 *
 * `stage` may be null: rows created before this existed, and rows claimed by a worker that has not
 * yet written its first stage. That is not an error state and must not read as one — it is
 * reported as the first working stage with an honest label, because "we are working on it and
 * cannot yet say where" is true, and 0% would not be.
 */
export function dubProgress(args: {
  status: string | null;
  stage: string | null;
  stageEnteredAtMs: number | null;
  nowMs: number;
}): DubProgress {
  const { status, stage, stageEnteredAtMs, nowMs } = args;

  if (status === 'completed') return { stage: 'completed', label: 'Ready', percent: 100, active: false };
  if (status === 'stale')     return { stage: 'stale', label: 'Out of date — the video changed', percent: 0, active: false };
  if (status === 'failed') {
    // Freeze at the stage it died in. Where a run stopped is the most useful thing a failed row
    // can say, and resetting the bar to zero would throw that away.
    const at = BY_KEY.get(stage ?? '');
    return { stage: 'failed', label: 'Failed', percent: at?.pct ?? 0, active: false };
  }
  if (status === 'queued' || !status) {
    return { stage: 'queued', label: DUB_STAGES[0]!.label, percent: 0, active: true };
  }

  // status === 'processing'
  const current = BY_KEY.get(stage ?? '') ?? BY_KEY.get('preparing')!;
  const idx = INDEX.get(current.key)!;
  const next = DUB_STAGES[idx + 1];
  // The last stage has no successor to creep toward, so it aims at 99: the run is not finished
  // until the row says `completed`, and no elapsed time may assert otherwise.
  const ceiling = (next?.pct ?? 100) - 1;
  const room = Math.max(0, ceiling - current.pct);

  const elapsed = stageEnteredAtMs === null ? 0 : Math.max(0, nowMs - stageEnteredAtMs);
  // 1 - e^(-t/τ): about 63% of the remaining room at τ, 86% at 2τ, and never all of it.
  const creep = room * (1 - Math.exp(-elapsed / Math.max(1, current.typicalMs)));

  return {
    stage: current.key,
    label: current.label,
    percent: Math.min(99, Math.round(current.pct + creep)),
    active: true,
  };
}

/**
 * One language's progress across every video in the project.
 *
 * The mean, not the minimum: a four-video project whose first dub is finished and whose second is
 * halfway is genuinely 37% done, and showing the slowest video's 50% would make finishing a video
 * move the bar backwards. An empty list is 0 rather than NaN.
 */
export function rollUpProgress(percents: readonly number[]): number {
  if (percents.length === 0) return 0;
  return Math.round(percents.reduce((a, b) => a + b, 0) / percents.length);
}
