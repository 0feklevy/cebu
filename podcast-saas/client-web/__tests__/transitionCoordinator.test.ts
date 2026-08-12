/**
 * The transition coordinator's reducer (audit P0.1) — the invariant, over the whole product.
 *
 * WHAT THIS FILE IS FOR
 * The coordinator decides which pixels a viewer may see during a handoff. There is exactly one
 * thing that must be true of it, and it is not "the happy path works": it is that NO sequence of
 * events, of any length, in any order, can reach a revealed state without evidence that matches
 * both the handoff generation and the requested media time. That claim is only worth anything if
 * it is checked over the product rather than over the handful of paths someone thought to write
 * down — the failures this replaces were all in the combinations nobody enumerated.
 *
 * So the bulk of this file walks a cartesian product of the five axes that can each independently
 * break the gate — generation match, evidence kind/arrival, visibility, deadline, audio policy —
 * and asserts `revealsWithoutEvidence` after EVERY step of EVERY sequence, not merely at the end.
 * A reducer that revealed for one event and corrected itself on the next would still be a
 * reducer that put an unproven frame on screen.
 */

import { describe, expect, it } from 'vitest';

import {
  reduce,
  reduceAll,
  coverFor,
  frameMatches,
  fallbackAdmissible,
  audioPolicySatisfied,
  revealsWithoutEvidence,
  isRevealed,
  INITIAL_TRANSITION_STATE,
  DEFAULT_FRAME_TOLERANCE_SEC,
  HAVE_CURRENT_DATA,
  type AudioIntent,
  type TransitionEffect,
  type TransitionEvent,
  type TransitionState,
} from '../lib/sim/transitionCoordinator';

const GEN = 7;
const TARGET = 42.5;

const exitRequested = (over: Partial<Extract<TransitionEvent, { type: 'EXIT_REQUESTED' }>> = {}): TransitionEvent => ({
  type: 'EXIT_REQUESTED',
  generation: GEN,
  incomingId: 'vid-1',
  requestedMediaTime: TARGET,
  seekRequested: true,
  audioIntent: 'narration-continuous',
  outgoing: { kind: 'sim', valid: true },
  poster: { available: false, loaded: false },
  rvfcAvailable: true,
  pageVisible: true,
  deadlineAt: 4_000,
  ...over,
});

/** The shortest legal path to a proven reveal, used as the control in several tests below. */
const HAPPY: readonly TransitionEvent[] = [
  exitRequested(),
  { type: 'SOURCE_ISSUED', generation: GEN },
  { type: 'MEDIA_READY', generation: GEN, readyState: 4, seeked: true },
  { type: 'FRAME_PRESENTED', generation: GEN, mediaTime: TARGET, kind: 'rvfc', atMs: 10 },
  { type: 'PARENT_PAINT', generation: GEN },
  { type: 'FADE_COMPLETE', generation: GEN },
];

const kinds = (effects: TransitionEffect[]): string[] => effects.map((e) => e.type);

/** Step a sequence, asserting the invariant after EVERY event rather than only at the end. */
function walk(events: readonly TransitionEvent[], label: string): TransitionState {
  let s = INITIAL_TRANSITION_STATE;
  expect(revealsWithoutEvidence(s), `${label}: initial state`).toBe(false);
  events.forEach((e, i) => {
    s = reduce(s, e).state;
    expect(
      revealsWithoutEvidence(s),
      `${label}: revealed without matching evidence after step ${i} (${e.type}) → phase=${s.phase}`,
    ).toBe(false);
  });
  return s;
}

// ── the predicates, on their own ──────────────────────────────────────────────────────────────

describe('frameMatches requires BOTH generation and media time', () => {
  const base: TransitionState = { ...INITIAL_TRANSITION_STATE, generation: GEN, requestedMediaTime: TARGET };

  it('accepts the target frame of the current generation', () => {
    expect(frameMatches(base, { generation: GEN, mediaTime: TARGET })).toBe(true);
  });

  it('accepts within, and rejects outside, the tolerance — on both sides', () => {
    const eps = 0.001;
    expect(frameMatches(base, { generation: GEN, mediaTime: TARGET + DEFAULT_FRAME_TOLERANCE_SEC - eps })).toBe(true);
    expect(frameMatches(base, { generation: GEN, mediaTime: TARGET - DEFAULT_FRAME_TOLERANCE_SEC + eps })).toBe(true);
    expect(frameMatches(base, { generation: GEN, mediaTime: TARGET + DEFAULT_FRAME_TOLERANCE_SEC + eps })).toBe(false);
    expect(frameMatches(base, { generation: GEN, mediaTime: TARGET - DEFAULT_FRAME_TOLERANCE_SEC - eps })).toBe(false);
  });

  it('rejects the RIGHT time from the WRONG generation', () => {
    // The scrub-out-and-back case: a superseded handoff's callback carrying a plausible timestamp.
    expect(frameMatches(base, { generation: GEN - 1, mediaTime: TARGET })).toBe(false);
    expect(frameMatches(base, { generation: GEN + 1, mediaTime: TARGET })).toBe(false);
  });

  it('rejects the RIGHT generation at the WRONG time (the pre-seek frame)', () => {
    expect(frameMatches(base, { generation: GEN, mediaTime: 0 })).toBe(false);
  });

  it('rejects a non-finite media time and a handoff with no request', () => {
    expect(frameMatches(base, { generation: GEN, mediaTime: Number.NaN })).toBe(false);
    expect(frameMatches({ ...base, requestedMediaTime: null }, { generation: GEN, mediaTime: TARGET })).toBe(false);
  });
});

describe('fallbackAdmissible is the audit’s three components, and only once rVFC is ruled out', () => {
  const ready: TransitionState = {
    ...INITIAL_TRANSITION_STATE,
    generation: GEN,
    requestedMediaTime: TARGET,
    seekRequested: true,
    pageVisible: true,
    readiness: { readyState: HAVE_CURRENT_DATA, seeked: true, visibleFrames: 2 },
    rvfc: { available: false, armed: false, nonArrival: false },
  };

  it('admits it when rVFC is absent and all three components are present', () => {
    expect(fallbackAdmissible(ready)).toBe(true);
  });

  it('refuses it while rVFC is available and has not been observed to stall', () => {
    expect(fallbackAdmissible({ ...ready, rvfc: { available: true, armed: true, nonArrival: false } })).toBe(false);
  });

  it('admits it once rVFC non-arrival has actually been observed', () => {
    expect(fallbackAdmissible({ ...ready, rvfc: { available: true, armed: true, nonArrival: true } })).toBe(true);
  });

  it('refuses it with any single component missing', () => {
    expect(fallbackAdmissible({ ...ready, readiness: { ...ready.readiness, seeked: false } })).toBe(false);
    expect(fallbackAdmissible({ ...ready, readiness: { ...ready.readiness, readyState: 1 } })).toBe(false);
    expect(fallbackAdmissible({ ...ready, readiness: { ...ready.readiness, visibleFrames: 1 } })).toBe(false);
    expect(fallbackAdmissible({ ...ready, pageVisible: false })).toBe(false);
  });

  it('waives `seeked` only where no seek was issued (the mid-roll exit)', () => {
    const midRoll = { ...ready, seekRequested: false, readiness: { ...ready.readiness, seeked: false } };
    expect(fallbackAdmissible(midRoll)).toBe(true);
    // …and still requires it where one was.
    expect(fallbackAdmissible({ ...midRoll, seekRequested: true })).toBe(false);
  });
});

describe('audio readiness is its own signal', () => {
  const audio = (over: Partial<TransitionState['audio']> = {}): TransitionState['audio'] => ({
    intent: 'narration-continuous', outgoingRetained: true, incomingAudible: false, blocked: false, ...over,
  });

  it('is unsatisfied until the incoming media is audible', () => {
    expect(audioPolicySatisfied(audio())).toBe(false);
    expect(audioPolicySatisfied(audio({ incomingAudible: true }))).toBe(true);
  });

  it('is never satisfied while blocked — a refused play() keeps the outgoing gain', () => {
    expect(audioPolicySatisfied(audio({ incomingAudible: true, blocked: true }))).toBe(false);
  });

  it('never releases the outgoing gain under `mixed`, which wants both sources', () => {
    expect(audioPolicySatisfied(audio({ intent: 'mixed', incomingAudible: true }))).toBe(false);
  });
});

// ── the cover, reusing the existing presentation policy ───────────────────────────────────────

describe('the cover follows the audit’s priority order, decided by presentationPolicy', () => {
  const waiting = (over: Partial<TransitionState>): TransitionState => ({
    ...INITIAL_TRANSITION_STATE, phase: 'VideoBuffering', intent: 'video', generation: GEN,
    requestedMediaTime: TARGET, ...over,
  });

  it('1. holds the outgoing simulation while its pixels are still valid', () => {
    const { cover, reason } = coverFor(waiting({ outgoing: { kind: 'sim', valid: true } }));
    expect(cover).toBe('outgoing');
    // The verdict the audit found unreachable from the player. Reaching it is the point.
    expect(reason).toBe('exit-to-video');
  });

  it('2. falls to the target poster once the outgoing pixels are gone — but only if DECODED', () => {
    const gone = { outgoing: { kind: 'none' as const, valid: false } };
    expect(coverFor(waiting({ ...gone, poster: { available: true, loaded: true } })).cover).toBe('poster');
    // An undecoded poster covers nothing, so it must not be chosen as if it did.
    expect(coverFor(waiting({ ...gone, poster: { available: true, loaded: false } })).cover).toBe('neutral');
  });

  it('3. falls to a neutral recovery cover when there is neither', () => {
    const { cover, reason } = coverFor(waiting({ outgoing: { kind: 'none', valid: false } }));
    expect(cover).toBe('neutral');
    expect(reason).toBe('exit-to-video-no-frame');
  });

  it('shows no cover once, and only once, the handoff is genuinely revealed', () => {
    expect(coverFor(waiting({ phase: 'CrossFading' })).cover).toBe('none');
    expect(coverFor(waiting({ phase: 'VideoLive' })).cover).toBe('none');
    expect(coverFor(waiting({ phase: 'CoveredFailure' })).cover).not.toBe('none');
  });

  it('never uncovers merely because the outgoing pixels were invalidated mid-wait', () => {
    const s = reduceAll(INITIAL_TRANSITION_STATE, [
      exitRequested(),
      { type: 'SOURCE_ISSUED', generation: GEN },
      { type: 'OUTGOING_INVALIDATED', generation: GEN },
    ]).state;
    expect(coverFor(s).cover).toBe('neutral');
    expect(isRevealed(s.phase)).toBe(false);
  });
});

// ── the happy path, so the invariant tests cannot be vacuously green ──────────────────────────

describe('the machine does reach VideoLive when the evidence is real', () => {
  it('walks SimLive → … → VideoLive on a matching rVFC frame plus a parent paint', () => {
    let s = INITIAL_TRANSITION_STATE;
    expect(s.phase).toBe('SimLive');
    s = reduce(s, HAPPY[0]).state; expect(s.phase).toBe('VideoRequested');
    s = reduce(s, HAPPY[1]).state; expect(s.phase).toBe('VideoBuffering');
    s = reduce(s, HAPPY[2]).state; expect(s.phase).toBe('VideoDecoded');
    s = reduce(s, HAPPY[3]).state; expect(s.phase).toBe('VideoSubmitted');
    s = reduce(s, HAPPY[4]).state; expect(s.phase).toBe('CrossFading');
    s = reduce(s, HAPPY[5]).state; expect(s.phase).toBe('VideoLive');
    expect(s.evidence).toMatchObject({ kind: 'rvfc', confidence: 'high', mediaTime: TARGET, generation: GEN });
  });

  it('emits COMMIT_REVEAL exactly once, and only from the parent paint', () => {
    const beforePaint = reduceAll(INITIAL_TRANSITION_STATE, HAPPY.slice(0, 4));
    expect(kinds(beforePaint.effects)).not.toContain('COMMIT_REVEAL');
    const withPaint = reduce(beforePaint.state, HAPPY[4]);
    expect(kinds(withPaint.effects).filter((k) => k === 'COMMIT_REVEAL')).toHaveLength(1);
    // A second paint for the same generation must not re-commit.
    expect(kinds(reduce(withPaint.state, HAPPY[4]).effects)).not.toContain('COMMIT_REVEAL');
  });

  it('arms the frame callback only AFTER the source is issued, never on the request', () => {
    const requested = reduce(INITIAL_TRANSITION_STATE, HAPPY[0]);
    expect(kinds(requested.effects)).not.toContain('ARM_FRAME_EVIDENCE');
    expect(kinds(reduce(requested.state, HAPPY[1]).effects)).toContain('ARM_FRAME_EVIDENCE');
  });

  it('accepts a labelled fallback and marks it LOW confidence', () => {
    const s = reduceAll(INITIAL_TRANSITION_STATE, [
      exitRequested({ rvfcAvailable: false }),
      { type: 'SOURCE_ISSUED', generation: GEN },
      { type: 'MEDIA_READY', generation: GEN, readyState: 4, seeked: true },
      { type: 'VISIBLE_FRAME', generation: GEN },
      { type: 'VISIBLE_FRAME', generation: GEN },
      { type: 'FRAME_PRESENTED', generation: GEN, mediaTime: TARGET, kind: 'fallback', atMs: 30 },
      { type: 'PARENT_PAINT', generation: GEN },
    ]).state;
    expect(s.phase).toBe('CrossFading');
    expect(s.evidence).toMatchObject({ kind: 'fallback', confidence: 'low' });
  });
});

// ── THE INVARIANT, over the cartesian product ─────────────────────────────────────────────────

describe('no sequence reveals without matching evidence', () => {
  const generations = [
    { label: 'matching-generation', gen: GEN },
    { label: 'stale-generation', gen: GEN - 3 },
  ] as const;

  const evidences = [
    { label: 'rvfc-target', kind: 'rvfc' as const, mediaTime: TARGET, arrives: true },
    { label: 'rvfc-pre-seek-frame', kind: 'rvfc' as const, mediaTime: 0, arrives: true },
    { label: 'rvfc-overshoot', kind: 'rvfc' as const, mediaTime: TARGET + 5, arrives: true },
    { label: 'fallback-target', kind: 'fallback' as const, mediaTime: TARGET, arrives: true },
    { label: 'never-arrives', kind: 'rvfc' as const, mediaTime: TARGET, arrives: false },
  ];

  const visibilities = [
    { label: 'always-visible', events: [] as TransitionEvent[] },
    { label: 'hidden-then-back', events: [{ type: 'VISIBILITY', visible: false }, { type: 'VISIBILITY', visible: true }] as TransitionEvent[] },
    { label: 'hidden-and-stays', events: [{ type: 'VISIBILITY', visible: false }] as TransitionEvent[] },
  ];

  const deadlines = [
    { label: 'no-deadline', fires: false },
    { label: 'deadline-fires-first', fires: true },
  ];

  const rvfcModes = [
    { label: 'rvfc-available', available: true },
    { label: 'rvfc-absent', available: false },
  ];

  const audioIntents: AudioIntent[] = ['narration-continuous', 'simulation-exclusive', 'mixed'];

  let caseIndex = 0;
  for (const g of generations) {
    for (const e of evidences) {
      for (const vis of visibilities) {
        for (const d of deadlines) {
          for (const r of rvfcModes) {
            const audioIntent = audioIntents[caseIndex++ % audioIntents.length];
            const label = `${g.label} / ${e.label} / ${vis.label} / ${d.label} / ${r.label} / ${audioIntent}`;

            it(label, () => {
              const seq: TransitionEvent[] = [
                exitRequested({ rvfcAvailable: r.available, audioIntent }),
                { type: 'SOURCE_ISSUED', generation: g.gen },
                { type: 'MEDIA_READY', generation: g.gen, readyState: 4, seeked: true },
                { type: 'VISIBLE_FRAME', generation: g.gen },
                { type: 'VISIBLE_FRAME', generation: g.gen },
                ...vis.events,
                ...(d.fires ? [{ type: 'DEADLINE', generation: g.gen, atMs: 4_000 } as TransitionEvent] : []),
                // rVFC non-arrival is reported whether or not it is true — the reducer must not
                // treat the report itself as permission for anything.
                ...(e.arrives ? [] : [{ type: 'RVFC_NON_ARRIVAL', generation: g.gen } as TransitionEvent]),
                ...(e.arrives
                  ? [{ type: 'FRAME_PRESENTED', generation: g.gen, mediaTime: e.mediaTime, kind: e.kind, atMs: 20 } as TransitionEvent]
                  : []),
                // Both are dispatched unconditionally: the reducer, not the caller, must be what
                // refuses to act on them out of turn.
                { type: 'AUDIO_INCOMING_AUDIBLE', generation: g.gen },
                { type: 'PARENT_PAINT', generation: g.gen },
                { type: 'FADE_COMPLETE', generation: g.gen },
              ];

              const final = walk(seq, label);

              // The invariant is checked inside `walk` after every step. What remains is to pin
              // WHICH combinations are supposed to reveal, so the invariant cannot be satisfied by
              // a reducer that simply never reveals anything.
              const generationOk = g.gen === GEN;
              const timeOk = Math.abs(e.mediaTime - TARGET) <= DEFAULT_FRAME_TOLERANCE_SEC;
              const visibleAtEnd = vis.label !== 'hidden-and-stays';
              // A hide RESETS the visible-frame count, so `hidden-then-back` arrives at the frame
              // with zero counted frames and the fallback is (correctly) inadmissible.
              const visibleFramesAtEnd = vis.label === 'always-visible' ? 2 : 0;
              const admissible = e.kind === 'rvfc'
                // A genuine compositor submission is evidence whatever the page's visibility says;
                // visibility governs whether a callback is ARMED, not whether a frame that really
                // was submitted counts. See the reducer's note on FRAME_PRESENTED.
                ? true
                // The fallback is a substitute for that evidence, so it carries the full gate.
                : !r.available && visibleAtEnd && visibleFramesAtEnd >= 2;
              const shouldReveal = generationOk && e.arrives && timeOk && admissible && !d.fires;

              expect(isRevealed(final.phase), `${label}: expected revealed=${shouldReveal}`).toBe(shouldReveal);
              if (d.fires && generationOk) {
                expect(final.phase, `${label}: a deadline must select recovery`).toBe('CoveredFailure');
              }
            });
          }
        }
      }
    }
  }
});

describe('a deadline never authorises a reveal, from ANY wait state (audit §21 rule 7)', () => {
  const upTo = (n: number): TransitionEvent[] => HAPPY.slice(0, n) as TransitionEvent[];

  for (const [n, phase] of [[1, 'VideoRequested'], [2, 'VideoBuffering'], [3, 'VideoDecoded'], [4, 'VideoSubmitted']] as const) {
    it(`${phase} + DEADLINE → CoveredFailure, never revealed`, () => {
      const before = reduceAll(INITIAL_TRANSITION_STATE, upTo(n)).state;
      expect(before.phase).toBe(phase);
      const after = reduce(before, { type: 'DEADLINE', generation: GEN, atMs: 4_000 });
      expect(after.state.phase).toBe('CoveredFailure');
      expect(after.state.failure).toBe('deadline');
      expect(isRevealed(after.state.phase)).toBe(false);
      expect(revealsWithoutEvidence(after.state)).toBe(false);
      expect(kinds(after.effects)).toContain('CANCEL_FRAME_EVIDENCE');
      expect(kinds(after.effects)).not.toContain('COMMIT_REVEAL');
    });
  }

  it('holds the cover even when the deadline arrives with evidence already accepted', () => {
    // VideoSubmitted has PROVEN pixels but no parent paint yet. The deadline still may not commit:
    // "timeout" is not one of the two things that authorise a reveal.
    const submitted = reduceAll(INITIAL_TRANSITION_STATE, upTo(4)).state;
    expect(submitted.evidence).not.toBeNull();
    const timedOut = reduce(submitted, { type: 'DEADLINE', generation: GEN, atMs: 4_000 });
    expect(kinds(timedOut.effects)).not.toContain('COMMIT_REVEAL');
    expect(coverFor(timedOut.state).cover).not.toBe('none');
  });

  it('a late matching frame does not un-fail a covered failure — only a retry does', () => {
    const failed = reduce(reduceAll(INITIAL_TRANSITION_STATE, upTo(2)).state,
      { type: 'DEADLINE', generation: GEN, atMs: 4_000 }).state;
    const late = reduceAll(failed, [
      { type: 'FRAME_PRESENTED', generation: GEN, mediaTime: TARGET, kind: 'rvfc', atMs: 5_000 },
      { type: 'PARENT_PAINT', generation: GEN },
    ]).state;
    expect(late.phase).toBe('CoveredFailure');

    const retried = reduce(late, { type: 'RETRY', generation: GEN + 1 });
    expect(retried.state.phase).toBe('VideoRequested');
    expect(retried.state.evidence, 'a retry discards the old generation’s evidence').toBeNull();
    expect(retried.state.failure).toBeNull();
  });

  it('a fatal media error is a covered failure too, and cancels the callback', () => {
    const buffering = reduceAll(INITIAL_TRANSITION_STATE, upTo(2)).state;
    const fatal = reduce(buffering, { type: 'FATAL', generation: GEN, reason: 'fatal-media-error' });
    expect(fatal.state.phase).toBe('CoveredFailure');
    expect(fatal.state.failure).toBe('fatal-media-error');
    expect(kinds(fatal.effects)).toContain('CANCEL_FRAME_EVIDENCE');
  });
});

// ── generation discipline ─────────────────────────────────────────────────────────────────────

describe('generation is what makes every in-flight callback safe', () => {
  it('ignores a stale frame and keeps looking', () => {
    const buffering = reduceAll(INITIAL_TRANSITION_STATE, HAPPY.slice(0, 3)).state;
    const stale = reduce(buffering, { type: 'FRAME_PRESENTED', generation: GEN - 1, mediaTime: TARGET, kind: 'rvfc', atMs: 5 });
    expect(stale.state.phase).toBe('VideoDecoded');
    expect(stale.state.evidence).toBeNull();
    expect(stale.state.rejected.staleGeneration).toBe(1);
  });

  it('re-arms after rejecting a frame at the WRONG media time (the pre-seek frame)', () => {
    const buffering = reduceAll(INITIAL_TRANSITION_STATE, HAPPY.slice(0, 3)).state;
    const wrong = reduce(buffering, { type: 'FRAME_PRESENTED', generation: GEN, mediaTime: 0, kind: 'rvfc', atMs: 5 });
    expect(wrong.state.evidence).toBeNull();
    expect(wrong.state.rejected.wrongMediaTime).toBe(1);
    expect(kinds(wrong.effects), 'a rejected frame must not end the search').toContain('ARM_FRAME_EVIDENCE');
    // …and the NEXT, correct frame is still accepted.
    const right = reduce(wrong.state, { type: 'FRAME_PRESENTED', generation: GEN, mediaTime: TARGET, kind: 'rvfc', atMs: 30 });
    expect(right.state.phase).toBe('VideoSubmitted');
  });

  it('does NOT re-arm after a stale frame — that generation owns nothing', () => {
    const buffering = reduceAll(INITIAL_TRANSITION_STATE, HAPPY.slice(0, 3)).state;
    const stale = reduce(buffering, { type: 'FRAME_PRESENTED', generation: GEN - 1, mediaTime: TARGET, kind: 'rvfc', atMs: 5 });
    expect(kinds(stale.effects)).not.toContain('ARM_FRAME_EVIDENCE');
  });

  it('a cancel returns to SimLive and makes every later event of that generation inert', () => {
    const buffering = reduceAll(INITIAL_TRANSITION_STATE, HAPPY.slice(0, 3)).state;
    const cancelled = reduce(buffering, { type: 'CANCEL', generation: GEN + 1 });
    expect(cancelled.state.phase).toBe('SimLive');
    expect(cancelled.state.intent).toBe('sim');
    expect(kinds(cancelled.effects)).toContain('CANCEL_FRAME_EVIDENCE');

    // The audit's specific worry: "a callback arriving after cancel".
    const after = reduceAll(cancelled.state, [
      { type: 'FRAME_PRESENTED', generation: GEN, mediaTime: TARGET, kind: 'rvfc', atMs: 60 },
      { type: 'PARENT_PAINT', generation: GEN },
      { type: 'FADE_COMPLETE', generation: GEN },
    ]);
    expect(after.state.phase).toBe('SimLive');
    expect(isRevealed(after.state.phase)).toBe(false);
    expect(kinds(after.effects)).not.toContain('COMMIT_REVEAL');
  });

  it('a retry’s generation cannot be satisfied by the previous generation’s frame', () => {
    const failed = reduce(reduceAll(INITIAL_TRANSITION_STATE, HAPPY.slice(0, 2)).state,
      { type: 'DEADLINE', generation: GEN, atMs: 4_000 }).state;
    const retried = reduceAll(reduce(failed, { type: 'RETRY', generation: GEN + 1 }).state, [
      { type: 'SOURCE_ISSUED', generation: GEN + 1 },
      { type: 'FRAME_PRESENTED', generation: GEN, mediaTime: TARGET, kind: 'rvfc', atMs: 100 },
      { type: 'PARENT_PAINT', generation: GEN + 1 },
    ]);
    expect(isRevealed(retried.state.phase)).toBe(false);
    expect(retried.state.rejected.staleGeneration).toBeGreaterThan(0);
  });
});

// ── visibility ────────────────────────────────────────────────────────────────────────────────

describe('visibility cancels and re-arms, and never advances the handoff', () => {
  const buffering = () => reduceAll(INITIAL_TRANSITION_STATE, HAPPY.slice(0, 3)).state;

  it('cancels the callback and resets the visible-frame count when the page hides', () => {
    const counted = reduceAll(buffering(), [
      { type: 'VISIBLE_FRAME', generation: GEN }, { type: 'VISIBLE_FRAME', generation: GEN },
    ]).state;
    expect(counted.readiness.visibleFrames).toBe(2);

    const hidden = reduce(counted, { type: 'VISIBILITY', visible: false });
    expect(kinds(hidden.effects)).toContain('CANCEL_FRAME_EVIDENCE');
    expect(hidden.state.rvfc.armed).toBe(false);
    expect(hidden.state.readiness.visibleFrames, 'frames counted before a hide prove nothing now').toBe(0);
    expect(hidden.state.phase, 'hiding must not advance the machine').toBe('VideoDecoded');
  });

  it('re-arms on return, and does not count frames while hidden', () => {
    const hidden = reduce(buffering(), { type: 'VISIBILITY', visible: false }).state;
    const ignored = reduce(hidden, { type: 'VISIBLE_FRAME', generation: GEN });
    expect(ignored.state.readiness.visibleFrames).toBe(0);

    const back = reduce(hidden, { type: 'VISIBILITY', visible: true });
    expect(kinds(back.effects)).toContain('ARM_FRAME_EVIDENCE');
    expect(back.state.rvfc.armed).toBe(true);
  });

  it('does not arm at all when the source is issued on a hidden page', () => {
    const requested = reduce(INITIAL_TRANSITION_STATE, exitRequested({ pageVisible: false }));
    const issued = reduce(requested.state, { type: 'SOURCE_ISSUED', generation: GEN });
    expect(kinds(issued.effects)).not.toContain('ARM_FRAME_EVIDENCE');
    expect(issued.state.rvfc.armed).toBe(false);
  });

  it('refuses the fallback while hidden, however ready the element claims to be', () => {
    const hidden = reduceAll(INITIAL_TRANSITION_STATE, [
      exitRequested({ rvfcAvailable: false }),
      { type: 'SOURCE_ISSUED', generation: GEN },
      { type: 'MEDIA_READY', generation: GEN, readyState: 4, seeked: true },
      { type: 'VISIBLE_FRAME', generation: GEN }, { type: 'VISIBLE_FRAME', generation: GEN },
      { type: 'VISIBILITY', visible: false },
      { type: 'FRAME_PRESENTED', generation: GEN, mediaTime: TARGET, kind: 'fallback', atMs: 50 },
      { type: 'PARENT_PAINT', generation: GEN },
    ]).state;
    expect(isRevealed(hidden.phase)).toBe(false);
    expect(hidden.rejected.inadmissibleFallback).toBeGreaterThan(0);
  });

  it('still accepts a REAL compositor submission that arrives while hidden', () => {
    // Deliberate, and the asymmetry with the fallback below it is the point. Arming is what
    // visibility governs; a callback that actually fired is a frame that actually reached the
    // compositor. Refusing it would leave a viewer who tabbed away mid-handoff behind the cover
    // until the deadline, and then show them a retry for a seek that already succeeded.
    const hidden = reduce(reduceAll(INITIAL_TRANSITION_STATE, HAPPY.slice(0, 3)).state,
      { type: 'VISIBILITY', visible: false }).state;
    const proven = reduceAll(hidden, [
      { type: 'FRAME_PRESENTED', generation: GEN, mediaTime: TARGET, kind: 'rvfc', atMs: 40 },
      { type: 'PARENT_PAINT', generation: GEN },
    ]).state;
    expect(proven.phase).toBe('CrossFading');
    expect(revealsWithoutEvidence(proven)).toBe(false);
  });

  it('does not re-arm on return once the handoff has already been revealed', () => {
    const live = reduceAll(INITIAL_TRANSITION_STATE, HAPPY).state;
    const cycled = reduceAll(live, [{ type: 'VISIBILITY', visible: false }, { type: 'VISIBILITY', visible: true }]);
    expect(kinds(cycled.effects)).not.toContain('ARM_FRAME_EVIDENCE');
    expect(cycled.state.phase).toBe('VideoLive');
  });

  it('asks for a RETRY when the page returns to a covered failure — the one state that cannot re-arm', () => {
    // THE WEDGE. Hiding cancels evidence and disarms rVFC, and neither rVFC nor rAF runs hidden, so
    // the deadline fires with nothing to show and lands in `CoveredFailure`. That phase is not in
    // WAIT_PHASES — deliberately, so no stale callback can revive a failed handoff — which means
    // the re-arm above cannot reach it and nothing else ever would: `COMMIT_REVEAL` never runs, the
    // caller's uncover never runs, and the frozen simulation stays at full opacity over a playing,
    // audible video until the viewer finds the "Go back to video" button.
    const hidden = reduce(buffering(), { type: 'VISIBILITY', visible: false }).state;
    const failed = reduce(hidden, { type: 'DEADLINE', generation: GEN, atMs: 4_000 }).state;
    expect(failed.phase, 'the hidden deadline did not fail — this proves nothing').toBe('CoveredFailure');

    const back = reduce(failed, { type: 'VISIBILITY', visible: true });
    expect(kinds(back.effects), 'a covered failure could not be reconsidered on return').toContain('REQUEST_RETRY');
    // AND IT IS NOT A REVEAL (audit §21 rule 7). Coming back into view proves nothing about the
    // frame; the retry the wiring issues has to prove its own, from `VideoRequested`.
    expect(kinds(back.effects)).not.toContain('COMMIT_REVEAL');
    expect(back.state.phase, 'visibility advanced the machine on its own').toBe('CoveredFailure');
    expect(isRevealed(back.state.phase)).toBe(false);
    expect(revealsWithoutEvidence(back.state)).toBe(false);
    expect(coverFor(back.state).cover, 'the cover was dropped by a visibility change').not.toBe('none');
  });

  it('asks only on a genuine hidden→visible edge, and never while the handoff is merely waiting', () => {
    // A repeated `visible: true` is dropped at the top of the case, so a page that was never hidden
    // cannot produce a retry request — the request means "the condition that failed this handoff
    // has changed", and if nothing changed, nothing has.
    const failedVisible = reduce(buffering(), { type: 'DEADLINE', generation: GEN, atMs: 4_000 }).state;
    expect(kinds(reduce(failedVisible, { type: 'VISIBILITY', visible: true }).effects))
      .not.toContain('REQUEST_RETRY');

    // And a wait phase re-arms as it always did, rather than asking for a whole new handoff.
    const waiting = reduce(buffering(), { type: 'VISIBILITY', visible: false }).state;
    const backToWaiting = reduce(waiting, { type: 'VISIBILITY', visible: true });
    expect(kinds(backToWaiting.effects)).toContain('ARM_FRAME_EVIDENCE');
    expect(kinds(backToWaiting.effects)).not.toContain('REQUEST_RETRY');
  });
});

// ── audio ─────────────────────────────────────────────────────────────────────────────────────

describe('the outgoing gain is retained until the incoming media satisfies the policy', () => {
  it('retains it from T0 and releases it only on audible incoming media', () => {
    const requested = reduce(INITIAL_TRANSITION_STATE, exitRequested()).state;
    expect(requested.audio.outgoingRetained, 'the package keeps its gain at T0').toBe(true);

    const decoded = reduceAll(requested, HAPPY.slice(1, 4) as TransitionEvent[]);
    expect(decoded.state.audio.outgoingRetained, 'decoded PIXELS must not release audio').toBe(true);
    expect(kinds(decoded.effects)).not.toContain('RELEASE_OUTGOING_AUDIO');

    const audible = reduce(decoded.state, { type: 'AUDIO_INCOMING_AUDIBLE', generation: GEN });
    expect(audible.state.audio.outgoingRetained).toBe(false);
    expect(kinds(audible.effects)).toContain('RELEASE_OUTGOING_AUDIO');
  });

  it('keeps the gain, and never fails visually, when play() is refused', () => {
    const decoded = reduceAll(INITIAL_TRANSITION_STATE, HAPPY.slice(0, 4)).state;
    const blocked = reduce(decoded, { type: 'AUDIO_BLOCKED', generation: GEN });
    expect(blocked.state.audio.blocked).toBe(true);
    expect(blocked.state.audio.outgoingRetained).toBe(true);
    expect(blocked.state.phase, 'a blocked AudioContext is not a visual failure').toBe('VideoSubmitted');
    // …and a later "audible" claim must not release it while still blocked.
    const claimed = reduce(blocked.state, { type: 'AUDIO_INCOMING_AUDIBLE', generation: GEN });
    expect(kinds(claimed.effects)).not.toContain('RELEASE_OUTGOING_AUDIO');
    expect(claimed.state.audio.outgoingRetained).toBe(true);
  });

  it('under `mixed`, both sources keep sounding — the coordinator never chooses silence', () => {
    const s = reduceAll(INITIAL_TRANSITION_STATE, [
      exitRequested({ audioIntent: 'mixed' }),
      { type: 'SOURCE_ISSUED', generation: GEN },
      { type: 'AUDIO_INCOMING_AUDIBLE', generation: GEN },
    ]);
    expect(kinds(s.effects)).not.toContain('RELEASE_OUTGOING_AUDIO');
    expect(s.state.audio.outgoingRetained).toBe(true);
  });

  it('the audio switch is not reachable from frame evidence alone', () => {
    const proven = reduceAll(INITIAL_TRANSITION_STATE, HAPPY);
    expect(proven.state.phase).toBe('VideoLive');
    expect(kinds(proven.effects), 'pixels released the gain').not.toContain('RELEASE_OUTGOING_AUDIO');
    expect(proven.state.audio.outgoingRetained).toBe(true);
  });
});
