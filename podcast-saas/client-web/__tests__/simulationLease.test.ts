/**
 * Page-wide simulation lease (P1.1c) — the broker itself, plus the pure fire-time/release-time
 * decisions the two surfaces defer to. The broker is a module singleton, so every test resets it.
 *
 * The unmount auto-release case uses @testing-library/react's renderHook: the contract is
 * "release lives in a React effect cleanup", and only a real unmount proves that wiring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEffect } from 'react';
import {
  acquireSimulationLease,
  simulationLeaseAllows,
  subscribeSimulationLease,
  heldSimulationLeases,
  leaseAllows,
  shouldFirePickerActivation,
  timelineActionOnLeaseFree,
  __resetSimulationLeaseForTests,
  type SimLeasePriority,
} from '../lib/sim/simulationLease';

beforeEach(() => __resetSimulationLeaseForTests());
afterEach(() => {
  __resetSimulationLeaseForTests();
  vi.restoreAllMocks();
});

describe('priority ordering', () => {
  it('an empty broker allows every priority', () => {
    expect(simulationLeaseAllows('preview-visible')).toBe(true);
    expect(simulationLeaseAllows('timeline-visible')).toBe(true);
    expect(simulationLeaseAllows('warm')).toBe(true);
  });

  it('preview-visible blocks timeline-visible and warm, never a peer', () => {
    acquireSimulationLease({ id: 'preview', priority: 'preview-visible' });
    expect(simulationLeaseAllows('timeline-visible')).toBe(false);
    expect(simulationLeaseAllows('warm')).toBe(false);
    // Equal ranks never block each other — the highest priority always may run.
    expect(simulationLeaseAllows('preview-visible')).toBe(true);
  });

  it('timeline-visible blocks only warm', () => {
    acquireSimulationLease({ id: 'timeline', priority: 'timeline-visible' });
    expect(simulationLeaseAllows('preview-visible')).toBe(true);
    expect(simulationLeaseAllows('timeline-visible')).toBe(true);
    expect(simulationLeaseAllows('warm')).toBe(false);
  });

  it('release restores exactly the priorities the released lease was blocking', () => {
    const preview = acquireSimulationLease({ id: 'preview', priority: 'preview-visible' });
    acquireSimulationLease({ id: 'timeline', priority: 'timeline-visible' });
    expect(simulationLeaseAllows('timeline-visible')).toBe(false);
    expect(simulationLeaseAllows('warm')).toBe(false);

    preview.release();
    expect(simulationLeaseAllows('timeline-visible')).toBe(true);
    expect(simulationLeaseAllows('warm')).toBe(false);   // the timeline lease still outranks warm
  });

  it('leaseAllows (pure form) matches the broker rule', () => {
    const held: SimLeasePriority[] = ['timeline-visible'];
    expect(leaseAllows(held, 'preview-visible')).toBe(true);
    expect(leaseAllows(held, 'timeline-visible')).toBe(true);
    expect(leaseAllows(held, 'warm')).toBe(false);
    expect(leaseAllows([], 'warm')).toBe(true);
    expect(leaseAllows(['preview-visible'], 'timeline-visible')).toBe(false);
  });
});

describe('block/unblock notification', () => {
  it('notifies on acquire and on release, and the listener sees the post-change state', () => {
    const observed: boolean[] = [];
    subscribeSimulationLease(() => observed.push(simulationLeaseAllows('timeline-visible')));

    const lease = acquireSimulationLease({ id: 'preview', priority: 'preview-visible' });
    lease.release();

    expect(observed).toEqual([false, true]);
  });

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSimulationLease(listener);
    acquireSimulationLease({ id: 'a', priority: 'warm' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    acquireSimulationLease({ id: 'b', priority: 'warm' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('idempotent release', () => {
  it('a second release() is a no-op: no state change, no second notification', () => {
    const listener = vi.fn();
    const lease = acquireSimulationLease({ id: 'preview', priority: 'preview-visible' });
    subscribeSimulationLease(listener);

    lease.release();
    expect(lease.released).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    lease.release();
    lease.release();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(heldSimulationLeases()).toEqual([]);
    expect(simulationLeaseAllows('warm')).toBe(true);
  });
});

describe('unmount auto-release (React cleanup wiring)', () => {
  it('a lease acquired in an effect is released by the unmount cleanup', () => {
    const { unmount } = renderHook(() => {
      useEffect(() => {
        const lease = acquireSimulationLease({ id: 'hook-owner', priority: 'preview-visible' });
        return () => lease.release();
      }, []);
    });

    expect(simulationLeaseAllows('timeline-visible')).toBe(false);
    unmount();
    expect(simulationLeaseAllows('timeline-visible')).toBe(true);
    expect(heldSimulationLeases()).toEqual([]);
  });
});

describe('double-acquire', () => {
  it('warns in dev and supersedes the stale lease instead of stacking it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = acquireSimulationLease({ id: 'preview', priority: 'preview-visible' });
    const second = acquireSimulationLease({ id: 'preview', priority: 'preview-visible' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('double-acquire');
    expect(first.released).toBe(true);            // superseded, not stacked
    expect(second.released).toBe(false);
    expect(heldSimulationLeases()).toHaveLength(1);

    // The stale handle's late release must NOT free the live lease.
    first.release();
    expect(second.released).toBe(false);
    expect(simulationLeaseAllows('timeline-visible')).toBe(false);

    second.release();
    expect(simulationLeaseAllows('timeline-visible')).toBe(true);
  });
});

// ─── pure decision helpers ───────────────────────────────────────────────────────────────────

describe('shouldFirePickerActivation (P1.1a fire-time decision)', () => {
  const base = { scheduledEpoch: 3, currentEpoch: 3, previewRunning: true, simpleUi: true };

  it('fires only when the epoch is unchanged and the live gates still hold', () => {
    expect(shouldFirePickerActivation(base)).toBe(true);
  });

  it('drops when the epoch moved (stop/reset/document change after scheduling)', () => {
    expect(shouldFirePickerActivation({ ...base, currentEpoch: 4 })).toBe(false);
  });

  it('drops when the preview is no longer running at fire time', () => {
    expect(shouldFirePickerActivation({ ...base, previewRunning: false })).toBe(false);
  });

  it('drops when Minimal UI was toggled off at fire time', () => {
    expect(shouldFirePickerActivation({ ...base, simpleUi: false })).toBe(false);
  });
});

describe('timelineActionOnLeaseFree (P1.1c release-time decision)', () => {
  it('does nothing when the timeline is not inside a sim section', () => {
    expect(timelineActionOnLeaseFree({ wantsSim: false, pendingActivation: false, ready: true }))
      .toBe('none');
    // Desire withdrawn while blocked (left the section mid-preview) must also be 'none'.
    expect(timelineActionOnLeaseFree({ wantsSim: false, pendingActivation: true, ready: true }))
      .toBe('none');
  });

  it('replays a blocked activation once the document is ready', () => {
    expect(timelineActionOnLeaseFree({ wantsSim: true, pendingActivation: true, ready: true }))
      .toBe('activate');
  });

  it('plain suspend/restore resumes the presentation it took away', () => {
    expect(timelineActionOnLeaseFree({ wantsSim: true, pendingActivation: false, ready: true }))
      .toBe('resume-presented');
  });

  it('a document suspended mid-boot resumes the boot, not the presentation', () => {
    expect(timelineActionOnLeaseFree({ wantsSim: true, pendingActivation: true, ready: false }))
      .toBe('resume-boot');
    expect(timelineActionOnLeaseFree({ wantsSim: true, pendingActivation: false, ready: false }))
      .toBe('resume-boot');
  });
});
