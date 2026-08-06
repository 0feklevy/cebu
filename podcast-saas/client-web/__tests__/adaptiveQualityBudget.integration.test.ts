/**
 * SERVER -> CONFIG -> VIEWER, for the number adaptive quality judges a device against.
 *
 * The defect this pins was invisible to every isolated unit test, and necessarily so: the server's
 * emit logic was correct, `nextQualityFor` was correct, and `decideQuality` was correct. The bug
 * lived in the ONE token joining them inside the player —
 *
 *     labBudgetsRef.current[id] ?? prepareBudgetsRef.current[id]
 *
 * — a fallback from the lab standard to the FIELD-REFINED preparation lead. So these tests start
 * from the config shape the server actually emits and run the REAL production selector
 * (`labStandardMs`, the function the hook now calls) into the REAL controller (`nextQualityFor`).
 * Nothing here re-expresses the rule it is testing.
 *
 * The server contract these fixtures encode is asserted directly against `buildPlayerConfig` in
 * backend-api/src/services/__tests__/buildPlayerConfig.revision.test.ts, under
 * "sim_lab_budget_ms — the unrefined canary standard": that `sim_lab_budget_ms` carries ONLY
 * publish-time canary numbers, and that a package with field data but no canary appears in
 * `sim_prepare_budget_ms` and NOT in `sim_lab_budget_ms`.
 */
import { describe, it, expect } from 'vitest';
import { labStandardMs } from '../lib/sim/qualityBudgets';
import { nextQualityFor, INITIAL_QUALITY_STATE, MIN_SAMPLES } from 'shared/sim/adaptiveQuality';
import { MIN_BUDGET_MS } from 'shared/sim/prepareBudget';

/** A device comfortably over the 250ms floor but doing nothing unusual. */
const ORDINARY_P90 = 900;
const HEALTHY_SAMPLES = MIN_SAMPLES * 4;

describe('adaptive quality: the standard comes from the canary, never from field data', () => {
  // THE CASE THE FIX EXISTS FOR. Package was never canaried, so the server omits it from
  // sim_lab_budget_ms; it HAS field data, so the refined lead time is present. The old fallback
  // picked that lead time up and judged the device against it.
  it('an UN-CANARIED package with field data is not judged at all — no-lab-budget, profile held', () => {
    const config = {
      sim_lab_budget_ms: {},
      sim_prepare_budget_ms: { 'sim-1': 1125 },   // fleet p90 x 1.25, i.e. field data
    };
    expect(labStandardMs(config, 'sim-1'), 'the lead time leaked in as a standard').toBeNull();

    let state = INITIAL_QUALITY_STATE;
    // Enough consecutive over-budget decisions to walk 'high' all the way down, if it could.
    for (let i = 0; i < 12; i++) {
      const d = nextQualityFor(state, {
        measuredP90Ms: ORDINARY_P90,
        samples: HEALTHY_SAMPLES,
        labBudgetMs: labStandardMs(config, 'sim-1'),
      });
      expect(d.reason).toBe('no-lab-budget');
      expect(d.changed, 'an un-canaried package was adapted').toBe(false);
      expect(d.next, 'an un-canaried package was degraded').toBe('high');
      expect(d.budgetSource).toBe('none');
      state = d.state;
    }
  });

  // The specific harm: MIN_BUDGET_MS is a floor, not a measurement, and an ordinary transition
  // exceeds it. Judging against it would degrade essentially every un-canaried package.
  it('never falls back to the 250ms floor for a package with no standard', () => {
    expect(ORDINARY_P90).toBeGreaterThan(MIN_BUDGET_MS);
    const viaFloor = nextQualityFor(
      { current: 'high', streak: 1, direction: 'down' },
      { measuredP90Ms: ORDINARY_P90, samples: HEALTHY_SAMPLES, labBudgetMs: MIN_BUDGET_MS },
    );
    // Proof the floor really would punish it, so the assertion below is not vacuous.
    expect(viaFloor.next, 'the floor is not actually punitive — this test proves nothing').toBe('balanced');

    const viaNoStandard = nextQualityFor(
      { current: 'high', streak: 1, direction: 'down' },
      { measuredP90Ms: ORDINARY_P90, samples: HEALTHY_SAMPLES, labBudgetMs: labStandardMs({ sim_lab_budget_ms: {} }, 'sim-1') },
    );
    expect(viaNoStandard.next).toBe('high');
    expect(viaNoStandard.reason).toBe('no-lab-budget');
  });

  it('a CANARIED package is judged against its canary number, and still adapts', () => {
    const config = {
      sim_lab_budget_ms: { 'sim-1': 400 },
      sim_prepare_budget_ms: { 'sim-1': 1125 },   // refined lead time — must be ignored here
    };
    expect(labStandardMs(config, 'sim-1')).toBe(400);

    let state: typeof INITIAL_QUALITY_STATE = INITIAL_QUALITY_STATE;
    let changed = false;
    for (let i = 0; i < 4 && !changed; i++) {
      const d = nextQualityFor(state, {
        measuredP90Ms: ORDINARY_P90, samples: HEALTHY_SAMPLES,
        labBudgetMs: labStandardMs(config, 'sim-1'),
      });
      state = d.state; changed = d.changed;
      expect(d.reason).not.toBe('no-lab-budget');
    }
    expect(changed, 'a canaried package over its lab budget never adapted').toBe(true);
    expect(state.current).toBe('balanced');
  });

  // If the lead time were still consulted, this device — six times over the refined lead — would
  // be pinned to 'high' by the p90 > 1.25*p90 tautology instead of reporting no-lab-budget.
  it('the refined lead time cannot stand in for the standard, even when it is the only number', () => {
    const config = { sim_lab_budget_ms: undefined, sim_prepare_budget_ms: { 'sim-1': 600 } };
    expect(labStandardMs(config, 'sim-1')).toBeNull();
    const d = nextQualityFor(INITIAL_QUALITY_STATE, {
      measuredP90Ms: 3600, samples: HEALTHY_SAMPLES, labBudgetMs: labStandardMs(config, 'sim-1'),
    });
    expect(d.reason).toBe('no-lab-budget');
    expect(d.next).toBe('high');
  });

  it('rejects unusable lab entries rather than treating them as a standard', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(labStandardMs({ sim_lab_budget_ms: { 'sim-1': bad } }, 'sim-1'), String(bad)).toBeNull();
    }
    expect(labStandardMs({ sim_lab_budget_ms: { 'sim-1': 400 } }, null)).toBeNull();
    expect(labStandardMs({ sim_lab_budget_ms: { 'sim-1': 400 } }, 'other-sim')).toBeNull();
    expect(labStandardMs({}, 'sim-1')).toBeNull();
  });
});
