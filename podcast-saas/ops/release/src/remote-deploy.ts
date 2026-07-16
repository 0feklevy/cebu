/**
 * Remote deployment adapter. All release logic talks to the abstract Executor;
 * SSH is just today's transport. Replacing SSH with AWS SSM later means writing
 * one new Executor — no release logic changes.
 *
 * The VM-side contract is deploy/scripts/deploy-images.sh and production-audit.sh:
 * pull-by-digest, verify, retag, migrate, recreate, health-gate. The VM NEVER
 * builds from source on this path. Secrets (the GHCR pull token) travel on stdin,
 * never in argv or logged output.
 */
import { spawn } from 'node:child_process';
import type { ImageManifest } from './image-manifest.js';

export interface RemoteResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Executor {
  /** Run a command on the target host. stdin (if given) is piped and never logged. */
  exec(command: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<RemoteResult>;
  describe(): string;
}

export interface SshTarget {
  host: string;
  user: string;
  keyPath: string;
  knownHostsPath?: string;
  port?: number;
}

/** SSH transport. BatchMode (never prompts), pinned host key, no agent forwarding. */
export class SshExecutor implements Executor {
  constructor(private readonly target: SshTarget) {}

  describe(): string {
    return `ssh ${this.target.user}@${this.target.host}`;
  }

  exec(command: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RemoteResult> {
    const t = this.target;
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes',
      ...(t.knownHostsPath ? ['-o', `UserKnownHostsFile=${t.knownHostsPath}`] : []),
      '-o', 'ConnectTimeout=15',
      '-i', t.keyPath,
      ...(t.port ? ['-p', String(t.port)] : []),
      `${t.user}@${t.host}`,
      '--',
      ...command,
    ];
    return new Promise((resolve) => {
      const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30 * 60 * 1000);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
      child.stdin.end();
    });
  }
}

const REMOTE_SCRIPTS_DIR = 'podcast-saas/deploy/scripts';

/**
 * Sync the VM checkout to the exact release commit BEFORE running deploy-images.sh
 * (a bash script must never rewrite itself mid-run, so the checkout is a separate
 * command). Detached checkout — the VM never builds from this tree on the normal path;
 * it only needs docker-compose.yml, nginx templates, and the deploy scripts to match.
 */
export async function syncRemoteCheckout(exec: Executor, remoteRepoDir: string, gitSha: string): Promise<DeployOutcome> {
  if (!/^[0-9a-f]{7,40}$/i.test(gitSha)) {
    return { ok: false, result: { code: 1, stdout: '', stderr: `refusing to checkout suspicious ref: ${gitSha}` } };
  }
  const result = await exec.exec(
    ['git', '-C', remoteRepoDir, 'fetch', 'origin', '--tags', '--prune', '&&', 'git', '-C', remoteRepoDir, 'checkout', '--detach', gitSha],
    { timeoutMs: 5 * 60 * 1000 },
  );
  return { ok: result.code === 0, result };
}

export interface DeployImagesParams {
  manifest: ImageManifest;
  /** Registry credentials for the VM's ephemeral `docker login` (stdin only). */
  ghcrUser: string;
  ghcrToken: string;
  /** Repo checkout path on the VM. */
  remoteRepoDir: string;
  /** Skip the migration step (used by rollback re-verification). */
  skipMigrations?: boolean;
}

export interface DeployOutcome {
  ok: boolean;
  result: RemoteResult;
}

/**
 * Deploy exact digests to the VM. The manifest and registry token are passed as a
 * single JSON envelope on stdin so the token never appears in argv, env listings,
 * or shell history.
 */
export async function deployImages(exec: Executor, p: DeployImagesParams): Promise<DeployOutcome> {
  const envelope = JSON.stringify({
    ghcrUser: p.ghcrUser,
    ghcrToken: p.ghcrToken,
    manifest: p.manifest,
    skipMigrations: p.skipMigrations === true,
  });
  const result = await exec.exec(
    ['bash', `${p.remoteRepoDir}/${REMOTE_SCRIPTS_DIR}/deploy-images.sh`, '--stdin-envelope'],
    { stdin: envelope, timeoutMs: 40 * 60 * 1000 },
  );
  return { ok: result.code === 0, result };
}

/** Roll application images back to a previously deployed version (no rebuild, no schema rollback). */
export async function rollbackRemote(exec: Executor, remoteRepoDir: string, targetVersion?: string): Promise<DeployOutcome> {
  const cmd = ['bash', `${remoteRepoDir}/${REMOTE_SCRIPTS_DIR}/rollback.sh`];
  if (targetVersion) cmd.push(targetVersion);
  const result = await exec.exec(cmd, { timeoutMs: 15 * 60 * 1000 });
  return { ok: result.code === 0, result };
}

/** Read-only VM audit; returns the JSON document the script prints on stdout. */
export async function runProductionAudit(exec: Executor, remoteRepoDir: string): Promise<{ ok: boolean; json: string; result: RemoteResult }> {
  const result = await exec.exec(['bash', `${remoteRepoDir}/${REMOTE_SCRIPTS_DIR}/production-audit.sh`, '--json'], {
    timeoutMs: 10 * 60 * 1000,
  });
  // stdout is exclusively the JSON document; human logs go to stderr.
  return { ok: result.code === 0, json: result.stdout, result };
}

/** Run the health-check script on the VM (exit 0 iff all green). */
export async function runRemoteHealthCheck(exec: Executor, remoteRepoDir: string): Promise<DeployOutcome> {
  const result = await exec.exec(['bash', `${remoteRepoDir}/${REMOTE_SCRIPTS_DIR}/health-check.sh`], {
    timeoutMs: 5 * 60 * 1000,
  });
  return { ok: result.code === 0, result };
}
