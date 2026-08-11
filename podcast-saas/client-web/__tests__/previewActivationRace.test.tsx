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
 *
 * ── P1.2: THE SAME EFFECTS NOW ASK FOR A POLICY FIRST ────────────────────────────────────────
 * Both re-apply paths (the toggle effect and this debounced picker) used to call `activate()`,
 * i.e. a full re-activation — which on v2 falls through the bridge's `stopScript` and on v3 mints
 * a new `configHash`. Either way, hiding a slider reset the physics. They now call
 * `simRuntime.setPolicy(...)` and only fall back to `activate()` for the one outcome the SURFACE
 * has to answer for itself: `'no-activation'`, meaning the preview chrome says it is running but
 * the runtime has no live section. The restart fallback for a package that cannot take a policy
 * belongs to the runtime, not here, and is pinned in `simRuntimeClient*.test.ts`.
 *
 * The harness mirrors that, with the runtime's answer as a knob. The P1.1a tests below are
 * UNCHANGED and run with `policyOutcome: 'no-activation'`, so every assertion they make about
 * `activate` still describes a real code path — the fallback one. The P1.2 tests that follow run
 * with `'policy'` and assert the opposite: the runtime is asked, and never re-activated.
 */
import { useEffect, useRef, useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldFirePickerActivation } from '../lib/sim/simulationLease';
import type { SimPolicyOutcome, SimSectionPolicy } from 'shared/src/sim/simPolicy';
import type { Mock } from 'vitest';

interface ActivateOpts {
  script: string;
  params: { simpleUi: boolean; autoScript: boolean; hideSelectors: string[] };
}
interface MockRuntime {
  activate: Mock<(opts: ActivateOpts) => void>;
  /** (P1.2) What SectionEditor asks for first. Its ANSWER decides whether activate() runs at all. */
  setPolicy: Mock<(patch: Partial<SimSectionPolicy>) => SimPolicyOutcome>;
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
      // (P1.2) A hide-selection change is pure chrome, so it is REQUESTED as policy. The epoch and
      // fire-time reads above are unchanged: they decide whether the runtime is touched AT ALL,
      // which is the P1.1a property, and they now guard a policy request as well as a fallback.
      const outcome = runtime.setPolicy({
        simpleUi: live.simpleUi,
        autoScript: live.autoScript,
        hideSelectors: live.effectiveHideSelectors ?? [],
      });
      if (outcome === 'no-activation') {
        runtime.activate({
          script: live.previewScript,
          params: { simpleUi: live.simpleUi, autoScript: live.autoScript, hideSelectors: live.effectiveHideSelectors ?? [] },
        });
      }
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

/** A runtime whose `setPolicy` answers with `outcome`. `activate` records the fallback. */
const makeRuntime = (outcome: SimPolicyOutcome): MockRuntime => ({
  activate: vi.fn<(opts: ActivateOpts) => void>(),
  setPolicy: vi.fn<(patch: Partial<SimSectionPolicy>) => SimPolicyOutcome>(() => outcome),
});

describe('debounced picker re-apply vs. preview teardown (P1.1a)', () => {
  let runtime: MockRuntime;
  let controls: HarnessControls;

  beforeEach(() => {
    vi.useFakeTimers();
    // 'no-activation' is the fallback branch, so every `activate` assertion below still describes
    // a path SectionEditor really takes. The P1.2 block at the bottom drives the policy branch.
    runtime = makeRuntime('no-activation');
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

    // BOTH mocks. Since P1.2 the effect asks for a policy FIRST, so `activate` alone no longer
    // means "the runtime was not touched" — a stale timer that got 'policy' back would have
    // reached the live document without ever calling activate.
    expect(runtime.setPolicy, 'a stale timer requested a policy').not.toHaveBeenCalled();
    expect(runtime.activate).not.toHaveBeenCalled();
  });

  it('a document change alone (epoch bump, still running) also kills the pending timer', () => {
    act(() => controls.pick(['#panel']));
    act(() => vi.advanceTimersByTime(100));
    act(() => controls.documentChange());     // e.g. a generation replaced simulation_url
    act(() => vi.advanceTimersByTime(200));

    // BOTH mocks. Since P1.2 the effect asks for a policy FIRST, so `activate` alone no longer
    // means "the runtime was not touched" — a stale timer that got 'policy' back would have
    // reached the live document without ever calling activate.
    expect(runtime.setPolicy, 'a stale timer requested a policy').not.toHaveBeenCalled();
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
    // BOTH mocks. Since P1.2 the effect asks for a policy FIRST, so `activate` alone no longer
    // means "the runtime was not touched" — a stale timer that got 'policy' back would have
    // reached the live document without ever calling activate.
    expect(runtime.setPolicy, 'a stale timer requested a policy').not.toHaveBeenCalled();
    expect(runtime.activate).not.toHaveBeenCalled();
  });
});

// ══ P1.2 — A LIVE TOGGLE ASKS FOR A POLICY; RUN/STOP AND DOCUMENT CHANGES STILL ACTIVATE ═════
//
// WHAT THIS HARNESS IS AND IS NOT. It mirrors SectionEditor's two re-apply effects, and its
// `runtime` is a recorder. So "no activate() call" is exactly as strong as "the surface did not
// ask for a re-activation" — and no stronger. That the runtime's own policy path then leaves the
// section body alone is proven where it can be: against the emitted v2 bridge in
// backend-api/src/services/simulation/__tests__/simPolicyBridge.test.ts and against the v3 child
// in backend-api/src/scripts/__tests__/v3FixtureParity.test.ts.

interface ToggleControls {
  setSimpleUi(v: boolean): void;
  setAutoScript(v: boolean): void;
  /** SectionEditor's runPreview + Run button: the chrome flag turns on and an activation happens. */
  run(): void;
  /** SectionEditor's stopPreview. */
  stop(): void;
}

/**
 * The TOGGLE effect, mirrored: it fires on `[simpleUi, autoScript]`, is gated on `previewRunning`,
 * asks for a policy, and re-activates only for `'no-activation'`. `hideSelectors` is the LIVE
 * selection or `null` — deliberately not `[]`, which is the picker's stronger instruction.
 */
function ToggleHarness({ runtime, controls }: { runtime: MockRuntime; controls: ToggleControls }) {
  const [simpleUi, setSimpleUi] = useState(false);
  const [autoScript, setAutoScript] = useState(true);
  const [previewRunning, setPreviewRunning] = useState(false);
  const effectiveHideSelectors: string[] | null = null;

  const runPreview = (): void => {
    runtime.activate({ script: 'main', params: { simpleUi, autoScript, hideSelectors: effectiveHideSelectors ?? [] } });
    setPreviewRunning(true);
  };

  controls.setSimpleUi = setSimpleUi;
  controls.setAutoScript = setAutoScript;
  controls.run = runPreview;
  controls.stop = () => setPreviewRunning(false);

  useEffect(() => {
    if (!previewRunning) return;
    const outcome = runtime.setPolicy({ simpleUi, autoScript, hideSelectors: effectiveHideSelectors });
    if (outcome === 'no-activation') runPreview();
  // Only re-fire on toggle changes — everything else is read fresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simpleUi, autoScript]);

  return null;
}

const makeToggleControls = (): ToggleControls => ({
  setSimpleUi: () => { throw new Error('harness not mounted'); },
  setAutoScript: () => { throw new Error('harness not mounted'); },
  run: () => { throw new Error('harness not mounted'); },
  stop: () => { throw new Error('harness not mounted'); },
});

describe('the Minimal-UI / Auto-Script toggles take the policy path while running (P1.2)', () => {
  let runtime: MockRuntime;
  let controls: ToggleControls;

  const mount = (outcome: SimPolicyOutcome): void => {
    runtime = makeRuntime(outcome);
    controls = makeToggleControls();
    render(<ToggleHarness runtime={runtime} controls={controls} />);
  };

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('a toggle on a NOT-running preview does nothing at all', () => {
    // The gate that keeps a stopped preview stopped. Without it, ticking Minimal UI would start a
    // simulation the user had deliberately stopped.
    mount('policy');
    act(() => controls.setSimpleUi(true));
    expect(runtime.setPolicy).not.toHaveBeenCalled();
    expect(runtime.activate).not.toHaveBeenCalled();
  });

  it('REGRESSION: a live toggle requests a POLICY and never re-activates', () => {
    // This is the finding, at the surface. It used to be `runPreview()` — a full activation, which
    // on v2 runs the body's cleanup and re-executes it and on v3 mints a new configHash.
    mount('policy');
    act(() => controls.run());
    runtime.activate.mockClear();

    act(() => controls.setSimpleUi(true));
    expect(runtime.setPolicy).toHaveBeenCalledTimes(1);
    expect(runtime.setPolicy).toHaveBeenCalledWith({ simpleUi: true, autoScript: true, hideSelectors: null });
    expect(runtime.activate, 'hiding a control re-activated the section').not.toHaveBeenCalled();

    act(() => controls.setAutoScript(false));
    expect(runtime.setPolicy).toHaveBeenCalledTimes(2);
    expect(runtime.setPolicy).toHaveBeenLastCalledWith({ simpleUi: true, autoScript: false, hideSelectors: null });
    expect(runtime.activate).not.toHaveBeenCalled();
  });

  it('sends `null` for the hide set, not `[]` — the picker\'s instruction is a different one', () => {
    // On the policy path the two are equivalent (the body is not re-run, so it never sees the
    // value). On the runtime's FALLBACK restart they are not: `null` omits the key and leaves the
    // body's own generated hide logic to decide, `[]` tells it the user re-checked everything.
    mount('policy');
    act(() => controls.run());
    act(() => controls.setSimpleUi(true));
    const patch = runtime.setPolicy.mock.calls[0][0];
    expect(patch.hideSelectors).toBeNull();
    expect(patch.hideSelectors).not.toEqual([]);
  });

  it('a REACTIVATED answer is the runtime\'s own fallback — the surface adds no second restart', () => {
    // The runtime already re-activated internally for an unsupported package. A surface that
    // "helpfully" activated as well would restart the section twice for one toggle.
    mount('reactivated');
    act(() => controls.run());
    runtime.activate.mockClear();
    act(() => controls.setSimpleUi(true));
    expect(runtime.setPolicy).toHaveBeenCalledTimes(1);
    expect(runtime.activate, 'the surface restarted on top of the runtime\'s own fallback')
      .not.toHaveBeenCalled();
  });

  it('an UNCHANGED answer costs nothing either', () => {
    mount('unchanged');
    act(() => controls.run());
    runtime.activate.mockClear();
    act(() => controls.setSimpleUi(true));
    expect(runtime.activate).not.toHaveBeenCalled();
  });

  it('NO-ACTIVATION is the one outcome the surface answers itself, with a real activation', () => {
    // The preview chrome says it is running but the runtime has no live section — a document that
    // reloaded underneath, say. A policy has nowhere to land, so the section must be started.
    mount('no-activation');
    act(() => controls.run());
    runtime.activate.mockClear();

    act(() => controls.setSimpleUi(true));
    expect(runtime.activate).toHaveBeenCalledTimes(1);
    expect(runtime.activate).toHaveBeenCalledWith({
      script: 'main', params: { simpleUi: true, autoScript: true, hideSelectors: [] },
    });
  });

  it('Run and Stop still ACTIVATE — a policy is not a substitute for starting a section', () => {
    // The boundary. Run/Stop and section/document changes are activations by definition: they
    // change WHICH body is installed, which no policy can do.
    mount('policy');
    act(() => controls.run());
    expect(runtime.activate).toHaveBeenCalledTimes(1);
    expect(runtime.setPolicy, 'Run went through the policy path').not.toHaveBeenCalled();

    act(() => controls.stop());
    act(() => controls.setSimpleUi(true));
    expect(runtime.setPolicy, 'a toggle after Stop touched the runtime').not.toHaveBeenCalled();

    act(() => controls.run());
    expect(runtime.activate, 'Run after Stop must re-activate').toHaveBeenCalledTimes(2);
  });
});

describe('the debounced picker takes the policy path too (P1.2)', () => {
  let runtime: MockRuntime;
  let controls: HarnessControls;

  beforeEach(() => {
    vi.useFakeTimers();
    runtime = makeRuntime('policy');
    controls = makeControls();
    render(<PickerTimerHarness runtime={runtime} controls={controls} />);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('a hide-selection change is delivered as policy, with no re-activation', () => {
    // The picker's whole purpose is to let the author watch hides apply and clear WHILE the
    // demonstration runs. Re-running the body on every 150ms debounce is what stopped that from
    // being watchable.
    act(() => controls.pick(['#panel']));
    act(() => vi.advanceTimersByTime(150));

    expect(runtime.setPolicy).toHaveBeenCalledTimes(1);
    expect(runtime.setPolicy).toHaveBeenCalledWith({
      simpleUi: true, autoScript: true, hideSelectors: ['#panel'],
    });
    expect(runtime.activate, 'a picker change re-activated the section').not.toHaveBeenCalled();
  });

  it('hideSelectors is ALWAYS an array here — [] is "the user re-checked everything"', () => {
    act(() => controls.pick(['#a']));
    act(() => vi.advanceTimersByTime(150));
    act(() => controls.pick([]));
    act(() => vi.advanceTimersByTime(150));
    expect(runtime.setPolicy).toHaveBeenLastCalledWith({
      simpleUi: true, autoScript: true, hideSelectors: [],
    });
  });

  it('the P1.1a epoch still governs the policy request — a stale timer requests nothing', () => {
    // The two findings compose: P1.1a decides WHETHER the runtime is touched, P1.2 decides HOW.
    // A regression in either one alone would leave this passing, which is why both are asserted.
    act(() => controls.pick(['#panel']));
    act(() => vi.advanceTimersByTime(100));
    act(() => controls.documentChange());
    act(() => vi.advanceTimersByTime(200));
    expect(runtime.setPolicy).not.toHaveBeenCalled();
    expect(runtime.activate).not.toHaveBeenCalled();
  });

  it('still debounces to ONE policy request carrying the LAST selection', () => {
    act(() => controls.pick(['#a']));
    act(() => vi.advanceTimersByTime(100));
    act(() => controls.pick(['#a', '#b']));
    act(() => vi.advanceTimersByTime(150));
    expect(runtime.setPolicy).toHaveBeenCalledTimes(1);
    expect(runtime.setPolicy).toHaveBeenCalledWith({
      simpleUi: true, autoScript: true, hideSelectors: ['#a', '#b'],
    });
  });
});
