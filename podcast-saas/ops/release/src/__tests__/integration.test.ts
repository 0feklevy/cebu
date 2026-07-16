import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cmdGate,
  cmdImageManifestVerify,
  cmdReport,
  cmdStateInit,
  cmdStateTransition,
  writeJsonFile,
  type CommandContext,
  type VmAudit,
} from '../commands.js';
import { RELEASE_CONFIG } from '../config.js';
import { setOutput } from '../gha.js';
import { buildManifest } from '../image-manifest.js';
import { deployImages, runProductionAudit, type Executor, type RemoteResult } from '../remote-deploy.js';
import { cmdRemoteBackfill } from '../remote-commands.js';
import { finding } from '../severity.js';
import { runCommand } from '../run.js';

let dir: string;

function ctx(): CommandContext {
  return {
    run: runCommand,
    fetchImpl: fetch,
    config: RELEASE_CONFIG,
    monorepoRoot: dir,
    appRoot: dir,
    log: () => {},
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relops-'));
});

const D = (c: string) => `sha256:${c.repeat(64)}`;
const MANIFEST = buildManifest({
  version: 'v0.1.3',
  gitSha: 'a'.repeat(40),
  images: [
    { service: 'backend', repository: 'ghcr.io/0feklevy/cebu/backend', tag: 'v0.1.3', digest: D('1') },
    { service: 'client-web', repository: 'ghcr.io/0feklevy/cebu/client-web', tag: 'v0.1.3', digest: D('2') },
    { service: 'admin-web', repository: 'ghcr.io/0feklevy/cebu/admin-web', tag: 'v0.1.3', digest: D('3') },
  ],
});

/** Scripted executor: records every call, plays back queued results. */
class FakeExecutor implements Executor {
  calls: Array<{ command: string[]; stdin?: string }> = [];
  queue: RemoteResult[] = [];
  describe() {
    return 'fake';
  }
  async exec(command: string[], opts?: { stdin?: string }): Promise<RemoteResult> {
    this.calls.push({ command, stdin: opts?.stdin });
    return this.queue.shift() ?? { code: 0, stdout: '', stderr: '' };
  }
}

describe('SSH executor contract (mocked)', () => {
  it('deployImages sends the token+manifest as a stdin envelope, never in argv', async () => {
    const exec = new FakeExecutor();
    const res = await deployImages(exec, {
      manifest: MANIFEST,
      ghcrUser: 'octocat',
      ghcrToken: 'ghp_supersecrettoken12345678',
      remoteRepoDir: '/home/ubuntu/cebu',
    });
    expect(res.ok).toBe(true);
    const call = exec.calls[0];
    expect(call.command.join(' ')).toBe('bash /home/ubuntu/cebu/podcast-saas/deploy/scripts/deploy-images.sh --stdin-envelope');
    expect(call.command.join(' ')).not.toContain('ghp_');
    const envelope = JSON.parse(call.stdin!);
    expect(envelope.ghcrToken).toBe('ghp_supersecrettoken12345678');
    expect(envelope.manifest.images).toHaveLength(3);
    expect(envelope.skipMigrations).toBe(false);
  });

  it('runProductionAudit returns the VM JSON document from stdout', async () => {
    const exec = new FakeExecutor();
    exec.queue.push({ code: 0, stdout: '{"schema":"flowvid.vm-audit/v1","containers":{}}', stderr: 'log noise' });
    const res = await runProductionAudit(exec, '/repo');
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.json).schema).toBe('flowvid.vm-audit/v1');
  });

  it('remote-backfill maps VM exit codes (0 ok / 2 blocked) and stores the JSON report', async () => {
    const exec = new FakeExecutor();
    exec.queue.push({ code: 2, stdout: '{"schema":"flowvid.url-backfill-report/v1","totalAffected":8}', stderr: 'BLOCKED' });
    const out = join(dir, 'backfill.json');
    const code = await cmdRemoteBackfill(
      ctx(),
      { host: 'h', user: 'u', keyPath: 'k', repoDir: '/repo', mode: 'apply', out },
      () => exec,
    );
    expect(code).toBe(2); // blocked by policy — surfaced, not swallowed
    expect(JSON.parse(readFileSync(out, 'utf8')).totalAffected).toBe(8);
    // apply mode without approval must NOT pass --approve-unsafe
    expect(exec.calls[0].command).toContain('--apply');
    expect(exec.calls[0].command).not.toContain('--approve-unsafe');
  });
});

describe('GitHub outputs (mocked GITHUB_OUTPUT)', () => {
  const prev = process.env.GITHUB_OUTPUT;
  afterEach(() => {
    if (prev === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prev;
  });

  it('writes heredoc-delimited outputs and redacts secrets', () => {
    const file = join(dir, 'gh-output');
    writeFileSync(file, '');
    process.env.GITHUB_OUTPUT = file;
    setOutput('next_tag', 'v0.1.3');
    setOutput('oops', 'token is ghp_abcdefghijklmnopqrst123456');
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('next_tag<<EOF_next_tag\nv0.1.3\nEOF_next_tag');
    expect(content).not.toContain('ghp_abcdefghijklmnopqrst123456');
  });
});

describe('gate flows (health/smoke failure → automatic rollback decision)', () => {
  it('backend unhealthy (VM audit) blocks post-deploy and demands rollback', () => {
    const f1 = join(dir, 'vm-findings.json');
    writeJsonFile(f1, { findings: [finding('vm.backend-unhealthy', 'CRITICAL', 'health', 'backend is restarting')] });
    const res = cmdGate(ctx(), { findingsFiles: [f1], phase: 'post-deploy', out: join(dir, 'gate.json') });
    expect(res.exitCode).toBe(1);
    expect(res.decision.blocked).toBe(true);
    expect(res.decision.shouldRollback).toBe(true);
  });

  it('smoke-test failure blocks; missing findings files are tolerated', () => {
    const f1 = join(dir, 'playwright-summary.json');
    writeJsonFile(f1, { total: 6, passed: 5, failed: 1, skipped: 0, failures: ['audit: public homepage'], findings: [finding('playwright.failures', 'CRITICAL', 'browser', '1 test failed')] });
    const res = cmdGate(ctx(), { findingsFiles: [f1, join(dir, 'does-not-exist.json')], phase: 'post-deploy' });
    expect(res.decision.shouldRollback).toBe(true);
  });

  it('clean production passes the post-deploy gate', () => {
    const f1 = join(dir, 'empty.json');
    writeJsonFile(f1, { findings: [] });
    const res = cmdGate(ctx(), { findingsFiles: [f1], phase: 'post-deploy' });
    expect(res.exitCode).toBe(0);
    expect(res.decision.shouldRollback).toBe(false);
  });
});

describe('interrupted / resumed run (state persistence)', () => {
  it('resumes from the persisted file and explains exactly where it stopped', () => {
    const file = join(dir, 'state.json');
    cmdStateInit(ctx(), { file, runId: 'rel-99', version: 'v0.1.3', gitSha: 'a'.repeat(40), bump: 'patch' });
    for (const to of ['SOURCE_VERIFIED', 'TESTED', 'IMAGES_BUILT', 'IMAGES_PUBLISHED'] as const) {
      cmdStateTransition(ctx(), { file, to });
    }
    // …the workflow is interrupted here; a later job reloads the same file.
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    expect(persisted.state).toBe('IMAGES_PUBLISHED');
    expect(persisted.history.map((h: { state: string }) => h.state)).toEqual([
      'PLANNED', 'SOURCE_VERIFIED', 'TESTED', 'IMAGES_BUILT', 'IMAGES_PUBLISHED',
    ]);
    // Non-idempotent stages refuse to silently rerun on resume.
    expect(() => cmdStateTransition(ctx(), { file, to: 'IMAGES_PUBLISHED' })).toThrow(/Illegal|not idempotent/);
  });
});

describe('image manifest verification via CLI handler', () => {
  it('accepts a valid manifest file and rejects a tampered digest', () => {
    const good = join(dir, 'manifest.json');
    writeJsonFile(good, MANIFEST);
    expect(cmdImageManifestVerify(ctx(), { manifestFile: good }).exitCode).toBe(0);

    const bad = join(dir, 'tampered.json');
    writeJsonFile(bad, { ...MANIFEST, images: [{ ...MANIFEST.images[0], digest: 'sha256:beef' }, ...MANIFEST.images.slice(1)] });
    expect(cmdImageManifestVerify(ctx(), { manifestFile: bad }).exitCode).toBe(1);
  });
});

describe('report assembly (full artifacts directory)', () => {
  it('merges every stage artifact into release-report.{json,md} with redaction + derived stages', () => {
    const art = join(dir, 'artifacts');
    writeJsonFile(join(art, 'plan.json'), { schema: 'flowvid.release-plan/v1', bump: 'patch', currentTag: 'v0.1.2', nextTag: 'v0.1.3', gitSha: 'a'.repeat(40) });
    const state = join(art, 'state.json');
    cmdStateInit(ctx(), { file: state, runId: 'rel-100', version: 'v0.1.3' });
    cmdStateTransition(ctx(), { file: state, to: 'SOURCE_VERIFIED' });
    cmdStateTransition(ctx(), { file: state, to: 'FAILED', note: 'verify failed' });
    writeJsonFile(join(art, 'image-manifest.json'), { manifest: MANIFEST, findings: [] });
    const vm: VmAudit = {
      schema: 'flowvid.vm-audit/v1',
      containers: { backend: 'healthy', worker: 'running', 'client-web': 'healthy', 'admin-web': 'healthy', nginx: 'healthy', certbot: 'running' },
      backendHealth: { ok: true },
      workerRunning: true,
      diskFreeGb: 14,
      certDaysRemaining: { 'flowvidco.com': 55 },
      urlBackfill: null,
    };
    writeJsonFile(join(art, 'vm-audit.json'), vm);
    writeJsonFile(join(art, 'gate.json'), {
      decision: { blocked: true, shouldRollback: false, counts: { CRITICAL: 1, HIGH: 0, WARNING: 0, INFO: 0 }, reasons: ['1 CRITICAL'] },
      findings: [],
    });
    writeJsonFile(join(art, 'secret-scan.json'), {
      findings: [finding('csp.client-web.frame-src.missing-firebase-auth-origin', 'CRITICAL', 'csp', 'CSP blocks Firebase auth', { detail: 'postgres://u:hunter2@db.example/x' })],
    });
    writeJsonFile(join(art, 'playwright-summary.json'), { total: 6, passed: 5, failed: 1, skipped: 0, failures: ['audit: login entry point'], findings: [] });

    const { report } = cmdReport(ctx(), {
      dir: art,
      meta: { runId: 'rel-100', bump: 'patch', deploy: true, backfillPolicy: 'report-only', actor: 'tester' },
      outJson: join(dir, 'release-report.json'),
      outMd: join(dir, 'release-report.md'),
    });

    expect(report.schema).toBe('flowvid.release-report/v1');
    expect(report.state).toBe('FAILED');
    expect(report.version).toBe('v0.1.3');
    expect(report.images).toHaveLength(3);
    expect(report.stages.length).toBeGreaterThan(0); // derived from state history
    expect(report.findings[0].severity).toBe('CRITICAL');
    expect(report.failing?.test).toBe('audit: login entry point');
    expect(report.deployment?.serviceHealth?.backend).toBe('healthy');

    const raw = readFileSync(join(dir, 'release-report.json'), 'utf8');
    expect(raw).not.toContain('hunter2'); // DB credentials never survive redaction
    const md = readFileSync(join(dir, 'release-report.md'), 'utf8');
    expect(md).toContain('# Release report — v0.1.3');
    expect(md).toContain('Blocked: **YES**');
    expect(md).not.toContain('hunter2');
  });
});
