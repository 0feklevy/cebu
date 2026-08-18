/**
 * Evidence collection.
 *
 * When a stage fails, the conductor's job is to leave behind everything needed to
 * explain the failure without anyone opening a browser: the failed-step logs, the
 * deterministic JSON the release engine already produced, and a pointer to which
 * jobs actually failed.
 *
 * Collection is best-effort by design — a missing artifact must degrade the report,
 * never abort the run and lose the failure that prompted it. But "best effort" here
 * means *recorded* effort: every gap is written into the returned notes, so a report
 * can never quietly imply it had evidence it never got.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Gh, JobSummary } from './gh.js';

export interface Collected {
  /** Run-directory-relative paths that now exist. */
  evidence: string[];
  /** Human-readable notes about anything that could not be collected. */
  notes: string[];
  failedJobs: { name: string; conclusion: string; url?: string }[];
}

export async function collectRunEvidence(args: {
  gh: Gh;
  runId: number;
  runDir: string;
  destDir: string;
  artifactNames: readonly string[];
  /** Jobs already known from a `viewRun` call, to avoid a second round trip. */
  jobs?: JobSummary[];
}): Promise<Collected> {
  const { gh, runId, runDir, destDir, artifactNames } = args;
  const evidence: string[] = [];
  const notes: string[] = [];
  mkdirSync(destDir, { recursive: true });

  let jobs = args.jobs;
  if (!jobs) {
    try {
      jobs = (await gh.viewRun(runId)).jobs;
    } catch (err) {
      notes.push(`could not list jobs for run ${runId}: ${errText(err)}`);
      jobs = [];
    }
  }
  const failedJobs = jobs
    .filter((j) => j.conclusion !== null && j.conclusion !== 'success' && j.conclusion !== 'skipped')
    .map((j) => ({ name: j.name, conclusion: j.conclusion ?? 'unknown', url: j.url }));

  // Failed-step logs. GitHub returns nothing when a run was cancelled before any step
  // produced output, so an empty body is recorded rather than written as a misleading
  // empty file.
  try {
    const log = await gh.failedLog(runId);
    if (log.trim()) {
      const file = join(destDir, 'failed.log');
      writeFileSync(file, log, 'utf8');
      evidence.push(relative(runDir, file));
    } else {
      notes.push(`run ${runId} exposed no failed-step logs (cancelled or timed out before a step ran)`);
    }
  } catch (err) {
    notes.push(`failed-step logs unavailable for run ${runId}: ${errText(err)}`);
  }

  // Deterministic artifacts — the release engine's own JSON reports.
  //
  // EVERY published name is downloaded, because the names are complements, not alternatives:
  // `release-report` is uploaded as `release-artifacts/release-report.*` (release.yml:565) and
  // therefore carries neither gate.json nor state.json, which live only in `release-artifacts`.
  // Stopping at the first name that downloaded left the conductor without the gate verdict and
  // without the final state, so a rolled-back post-deploy gate was reported as a failed deploy —
  // the wrong cause, at the moment cause matters most.
  const available = await gh.listArtifactNames(runId);
  let downloaded = 0;
  const failedNames: string[] = [];
  for (const name of artifactNames) {
    // A name this run never published is not a gap: the list carries per-run and generic
    // spellings of the same artifact, and only one of them can exist.
    if (available.length > 0 && !available.includes(name)) continue;
    if (await gh.downloadArtifact(runId, name, destDir)) downloaded += 1;
    else failedNames.push(name);
  }
  if (downloaded === 0) {
    notes.push(
      available.length === 0
        ? `run ${runId} published no artifacts (it failed before the upload step)`
        : `none of [${artifactNames.join(', ')}] could be downloaded from run ${runId}; available: ${available.join(', ')}`,
    );
  } else if (failedNames.length > 0) {
    notes.push(`run ${runId} published [${failedNames.join(', ')}] but they could not be downloaded; the report is missing whatever they carried`);
  }

  for (const f of listFilesShallow(destDir)) evidence.push(relative(runDir, f));

  return { evidence: dedupe(evidence), notes, failedJobs };
}

/** Read a JSON artifact the release engine wrote, if collection produced it. */
export function readArtifact<T>(dir: string, ...names: string[]): T | null {
  for (const name of names) {
    const direct = join(dir, name);
    if (existsSync(direct)) {
      try {
        return JSON.parse(readFileSync(direct, 'utf8')) as T;
      } catch {
        return null;
      }
    }
  }
  // Artifacts sometimes unpack one level down (release-artifacts/…).
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = readArtifact<T>(join(dir, entry.name), ...names);
    if (found) return found;
  }
  return null;
}

function listFilesShallow(dir: string, depth = 2): string[] {
  if (depth < 0 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesShallow(p, depth - 1));
    else if (statSync(p).size > 0) out.push(p);
  }
  return out;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
