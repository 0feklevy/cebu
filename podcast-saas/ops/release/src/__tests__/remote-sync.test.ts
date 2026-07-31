import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  REMOTE_SYNC_SCRIPT,
  REMOTE_SYNC_STAGES,
  SshExecutor,
  parseReachedStages,
  syncRemoteCheckout,
  type Executor,
  type RemoteResult,
} from '../remote-deploy.js';
import { cmdRemoteSync } from '../remote-commands.js';
import type { CommandContext } from '../commands.js';

/**
 * Regression coverage for the v0.1.8 deploy failure: `remote-sync` hung for the full
 * 5-minute timeout because the VM-side `git fetch` blocked on a credential / host-key
 * prompt (GIT_TERMINAL_PROMPT was never set). These tests lock in the fix: fully
 * non-interactive, staged, bounded, HEAD-verified sync — and prove a sync failure never
 * touches containers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — syncRemoteCheckout / cmdRemoteSync over a fake Executor (no SSH, no VM)
// ─────────────────────────────────────────────────────────────────────────────

const SHA = 'a'.repeat(40);
const REPO = '/home/ubuntu/cebu';

class FakeExecutor implements Executor {
  public calls: { command: string[]; opts: { stdin?: string; timeoutMs?: number } }[] = [];
  constructor(private readonly reply: RemoteResult) {}
  describe(): string {
    return 'fake';
  }
  exec(command: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RemoteResult> {
    this.calls.push({ command, opts });
    return Promise.resolve(this.reply);
  }
}

const allMarkers = REMOTE_SYNC_STAGES.join('\n') + '\n';

function captureCtx(): { ctx: CommandContext; logs: string[] } {
  const logs: string[] = [];
  const ctx = { log: (m: string) => logs.push(m) } as unknown as CommandContext;
  return { ctx, logs };
}

describe('syncRemoteCheckout — command shape and non-interactive contract', () => {
  it('sends the staged script on stdin with (repo, sha, timeouts) as positional args', async () => {
    const fake = new FakeExecutor({ code: 0, stdout: allMarkers, stderr: '' });
    await syncRemoteCheckout(fake, REPO, SHA);
    expect(fake.calls).toHaveLength(1);
    const { command, opts } = fake.calls[0];
    expect(command.slice(0, 5)).toEqual(['bash', '-s', '--', REPO, SHA]);
    expect(command.slice(5)).toEqual(['20', '120', '30']); // ls-remote / fetch / fallback bounds
    expect(opts.stdin).toBe(REMOTE_SYNC_SCRIPT);
  });

  it('does NOT merely raise the timeout — the outer bound is shorter than the old 5 minutes', async () => {
    const fake = new FakeExecutor({ code: 0, stdout: allMarkers, stderr: '' });
    await syncRemoteCheckout(fake, REPO, SHA);
    const timeoutMs = fake.calls[0].opts.timeoutMs ?? Infinity;
    expect(timeoutMs).toBeLessThan(5 * 60 * 1000);
  });

  it('the script itself prevents every interactive prompt (GIT_TERMINAL_PROMPT + BatchMode)', () => {
    expect(REMOTE_SYNC_SCRIPT).toContain('GIT_TERMINAL_PROMPT=0');
    expect(REMOTE_SYNC_SCRIPT).toContain('BatchMode=yes');
    expect(REMOTE_SYNC_SCRIPT).toContain('GCM_INTERACTIVE=never');
    // It performs git only — never docker/compose — so a failure cannot touch containers.
    expect(REMOTE_SYNC_SCRIPT).not.toMatch(/\bdocker\b/);
    expect(REMOTE_SYNC_SCRIPT).not.toMatch(/\bcompose\b/);
  });

  it('refuses a non-hex ref without ever contacting the VM', async () => {
    const fake = new FakeExecutor({ code: 0, stdout: '', stderr: '' });
    const res = await syncRemoteCheckout(fake, REPO, 'not-a-real-sha; rm -rf /');
    expect(res.ok).toBe(false);
    expect(res.connected).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(res.result.stderr).toContain('suspicious ref');
  });
});

describe('syncRemoteCheckout — outcome classification', () => {
  it('SSH connection failure ⇒ connected=false, no stages reached', async () => {
    const fake = new FakeExecutor({ code: 255, stdout: '', stderr: 'ssh: connect to host 44.225.68.155 port 22: Connection timed out' });
    const res = await syncRemoteCheckout(fake, REPO, SHA);
    expect(res.ok).toBe(false);
    expect(res.connected).toBe(false);
    expect(res.stagesReached).toEqual([]);

    const { ctx, logs } = captureCtx();
    const code = await cmdRemoteSync(ctx, { host: 'h', user: 'ubuntu', keyPath: 'k', repoDir: REPO, gitSha: SHA }, () => fake);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('SSH_CONNECT: FAILED');
  });

  it('a mid-stage hang (SIGKILL) is pinned to the exact stage reached', async () => {
    // The VM connected and got as far as the fetch, then the outer bound killed it.
    const partial = 'SSH_CONNECT\nVERIFY_REMOTE_REPOSITORY\nCHECK_REMOTE_STATUS\nFETCH_TARGET_SHA\n';
    const fake = new FakeExecutor({ code: 137, stdout: partial, stderr: '' });
    const res = await syncRemoteCheckout(fake, REPO, SHA);
    expect(res.ok).toBe(false);
    expect(res.connected).toBe(true);
    expect(res.lastStage).toBe('FETCH_TARGET_SHA');
  });

  it('full marker trail + exit 0 ⇒ ok, and cmdRemoteSync returns 0', async () => {
    const fake = new FakeExecutor({ code: 0, stdout: allMarkers, stderr: '' });
    const res = await syncRemoteCheckout(fake, REPO, SHA);
    expect(res.ok).toBe(true);
    expect(res.connected).toBe(true);
    expect(res.lastStage).toBe('REMOTE_SYNC_COMPLETE');

    const { ctx, logs } = captureCtx();
    const code = await cmdRemoteSync(ctx, { host: 'h', user: 'ubuntu', keyPath: 'k', repoDir: REPO, gitSha: SHA }, () => fake);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('remote-sync: ok');
  });

  it('parseReachedStages reports only the markers actually present, in order', () => {
    expect(parseReachedStages('SSH_CONNECT\nnoise\nCHECK_REMOTE_STATUS\n')).toEqual(['SSH_CONNECT', 'CHECK_REMOTE_STATUS']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — SshExecutor builds a fully non-interactive ssh invocation
// ─────────────────────────────────────────────────────────────────────────────

/** A fake spawn that records argv and drives the child to close deterministically. */
function fakeSpawn(reply: { code?: number; stdout?: string; stderr?: string } = {}) {
  const rec: { cmd?: string; args?: string[]; stdin?: string; stdinEnded?: boolean; killed?: string } = {};
  const impl = ((cmd: string, args: string[]) => {
    rec.cmd = cmd;
    rec.args = args;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: (d: string) => void; end: () => void };
      kill: (s: string) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (d: string) => (rec.stdin = (rec.stdin ?? '') + d), end: () => (rec.stdinEnded = true) };
    child.kill = (s: string) => (rec.killed = s);
    setImmediate(() => {
      if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout));
      if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr));
      child.emit('close', reply.code ?? 0);
    });
    return child as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn;
  return { rec, impl };
}

describe('SshExecutor — non-interactive, key-only, pinned-host-key transport', () => {
  const target = { host: '44.225.68.155', user: 'ubuntu', keyPath: '/tmp/key', knownHostsPath: '/tmp/known' };

  it('every prompt-defeating ssh option is present', async () => {
    const { rec, impl } = fakeSpawn({ code: 0, stdout: 'ok' });
    const out = await new SshExecutor(target, impl).exec(['bash', '-s', '--', REPO], { stdin: 'SCRIPT' });
    expect(out.code).toBe(0);
    const argv = (rec.args ?? []).join(' ');
    expect(argv).toContain('BatchMode=yes');
    expect(argv).toContain('PasswordAuthentication=no');
    expect(argv).toContain('StrictHostKeyChecking=yes');
    expect(argv).toContain('ConnectTimeout=15');
    expect(argv).toContain('IdentitiesOnly=yes');
    expect(argv).toContain('UserKnownHostsFile=/tmp/known');
  });

  it('pipes stdin to the VM and closes it (script travels on stdin, never argv)', async () => {
    const { rec, impl } = fakeSpawn({ code: 0 });
    await new SshExecutor(target, impl).exec(['bash', '-s', '--', REPO], { stdin: 'SECRET-FREE-SCRIPT' });
    expect(rec.stdin).toBe('SECRET-FREE-SCRIPT');
    expect(rec.stdinEnded).toBe(true);
    // the remote command follows a `--`, not embedded in ssh options
    const args = rec.args ?? [];
    expect(args[args.indexOf('--', args.indexOf(`${target.user}@${target.host}`)) + 1]).toBe('bash');
  });

  it('a bounded timeout SIGKILLs a hung child instead of waiting forever', async () => {
    // A spawn whose child never closes; the executor must kill it at the timeout.
    const rec: { killed?: string } = {};
    const neverCloses = ((_c: string, _a: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: () => void; end: () => void };
        kill: (s: string) => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {} };
      child.kill = (s: string) => {
        rec.killed = s;
        child.emit('close', null); // kernel would deliver close after the signal
      };
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const res = await new SshExecutor(target, neverCloses).exec(['sleep', '999'], { timeoutMs: 20 });
    expect(rec.killed).toBe('SIGKILL');
    expect(res.code).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — run the REAL REMOTE_SYNC_SCRIPT under bash against a real git repo,
// with git's *network* subcommands (ls-remote/fetch) and pgrep stubbed.
// ─────────────────────────────────────────────────────────────────────────────

const hasBash = (() => {
  try {
    execFileSync('bash', ['-c', 'true']);
    return true;
  } catch {
    return false;
  }
})();

const REAL_GIT = (() => {
  try {
    return execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();

describe.runIf(hasBash && REAL_GIT)('REMOTE_SYNC_SCRIPT executed under bash (network stubbed, git real)', () => {
  const sandboxes: string[] = [];
  afterAll(() => sandboxes.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function git(cwd: string, ...args: string[]): string {
    return execFileSync(REAL_GIT, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim();
  }

  /** A real repo with one or two commits and an `origin` remote. */
  function makeRepo(opts: { originUrl?: string; twoCommits?: boolean } = {}): { dir: string; head: string; parent: string } {
    const dir = mkdtempSync(join(tmpdir(), 'remote-sync-repo-'));
    sandboxes.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'c1');
    const parent = git(dir, 'rev-parse', 'HEAD');
    let head = parent;
    if (opts.twoCommits) {
      writeFileSync(join(dir, 'a.txt'), 'two\n');
      git(dir, 'commit', '-q', '-am', 'c2');
      head = git(dir, 'rev-parse', 'HEAD');
    }
    git(dir, 'remote', 'add', 'origin', opts.originUrl ?? 'https://github.com/0feklevy/cebu.git');
    return { dir, head, parent };
  }

  /** PATH with a fake `git` (network faked, everything else real) and a fake `pgrep`. */
  function makeBin(): { binDir: string; envLog: string } {
    const binDir = mkdtempSync(join(tmpdir(), 'remote-sync-bin-'));
    sandboxes.push(binDir);
    const envLog = join(binDir, 'env.log');
    const gitStub = [
      '#!/usr/bin/env bash',
      'sub=""; i=1',
      'while [ $i -le $# ]; do',
      '  a="${!i}"',
      '  case "$a" in',
      '    -C|-c) i=$((i+2)); continue ;;',
      '    -*) i=$((i+1)); continue ;;',
      '    *) sub="$a"; break ;;',
      '  esac',
      'done',
      'case "$sub" in',
      '  ls-remote) printf "ls-remote TP=%s SSH=%s\\n" "${GIT_TERMINAL_PROMPT:-UNSET}" "${GIT_SSH_COMMAND:-UNSET}" >> "$ENV_LOG"; exit "${FAKE_LSREMOTE_RC:-0}" ;;',
      '  fetch) printf "fetch TP=%s\\n" "${GIT_TERMINAL_PROMPT:-UNSET}" >> "$ENV_LOG"; exit "${FAKE_FETCH_RC:-0}" ;;',
      '  checkout) if [ "${FAKE_CHECKOUT_NOOP:-0}" = 1 ]; then exit 0; fi; exec "$REAL_GIT" "$@" ;;',
      '  *) exec "$REAL_GIT" "$@" ;;',
      'esac',
    ].join('\n');
    writeFileSync(join(binDir, 'git'), gitStub + '\n');
    chmodSync(join(binDir, 'git'), 0o755);
    writeFileSync(join(binDir, 'pgrep'), '#!/usr/bin/env bash\nexit 1\n'); // nothing running
    chmodSync(join(binDir, 'pgrep'), 0o755);
    return { binDir, envLog };
  }

  interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
    stages: string[];
  }

  function runScript(
    repoDir: string,
    sha: string,
    env: Record<string, string> = {},
    timeouts: [string, string, string] = ['5', '5', '5'],
  ): RunResult {
    const { binDir, envLog } = makeBin();
    let code = 0;
    let stdout: string;
    let stderr = '';
    try {
      stdout = execFileSync('bash', ['-s', '--', repoDir, sha, ...timeouts], {
        input: REMOTE_SYNC_SCRIPT,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, REAL_GIT, ENV_LOG: envLog, ...env },
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = typeof err.status === 'number' ? err.status : 1;
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
    }
    return { code, stdout, stderr, stages: parseReachedStages(stdout) };
  }

  it('happy path: fetch succeeds, HEAD is verified, all stages complete', () => {
    const { dir, head } = makeRepo();
    const r = runScript(dir, head);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stages).toEqual([...REMOTE_SYNC_STAGES]);
    expect(r.stdout).toContain(`HEAD=${head}`);
  });

  it('git credential prompts are prevented: the VM saw GIT_TERMINAL_PROMPT=0 before any network call', () => {
    const { dir, head } = makeRepo();
    const { binDir, envLog } = makeBin();
    // Re-run inline so we can read the same env log this bin wrote.
    execFileSync('bash', ['-s', '--', dir, head, '5', '5', '5'], {
      input: REMOTE_SYNC_SCRIPT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, REAL_GIT, ENV_LOG: envLog },
    });
    const seen = existsSync(envLog) ? readFileSync(envLog, 'utf8') : '';
    expect(seen).toContain('ls-remote TP=0');
    expect(seen).toContain('fetch TP=0');
    expect(seen).toContain('BatchMode=yes'); // GIT_SSH_COMMAND was exported for the ssh transport too
  });

  it('missing repository fails at VERIFY_REMOTE_REPOSITORY (containers never in scope)', () => {
    const r = runScript('/no/such/repo/here', SHA);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('does not exist');
    expect(r.stages).toEqual(['SSH_CONNECT', 'VERIFY_REMOTE_REPOSITORY']);
  });

  it('a stale .git/index.lock (no git running) is cleared, then the sync completes', () => {
    const { dir, head } = makeRepo();
    writeFileSync(join(dir, '.git', 'index.lock'), '');
    const r = runScript(dir, head);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('removed_stale_lock');
    expect(r.stages).toContain('REMOTE_SYNC_COMPLETE');
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false);
  });

  it('a fetch timeout (rc 124) fails fast at FETCH_TARGET_SHA — never a blind 5-minute wait', () => {
    const { dir, head } = makeRepo();
    const r = runScript(dir, head, { FAKE_FETCH_RC: '124' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('timed out');
    expect(r.stages).toContain('FETCH_TARGET_SHA');
    expect(r.stages).not.toContain('CHECKOUT_TARGET_SHA');
  });

  it('an unreachable / unauthenticated origin (ls-remote fails) is caught at CHECK_REMOTE_STATUS', () => {
    const { dir, head } = makeRepo();
    const r = runScript(dir, head, { FAKE_LSREMOTE_RC: '128' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('cannot reach or authenticate');
    expect(r.stages).toContain('CHECK_REMOTE_STATUS');
    expect(r.stages).not.toContain('FETCH_TARGET_SHA');
  });

  it('a requested SHA that is not on origin fails at FETCH_TARGET_SHA', () => {
    const { dir } = makeRepo();
    const missing = 'b'.repeat(40);
    const r = runScript(dir, missing);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('not available on origin');
    expect(r.stages).toContain('FETCH_TARGET_SHA');
    expect(r.stages).not.toContain('CHECKOUT_TARGET_SHA');
  });

  it('exact-HEAD verification fails loudly if the checkout did not land on the release commit', () => {
    const { dir, parent } = makeRepo({ twoCommits: true }); // HEAD=c2, target=c1(parent)
    const r = runScript(dir, parent, { FAKE_CHECKOUT_NOOP: '1' }); // pretend checkout was a no-op
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('HEAD is');
    expect(r.stages).toContain('VERIFY_REMOTE_HEAD');
    expect(r.stages).not.toContain('REMOTE_SYNC_COMPLETE');
  });

  it('the origin URL is redacted (an embedded credential never reaches the logs)', () => {
    const { dir, head } = makeRepo({ originUrl: 'https://x-access-token:SUPERSECRET@github.com/0feklevy/cebu.git' });
    const r = runScript(dir, head);
    expect(r.stdout).not.toContain('SUPERSECRET');
    expect(r.stdout).toContain('https://***@github.com');
  });
});
