/**
 * Evidence identity — proving that an artifact describes THIS run, at THIS commit.
 *
 * The audit and release gates consume JSON artifacts written by earlier steps. Two
 * different failures were previously indistinguishable from "clean":
 *
 *   1. the producing step never ran (or crashed), so the file is simply absent, and
 *      `collectFindingsFromFiles` skipped it with `if (!existsSync(file)) continue`;
 *   2. a file from an EARLIER run rode in (downloaded release-artifacts, a re-run on a
 *      dirty workspace) and was read as if it described the current deployment.
 *
 * Both mean "no verification happened", and both used to read as "no findings". This
 * module makes the absence of evidence a CRITICAL finding rather than silence, and
 * binds every artifact that can carry identity to a run id and a commit sha.
 *
 * Ported from the unmerged `fix/playwright-release-summary` branch (a245b9c) and
 * modernised: `createdAt` is the canonical timestamp field, and the artifact stamp is
 * shared by every producer rather than being specific to playwright-summary.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { finding, type Finding } from './severity.js';

/** Run identity that current evidence must match. */
export interface EvidenceExpectation {
  runId?: string;
  gitSha?: string;
}

/** The identity envelope every audit/release artifact carries. */
export interface ArtifactIdentity {
  schema: string;
  runId?: string;
  gitSha?: string;
  createdAt: string;
}

/**
 * Stamp a payload with its schema and run identity.
 *
 * `createdAt` is always present; `runId`/`gitSha` are omitted rather than written as
 * undefined so that "carries no identity" stays distinguishable from "identity is
 * empty" when the gate later inspects the file.
 */
export function stampArtifact<T extends object>(
  schema: string,
  payload: T,
  identity: EvidenceExpectation & { now?: () => Date } = {},
): T & ArtifactIdentity {
  const now = identity.now ?? (() => new Date());
  return {
    schema,
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(identity.gitSha ? { gitSha: identity.gitSha } : {}),
    createdAt: now().toISOString(),
    ...payload,
  };
}

/** Read `createdAt`/`generatedAt` as epoch ms, or null when absent/unparseable. */
function createdAtMs(doc: Record<string, unknown>): number | null {
  const raw = (doc.createdAt ?? doc.generatedAt) as string | undefined;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

export interface EvidenceOptions {
  /** Basenames that MUST carry a matching run identity (not merely match if present). */
  identityBearing?: readonly string[];
  /**
   * Reject evidence older than this many milliseconds. Off by default: a correct
   * runId/gitSha match is the strong check, and wall-clock skew between a runner and
   * an artifact is not by itself proof of staleness.
   */
  maxAgeMs?: number;
  /** Injectable clock for freshness tests. */
  now?: () => Date;
}

/**
 * Require each named evidence file to exist, parse, and — where it can carry identity —
 * belong to the current run and commit.
 *
 * Fails closed: every negative outcome is a CRITICAL finding, so the gate blocks rather
 * than treating unverifiable evidence as a pass. The finding ids are stable and are
 * asserted by tests, because they are what an operator greps for:
 *
 *   evidence.missing       the file is not there at all
 *   evidence.unreadable    present but not valid JSON
 *   evidence.no-identity   identity-bearing file with no runId
 *   evidence.no-commit     identity-bearing file with no gitSha
 *   evidence.stale-run     produced by a different run
 *   evidence.stale-commit  produced for a different commit
 *   evidence.stale-time    older than an explicit freshness bound
 */
export function checkRequiredEvidence(
  files: readonly string[],
  expect: EvidenceExpectation = {},
  options: EvidenceOptions | readonly string[] = {},
): Finding[] {
  // Tolerate the ported call shape (third arg = identityBearing array) so this function
  // can be adopted incrementally without a flag-day change at every call site.
  const opts: EvidenceOptions = Array.isArray(options) ? { identityBearing: options } : (options as EvidenceOptions);
  const identityBearing = opts.identityBearing ?? [];
  const now = opts.now ?? (() => new Date());

  const findings: Finding[] = [];
  for (const file of files) {
    const name = basename(file);
    if (!existsSync(file)) {
      findings.push(
        finding('evidence.missing', 'CRITICAL', 'evidence', `Required evidence "${name}" is missing — this run cannot be verified.`, {
          detail: file,
          remediation: 'Ensure the producing step ran and wrote this artifact before the gate; never treat an absent artifact as "no findings".',
        }),
      );
      continue;
    }

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      findings.push(
        finding('evidence.unreadable', 'CRITICAL', 'evidence', `Required evidence "${name}" is not valid JSON — it cannot be trusted as verification.`, {
          detail: file,
          remediation: 'Inspect the producing step; a truncated or partially-written artifact is an audit error, not a pass.',
        }),
      );
      continue;
    }

    // A collector that failed writes a placeholder so downstream steps read JSON instead
    // of throwing ENOENT. That placeholder must never be mistaken for verification: it
    // proves the opposite, so it is called out explicitly rather than passing the
    // "exists and parses" checks above.
    if (doc.auditError === true) {
      findings.push(
        finding('evidence.collector-error', 'CRITICAL', 'evidence', `Evidence "${name}" is an error placeholder — the collector that should have produced it failed.`, {
          detail: typeof doc.reason === 'string' ? doc.reason : file,
          remediation: 'Fix the failing collector. An error placeholder is not a clean result.',
        }),
      );
      continue;
    }

    const seenRun = (doc.runId ?? doc.expectedRunId) as string | undefined;
    const seenSha = (doc.gitSha ?? doc.expectedGitSha) as string | undefined;
    const mustHaveIdentity = identityBearing.includes(name);

    if (expect.runId !== undefined) {
      if (seenRun === undefined) {
        if (mustHaveIdentity) {
          findings.push(
            finding('evidence.no-identity', 'CRITICAL', 'evidence', `Evidence "${name}" carries no run id — cannot confirm it belongs to run ${expect.runId}.`, {
              detail: file,
            }),
          );
        }
      } else if (seenRun !== expect.runId) {
        findings.push(
          finding('evidence.stale-run', 'CRITICAL', 'evidence', `Evidence "${name}" was produced by run ${seenRun}, not the current run ${expect.runId} — refusing stale evidence.`, {
            detail: file,
          }),
        );
      }
    }

    if (expect.gitSha !== undefined) {
      if (seenSha === undefined) {
        if (mustHaveIdentity) {
          findings.push(
            finding('evidence.no-commit', 'CRITICAL', 'evidence', `Evidence "${name}" carries no git sha — cannot confirm it belongs to commit ${expect.gitSha}.`, {
              detail: file,
            }),
          );
        }
      } else if (seenSha !== expect.gitSha) {
        findings.push(
          finding('evidence.stale-commit', 'CRITICAL', 'evidence', `Evidence "${name}" was produced for commit ${seenSha}, not ${expect.gitSha} — refusing stale evidence.`, {
            detail: file,
          }),
        );
      }
    }

    if (opts.maxAgeMs !== undefined) {
      const ms = createdAtMs(doc);
      if (ms !== null && now().getTime() - ms > opts.maxAgeMs) {
        findings.push(
          finding('evidence.stale-time', 'CRITICAL', 'evidence', `Evidence "${name}" is older than the freshness bound — refusing stale evidence.`, {
            detail: file,
          }),
        );
      }
    }
  }
  return findings;
}
