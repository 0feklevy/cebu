/**
 * The global ffmpeg limiter, under saturation and cancellation.
 *
 * The interesting task is the one WAITING, not the one running. A caller that attaches its abort
 * listener inside the task body cannot be interrupted while queued — and `addEventListener` on an
 * already-aborted signal never fires — so a user who pressed stop while other encodes held the slots
 * had their pass start anyway and run to completion. On the measured 2-vCPU worker that is minutes
 * of work nobody wanted, and it is invisible: the export ends up cancelled, just much later.
 *
 * The two properties that make cancellation real here are (a) the waiter leaves the queue and
 * rejects immediately, and (b) it never holds a slot, so nothing leaks and the NEXT waiter is not
 * delayed by a task that will never run. Both are asserted, and the leak assertion is the one that
 * matters: a limiter that leaks a slot degrades silently until the whole host stops encoding.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { runFfmpegLimited, ffmpegLimiterState, FfmpegTaskAborted } from '../ffmpegLimit.js';

/** A task that blocks until released, so saturation is deterministic rather than timing-dependent. */
function gate(): { task: () => Promise<string>; open: () => void; started: Promise<void> } {
  let release!: () => void;
  let markStarted!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { markStarted = r; });
  return {
    task: async () => { markStarted(); await blocked; return 'done'; },
    open: () => release(),
    started,
  };
}

/** Drain to idle so each test starts from a known state (MAX is module-level). */
beforeEach(async () => {
  for (let i = 0; i < 50 && ffmpegLimiterState().active > 0; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
});

describe('runFfmpegLimited under saturation', () => {
  it('caps concurrency and queues the rest', async () => {
    const { max } = ffmpegLimiterState();
    const gates = Array.from({ length: max }, () => gate());
    const running = gates.map((g) => runFfmpegLimited(g.task));
    await Promise.all(gates.map((g) => g.started));

    expect(ffmpegLimiterState().active).toBe(max);

    const queued = gate();
    const queuedRun = runFfmpegLimited(queued.task);
    await new Promise((r) => setTimeout(r, 5));
    expect(ffmpegLimiterState().queued).toBe(1);

    gates[0]!.open();
    await running[0];
    await queued.started;          // the slot was handed straight over
    queued.open();
    await queuedRun;
    for (const g of gates.slice(1)) g.open();
    await Promise.all(running);
    expect(ffmpegLimiterState().active).toBe(0);
  });

  it('rejects an ALREADY-cancelled task without taking a slot', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await expect(
      runFfmpegLimited(async () => { ran = true; return 1; }, controller.signal),
    ).rejects.toBeInstanceOf(FfmpegTaskAborted);
    expect(ran).toBe(false);
    expect(ffmpegLimiterState()).toMatchObject({ active: 0, queued: 0 });
  });

  it('a WAITING task cancelled mid-queue rejects at once, never starts, and leaks no slot', async () => {
    const { max } = ffmpegLimiterState();
    const holders = Array.from({ length: max }, () => gate());
    const running = holders.map((g) => runFfmpegLimited(g.task));
    await Promise.all(holders.map((g) => g.started));

    const controller = new AbortController();
    let waiterRan = false;
    const waiting = runFfmpegLimited(async () => { waiterRan = true; return 'nope'; }, controller.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(ffmpegLimiterState().queued).toBe(1);

    controller.abort();
    // Immediately — not "once a slot frees", which is what the old shape did.
    await expect(waiting).rejects.toBeInstanceOf(FfmpegTaskAborted);
    expect(waiterRan).toBe(false);
    expect(ffmpegLimiterState().queued).toBe(0);

    // The cancelled waiter must not have consumed the slot it was queued for: the next task in line
    // still gets it. A leak here would be invisible until the host stopped encoding entirely.
    const next = gate();
    const nextRun = runFfmpegLimited(next.task);
    holders[0]!.open();
    await running[0];
    await next.started;
    next.open();
    await nextRun;

    for (const g of holders.slice(1)) g.open();
    await Promise.all(running);
    expect(ffmpegLimiterState()).toMatchObject({ active: 0, queued: 0 });
  });

  it('cancelling one waiter does not delay the waiters behind it', async () => {
    const { max } = ffmpegLimiterState();
    const holders = Array.from({ length: max }, () => gate());
    const running = holders.map((g) => runFfmpegLimited(g.task));
    await Promise.all(holders.map((g) => g.started));

    const doomed = new AbortController();
    const doomedRun = runFfmpegLimited(async () => 'never', doomed.signal);
    const survivor = gate();
    const survivorRun = runFfmpegLimited(survivor.task);
    await new Promise((r) => setTimeout(r, 5));
    expect(ffmpegLimiterState().queued).toBe(2);

    doomed.abort();
    await expect(doomedRun).rejects.toBeInstanceOf(FfmpegTaskAborted);

    holders[0]!.open();
    await running[0];
    // ONE slot freed, and it went to the survivor rather than being consumed by the dead waiter.
    await survivor.started;
    survivor.open();
    await survivorRun;

    for (const g of holders.slice(1)) g.open();
    await Promise.all(running);
    expect(ffmpegLimiterState()).toMatchObject({ active: 0, queued: 0 });
  });

  it('releases the slot when the task itself throws', async () => {
    const before = ffmpegLimiterState().active;
    await expect(runFfmpegLimited(async () => { throw new Error('ffmpeg exploded'); }))
      .rejects.toThrow(/exploded/);
    expect(ffmpegLimiterState().active).toBe(before);
  });

  it('the abort error is spelled the way the export classifier recognises', () => {
    // `classifyExportFailure` keys off `name === 'AbortError'`, so a cancelled encode has to arrive
    // wearing that name or it is recorded as a failure and the user is told their render broke.
    expect(new FfmpegTaskAborted().name).toBe('AbortError');
  });
});
