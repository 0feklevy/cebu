/**
 * The container contract, as code: the hardened `docker run` argument assembler (plan §0.2).
 *
 * This is the "least privilege runtime" of the security architecture turned into an argv the
 * orchestrator can spawn — AND the thing a unit test can assert without a Linux host, which is the
 * point: the flag set is the contract, so the flag set is what we pin. What CANNOT be verified on
 * macOS (that `--network none` actually blocks egress while `127.0.0.1` still serves, that the
 * read-only rootfs actually refuses writes, that Chrome's sandbox actually initialises with the
 * chosen mechanism) is the container-verification checklist in the runbook — this file only proves
 * the argv is exactly right.
 *
 * Design commitments, each mapped to a flag below:
 *   • NO network egress            → `--network none`  (lo stays up inside the netns; see the server)
 *   • non-root                     → `--user <uid>:<gid>`, refused when it resolves to root
 *   • read-only root filesystem    → `--read-only`
 *   • a single tmpfs work dir      → `--tmpfs /tmp:rw,nosuid,nodev,noexec,size=…`
 *   • hard CPU / memory / PID caps → `--cpus`, `--memory` + `--memory-swap` (swap off), `--pids-limit`
 *   • Chrome's OWN sandbox KEPT    → we NEVER emit `--no-sandbox`; we grant what the sandbox needs
 *                                    (see `SandboxMechanism`), and drop everything else
 *   • no secrets                   → the argv carries no `-e`/`--env` at all; the capture spec is a
 *                                    file on the read-only input mount, never an environment variable
 *   • a hard wall-clock kill       → enforced by the orchestrator (docker cannot self-SIGKILL on a
 *                                    wall clock); `--stop-timeout` bounds the graceful window and the
 *                                    orchestrator escalates to `docker kill --signal=KILL`
 *
 * The input/output/tmpfs split resolves a tension the plan flags: a Docker `--tmpfs` is
 * container-internal and the host cannot read it, so it cannot be the handoff medium for captured
 * frames. Resolution: the RAM-backed `--tmpfs /tmp` is Chrome's ephemeral scratch (user-data-dir,
 * `/dev/shm` substitute under `--disable-dev-shm-usage`); the package bytes arrive on a READ-ONLY
 * bind mount; the frames leave on a minimal READ-WRITE bind mount the trusted side owns and reads.
 * Both binds are `nosuid,nodev,noexec`. See the runbook for the full rationale.
 */

/**
 * How Chrome's Linux sandbox is granted what it needs WITHOUT `--no-sandbox`.
 *
 * Chrome's namespace sandbox creates an unprivileged user namespace (`unshare(CLONE_NEWUSER|…)`).
 * Creating a NEW user namespace requires NO capability — that is the whole point of unprivileged
 * userns — so it is compatible with `--cap-drop ALL`. What can block it is (a) the host kernel
 * disallowing unprivileged userns, or (b) a seccomp profile that forbids the clone/unshare flags.
 *
 *   • 'userns'         — the least-privilege default. Rely on the host having unprivileged user
 *                        namespaces enabled and Docker's DEFAULT seccomp profile (which permits the
 *                        clone/unshare needed). No extra docker grant; the "capability" is a host
 *                        sysctl the runbook has you verify. `--cap-drop ALL` stays.
 *   • 'seccomp-profile'— supply a curated seccomp profile via `--security-opt seccomp=<path>` for a
 *                        host whose default profile is stricter than stock Docker's.
 *   • 'sys-admin'      — the documented fallback for a hardened host with unprivileged userns
 *                        DISABLED: `--cap-add SYS_ADMIN` lets the sandbox initialise. Broad, but the
 *                        residual blast radius is bounded by `--network none` + `--read-only` +
 *                        non-root + `--pids-limit` + no-new-privileges, and it is STILL not
 *                        `--no-sandbox` (the renderer seccomp-bpf layer stays on).
 */
export type SandboxMechanism = 'userns' | 'seccomp-profile' | 'sys-admin';

export interface ContainerRunSpec {
  /**
   * The pinned image — a digest, e.g. `registry/podcast-export-worker@sha256:…`. A tag is accepted
   * (dev) but the runbook requires a digest in production so the renderer identity is reproducible.
   */
  image: string;
  /** A deterministic container name so the orchestrator's wall-clock timer can `docker kill` it. */
  containerName: string;
  /** Host path holding the package bytes + capture-spec.json; mounted READ-ONLY at /input. */
  inputDir: string;
  /** Host path the frames/clip are written to; mounted READ-WRITE at /output; the trusted side reads it. */
  outputDir: string;
  /** Non-root `uid:gid` (or `uid`). Refused if it resolves to 0/root. */
  user: string;
  /** CPU quota, docker `--cpus` form (e.g. "2" or "1.5"). */
  cpus: string;
  /** Hard memory cap in MiB. Swap is pinned to the same value, so swap usage is zero. */
  memoryMb: number;
  /** Hard process cap (fork-bomb ceiling). */
  pidsLimit: number;
  /** Size of the single RAM-backed scratch tmpfs mounted at /tmp, in MiB. */
  tmpfsScratchMb: number;
  /** Graceful window (seconds) before `docker stop`/the orchestrator escalates to SIGKILL. */
  stopTimeoutSec: number;
  /** Which sandbox grant to emit. Defaults to 'userns'. */
  sandboxMechanism?: SandboxMechanism;
  /** Required when `sandboxMechanism === 'seccomp-profile'`: path to the curated profile. */
  seccompProfilePath?: string;
}

/** Mount points inside the container — kept in one place so the entrypoint and args agree. */
export const CONTAINER_MOUNTS = {
  /** Read-only: the package bytes + capture-spec.json. */
  input: '/input',
  /** Read-write: captured frames/clip + result.json, read back by the trusted side. */
  output: '/output',
  /** RAM-backed scratch: Chrome user-data-dir, /dev/shm substitute, temp. */
  scratch: '/tmp',
} as const;

function isRootUser(user: string): boolean {
  const uid = user.split(':', 1)[0]?.trim();
  return uid === '0' || uid === 'root' || uid === '';
}

/**
 * Assemble the argv that follows `docker` (i.e. starts with `run`). Spawn as
 * `spawn('docker', buildContainerRunArgv(spec))` — an array, never a shell string.
 *
 * Throws on any spec that would weaken the contract (root user, missing seccomp profile, non-positive
 * quota, empty image/name/dirs) so a misconfiguration fails at assembly, not at container start.
 */
export function buildContainerRunArgv(spec: ContainerRunSpec): string[] {
  const mechanism: SandboxMechanism = spec.sandboxMechanism ?? 'userns';

  if (!spec.image.trim()) throw new Error('containerRunArgs: image is required');
  if (!spec.containerName.trim()) throw new Error('containerRunArgs: containerName is required');
  if (!spec.inputDir.trim() || !spec.outputDir.trim()) {
    throw new Error('containerRunArgs: inputDir and outputDir are required');
  }
  if (isRootUser(spec.user)) {
    throw new Error(`containerRunArgs: refusing a root user (${JSON.stringify(spec.user)}); the container must run non-root`);
  }
  if (!(spec.memoryMb > 0) || !(spec.pidsLimit > 0) || !(spec.tmpfsScratchMb > 0)) {
    throw new Error('containerRunArgs: memoryMb, pidsLimit and tmpfsScratchMb must be positive');
  }
  if (!spec.cpus.trim()) throw new Error('containerRunArgs: cpus is required');
  if (mechanism === 'seccomp-profile' && !spec.seccompProfilePath?.trim()) {
    throw new Error("containerRunArgs: sandboxMechanism 'seccomp-profile' requires seccompProfilePath");
  }

  const argv: string[] = [
    'run',
    '--rm', // no leftover container; the work dirs are the only durable artefacts
    '--name', spec.containerName,
    '--init', // tini as PID 1: reaps zombies and forwards SIGKILL cleanly to the process tree

    // ── No network egress ──────────────────────────────────────────────────────────────────────
    // An isolated netns with only `lo` up. The loopback package server binds 127.0.0.1 and works;
    // the metadata endpoint, the backend, Postgres and every other host are simply unrouteable.
    '--network', 'none',

    // ── Read-only root, one writable RAM scratch, minimal binds ──────────────────────────────────
    '--read-only',
    '--tmpfs', `${CONTAINER_MOUNTS.scratch}:rw,nosuid,nodev,noexec,size=${spec.tmpfsScratchMb}m,mode=1777`,
    '--mount', `type=bind,src=${spec.inputDir},dst=${CONTAINER_MOUNTS.input},ro`,
    '--mount', `type=bind,src=${spec.outputDir},dst=${CONTAINER_MOUNTS.output},readonly=false`,

    // ── Identity & quotas ────────────────────────────────────────────────────────────────────────
    '--user', spec.user,
    '--cpus', spec.cpus,
    '--memory', `${spec.memoryMb}m`,
    '--memory-swap', `${spec.memoryMb}m`, // equal to --memory ⇒ zero swap
    '--pids-limit', String(spec.pidsLimit),
  ];

  // ── Privileges: drop everything, then grant ONLY what Chrome's sandbox needs ──────────────────
  argv.push('--cap-drop', 'ALL');
  if (mechanism === 'sys-admin') {
    argv.push('--cap-add', 'SYS_ADMIN');
  }
  if (mechanism === 'seccomp-profile') {
    argv.push('--security-opt', `seccomp=${spec.seccompProfilePath}`);
  }
  // Compatible with the namespace sandbox (which does not escalate via setuid) and closes the
  // setuid-escalation path for everything else in the container.
  argv.push('--security-opt', 'no-new-privileges:true');

  // ── Wall-clock ────────────────────────────────────────────────────────────────────────────────
  // docker cannot SIGKILL itself on a wall clock; this only bounds the graceful window. The hard
  // per-section / per-job wall-clock kill is the orchestrator's job (AbortSignal → docker kill KILL).
  argv.push('--stop-timeout', String(spec.stopTimeoutSec));

  argv.push(spec.image);
  return argv;
}
