/**
 * Run-directory layout and the resumable `ship.json` state file.
 *
 *   .claude/ship/
 *     current                  → run id of the shipment in flight (a pointer, not a lock)
 *     runs/<runId>/
 *       ship.json              → this file's ShipRun
 *       ship.ndjson            → the event journal
 *       APPROVE | DENY         → the approval handshake (written by `ship approve|deny`)
 *       ci/failed.log          → failed-step logs, downloaded on failure only
 *       release/…              → release-report.json/md, gate.json, state.json, …
 *       plan/…                 → the pre-approval snapshot (stale by design; never the verdict)
 *       audit/…                → audit-report.json/md, audit-verdict.json, …
 *       SHIP-REPORT.md         → the one file a human or Claude needs to read
 *
 * The directory sits under `.claude/` because that is where Claude already looks for
 * this project's machine-readable run output (`.claude/review/runs/…`), and it is
 * git-ignored: it holds logs, not source.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SHIP_RUN_SCHEMA, SHIP_STAGES, type ShipRun, type ShipStage, type ShipStageName, type ShipStageStatus } from './types.js';

export const SHIP_HOME = '.claude/ship';

export interface RunPaths {
  root: string; // repository root
  home: string; // <root>/.claude/ship
  dir: string; // <home>/runs/<runId>
  stateFile: string;
  journalFile: string;
  reportFile: string;
  approveFile: string;
  denyFile: string;
  ciDir: string;
  releaseDir: string;
  /**
   * The PRE-approval `release-artifacts` snapshot, kept deliberately OUTSIDE releaseDir.
   * At approval time the deploy job has not run, so that snapshot's gate.json is the passing
   * pre-deploy gate and its state.json still says AWAITING_APPROVAL. readArtifact() recurses
   * one directory down, so a copy anywhere under release/ would let the finished run's verdict
   * be read from files that predate the deployment.
   */
  planDir: string;
  auditDir: string;
}

export function runPaths(root: string, runId: string): RunPaths {
  const home = join(root, SHIP_HOME);
  const dir = join(home, 'runs', runId);
  return {
    root,
    home,
    dir,
    stateFile: join(dir, 'ship.json'),
    journalFile: join(dir, 'ship.ndjson'),
    reportFile: join(dir, 'SHIP-REPORT.md'),
    approveFile: join(dir, 'APPROVE'),
    denyFile: join(dir, 'DENY'),
    ciDir: join(dir, 'ci'),
    releaseDir: join(dir, 'release'),
    planDir: join(dir, 'plan'),
    auditDir: join(dir, 'audit'),
  };
}

/** `ship-20260814T164500Z` — sortable, collision-free at one shipment per second. */
export function newRunId(now = new Date()): string {
  return `ship-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

export function initStages(): ShipStage[] {
  return SHIP_STAGES.map((name) => ({ name, status: 'pending' as ShipStageStatus }));
}

export function ensureRunDir(paths: RunPaths): void {
  mkdirSync(paths.dir, { recursive: true });
}

export function saveRun(paths: RunPaths, run: ShipRun): void {
  ensureRunDir(paths);
  // Write-then-rename: a reader tailing this directory never sees a half-written state.
  const tmp = `${paths.stateFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  writeFileSync(paths.stateFile, readFileSync(tmp, 'utf8'), 'utf8');
  rmSync(tmp, { force: true });
}

export function loadRun(paths: RunPaths): ShipRun | null {
  if (!existsSync(paths.stateFile)) return null;
  try {
    const run = JSON.parse(readFileSync(paths.stateFile, 'utf8')) as ShipRun;
    return run.schema === SHIP_RUN_SCHEMA ? run : null;
  } catch {
    return null;
  }
}

export function setCurrent(root: string, runId: string): void {
  const home = join(root, SHIP_HOME);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'current'), `${runId}\n`, 'utf8');
}

export function getCurrent(root: string): string | null {
  const file = join(root, SHIP_HOME, 'current');
  if (!existsSync(file)) return null;
  const id = readFileSync(file, 'utf8').trim();
  return id || null;
}

/** Newest-first run ids. Used by `ship status` when `current` is missing or stale. */
export function listRunIds(root: string): string[] {
  const dir = join(root, SHIP_HOME, 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('ship-'))
    .map((e) => e.name)
    .sort()
    .reverse();
}

export function stage(run: ShipRun, name: ShipStageName): ShipStage {
  const s = run.stages.find((x) => x.name === name);
  if (!s) throw new Error(`unknown stage ${name}`);
  return s;
}

export function markStage(run: ShipRun, name: ShipStageName, status: ShipStageStatus, note?: string): ShipStage {
  const s = stage(run, name);
  const now = new Date().toISOString();
  if (status === 'running' && !s.startedAt) s.startedAt = now;
  if (status !== 'running' && status !== 'pending') s.endedAt = now;
  s.status = status;
  if (note !== undefined) s.note = note;
  return s;
}
