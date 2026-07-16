import { describe, expect, it } from 'vitest';
import { preflight } from '../preflight.js';
import type { ExecResult, Runner } from '../run.js';

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
