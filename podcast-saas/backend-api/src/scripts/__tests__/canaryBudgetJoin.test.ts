/**
 * The JOIN between a real canary report and the budget derived from it.
 *
 * WHY THIS EXISTS SEPARATELY FROM prepareBudget.test.ts
 * The original defect was not in the function — it was at the CALL SITE: `canary_report.steps` was
 * read from a report shape that has no top-level `steps`, and a cast let it compile. Both ends are
 * now tested independently (prepareBudget over hand-built inputs; buildPlayerConfig over a mocked
 * column value) and the join between them was not. Pass a report whose cases live under another key
 * and every one of those tests stays green while every package's budget is silently null.
 *
 * So this test builds the report through the REAL assembler and asserts the budget derived from it
 * is a number — no hand-written shape anywhere.
 */

import { describe, it, expect } from 'vitest';
import { assembleCanaryReport } from '../../services/simulation/canaryJudge.js';
import { canaryReportPrepareMs } from 'shared/sim/prepareBudget';

/** One case, shaped by the real contract, with the four preparation steps timed. */
const caseResult = (ms: Record<string, number>) => ({
  case: { id: 'c1', variantKey: 'main', aspect: 'wide', quality: 'high' },
  steps: [
    { step: 'load', status: 'pass', ms: 500 },
    { step: 'handshake', status: 'pass', ms: 40 },
    { step: 'prepare', status: 'pass', ms: ms.prepare },
    { step: 'section-applied', status: 'pass', ms: ms.applied },
    { step: 'present', status: 'pass', ms: ms.present },
    { step: 'section-presented', status: 'pass', ms: ms.presented },
    { step: 'poster-captured', status: 'pass', ms: 9000 },
  ],
  capabilities: null, errors: [], countsAfterDispose: null, leaked: [], posterIdentity: null,
});

describe('a budget derived from a REAL assembled report', () => {
  // The REAL positional signature: (meta, cases, assets, aborted).
  const report = assembleCanaryReport(
    {
      packageRevision: 'rev0123456789ab',
      simulationId: 'sim-1',
      storagePrefix: 'simulations/p/s',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      engine: 'chromium',
    } as never,
    [
      caseResult({ prepare: 200, applied: 30, present: 100, presented: 50 }),
      caseResult({ prepare: 300, applied: 30, present: 100, presented: 50 }),
    ] as never,
    [],
    null,
  );

  it('the assembler really puts steps under cases[], not at the top level', () => {
    // Pins the shape the derivation depends on. If the assembler ever hoisted steps, the derivation
    // would keep working and this test would tell you why the other one started failing.
    expect(Array.isArray((report as unknown as { cases?: unknown[] }).cases)).toBe(true);
    expect((report as unknown as { steps?: unknown }).steps).toBeUndefined();
    expect(((report as unknown as { cases: { steps: unknown[] }[] }).cases)[0]!.steps.length).toBeGreaterThan(0);
  });

  it('derives a NUMBER from it — the join the original bug broke', () => {
    const ms = canaryReportPrepareMs(report as never);
    expect(ms, 'the derivation returned null for a real report — the original defect').not.toBeNull();
    // Worst case: 300+30+100+50 = 480. load and handshake are excluded by design so the lab number
    // spans what the field measurement spans.
    expect(ms).toBe(480);
  });

  it('excludes load and handshake, which the field measurement does not cover', () => {
    // 500 + 40 would be included by a derivation spanning the whole run.
    expect(canaryReportPrepareMs(report as never)!).toBeLessThan(500);
  });
});
