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
  /** TCP/handshake bound. Short by design — a live host answers in <1s. */
  connectTimeoutSecs?: number;
}

/**
 * SSH transport, fully non-interactive by construction: BatchMode means it NEVER
 * waits for a password/passphrase/host-key confirmation (it fails fast instead),
 * the host key is pinned, password auth is off, and a dead connection is detected
 * via keepalives rather than hanging on the kernel TCP timeout. No stage may block
 * on user input — the release runs headless in CI.
 */
export class SshExecutor implements Executor {
  constructor(
    private readonly target: SshTarget,
    /** Injectable for tests; defaults to the real child_process.spawn. */
    private readonly spawnImpl: typeof spawn = spawn,
  ) {}

  describe(): string {
    return `ssh ${this.target.user}@${this.target.host}`;
  }

  exec(command: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RemoteResult> {
    const t = this.target;
    const connectTimeout = t.connectTimeoutSecs ?? 15;
    const args = [
      '-o', 'BatchMode=yes',              // never prompt for a password/passphrase — fail fast
      '-o', 'IdentitiesOnly=yes',
      '-o', 'PasswordAuthentication=no',  // key-only; never fall through to a password prompt
      '-o', 'StrictHostKeyChecking=yes',  // host key must already be pinned (known-hosts)
      ...(t.knownHostsPath ? ['-o', `UserKnownHostsFile=${t.knownHostsPath}`] : []),
      '-o', `ConnectTimeout=${connectTimeout}`,
      '-o', 'ConnectionAttempts=1',       // fail fast; don't silently retry the TCP connect
      '-o', 'ServerAliveInterval=15',     // detect a dead peer in ~45s instead of hanging on TCP
      '-o', 'ServerAliveCountMax=3',
      '-i', t.keyPath,
      ...(t.port ? ['-p', String(t.port)] : []),
      `${t.user}@${t.host}`,
      '--',
      ...command,
    ];
    return new Promise((resolve) => {
      const child = this.spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
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

/** Ordered stage markers the VM-side sync prints to stdout, one exact token per line. */
export const REMOTE_SYNC_STAGES = [
  'SSH_CONNECT',
  'VERIFY_REMOTE_REPOSITORY',
  'CHECK_REMOTE_STATUS',
  'FETCH_TARGET_SHA',
  'CHECKOUT_TARGET_SHA',
  'VERIFY_REMOTE_HEAD',
  'REMOTE_SYNC_COMPLETE',
] as const;
export type RemoteSyncStage = (typeof REMOTE_SYNC_STAGES)[number];

/** The stages the VM reported reaching, in order (parsed from stdout markers). */
export function parseReachedStages(stdout: string): RemoteSyncStage[] {
  const seen = new Set(stdout.split('\n').map((l) => l.trim()));
  return REMOTE_SYNC_STAGES.filter((s) => seen.has(s));
}

export interface SyncOutcome extends DeployOutcome {
  /** True once the SSH transport connected and the VM shell started (SSH_CONNECT seen). */
  connected: boolean;
  stagesReached: RemoteSyncStage[];
  lastStage?: RemoteSyncStage;
}

// Per-stage network bounds are enforced ON THE VM by coreutils `timeout`, so a stalled
// git command dies with a precise message. The outer SSH bound is only a backstop and is
// deliberately SHORTER than the previous unconditional 5-minute wait — the real fix is
// that git can no longer block on a credential/host-key prompt (see REMOTE_SYNC_SCRIPT).
const SYNC_LS_REMOTE_TIMEOUT_SECS = 20;
const SYNC_FETCH_TIMEOUT_SECS = 120;
const SYNC_FALLBACK_FETCH_TIMEOUT_SECS = 30;
const SYNC_OUTER_TIMEOUT_MS = 210_000;

/**
 * VM-side checkout sync. Read from stdin by `bash -s`; the repo dir, target SHA and the
 * three per-stage timeouts arrive as positional args ($1..$5) so nothing untrusted is
 * ever interpolated into the shell. It performs ONLY git operations (fetch + detached
 * checkout) and never touches docker/compose, so a failure here cannot modify or stop
 * the running production containers. Every network stage is non-interactive and bounded.
 */
export const REMOTE_SYNC_SCRIPT = `set -u
REPO_DIR="$1"
TARGET_SHA="$2"
LS_TIMEOUT="$3"; [ -n "$LS_TIMEOUT" ] || LS_TIMEOUT=20
FETCH_TIMEOUT="$4"; [ -n "$FETCH_TIMEOUT" ] || FETCH_TIMEOUT=120
FALLBACK_TIMEOUT="$5"; [ -n "$FALLBACK_TIMEOUT" ] || FALLBACK_TIMEOUT=30

# Fully non-interactive git + ssh: NOTHING below may block on a password, passphrase,
# host-key confirmation, editor, or credential prompt. Prompts fail fast instead.
export GIT_TERMINAL_PROMPT=0
export GCM_INTERACTIVE=never
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"

TIMEOUT_BIN="$(command -v timeout || true)"
bounded() { s="$1"; shift; if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" -k 5 "$s" "$@"; else "$@"; fi; }
redact() { sed -E 's#://[^@/[:space:]]+@#://***@#g'; }
stage() { printf '%s\\n' "$1"; }
fail() { at="$1"; shift; printf 'REMOTE_SYNC_FAILED_AT=%s\\n' "$at" >&2; printf '%s\\n' "$*" | redact >&2; exit 1; }

# Reaching this line proves the SSH transport connected and a shell started.
stage SSH_CONNECT

stage VERIFY_REMOTE_REPOSITORY
[ -n "$REPO_DIR" ] || fail VERIFY_REMOTE_REPOSITORY "no repository directory was provided"
[ -d "$REPO_DIR" ] || fail VERIFY_REMOTE_REPOSITORY "repository directory does not exist: $REPO_DIR"
[ -O "$REPO_DIR" ] || fail VERIFY_REMOTE_REPOSITORY "repository directory is not owned by $(id -un): $REPO_DIR"
[ -w "$REPO_DIR" ] || fail VERIFY_REMOTE_REPOSITORY "repository directory is not writable by $(id -un): $REPO_DIR"
git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail VERIFY_REMOTE_REPOSITORY "not a git work tree: $REPO_DIR"
GIT_DIR_ABS="$(git -C "$REPO_DIR" rev-parse --absolute-git-dir 2>/dev/null || true)"
[ -n "$GIT_DIR_ABS" ] && [ -w "$GIT_DIR_ABS" ] || fail VERIFY_REMOTE_REPOSITORY "the .git directory is missing or not writable under $REPO_DIR"
ORIGIN_URL="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
[ -n "$ORIGIN_URL" ] || fail VERIFY_REMOTE_REPOSITORY "no origin remote is configured in $REPO_DIR"
printf 'origin=%s\\n' "$(printf '%s' "$ORIGIN_URL" | redact)"

stage CHECK_REMOTE_STATUS
AVAIL_KB="$(df -Pk "$REPO_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
AVAIL_INO="$(df -Pi "$REPO_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
case "$AVAIL_KB" in ''|*[!0-9]*) AVAIL_KB=0 ;; esac
case "$AVAIL_INO" in ''|*[!0-9]*) AVAIL_INO=0 ;; esac
[ "$AVAIL_KB" -eq 0 ] || [ "$AVAIL_KB" -ge 102400 ] || fail CHECK_REMOTE_STATUS "insufficient disk on the repo filesystem: $AVAIL_KB KB free (need at least 100MB)"
[ "$AVAIL_INO" -eq 0 ] || [ "$AVAIL_INO" -ge 1000 ] || fail CHECK_REMOTE_STATUS "insufficient inodes on the repo filesystem: $AVAIL_INO free"
printf 'disk_kb=%s inodes=%s\\n' "$AVAIL_KB" "$AVAIL_INO"
if pgrep -af 'deploy-images[.]sh|[d]eploy[.]sh' >/dev/null 2>&1; then fail CHECK_REMOTE_STATUS "a deploy script is already running on the VM; refusing to sync under an in-flight deploy"; fi
GIT_RUNNING=no; pgrep -x git >/dev/null 2>&1 && GIT_RUNNING=yes
for lk in "$GIT_DIR_ABS/index.lock" "$GIT_DIR_ABS/shallow.lock" "$GIT_DIR_ABS/HEAD.lock" "$GIT_DIR_ABS/config.lock"; do
  [ -e "$lk" ] || continue
  if [ "$GIT_RUNNING" = yes ]; then fail CHECK_REMOTE_STATUS "a stale lock ($lk) is present while a git process is running; refusing to remove it"; fi
  rm -f "$lk" && printf 'removed_stale_lock=%s\\n' "$lk"
done
if [ "$GIT_RUNNING" = no ] && [ -d "$GIT_DIR_ABS/refs" ]; then find "$GIT_DIR_ABS/refs" -type f -name '*.lock' -exec rm -f {} + 2>/dev/null || true; fi
if [ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]; then fail CHECK_REMOTE_STATUS "the VM working tree has uncommitted changes; refusing to overwrite them"; fi
LSOUT="$(bounded "$LS_TIMEOUT" git -C "$REPO_DIR" ls-remote --heads origin 2>&1)"; rc=$?
if [ "$rc" != 0 ]; then
  if [ "$rc" = 124 ]; then fail CHECK_REMOTE_STATUS "GitHub is not reachable: git ls-remote origin timed out after $LS_TIMEOUT seconds"; fi
  fail CHECK_REMOTE_STATUS "cannot reach or authenticate to origin: $LSOUT"
fi

stage FETCH_TARGET_SHA
FOUT="$(bounded "$FETCH_TIMEOUT" git -C "$REPO_DIR" fetch --tags --prune --no-progress origin 2>&1)"; rc=$?
if [ "$rc" != 0 ]; then
  if [ "$rc" = 124 ]; then fail FETCH_TARGET_SHA "git fetch timed out after $FETCH_TIMEOUT seconds (network or credentials)"; fi
  fail FETCH_TARGET_SHA "git fetch origin failed: $FOUT"
fi
if ! git -C "$REPO_DIR" cat-file -e "$TARGET_SHA^{commit}" 2>/dev/null; then
  bounded "$FALLBACK_TIMEOUT" git -C "$REPO_DIR" fetch --no-progress origin "$TARGET_SHA" >/dev/null 2>&1 || true
fi
git -C "$REPO_DIR" cat-file -e "$TARGET_SHA^{commit}" 2>/dev/null || fail FETCH_TARGET_SHA "the requested commit $TARGET_SHA is not available on origin after fetch"

stage CHECKOUT_TARGET_SHA
if ! COUT="$(git -C "$REPO_DIR" -c advice.detachedHead=false checkout --detach "$TARGET_SHA" 2>&1)"; then
  fail CHECKOUT_TARGET_SHA "git checkout --detach $TARGET_SHA failed: $COUT"
fi

stage VERIFY_REMOTE_HEAD
HEAD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
WANT_SHA="$(git -C "$REPO_DIR" rev-parse "$TARGET_SHA^{commit}" 2>/dev/null || true)"
[ -n "$HEAD_SHA" ] && [ "$HEAD_SHA" = "$WANT_SHA" ] || fail VERIFY_REMOTE_HEAD "HEAD is $HEAD_SHA but the release commit is $WANT_SHA"
printf 'HEAD=%s\\n' "$HEAD_SHA"

stage REMOTE_SYNC_COMPLETE
`;

/**
 * Sync the VM checkout to the exact release commit BEFORE running deploy-images.sh
 * (a bash script must never rewrite itself mid-run, so the checkout is a separate
 * command). Detached checkout — the VM never builds from this tree on the normal path;
 * it only needs docker-compose.yml, nginx templates, and the deploy scripts to match.
 *
 * Fully non-interactive and staged: each phase prints a marker (REMOTE_SYNC_STAGES) so a
 * hang is pinpointed to an exact stage rather than a blind 5-minute timeout, and the
 * final stage verifies HEAD is exactly the requested commit.
 */
export async function syncRemoteCheckout(exec: Executor, remoteRepoDir: string, gitSha: string): Promise<SyncOutcome> {
  if (!/^[0-9a-f]{7,40}$/i.test(gitSha)) {
    return {
      ok: false,
      connected: false,
      stagesReached: [],
      result: { code: 1, stdout: '', stderr: `refusing to checkout suspicious ref: ${gitSha}` },
    };
  }
  const result = await exec.exec(
    [
      'bash',
      '-s',
      '--',
      remoteRepoDir,
      gitSha,
      String(SYNC_LS_REMOTE_TIMEOUT_SECS),
      String(SYNC_FETCH_TIMEOUT_SECS),
      String(SYNC_FALLBACK_FETCH_TIMEOUT_SECS),
    ],
    { stdin: REMOTE_SYNC_SCRIPT, timeoutMs: SYNC_OUTER_TIMEOUT_MS },
  );
  const stagesReached = parseReachedStages(result.stdout);
  const connected = stagesReached.includes('SSH_CONNECT');
  const ok = result.code === 0 && stagesReached.includes('REMOTE_SYNC_COMPLETE');
  return { ok, connected, stagesReached, lastStage: stagesReached[stagesReached.length - 1], result };
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
