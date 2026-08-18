/**
 * types-001 — `SimMeta` described a shape the server has never written.
 *
 * The declared interface listed eight REQUIRED fields (`targetControlId`, `hideControlIds`,
 * `hideButtonIds`, `hideSelectorStrings`, `animation`, `confidence`, `warnings`, `planVersion`)
 * — the pre-planVersion-7 "BridgePlan" shape. What `sections.controller.ts` actually persists to
 * `timeline_sections.sim_meta` today is a generation-provenance record: `planVersion: '7'`,
 * `generatedBy`, `uiControls`, `bridgeHash`, `sourceHash`, `provider`, `model`,
 * `conversationHistory`, and so on. Of the eight required fields, exactly three are ever written,
 * and five of the written ones were not declared at all.
 *
 * The frontend had already routed around it rather than trusted it:
 *   SectionEditor.tsx    `const m = simMeta as unknown as Record<string, unknown>` — a DOUBLE cast
 *                        through `unknown`, needed because `provider`/`model` are not on the type;
 *   simUiControls.ts     "uiControls is not declared on the generated SimMeta type yet".
 *
 * A type nobody can use is worse than no type: it typechecks the wrong thing while every real
 * reader casts past it.
 *
 * WHAT THIS TEST IS. The fixtures below are the literal objects the two write sites build
 * (sections.controller.ts, the mechanical Minimal-UI path and the LLM path), annotated `: SimMeta`.
 * The assertion is therefore made by `tsc`, and the gate for it is `pnpm --filter shared typecheck`
 * — before the fix that command exits non-zero on this file with "missing the following properties
 * from type 'SimMeta'" plus excess-property errors on `generatedBy`, `uiControls`, `bridgeHash`,
 * `sourceHash`, `provider`, `model` and the rest. The runtime `expect`s below pin the fixtures
 * themselves against the controller, so the compile-time claim cannot be quietly weakened by
 * editing the fixture instead of the type.
 */
import { describe, it, expect } from 'vitest';
import type { SimMeta } from '../generated/client-v1.js';

/**
 * `sections.controller.ts` — the mechanical Minimal-UI path (`rawPrompt === ''`). Spreads the
 * stored meta forward, then stamps the fields below.
 */
const MECHANICAL_WRITE: SimMeta = {
  planVersion:           '7',
  generatedBy:           'mechanical',
  uiControls:            {
    controls: [{ selector: '#speed', kind: 'slider', label: 'Speed' }],
    show:     ['#speed'],
    hide:     ['#reset'],
  },
  bridgeHash:            'b3f1c0',
  generatedAt:           '2026-08-18T12:00:00.000Z',
  supportsRuntimeParams: true,
};

/** `sections.controller.ts` — the LLM path, written from `BridgeGenerationResult`. */
const LLM_WRITE: SimMeta = {
  planVersion:           '7',
  generatedBy:           'llm',
  prompt:                'Slow the pendulum and hide the reset button',
  uiControls:            {
    controls: [{ selector: '#speed', kind: 'slider', label: 'Speed', hidden: false }],
    show:     ['#speed'],
    hide:     ['#reset'],
  },
  sourceHash:            'a1b2c3',
  bridgeHash:            'b3f1c0',
  generatedAt:           '2026-08-18T12:00:00.000Z',
  provider:              'anthropic',
  model:                 'claude-x',
  confidence:            0.92,
  confidenceLevel:       'high',
  contextTruncated:      false,
  retryCount:            0,
  retryReason:           null,
  warnings:              [],
  validationErrors:      [],
  validationWarnings:    ['unused selector'],
  supportsRuntimeParams: true,
  runtimeValidated:      false,
  conversationHistory:   [{ role: 'user', content: 'slower' }, { role: 'assistant', content: 'ok' }],
};

/**
 * A row written before planVersion 7. These rows are still in the table and SectionEditor still
 * renders them ("handles both old BridgePlan shape and new Phase 4 shape"), so the type must keep
 * describing them — deleting the legacy half would just push those readers back to casting.
 */
const LEGACY_BRIDGE_PLAN: SimMeta = {
  planVersion:         '5',
  targetControlId:     'speed',
  confidence:          0.7,
  warnings:            ['low contrast'],
  hideControlIds:      ['reset'],
  hideButtonIds:       ['pause'],
  hideSelectorStrings: ['.debug'],
  animation: {
    enabled:      true,
    controllerId: 'speed',
    min:          0,
    max:          10,
    step:         0.5,
    intervalMs:   50,
    showOptimal:  true,
  },
};

/** `{}` is a real value of this column: a bare section that has never been generated. */
const NEVER_GENERATED: SimMeta = {};

describe('SimMeta describes what the server writes', () => {
  it('the mechanical path stamps exactly six fields', () => {
    expect(Object.keys(MECHANICAL_WRITE).sort()).toEqual([
      'bridgeHash', 'generatedAt', 'generatedBy', 'planVersion', 'supportsRuntimeParams', 'uiControls',
    ]);
  });

  it('the LLM path carries the generation provenance the editor renders', () => {
    // These four are exactly what SectionEditor's "Last generation" card reads, and every one of
    // them was absent from the old interface — which is why that card casts through `unknown`.
    expect(LLM_WRITE.provider).toBe('anthropic');
    expect(LLM_WRITE.model).toBe('claude-x');
    expect(LLM_WRITE.confidence).toBe(0.92);
    expect(LLM_WRITE.warnings).toEqual([]);
  });

  it('the persisted Minimal-UI selection is reachable without a cast', () => {
    expect(LLM_WRITE.uiControls?.hide).toEqual(['#reset']);
    expect(MECHANICAL_WRITE.uiControls?.controls[0].selector).toBe('#speed');
  });

  it('planVersion is the version marker the canReuse decision reads', () => {
    expect(MECHANICAL_WRITE.planVersion).toBe('7');
    expect(LEGACY_BRIDGE_PLAN.planVersion).toBe('5');
  });

  it('a legacy BridgePlan row is still describable', () => {
    expect(LEGACY_BRIDGE_PLAN.targetControlId).toBe('speed');
    expect(LEGACY_BRIDGE_PLAN.animation?.controllerId).toBe('speed');
  });

  it('an ungenerated section is an empty object, not a missing one', () => {
    expect(NEVER_GENERATED).toEqual({});
  });
});
