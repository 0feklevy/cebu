/**
 * Explicit release state machine. Every workflow stage records a transition into a
 * persisted state file (uploaded as an artifact), so an interrupted run can explain
 * exactly where it stopped and non-idempotent stages are never silently rerun.
 */

export const RELEASE_STATES = [
  'PLANNED',
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
  'FAILED',
  'ROLLED_BACK',
] as const;

export type ReleaseState = (typeof RELEASE_STATES)[number];

/** Stages that must never re-run once passed (side effects are not idempotent). */
export const NON_IDEMPOTENT_STATES: readonly ReleaseState[] = [
  'IMAGES_PUBLISHED', // pushes immutable tags
  'MIGRATED', // applies schema migrations
  'RELEASED', // publishes the GitHub release
];

const HAPPY_PATH: Partial<Record<ReleaseState, ReleaseState>> = {
  PLANNED: 'SOURCE_VERIFIED',
  SOURCE_VERIFIED: 'TESTED',
  TESTED: 'IMAGES_BUILT',
  IMAGES_BUILT: 'IMAGES_PUBLISHED',
  IMAGES_PUBLISHED: 'MIGRATIONS_PLANNED',
  MIGRATIONS_PLANNED: 'AWAITING_APPROVAL',
  AWAITING_APPROVAL: 'DEPLOYING',
  DEPLOYING: 'MIGRATED',
  MIGRATED: 'SERVICES_RECREATED',
  SERVICES_RECREATED: 'HEALTHY',
  HEALTHY: 'BROWSER_VERIFIED',
  BROWSER_VERIFIED: 'RELEASED',
};

export const TERMINAL_STATES: readonly ReleaseState[] = ['RELEASED', 'ROLLED_BACK'];

export function allowedTransitions(from: ReleaseState): ReleaseState[] {
  if (from === 'RELEASED' || from === 'ROLLED_BACK') return [];
  if (from === 'FAILED') return ['ROLLED_BACK'];
  const next = HAPPY_PATH[from];
  // Any active state may fail; only the happy-path successor moves forward.
  return next ? [next, 'FAILED'] : ['FAILED'];
}

export interface StateEvent {
  state: ReleaseState;
  at: string;
  note?: string;
}

export interface RunState {
  schema: 'flowvid.release-state/v1';
  runId: string;
  version?: string;
  gitSha?: string;
  requestedBump?: string;
  state: ReleaseState;
  history: StateEvent[];
}

export function createRun(
  runId: string,
  at: string,
  init?: Partial<Pick<RunState, 'version' | 'gitSha' | 'requestedBump'>>,
): RunState {
  return {
    schema: 'flowvid.release-state/v1',
    runId,
    ...init,
    state: 'PLANNED',
    history: [{ state: 'PLANNED', at }],
  };
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: ReleaseState,
    public readonly to: ReleaseState,
  ) {
    super(`Illegal release-state transition ${from} -> ${to}. Allowed: ${allowedTransitions(from).join(', ') || '(terminal)'}`);
  }
}

export class ReplayedStageError extends Error {
  constructor(public readonly state: ReleaseState) {
    super(
      `Stage ${state} has already run in this release and is not idempotent — refusing to rerun it silently. ` +
        `Start a new release run (or roll back) instead.`,
    );
  }
}

export function transition(run: RunState, to: ReleaseState, at: string, note?: string): RunState {
  if (!allowedTransitions(run.state).includes(to)) {
    throw new IllegalTransitionError(run.state, to);
  }
  if (NON_IDEMPOTENT_STATES.includes(to) && run.history.some((h) => h.state === to)) {
    throw new ReplayedStageError(to);
  }
  return {
    ...run,
    state: to,
    history: [...run.history, { state: to, at, ...(note ? { note } : {}) }],
  };
}

export function serializeRun(run: RunState): string {
  return JSON.stringify(run, null, 2) + '\n';
}

export function parseRun(json: string): RunState {
  const run = JSON.parse(json) as RunState;
  if (run.schema !== 'flowvid.release-state/v1') {
    throw new Error(`Unknown release-state schema: ${String(run.schema)}`);
  }
  if (!RELEASE_STATES.includes(run.state)) {
    throw new Error(`Unknown release state: ${String(run.state)}`);
  }
  return run;
}
