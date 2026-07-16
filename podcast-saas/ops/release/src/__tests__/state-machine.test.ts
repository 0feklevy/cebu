import { describe, expect, it } from 'vitest';
import {
  createRun,
  IllegalTransitionError,
  parseRun,
  ReplayedStageError,
  serializeRun,
  transition,
  type RunState,
} from '../state-machine.js';

const T0 = '2026-07-16T10:00:00.000Z';

function advance(run: RunState, states: string[], at = T0): RunState {
  let r = run;
  for (const s of states) r = transition(r, s as RunState['state'], at);
  return r;
}

describe('release state machine', () => {
  it('walks the full happy path to RELEASED', () => {
    const run = advance(createRun('run-1', T0), [
      'SOURCE_VERIFIED',
      'TESTED',
      'IMAGES_BUILT',
      'IMAGES_PUBLISHED',
      'MIGRATIONS_PLANNED',
      'AWAITING_APPROVAL',
      'DEPLOYING',
      'MIGRATED',
      'SERVICES_RECREATED',
      'HEALTHY',
      'BROWSER_VERIFIED',
      'RELEASED',
    ]);
    expect(run.state).toBe('RELEASED');
    expect(run.history).toHaveLength(13);
  });

  it('rejects skipping stages', () => {
    const run = createRun('run-2', T0);
    expect(() => transition(run, 'DEPLOYING', T0)).toThrow(IllegalTransitionError);
    expect(() => transition(run, 'RELEASED', T0)).toThrow(IllegalTransitionError);
  });

  it('any active state can FAIL; FAILED can only be ROLLED_BACK', () => {
    let run = advance(createRun('run-3', T0), ['SOURCE_VERIFIED', 'TESTED']);
    run = transition(run, 'FAILED', T0, 'tests failed');
    expect(run.state).toBe('FAILED');
    expect(() => transition(run, 'TESTED', T0)).toThrow(IllegalTransitionError);
    run = transition(run, 'ROLLED_BACK', T0);
    expect(run.state).toBe('ROLLED_BACK');
  });

  it('terminal states accept no transitions', () => {
    const released = advance(createRun('run-4', T0), [
      'SOURCE_VERIFIED',
      'TESTED',
      'IMAGES_BUILT',
      'IMAGES_PUBLISHED',
      'MIGRATIONS_PLANNED',
      'AWAITING_APPROVAL',
      'DEPLOYING',
      'MIGRATED',
      'SERVICES_RECREATED',
      'HEALTHY',
      'BROWSER_VERIFIED',
      'RELEASED',
    ]);
    expect(() => transition(released, 'FAILED', T0)).toThrow(IllegalTransitionError);
  });

  it('refuses to silently rerun non-idempotent stages (resume safety)', () => {
    // Simulate a resumed run whose history already shows IMAGES_PUBLISHED, then a retry
    // that walks forward again and attempts to publish a second time.
    let run = advance(createRun('run-5', T0), ['SOURCE_VERIFIED', 'TESTED', 'IMAGES_BUILT', 'IMAGES_PUBLISHED']);
    run = { ...run, state: 'IMAGES_BUILT' }; // artifact restored to an earlier point
    expect(() => transition(run, 'IMAGES_PUBLISHED', T0)).toThrow(ReplayedStageError);
  });

  it('survives serialize/parse round trips (workflow persistence)', () => {
    const run = advance(createRun('run-6', T0, { version: 'v0.1.2', gitSha: 'abc123' }), [
      'SOURCE_VERIFIED',
      'TESTED',
    ]);
    const restored = parseRun(serializeRun(run));
    expect(restored).toEqual(run);
    expect(() => parseRun('{"schema":"nope"}')).toThrow(/schema/);
  });
});
