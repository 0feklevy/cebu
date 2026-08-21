import { describe, it, expect } from 'vitest';
import { DUB_STAGES, dubProgress, rollUpProgress, isDubStage } from '../stages.js';

const NOW = 1_800_000_000_000;

describe('DUB_STAGES', () => {
  it('is strictly increasing and starts at zero', () => {
    expect(DUB_STAGES[0]!.pct).toBe(0);
    for (let i = 1; i < DUB_STAGES.length; i += 1) {
      expect(DUB_STAGES[i]!.pct).toBeGreaterThan(DUB_STAGES[i - 1]!.pct);
    }
    expect(DUB_STAGES.at(-1)!.pct).toBeLessThan(100);
  });

  it('gives the two vendor waits most of the bar, because they are most of the wait', () => {
    const vendor = DUB_STAGES.filter((s) => s.key === 'transcribing' || s.key === 'translating');
    const span = vendor.reduce((total, s) => {
      const next = DUB_STAGES[DUB_STAGES.indexOf(s) + 1];
      return total + ((next?.pct ?? 100) - s.pct);
    }, 0);
    expect(span).toBeGreaterThan(60);
  });
});

describe('dubProgress', () => {
  it('reports the terminal states without inventing a stage', () => {
    expect(dubProgress({ status: 'completed', stage: 'packaging', stageEnteredAtMs: NOW, nowMs: NOW }))
      .toMatchObject({ percent: 100, active: false, label: 'Ready' });
    expect(dubProgress({ status: 'queued', stage: null, stageEnteredAtMs: null, nowMs: NOW }))
      .toMatchObject({ percent: 0, active: true });
    expect(dubProgress({ status: 'stale', stage: 'mixing', stageEnteredAtMs: NOW, nowMs: NOW }).active)
      .toBe(false);
  });

  it('freezes a failed run at the stage it died in rather than resetting it', () => {
    const p = dubProgress({ status: 'failed', stage: 'translating', stageEnteredAtMs: NOW, nowMs: NOW });
    expect(p.percent).toBe(45);
    expect(p.active).toBe(false);
  });

  it('treats a processing row with no stage as working, not as zero', () => {
    const p = dubProgress({ status: 'processing', stage: null, stageEnteredAtMs: null, nowMs: NOW });
    expect(p.percent).toBeGreaterThan(0);
    expect(p.active).toBe(true);
  });

  it('creeps forward inside a stage without ever reaching the next one', () => {
    const at = (minutes: number) => dubProgress({
      status: 'processing', stage: 'translating',
      stageEnteredAtMs: NOW, nowMs: NOW + minutes * 60_000,
    }).percent;

    expect(at(0)).toBe(45);
    expect(at(2)).toBeGreaterThan(at(0));
    expect(at(10)).toBeGreaterThan(at(2));
    // `captioning` starts at 78. However long this runs, the bar may not claim that step began.
    expect(at(600)).toBeLessThan(78);
    expect(at(6000)).toBeLessThan(78);
  });

  it('never reports 100 for anything that is not completed', () => {
    for (const stage of DUB_STAGES) {
      const p = dubProgress({
        status: 'processing', stage: stage.key,
        stageEnteredAtMs: NOW, nowMs: NOW + 30 * 24 * 3600_000,
      });
      expect(p.percent).toBeLessThan(100);
    }
  });

  it('is monotonic across the pipeline at equal elapsed time', () => {
    const seen = DUB_STAGES.map((s) => dubProgress({
      status: 'processing', stage: s.key, stageEnteredAtMs: NOW, nowMs: NOW,
    }).percent);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  });
});

describe('rollUpProgress', () => {
  it('averages, so finishing a video never moves the bar backwards', () => {
    expect(rollUpProgress([])).toBe(0);
    expect(rollUpProgress([100])).toBe(100);
    expect(rollUpProgress([100, 50, 0, 0])).toBe(38);
    expect(rollUpProgress([100, 50])).toBeGreaterThan(rollUpProgress([50, 50]));
  });
});

describe('isDubStage', () => {
  it('accepts only real stages', () => {
    expect(isDubStage('translating')).toBe(true);
    expect(isDubStage('completed')).toBe(false);
    expect(isDubStage(null)).toBe(false);
    expect(isDubStage('')).toBe(false);
  });
});
