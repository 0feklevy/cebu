/**
 * P1.1a — the section editor's debounced Minimal-UI picker re-apply raced its own teardown: the
 * 150ms timer captured script/params (and the gating state) at SCHEDULE time, and nothing —
 * not Stop, not a section switch, not a document change — cancelled it. Because the runtime
 * keeps ONE client across document changes, the stale timer's activate() drove the NEW document
 * with the OLD script/params.
 *
 * The fix is an activation EPOCH captured at schedule time plus fire-time reads of the live
 * state, decided by `shouldFirePickerActivation` (lib/sim/simulationLease.ts). This file drives
 * that discipline under real (fake-clock) timers through a harness component that mirrors
 * SectionEditor's wiring line for line — the same schedule guard, the same epoch capture, the
 * same fire-time ref reads, the same shared decision function. A harness because mounting the
 * 3,000-line SectionEditor needs the whole app shell (Firebase auth, the API client, SSE); the
 * decision function and the epoch discipline are the pieces under test, and SectionEditor's own
 * AST pins (transitionOrder.test.ts) keep the surface routed through the shared runtime.
 */
import { useEffect, useRef, useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldFirePickerActivation } from '../lib/sim/simulationLease';
import type { Mock } from 'vitest';

interface ActivateOpts {
  script: string;
  params: { simpleUi: boolean; autoScript: boolean; hideSelectors: string[] };
}
interface MockRuntime {
  activate: Mock<(opts: ActivateOpts) => void>;
}

/** Imperative handles the tests drive — assigned by the harness on every render. */
interface HarnessControls {
  /** Change the picker's checked set (SectionEditor: a checkbox toggle → setUiUnchecked). */
  pick(unchecked: string[]): void;
  /** SectionEditor's stopPreview: bump the epoch, then clear the run flag. */
  stop(): void;
  /** A document change (simPreviewUrl): epoch bump ONLY — run flag untouched. */
  documentChange(): void;
  /** Flip a live param between schedule and fire (proves fire-time reads). */
  setAutoScript(v: boolean): void;
}

function PickerTimerHarness({ runtime, controls }: { runtime: MockRuntime; controls: HarnessControls }) {
  const [uiUnchecked, setUiUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [previewRunning, setPreviewRunning] = useState(true);
  const [autoScript, setAutoScript] = useState(true);
  const simpleUi = true;
  const uiDirty = true;

  // ── mirrors of SectionEditor's P1.1a machinery ──────────────────────────────
  const previewEpochRef = useRef(0);
  const hide = [...uiUnchecked];
  const pickerFireStateRef = useRef({ previewRunning, simpleUi, autoScript, effectiveHideSelectors: hide as string[] | null, previewScript: 'main' });
  pickerFireStateRef.current = { previewRunning, simpleUi, autoScript, effectiveHideSelectors: hide, previewScript: 'main' };

  controls.pick = (unchecked) => setUiUnchecked(new Set(unchecked));
  controls.stop = () => { previewEpochRef.current += 1; setPreviewRunning(false); };
  controls.documentChange = () => { previewEpochRef.current += 1; };
  controls.setAutoScript = (v) => setAutoScript(v);

  useEffect(() => {
    if (!uiDirty || !previewRunning || !simpleUi) return;
    const scheduledEpoch = previewEpochRef.current;
    const timer = window.setTimeout(() => {
      const live = pickerFireStateRef.current;
      if (!shouldFirePickerActivation({
        scheduledEpoch,
        currentEpoch: previewEpochRef.current,
        previewRunning: live.previewRunning,
        simpleUi: live.simpleUi,
      })) return;
      runtime.activate({
        script: live.previewScript,
        params: { simpleUi: live.simpleUi, autoScript: live.autoScript, hideSelectors: live.effectiveHideSelectors ?? [] },
      });
    }, 150);
    return () => window.clearTimeout(timer);
    // Mirrors SectionEditor: re-fire only when the picks change; the rest is read at fire time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiUnchecked]);

  return null;
}

const makeControls = (): HarnessControls => ({
  pick: () => { throw new Error('harness not mounted'); },
  stop: () => { throw new Error('harness not mounted'); },
  documentChange: () => { throw new Error('harness not mounted'); },
  setAutoScript: () => { throw new Error('harness not mounted'); },
});

describe('debounced picker re-apply vs. preview teardown (P1.1a)', () => {
  let runtime: MockRuntime;
  let controls: HarnessControls;

  beforeEach(() => {
    vi.useFakeTimers();
    runtime = { activate: vi.fn<(opts: ActivateOpts) => void>() };
    controls = makeControls();
    render(<PickerTimerHarness runtime={runtime} controls={controls} />);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('REGRESSION: schedule → Stop within 150ms → the timer must NOT activate', () => {
    act(() => controls.pick(['#panel']));
    act(() => vi.advanceTimersByTime(100));   // inside the debounce window
    act(() => controls.stop());               // epoch bump + previewRunning=false, no reset effect runs
    act(() => vi.advanceTimersByTime(200));

    expect(runtime.activate).not.toHaveBeenCalled();
  });

  it('a document change alone (epoch bump, still running) also kills the pending timer', () => {
    act(() => controls.pick(['#panel']));
    act(() => vi.advanceTimersByTime(100));
    act(() => controls.documentChange());     // e.g. a generation replaced simulation_url
    act(() => vi.advanceTimersByTime(200));

    expect(runtime.activate).not.toHaveBeenCalled();
  });

  it('an undisturbed pick fires exactly once, with params read at FIRE time, not schedule time', () => {
    act(() => controls.pick(['#panel']));
    act(() => controls.setAutoScript(false)); // flips after scheduling, before firing
    act(() => vi.advanceTimersByTime(150));

    expect(runtime.activate).toHaveBeenCalledTimes(1);
    expect(runtime.activate).toHaveBeenCalledWith({
      script: 'main',
      params: { simpleUi: true, autoScript: false, hideSelectors: ['#panel'] },
    });
  });

  it('rapid picks debounce to a single activation carrying the LAST selection', () => {
    act(() => controls.pick(['#a']));
    act(() => vi.advanceTimersByTime(100));
    act(() => controls.pick(['#a', '#b']));   // re-schedules; cleanup cleared the first timer
    act(() => vi.advanceTimersByTime(100));
    act(() => controls.pick([]));             // every control re-checked → empty CLEAR list
    act(() => vi.advanceTimersByTime(150));

    expect(runtime.activate).toHaveBeenCalledTimes(1);
    // hideSelectors must be PRESENT and empty — the meaningful "clear every hide" instruction.
    expect(runtime.activate).toHaveBeenCalledWith({
      script: 'main',
      params: { simpleUi: true, autoScript: true, hideSelectors: [] },
    });
  });

  it('stopping and never rescheduling leaves the runtime untouched forever', () => {
    act(() => controls.pick(['#a']));
    act(() => controls.stop());
    act(() => vi.advanceTimersByTime(10_000));
    expect(runtime.activate).not.toHaveBeenCalled();
  });
});
