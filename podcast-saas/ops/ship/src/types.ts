/**
 * The ship conductor's data model.
 *
 * `ship.json` is the single resumable source of truth for one shipment; `ship.ndjson`
 * is its append-only event stream. Both are written to a run directory that Claude
 * reads directly, so every field here is part of a contract with the `/ship` skill —
 * renaming one means updating `.claude/skills/ship/SKILL.md` too.
 */

export const SHIP_RUN_SCHEMA = 'flowvid.ship-run/v1';
export const SHIP_EVENT_SCHEMA = 'flowvid.ship-event/v1';

/** Ordered pipeline stages. The conductor never skips forward past a failure. */
export const SHIP_STAGES = [
  'preflight', // local git + gh sanity, before anything is created
  'pr', // create or adopt the pull request
  'ci', // the pull_request CI run must be green
  'merge', // merge the PR into main
  'main-ci', // the push-to-main CI run (usually short-circuited by the tree guard)
  'release', // dispatch Release FlowVid and watch it to the approval gate
  'approval', // production environment approval (human decision by default)
  'deploy', // deploy + post-deploy gate + publish
  'audit', // production audit over the freshly deployed system
  'report', // assemble SHIP-REPORT.md
] as const;

export type ShipStageName = (typeof SHIP_STAGES)[number];

export type ShipStageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'blocked';

export interface ShipStage {
  name: ShipStageName;
  status: ShipStageStatus;
  startedAt?: string;
  endedAt?: string;
  /** One line explaining the status — always present once the stage leaves `pending`. */
  note?: string;
}

/**
 * How a shipment ended.
 *
 * BLOCKED and FAILED are kept apart for the same reason the production audit keeps
 * BLOCKED_BY_FINDINGS apart from BLOCKED_BY_AUDIT_ERROR: they demand opposite
 * responses. BLOCKED means the pipeline worked and said no — fix the code. FAILED
 * means the pipeline itself could not produce a trustworthy answer — fix the
 * pipeline, and draw no conclusion about the product.
 */
export type ShipVerdict =
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'SHIPPED' // deployed, verified, published, audited
  | 'BLOCKED' // a gate said no (tests red, findings, unapproved HIGH)
  | 'FAILED' // the conductor or a workflow broke; product state may be unknown
  | 'ABORTED'; // a human declined at the approval gate

export type FailureKind =
  | 'ci-red' // tests/typecheck/lint/build failed on the PR
  | 'merge-conflict'
  | 'release-verify' // the release's own verification gate failed
  | 'build-images'
  | 'gate-blocked' // pre- or post-deploy gate blocked
  | 'deploy-failed' // remote-sync/remote-deploy failed (rollback may have engaged)
  | 'audit-findings' // production violates policy
  | 'audit-error' // a collector could not produce a trustworthy answer
  | 'approval-denied'
  | 'conductor'; // gh/network/permission problem on this machine

export interface ShipFailure {
  stage: ShipStageName;
  kind: FailureKind;
  /** One sentence a human can act on. */
  summary: string;
  /** Run-directory-relative paths to the logs and reports that prove it. */
  evidence: string[];
  /** Present when the failure came from a GitHub run. */
  workflowUrl?: string;
  /** Jobs that actually failed, so the report does not make the reader hunt. */
  failedJobs?: { name: string; conclusion: string; url?: string }[];
}

export interface ShipInputs {
  bump: 'patch' | 'minor' | 'major';
  deploy: boolean;
  backfillPolicy: 'report-only' | 'allow-safe' | 'require-approval';
  approveHigh: boolean;
  /** Run the production audit after publishing. */
  audit: boolean;
  /** Approve the production environment without asking a human. Off by default. */
  autoApprove: boolean;
  /** Merge strategy — `merge` keeps the two-parent shape the CI tree guard relies on. */
  mergeMethod: 'merge' | 'squash';
  baseBranch: string;
}

export interface ShipRun {
  schema: typeof SHIP_RUN_SCHEMA;
  runId: string;
  /** Absolute path to this run's directory. */
  dir: string;
  startedAt: string;
  endedAt?: string;
  verdict: ShipVerdict;
  inputs: ShipInputs;
  git: {
    branch: string;
    headSha: string;
  };
  pr?: {
    number: number;
    url: string;
    headSha: string;
    merged: boolean;
    mergeSha?: string;
  };
  ci?: WorkflowRunRef;
  mainCi?: WorkflowRunRef;
  release?: WorkflowRunRef & {
    version?: string;
    previousVersion?: string;
  };
  audit?: WorkflowRunRef & {
    /** PASS | BLOCKED_BY_FINDINGS | BLOCKED_BY_AUDIT_ERROR, from audit-verdict.json. */
    verdict?: string;
  };
  stages: ShipStage[];
  failure?: ShipFailure;
}

export interface WorkflowRunRef {
  runId: number;
  url: string;
  status?: string;
  conclusion?: string;
}

/** Event levels. `action` means the run has stopped and needs a human decision. */
export type ShipEventLevel = 'info' | 'warn' | 'error' | 'action';

export interface ShipEvent {
  schema: typeof SHIP_EVENT_SCHEMA;
  seq: number;
  ts: string;
  stage: ShipStageName | 'run';
  event:
    | 'run.start'
    | 'run.end'
    | 'stage.start'
    | 'stage.ok'
    | 'stage.fail'
    | 'stage.skip'
    | 'progress'
    | 'need.approval'
    | 'evidence';
  level: ShipEventLevel;
  /** Pre-rendered single line. The Monitor filter prints this verbatim. */
  line: string;
  /**
   * Whether this event is worth interrupting a human (or Claude) for. Progress
   * chatter is written to the file but never notified.
   */
  notify: boolean;
  data?: Record<string, unknown>;
}
