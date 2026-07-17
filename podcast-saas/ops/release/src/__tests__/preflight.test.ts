import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdPreflight, type CommandContext } from '../commands.js';
import { RELEASE_CONFIG } from '../config.js';
import { preflight } from '../preflight.js';
import { REDACTED } from '../redact.js';
import { runCommand, type ExecResult, type Runner } from '../run.js';

const SHA = 'abc123def4567890abc123def4567890abc123de';

type GitResponses = Record<string, Partial<ExecResult>>;

function fakeGit(responses: GitResponses): Runner {
  return async (_cmd, args) => {
    const key = args.join(' ');
    const r = responses[key] ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

const cleanRepo: GitResponses = {
  'status --porcelain': { stdout: '' },
  'rev-parse HEAD': { stdout: `${SHA}\n` },
  'rev-parse origin/main': { stdout: `${SHA}\n` },
  'tag -l': { stdout: 'v0.1.0\nv0.1.1\n' },
  'ls-remote --tags origin refs/tags/v0.1.2': { stdout: '' },
};

const OPTS = {
  cwd: '/repo',
  nextTag: 'v0.1.2',
  rootPackageJson: JSON.stringify({ packageManager: 'pnpm@11.4.0' }),
  lockfileExists: true,
};

describe('preflight source verification', () => {
  it('passes a clean origin/main checkout with a free tag', async () => {
    const res = await preflight(fakeGit(cleanRepo), OPTS);
    expect(res.findings).toEqual([]);
    expect(res.facts.headSha).toBe(SHA);
  });

  it('blocks a dirty working tree', async () => {
    const res = await preflight(fakeGit({ ...cleanRepo, 'status --porcelain': { stdout: ' M src/x.ts\n?? y\n' } }), OPTS);
    expect(res.findings.some((f) => f.id === 'source.dirty-tree' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('blocks when HEAD is not origin/main (divergent or behind)', async () => {
    const res = await preflight(
      fakeGit({ ...cleanRepo, 'rev-parse origin/main': { stdout: 'ffff123def4567890abc123def4567890abc123d\n' } }),
      OPTS,
    );
    expect(res.findings.some((f) => f.id === 'source.not-origin-main')).toBe(true);
  });

  it('blocks when the tag exists locally or remotely', async () => {
    const local = await preflight(fakeGit({ ...cleanRepo, 'tag -l': { stdout: 'v0.1.2\n' } }), OPTS);
    expect(local.findings.some((f) => f.id === 'source.tag-exists-local')).toBe(true);

    const remote = await preflight(
      fakeGit({ ...cleanRepo, 'ls-remote --tags origin refs/tags/v0.1.2': { stdout: `${SHA}\trefs/tags/v0.1.2\n` } }),
      OPTS,
    );
    expect(remote.findings.some((f) => f.id === 'source.tag-exists-remote')).toBe(true);
  });

  it('flags missing determinism pins', async () => {
    const res = await preflight(fakeGit(cleanRepo), {
      ...OPTS,
      rootPackageJson: JSON.stringify({}),
      lockfileExists: false,
    });
    expect(res.findings.some((f) => f.id === 'source.no-package-manager-pin')).toBe(true);
    expect(res.findings.some((f) => f.id === 'source.no-lockfile' && f.severity === 'CRITICAL')).toBe(true);
  });
});

/**
 * Regression for release run 29602969853: the workflow writes plan.json and
 * state.json into $ART (<workspace>/release-artifacts) BEFORE preflight, so an
 * un-ignored artifact dir made preflight block the release as source.dirty-tree.
 * These tests run the REAL preflight against a real sandbox repo whose
 * .gitignore mirrors the monorepo root's `/release-artifacts/` rule.
 */
describe('preflight vs the pipeline’s own release-artifacts (real git)', () => {
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'ci@test.invalid');
    git('config', 'user.name', 'ci');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, '.gitignore'), '/release-artifacts/\n');
    writeFileSync(join(dir, 'file.txt'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    const origin = mkdtempSync(join(tmpdir(), 'preflight-origin-'));
    execFileSync('git', ['clone', '-q', '--bare', dir, origin], { stdio: 'pipe' });
    git('remote', 'add', 'origin', origin);
    git('fetch', '-q', 'origin');
    return dir;
  }

  const REAL_OPTS = {
    nextTag: 'v0.1.0',
    rootPackageJson: JSON.stringify({ packageManager: 'pnpm@11.4.0' }),
    lockfileExists: true,
  };

  it('ignored release-artifacts (plan.json, state.json) are NOT a dirty tree', async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'release-artifacts'));
    writeFileSync(join(dir, 'release-artifacts', 'plan.json'), '{"fixture":true}\n');
    writeFileSync(join(dir, 'release-artifacts', 'state.json'), '{"fixture":true}\n');
    const res = await preflight(runCommand, { cwd: dir, ...REAL_OPTS });
    expect(res.findings).toEqual([]);
    expect(res.facts.dirtyFiles).toBe(0);
  });

  it('a genuinely untracked source file next to ignored artifacts still blocks', async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'release-artifacts'));
    writeFileSync(join(dir, 'release-artifacts', 'plan.json'), '{"fixture":true}\n');
    writeFileSync(join(dir, 'stray.ts'), 'export {};\n');
    const res = await preflight(runCommand, { cwd: dir, ...REAL_OPTS });
    expect(res.findings.some((f) => f.id === 'source.dirty-tree' && f.severity === 'CRITICAL')).toBe(true);
  });
});

describe('cmdPreflight diagnostics', () => {
  function makeCtx(run: Runner, lines: string[]): CommandContext {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-ctx-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.4.0' }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    return { run, fetchImpl: fetch, config: RELEASE_CONFIG, monorepoRoot: dir, appRoot: dir, log: (m) => lines.push(m) };
  }

  it('logs every finding in full so a failed preflight is diagnosable from the run log', async () => {
    const lines: string[] = [];
    const ctx = makeCtx(fakeGit({ ...cleanRepo, 'status --porcelain': { stdout: '?? release-artifacts/\n' } }), lines);
    const { exitCode } = await cmdPreflight(ctx, { nextTag: 'v0.1.2' });
    expect(exitCode).toBe(1);
    const log = lines.join('\n');
    expect(log).toContain('[CRITICAL] source.dirty-tree');
    expect(log).toContain('Working tree is dirty');
  });

  it('redacts credentials that reach a finding detail (git remote stderr)', async () => {
    const lines: string[] = [];
    const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_'); // fixture, split so scanners never match source
    const ctx = makeCtx(
      fakeGit({
        ...cleanRepo,
        'ls-remote --tags origin refs/tags/v0.1.2': { code: 128, stderr: `fatal: could not read from https://x:${token}@github.com/` },
      }),
      lines,
    );
    await cmdPreflight(ctx, { nextTag: 'v0.1.2' });
    const log = lines.join('\n');
    expect(log).toContain('source.ls-remote-failed');
    expect(log).not.toContain(token);
    expect(log).toContain(REDACTED);
  });
});
