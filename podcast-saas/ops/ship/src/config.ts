/**
 * Deterministic configuration for the ship conductor.
 *
 * Only public facts live here: repository, branch names, workflow filenames, artifact
 * names, and poll intervals. No secrets, no hostnames the release engine already owns.
 */

export interface ShipConfig {
  /** owner/name. */
  repo: string;
  baseBranch: string;
  /** Branch names a shipment may never start from. */
  protectedBranches: readonly string[];
  workflows: {
    ci: string;
    release: string;
    audit: string;
    rollback: string;
  };
  /**
   * GitHub Actions artifact names to collect. ALL of them are downloaded — they are
   * complementary parts of one evidence set, not fallbacks for each other (see collect.ts).
   * A name the run did not publish is skipped silently.
   */
  artifacts: {
    release: readonly string[];
    audit: readonly string[];
  };
  /** The environment whose approval gates production. */
  productionEnvironment: string;
  poll: {
    /** GitHub API polling. 15s keeps a 40-minute pipeline well under rate limits. */
    intervalMs: number;
    /** Local file polling for the approval handshake. */
    approvalIntervalMs: number;
    /** Ceilings per stage. Reaching one is a FAILED conductor verdict, never a pass. */
    ciTimeoutMs: number;
    releaseTimeoutMs: number;
    auditTimeoutMs: number;
    approvalTimeoutMs: number;
    /** How long to wait for a dispatched run to appear in the runs list. */
    dispatchAppearMs: number;
  };
}

export const SHIP_CONFIG: ShipConfig = {
  repo: '0feklevy/cebu',
  baseBranch: 'main',
  protectedBranches: ['main', 'master'],
  workflows: {
    ci: 'ci.yml',
    release: 'release.yml',
    audit: 'production-audit.yml',
    rollback: 'rollback.yml',
  },
  artifacts: {
    release: ['release-report', 'release-artifacts'],
    audit: ['production-audit'],
  },
  productionEnvironment: 'production',
  poll: {
    intervalMs: 15_000,
    approvalIntervalMs: 3_000,
    ciTimeoutMs: 45 * 60_000,
    releaseTimeoutMs: 120 * 60_000,
    auditTimeoutMs: 60 * 60_000,
    approvalTimeoutMs: 12 * 60 * 60_000,
    dispatchAppearMs: 3 * 60_000,
  },
};

/**
 * Release jobs, in the order they run, split at the approval gate.
 *
 * The conductor watches named jobs rather than the run's overall conclusion so it can
 * tell "waiting for a human" apart from "still building" apart from "died in verify" —
 * a single `conclusion` field cannot express that difference, and treating a
 * long-pending run as healthy is how a stuck release goes unnoticed for an hour.
 */
export const RELEASE_JOBS_BEFORE_APPROVAL = [
  'Plan & verify source',
  'Full release verification (tests + prod builds + bundle scan)',
  'Build & push backend',
  'Build & push client-web',
  'Build & push admin-web',
  'Manifest, tag & draft release',
] as const;

export const RELEASE_JOB_DEPLOY = 'Deploy to production (digest-pinned)';
export const RELEASE_JOB_PUBLISH = 'Publish GitHub release';
export const RELEASE_JOB_REPORT = 'Release report';

/** Maps a failed release job to the failure kind the report should carry. */
export function releaseJobFailureKind(jobName: string): 'release-verify' | 'build-images' | 'deploy-failed' | 'gate-blocked' | 'conductor' {
  if (jobName.startsWith('Build & push')) return 'build-images';
  if (jobName.startsWith('Full release verification') || jobName.startsWith('Plan & verify')) return 'release-verify';
  if (jobName === RELEASE_JOB_DEPLOY) return 'deploy-failed';
  if (jobName === RELEASE_JOB_PUBLISH || jobName === 'Manifest, tag & draft release') return 'conductor';
  return 'conductor';
}
