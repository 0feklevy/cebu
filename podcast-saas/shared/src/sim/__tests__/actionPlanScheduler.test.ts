/**
 * The action-plan scheduler, driven entirely by a FAKE clock.
 *
 * ADR §6.5 requires the scheduler to be proven against one: pause, resume, rate, restart-on-seek,
 * adapter seek both directions. Nothing here sleeps, so nothing here is timing-dependent — the
 * clock only moves when a test moves it, and every timer fires only when a test fires it.
 *
 * The fake clock also makes the invariant that matters observable: `armedCount()` counts every
 * timer ever created, so "one handle, ever" is an assertion rather than a claim in a comment.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ActionPlanScheduler,
  SLEW_MAX_MS,
  type ClockRejectReason,
  type DiscontinuityKind,
  type SchedulerMode,
  type SchedulerStep,
  type TimelineClockSyncV1,
} from '../actionPlanScheduler.js';

/** A clock and timer queue a test fully controls. */
class FakeClock {
  private t = 1000;                       // deliberately not 0, so an absolute/relative mix-up shows
  private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.t;

  setTimer = (delayMs: number, fn: () => void): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.t + delayMs, fn });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Outstanding timers. The scheduler must never have more than one. */
  pending(): number {
    return this.timers.size;
  }

  /** Advance wall time, firing every timer that comes due, in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let soonest: number | null = null;
      for (const [id, tm] of this.timers) {
        if (tm.at <= end && (soonest === null || tm.at < this.timers.get(soonest)!.at)) soonest = id;
      }
      if (soonest === null) break;
      const tm = this.timers.get(soonest)!;
      this.timers.delete(soonest);
      this.t = tm.at;
      tm.fn();
    }
    this.t = end;
  }
}

const STEPS: SchedulerStep[] = [
  { atMs: 0, index: 0 },
  { atMs: 1000, index: 1 },
  { atMs: 2000, index: 2 },
  { atMs: 3000, index: 3 },
];
const DURATION = 4000;

interface Harness {
  clock: FakeClock;
  sched: ActionPlanScheduler;
  drained: number[];
  discontinuities: Array<{ kind: DiscontinuityKind; toMs: number; epoch: number }>;
  rejects: ClockRejectReason[];
  seq: number;
  /** Send a sync, defaulting everything a test does not care about. */
  sync(p: Partial<TimelineClockSyncV1>): void;
}

function harness(mode: SchedulerMode = 'entry-relative', steps = STEPS): Harness {
  const clock = new FakeClock();
  const h: Harness = {
    clock,
    drained: [],
    discontinuities: [],
    rejects: [],
    seq: 0,
    sched: null as unknown as ActionPlanScheduler,
    sync: () => {},
  };
  h.sched = new ActionPlanScheduler(
    { mode, durationMs: DURATION, steps },
    { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    {
      drain: (idx) => h.drained.push(...idx),
      discontinuity: (kind, toMs, epoch) => h.discontinuities.push({ kind, toMs, epoch }),
      rejected: (reason) => h.rejects.push(reason),
    },
  );
  h.sync = (p) => h.sched.applySync({
    epoch: 1,
    seq: ++h.seq,
    sectionOffsetMs: 0,
    activationOriginOffsetMs: 0,
    running: true,
    playbackRate: 1,
    ...p,
  });
  return h;
}

let h: Harness;
beforeEach(() => { h = harness(); });

// ── The invariant the whole design rests on ──────────────────────────────────

describe('one handle, ever', () => {
  it('never has more than one timer outstanding, across a full playthrough', () => {
    h.sync({ sectionOffsetMs: 0 });
    expect(h.clock.pending()).toBeLessThanOrEqual(1);
    for (let i = 0; i < 8; i++) {
      h.clock.advance(500);
      expect(h.clock.pending(), 'a second handle appeared').toBeLessThanOrEqual(1);
    }
    expect(h.drained).toEqual([0, 1, 2, 3]);
  });

  it('arms one timer per step, not one per event up front', () => {
    h.sync({ sectionOffsetMs: 0 });
    // Step 0 is due immediately, so the first arm targets step 1.
    const afterFirst = h.sched.armedCount();
    expect(afterFirst).toBe(1);
    h.clock.advance(3200);
    // Three more steps, three more arms — and the last arm is skipped once the list is exhausted.
    expect(h.sched.armedCount()).toBe(3);
    expect(h.sched.isArmed()).toBe(false);
  });
});

// ── Pause and resume ─────────────────────────────────────────────────────────

describe('pause and resume', () => {
  it('pause cancels the handle without advancing logical time', () => {
    h.sync({ sectionOffsetMs: 0 });
    h.clock.advance(400);
    h.sync({ sectionOffsetMs: 400 });
    expect(h.sched.position()).toBe(400);

    h.sync({ sectionOffsetMs: 400, running: false });
    expect(h.clock.pending(), 'a paused scheduler holds no timer').toBe(0);

    // Five seconds of wall time pass. Logical time must not move — the whole recording would
    // otherwise complete while the video sat still.
    h.clock.advance(5000);
    expect(h.sched.position()).toBe(400);
    expect(h.drained).toEqual([0]);
  });

  it('resume arms the REMAINING delay, not the whole one', () => {
    h.sync({ sectionOffsetMs: 0 });
    h.clock.advance(900);                         // 100ms short of step 1
    h.sync({ sectionOffsetMs: 900, running: false });
    h.clock.advance(10_000);                      // long pause
    h.sync({ sectionOffsetMs: 900, running: true });

    expect(h.drained).toEqual([0]);
    // If resume re-armed the ORIGINAL 1000ms — the bug `pauseScript` has today — nothing fires
    // here. The remaining delay is 100ms.
    h.clock.advance(120);
    expect(h.drained).toEqual([0, 1]);
  });
});

// ── Playback rate ────────────────────────────────────────────────────────────

describe('playback rate', () => {
  it('double speed halves the wall time to the next step', () => {
    h.sync({ sectionOffsetMs: 0, playbackRate: 2 });
    expect(h.drained).toEqual([0]);
    h.clock.advance(400);                          // 800ms of logical time
    expect(h.drained).toEqual([0]);
    h.clock.advance(120);                          // past 1000ms logical
    expect(h.drained).toEqual([0, 1]);
  });

  it('half speed doubles it', () => {
    h.sync({ sectionOffsetMs: 0, playbackRate: 0.5 });
    h.clock.advance(1500);                         // only 750ms logical
    expect(h.drained).toEqual([0]);
    h.clock.advance(600);                          // past 1000ms logical
    expect(h.drained).toEqual([0, 1]);
  });

  it('a rate outside policy is REFUSED, not clamped', () => {
    h.sync({ sectionOffsetMs: 0, playbackRate: 1000 });
    expect(h.rejects).toEqual(['rate-out-of-policy']);
    // And nothing moved: a refused sync must not be half-applied.
    expect(h.drained).toEqual([]);
    expect(h.sched.isArmed()).toBe(false);
  });
});

// ── Seek ─────────────────────────────────────────────────────────────────────

describe('seek — entry-relative RESTARTS', () => {
  it('a new epoch resets the cursor to zero and asks the parent for a fresh document', () => {
    h.sync({ sectionOffsetMs: 0 });
    h.clock.advance(2200);
    expect(h.drained).toEqual([0, 1, 2]);

    h.sched.applySync({
      epoch: 2, seq: 1, sectionOffsetMs: 2500, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });

    expect(h.discontinuities).toEqual([{ kind: 'restart', toMs: 0, epoch: 2 }]);
    expect(h.sched.cursorIndex(), 'the cursor went back to the start').toBe(0);
    // Nothing is armed: the activation is over until the parent brings a pristine document and
    // sends a new epoch. Arming here would drive a document that is about to be discarded.
    expect(h.clock.pending()).toBe(0);
  });

  it('after the restart, a fresh activation replays from zero', () => {
    h.sync({ sectionOffsetMs: 0 });
    h.clock.advance(2200);
    h.drained.length = 0;

    h.sched.applySync({
      epoch: 2, seq: 1, sectionOffsetMs: 0, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });
    h.sched.applySync({
      epoch: 2, seq: 2, sectionOffsetMs: 0, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });
    h.clock.advance(3200);
    expect(h.drained).toEqual([0, 1, 2, 3]);
  });
});

describe('seek — section-synchronous defers to the adapter, both directions', () => {
  it('seeking FORWARD skips the passed steps instead of replaying them', () => {
    const s = harness('section-synchronous');
    s.sync({ sectionOffsetMs: 0 });
    expect(s.drained).toEqual([0]);

    s.sched.applySync({
      epoch: 2, seq: 1, sectionOffsetMs: 2500, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });

    expect(s.discontinuities.at(-1)).toEqual({ kind: 'adapter-seek', toMs: 2500, epoch: 2 });
    // Steps 1 and 2 are BEHIND the seek target. They are not drained — reproducing the inputs is
    // exactly what an adapter seek exists to avoid. The adapter owns that state now.
    expect(s.drained).toEqual([0]);
    expect(s.sched.cursorIndex()).toBe(3);

    s.clock.advance(600);
    expect(s.drained).toEqual([0, 3]);
  });

  it('seeking BACKWARD rewinds the cursor — the adapter restores, the scheduler replays from there', () => {
    const s = harness('section-synchronous');
    s.sync({ sectionOffsetMs: 0 });
    s.clock.advance(2200);
    expect(s.drained).toEqual([0, 1, 2]);

    s.sched.applySync({
      epoch: 2, seq: 1, sectionOffsetMs: 500, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });

    expect(s.discontinuities.at(-1)).toEqual({ kind: 'adapter-seek', toMs: 500, epoch: 2 });
    // Only step 0 is at or before 500ms, so the cursor lands on step 1 and playback continues
    // from there. A backward seek is legal ONLY because it carried a new epoch.
    expect(s.sched.cursorIndex()).toBe(1);
    s.clock.advance(600);
    expect(s.drained).toEqual([0, 1, 2, 1]);
  });
});

// ── Staleness ────────────────────────────────────────────────────────────────

describe('stale and out-of-order syncs', () => {
  it('a sync from a superseded epoch is refused', () => {
    h.sync({ sectionOffsetMs: 0 });
    h.sched.applySync({
      epoch: 5, seq: 1, sectionOffsetMs: 0, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });
    h.sched.applySync({
      epoch: 1, seq: 99, sectionOffsetMs: 3000, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });
    expect(h.rejects).toEqual(['stale-epoch']);
  });

  it('a repeated or older seq within an epoch is refused, so no action fires twice', () => {
    h.sync({ sectionOffsetMs: 0 });
    const at = h.seq;
    h.sched.applySync({
      epoch: 1, seq: at, sectionOffsetMs: 1500, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });
    expect(h.rejects).toEqual(['stale-seq']);
    expect(h.drained).toEqual([0]);
  });

  it('a timer that outlives its epoch does not fire into the new one', () => {
    h.sync({ sectionOffsetMs: 0 });                 // arms for step 1 at +1000ms
    h.sched.applySync({                             // supersede before it fires
      epoch: 2, seq: 1, sectionOffsetMs: 0, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });
    h.drained.length = 0;
    h.clock.advance(5000);
    // Under entry-relative the new epoch is a restart and nothing is armed, so the ONLY way an
    // index could appear here is a stale handle surviving. It must not.
    expect(h.drained).toEqual([]);
  });

  it('the epoch guard holds even when clearTimeout comes too late to help', () => {
    // WHY A SEPARATE, LEAKY CLOCK. The test above passes for the wrong reason: `cancel()` removes
    // the handle from the fake queue, so the guard inside the callback is never reached. Proven by
    // mutation on 2026-08-25 — deleting `armedEpoch !== this.epoch` left all 23 tests green.
    //
    // The browser is not that tidy. A timer whose deadline has passed is already queued as a task,
    // and `clearTimeout` at that point does not un-queue it: the callback still runs. That is the
    // exact shape of every wrong-frame incident in this pipeline's history — a message true about
    // a past state, applied to the present — so the guard has to be the thing that stops it, not
    // the cancellation. This clock reproduces it by making `clearTimer` a no-op.
    const leaky = new FakeClock();
    const drained: number[] = [];
    const sched = new ActionPlanScheduler(
      { mode: 'entry-relative', durationMs: DURATION, steps: STEPS },
      { now: leaky.now, setTimer: leaky.setTimer, clearTimer: () => { /* too late */ } },
      { drain: (idx) => drained.push(...idx), discontinuity: () => {}, rejected: () => {} },
    );

    sched.applySync({
      epoch: 1, seq: 1, sectionOffsetMs: 0, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });
    expect(drained).toEqual([0]);

    sched.applySync({                               // supersede; the old handle survives
      epoch: 2, seq: 1, sectionOffsetMs: 0, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });
    drained.length = 0;

    leaky.advance(5000);
    expect(drained, 'a superseded activation applied its action to the present').toEqual([]);
  });

  it('a non-finite or non-integer field is refused before anything is applied', () => {
    h.sync({ sectionOffsetMs: 0 });
    h.sched.applySync({
      epoch: 1, seq: 50, sectionOffsetMs: Number.NaN, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });
    h.sched.applySync({
      epoch: 1.5, seq: 51, sectionOffsetMs: 0, activationOriginOffsetMs: 0,
      running: true, playbackRate: 1,
    });
    expect(h.rejects).toEqual(['non-finite', 'non-finite']);
  });
});

// ── Drift ────────────────────────────────────────────────────────────────────

describe('drift', () => {
  it('a small disagreement is absorbed — no discontinuity, no replay', () => {
    h.sync({ sectionOffsetMs: 0 });
    h.clock.advance(500);
    h.sync({ sectionOffsetMs: 500 + (SLEW_MAX_MS - 20) });   // parent says we are slightly ahead
    expect(h.discontinuities).toEqual([]);
    expect(h.drained).toEqual([0]);
  });

  it('a large FORWARD correction snaps once and drains what became due', () => {
    h.sync({ sectionOffsetMs: 0 });
    h.clock.advance(100);
    h.sync({ sectionOffsetMs: 2400 });                        // a stall, then a catch-up
    expect(h.discontinuities.map((d) => d.kind)).toEqual(['snap']);
    // Steps 1 and 2 are now behind us. They are applied ONCE, in order — not replayed with their
    // original spacing, and not skipped.
    expect(h.drained).toEqual([0, 1, 2]);
  });

  it('a large BACKWARD correction inside one epoch is refused, not obeyed', () => {
    h.sync({ sectionOffsetMs: 0 });
    h.clock.advance(2200);
    expect(h.drained).toEqual([0, 1, 2]);
    h.sync({ sectionOffsetMs: 200 });                         // backwards, same epoch
    expect(h.rejects).toEqual(['backward-within-epoch']);
    // The cursor did NOT rewind, so steps 1 and 2 cannot fire a second time.
    expect(h.sched.cursorIndex()).toBe(3);
    expect(h.drained).toEqual([0, 1, 2]);
  });
});

// ── Bounds and lifecycle ─────────────────────────────────────────────────────

describe('bounds and lifecycle', () => {
  it('logical position is clamped to the recording, not the section', () => {
    h.sync({ sectionOffsetMs: 99_000 });
    expect(h.sched.position()).toBe(DURATION);
    expect(h.drained).toEqual([0, 1, 2, 3]);
  });

  it('entry-relative subtracts the activation origin; section-synchronous does not', () => {
    h.sync({ sectionOffsetMs: 5000, activationOriginOffsetMs: 4000 });
    expect(h.sched.position()).toBe(1000);

    const s = harness('section-synchronous');
    s.sync({ sectionOffsetMs: 5000, activationOriginOffsetMs: 4000 });
    expect(s.sched.position()).toBe(DURATION);   // 5000 clamped — the origin is ignored
  });

  it('dispose releases the handle and stops accepting syncs', () => {
    h.sync({ sectionOffsetMs: 0 });
    expect(h.clock.pending()).toBe(1);
    h.sched.dispose();
    expect(h.clock.pending()).toBe(0);
    h.drained.length = 0;
    h.sync({ sectionOffsetMs: 3000 });
    h.clock.advance(5000);
    expect(h.drained).toEqual([]);
  });

  it('an empty plan arms nothing', () => {
    const e = harness('entry-relative', []);
    e.sync({ sectionOffsetMs: 0 });
    expect(e.clock.pending()).toBe(0);
    expect(e.drained).toEqual([]);
  });

  it('unsorted steps are rejected at construction rather than misfiring at runtime', () => {
    expect(() => harness('entry-relative', [{ atMs: 100, index: 0 }, { atMs: 50, index: 1 }]))
      .toThrow(/sorted ascending/);
  });
});
