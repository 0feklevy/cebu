/**
 * CLI handlers for remote (VM) operations. All of them go through the Executor
 * abstraction (remote-deploy.ts) — swap SshExecutor for an SSM executor later and
 * these commands do not change.
 *
 * Secrets policy: the SSH key arrives as a FILE PATH (written by the workflow step
 * with 0600 perms), the GHCR token via the GHCR_PULL_TOKEN env var — it is passed
 * to the VM on stdin and never appears in argv, logs, or reports.
 */
import { readFileSync } from 'node:fs';
import { parseManifest } from './image-manifest.js';
import {
  deployImages,
  rollbackRemote,
  runProductionAudit,
  runRemoteHealthCheck,
  SshExecutor,
  syncRemoteCheckout,
  type Executor,
} from './remote-deploy.js';
import { writeJsonFile, type CommandContext } from './commands.js';
import { redactValue } from './redact.js';
import { diagnoseRemoteFailure } from './remote-diagnosis.js';

export interface RemoteTargetFlags {
  host: string;
  user: string;
  keyPath: string;
  knownHostsPath?: string;
  repoDir: string;
}

export function executorFor(flags: RemoteTargetFlags): Executor {
  return new SshExecutor({
    host: flags.host,
    user: flags.user,
    keyPath: flags.keyPath,
    knownHostsPath: flags.knownHostsPath,
  });
}

/** Overridable for integration tests. */
export type ExecutorFactory = (flags: RemoteTargetFlags) => Executor;

export async function cmdRemoteSync(
  ctx: CommandContext,
  flags: RemoteTargetFlags & { gitSha: string },
  makeExecutor: ExecutorFactory = executorFor,
): Promise<number> {
  const res = await syncRemoteCheckout(makeExecutor(flags), flags.repoDir, flags.gitSha);
  // Echo the VM's stage trail (secret-free) so the workflow console shows exactly how far
  // the sync got — a stall is pinned to a named stage rather than a blind 5-minute wait.
  const trail = res.result.stdout.trim();
  if (trail) ctx.log(trail);
  if (res.ok) {
    ctx.log('remote-sync: ok');
    return 0;
  }
  if (!res.connected) {
    ctx.log('SSH_CONNECT: FAILED — could not establish an SSH connection to the VM (nothing on the VM was touched).');
  }
  ctx.log(`remote-sync: FAILED${res.lastStage ? ` at stage ${res.lastStage}` : ''}`);
  if (res.result.stderr) ctx.log(res.result.stderr.slice(-2000));
  return 1;
}

export async function cmdRemoteDeploy(
  ctx: CommandContext,
  flags: RemoteTargetFlags & { manifestFile: string; ghcrUser: string; skipMigrations?: boolean },
  makeExecutor: ExecutorFactory = executorFor,
): Promise<number> {
  const token = process.env.GHCR_PULL_TOKEN ?? '';
  if (!token) {
    ctx.log('remote-deploy: GHCR_PULL_TOKEN env var is required (read:packages token for the VM pull).');
    return 1;
  }
  const manifest = parseManifest(readFileSync(flags.manifestFile, 'utf8'));
  const res = await deployImages(makeExecutor(flags), {
    manifest,
    ghcrUser: flags.ghcrUser,
    ghcrToken: token,
    remoteRepoDir: flags.repoDir,
    skipMigrations: flags.skipMigrations,
  });
  // Stream the VM's (secret-free) deploy log for the workflow console.
  ctx.log(res.result.stdout.slice(-8000));
  if (res.result.stderr) ctx.log(res.result.stderr.slice(-4000));
  ctx.log(`remote-deploy: ${res.ok ? 'ok' : 'FAILED'}`);
  return res.ok ? 0 : 1;
}

export async function cmdRemoteRollback(
  ctx: CommandContext,
  flags: RemoteTargetFlags & { target?: string; out?: string },
  makeExecutor: ExecutorFactory = executorFor,
): Promise<number> {
  const res = await rollbackRemote(makeExecutor(flags), flags.repoDir, flags.target);
  ctx.log(res.result.stdout.slice(-4000));
  if (res.result.stderr) ctx.log(res.result.stderr.slice(-2000));
  if (flags.out) writeJsonFile(flags.out, { attempted: true, target: flags.target ?? '(previous)', success: res.ok });
  ctx.log(`remote-rollback: ${res.ok ? 'restored' : 'FAILED'}`);
  return res.ok ? 0 : 1;
}

export async function cmdRemoteAudit(
  ctx: CommandContext,
  flags: RemoteTargetFlags & { out: string },
  makeExecutor: ExecutorFactory = executorFor,
): Promise<number> {
  const res = await runProductionAudit(makeExecutor(flags), flags.repoDir);
  if (!res.ok) {
    const d = diagnoseRemoteFailure({ code: res.result.code, stdout: res.result.stdout, stderr: res.result.stderr });
    // Preserve what the VM actually said. The previous version printed only stderr (empty
    // in the observed failure) and DISCARDED stdout, so the diagnosis had to be redone by
    // hand. stdout is where production-audit.sh writes its JSON, including partial output.
    ctx.log(`remote-audit: FAILED [${d.kind}] — ${d.summary}`);
    ctx.log(`  classification: ${d.auditError ? 'AUDIT ERROR (production state unknown)' : 'PRODUCTION FINDING (the VM answered)'}`);
    ctx.log(`  remediation: ${d.remediation}`);
    const stderrTail = redactValue(res.result.stderr.slice(-2000)).trim();
    const stdoutTail = redactValue(res.result.stdout.slice(-2000)).trim();
    if (stderrTail) ctx.log(`  stderr(tail): ${stderrTail}`);
    if (stdoutTail) ctx.log(`  stdout(tail): ${stdoutTail}`);
    // Always leave a readable artifact so downstream steps classify rather than ENOENT.
    writeJsonFile(flags.out, {
      schema: 'flowvid.remote-audit-error/v1',
      auditError: d.auditError,
      kind: d.kind,
      reason: d.summary,
      remediation: d.remediation,
      exitCode: res.result.code,
      createdAt: new Date().toISOString(),
      findings: [],
    });
    return 1;
  }
  try {
    const doc = JSON.parse(res.json) as unknown;
    writeJsonFile(flags.out, doc);
  } catch {
    ctx.log('remote-audit: [INVALID_REMOTE_JSON] the VM did not return valid JSON on stdout.');
    writeJsonFile(flags.out, {
      schema: 'flowvid.remote-audit-error/v1',
      auditError: true,
      kind: 'INVALID_REMOTE_JSON',
      reason: 'the VM returned output that is not valid JSON',
      remediation: 'Inspect production-audit.sh output; partial JSON is an audit error, not a pass.',
      createdAt: new Date().toISOString(),
      findings: [],
    });
    return 1;
  }
  ctx.log(`remote-audit: wrote ${flags.out}`);
  return 0;
}

/**
 * Run the URL backfill on the VM. mode 'report' is read-only; 'apply' executes the
 * repair and is refused by the VM-side script when the plan is unsafe, unless
 * approveUnsafe records explicit human approval (the workflow maps this from the
 * backfill_policy + approve_high inputs — never automatic).
 */
export async function cmdRemoteBackfill(
  ctx: CommandContext,
  flags: RemoteTargetFlags & { mode: 'report' | 'apply'; approveUnsafe?: boolean; maxAffected?: number; out: string },
  makeExecutor: ExecutorFactory = executorFor,
): Promise<number> {
  const cmd = ['bash', `${flags.repoDir}/podcast-saas/deploy/scripts/run-backfill.sh`];
  if (flags.mode === 'apply') cmd.push('--apply');
  if (flags.approveUnsafe) cmd.push('--approve-unsafe');
  if (flags.maxAffected !== undefined) cmd.push('--max-affected', String(flags.maxAffected));
  const res = await makeExecutor(flags).exec(cmd, { timeoutMs: 15 * 60 * 1000 });
  if (res.stderr) ctx.log(res.stderr.slice(-4000));
  try {
    writeJsonFile(flags.out, JSON.parse(res.stdout));
  } catch {
    ctx.log('remote-backfill: no valid JSON returned (older image without --json support?).');
    writeJsonFile(flags.out, null);
  }
  ctx.log(`remote-backfill(${flags.mode}): exit ${res.code}`);
  return res.code === 0 ? 0 : res.code === 2 ? 2 : 1;
}

export async function cmdRemoteHealth(
  ctx: CommandContext,
  flags: RemoteTargetFlags,
  makeExecutor: ExecutorFactory = executorFor,
): Promise<number> {
  const res = await runRemoteHealthCheck(makeExecutor(flags), flags.repoDir);
  ctx.log(res.result.stdout.slice(-4000));
  ctx.log(`remote-health: ${res.ok ? 'all green' : 'FAILED'}`);
  return res.ok ? 0 : 1;
}
