/**
 * The git facts the conductor needs. Read-only apart from `push`, which is the one
 * local mutation a shipment performs before GitHub takes over.
 */
import { runCommand, type Runner } from './run.js';

export class Git {
  constructor(
    private readonly cwd: string,
    private readonly runner: Runner = runCommand,
  ) {}

  private async git(args: string[], timeoutMs = 120_000): Promise<string> {
    const res = await this.runner('git', args, { cwd: this.cwd, timeoutMs });
    if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed (exit ${res.code}): ${res.stderr.trim()}`);
    return res.stdout.trim();
  }

  private async gitOk(args: string[]): Promise<boolean> {
    const res = await this.runner('git', args, { cwd: this.cwd });
    return res.code === 0;
  }

  async repoRoot(): Promise<string> {
    return this.git(['rev-parse', '--show-toplevel']);
  }

  async currentBranch(): Promise<string> {
    return this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async headSha(): Promise<string> {
    return this.git(['rev-parse', 'HEAD']);
  }

  /** Tracked-file changes only — untracked scratch files never block a shipment. */
  async isDirty(): Promise<boolean> {
    const out = await this.git(['status', '--porcelain', '--untracked-files=no']);
    return out !== '';
  }

  async untrackedCount(): Promise<number> {
    const out = await this.git(['ls-files', '--others', '--exclude-standard']);
    return out === '' ? 0 : out.split('\n').length;
  }

  async hasUpstream(): Promise<boolean> {
    return this.gitOk(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  }

  /** Commits on this branch that the remote does not have yet. */
  async unpushedCount(branch: string): Promise<number> {
    if (!(await this.gitOk(['rev-parse', '--verify', `origin/${branch}`]))) return -1; // remote branch absent
    const out = await this.git(['rev-list', '--count', `origin/${branch}..HEAD`]);
    return Number.parseInt(out, 10) || 0;
  }

  async fetch(): Promise<void> {
    await this.git(['fetch', 'origin', '--prune', '--tags'], 180_000);
  }

  async push(branch: string, setUpstream: boolean): Promise<void> {
    const args = ['push'];
    if (setUpstream) args.push('--set-upstream');
    args.push('origin', branch);
    await this.git(args, 300_000);
  }

  async subject(ref = 'HEAD'): Promise<string> {
    return this.git(['log', '-1', '--pretty=%s', ref]);
  }

  /** Subjects of the commits this branch adds on top of `base`, oldest first. */
  async commitsSince(base: string, ref = 'HEAD'): Promise<string[]> {
    const out = await this.git(['log', '--reverse', '--pretty=%s', `${base}..${ref}`]);
    return out === '' ? [] : out.split('\n');
  }

  async changedFiles(base: string, ref = 'HEAD'): Promise<string[]> {
    const out = await this.git(['diff', '--name-only', `${base}...${ref}`]);
    return out === '' ? [] : out.split('\n');
  }

  async remoteExists(branch: string): Promise<boolean> {
    return this.gitOk(['rev-parse', '--verify', `origin/${branch}`]);
  }
}
