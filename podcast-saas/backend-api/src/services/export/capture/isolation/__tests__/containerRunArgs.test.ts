/**
 * The hardened `docker run` argv is the container contract, so the argv is what we pin here. These
 * assertions are the local, macOS-runnable half of §0.2: the flag SET is exactly right. Whether the
 * flags DO what they claim on a Linux host (egress actually blocked, rootfs actually read-only,
 * Chrome's sandbox actually initialises) is the container-verification checklist in the runbook.
 */

import { describe, expect, it } from 'vitest';

import { buildContainerRunArgv, CONTAINER_MOUNTS, type ContainerRunSpec } from '../containerRunArgs.js';

const BASE: ContainerRunSpec = {
  image: 'registry/podcast-export-worker@sha256:' + 'a'.repeat(64),
  containerName: 'export-capture-sec1',
  inputDir: '/work/in',
  outputDir: '/work/out',
  user: '10001:10001',
  cpus: '2',
  memoryMb: 2048,
  pidsLimit: 256,
  tmpfsScratchMb: 512,
  stopTimeoutSec: 10,
};

/** True if the argv contains the flag immediately followed by exactly `value`. */
function hasFlagValue(argv: string[], flag: string, value: string): boolean {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1] === value) return true;
  }
  return false;
}

/** All values that immediately follow occurrences of `flag`. */
function valuesOf(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === flag) out.push(argv[i + 1]);
  return out;
}

describe('buildContainerRunArgv — the hardened flag set', () => {
  it('starts with run and pins the image last', () => {
    const argv = buildContainerRunArgv(BASE);
    expect(argv[0]).toBe('run');
    expect(argv[argv.length - 1]).toBe(BASE.image);
  });

  it('has NO network egress (--network none)', () => {
    expect(hasFlagValue(buildContainerRunArgv(BASE), '--network', 'none')).toBe(true);
  });

  it('runs read-only rootfs with a single RAM tmpfs work dir', () => {
    const argv = buildContainerRunArgv(BASE);
    expect(argv).toContain('--read-only');
    const tmpfs = valuesOf(argv, '--tmpfs');
    expect(tmpfs).toHaveLength(1);
    expect(tmpfs[0]).toContain(`${CONTAINER_MOUNTS.scratch}:`);
    expect(tmpfs[0]).toContain('nosuid');
    expect(tmpfs[0]).toContain('nodev');
    expect(tmpfs[0]).toContain('noexec');
    expect(tmpfs[0]).toContain('size=512m');
  });

  it('mounts input read-only and output read-write', () => {
    const mounts = valuesOf(buildContainerRunArgv(BASE), '--mount');
    const input = mounts.find((m) => m.includes(`dst=${CONTAINER_MOUNTS.input}`));
    const output = mounts.find((m) => m.includes(`dst=${CONTAINER_MOUNTS.output}`));
    expect(input).toContain('src=/work/in');
    expect(input).toContain(',ro');
    expect(output).toContain('src=/work/out');
    expect(output).toContain('readonly=false');
  });

  it('runs as a non-root user', () => {
    expect(hasFlagValue(buildContainerRunArgv(BASE), '--user', '10001:10001')).toBe(true);
  });

  it('sets hard CPU / memory / PID quotas with swap disabled', () => {
    const argv = buildContainerRunArgv(BASE);
    expect(hasFlagValue(argv, '--cpus', '2')).toBe(true);
    expect(hasFlagValue(argv, '--memory', '2048m')).toBe(true);
    expect(hasFlagValue(argv, '--memory-swap', '2048m')).toBe(true); // == memory ⇒ no swap
    expect(hasFlagValue(argv, '--pids-limit', '256')).toBe(true);
  });

  it('drops ALL capabilities and adds no-new-privileges', () => {
    const argv = buildContainerRunArgv(BASE);
    expect(hasFlagValue(argv, '--cap-drop', 'ALL')).toBe(true);
    expect(valuesOf(argv, '--security-opt')).toContain('no-new-privileges:true');
  });

  it('bounds the graceful window and uses an init PID 1', () => {
    const argv = buildContainerRunArgv(BASE);
    expect(hasFlagValue(argv, '--stop-timeout', '10')).toBe(true);
    expect(argv).toContain('--init');
    expect(argv).toContain('--rm');
  });

  it('NEVER passes --no-sandbox and NEVER --privileged', () => {
    const argv = buildContainerRunArgv(BASE);
    expect(argv).not.toContain('--no-sandbox');
    expect(argv.join(' ')).not.toContain('--no-sandbox');
    expect(argv).not.toContain('--privileged');
  });

  it('passes NO environment variables (no credential can ride in)', () => {
    const argv = buildContainerRunArgv(BASE);
    expect(argv).not.toContain('-e');
    expect(argv).not.toContain('--env');
    expect(argv).not.toContain('--env-file');
  });
});

describe('buildContainerRunArgv — sandbox mechanisms (never --no-sandbox)', () => {
  it("default 'userns' grants nothing beyond cap-drop ALL (relies on host unprivileged userns)", () => {
    const argv = buildContainerRunArgv(BASE);
    expect(argv).not.toContain('--cap-add');
    expect(valuesOf(argv, '--security-opt').some((v) => v.startsWith('seccomp='))).toBe(false);
    expect(argv).not.toContain('--no-sandbox');
  });

  it("'sys-admin' grants EXACTLY {SYS_ADMIN, SYS_CHROOT} — the pair proven on Ubuntu 26.04", () => {
    const argv = buildContainerRunArgv({ ...BASE, sandboxMechanism: 'sys-admin' });
    // Exact set, not merely membership: a regression that DROPS one cap (SYS_ADMIN alone dies at
    // sys_chroot("/proc/self/fdinfo/"), exit 133) or smuggles in a third must fail here.
    expect(valuesOf(argv, '--cap-add').sort()).toEqual(['SYS_ADMIN', 'SYS_CHROOT']);
    expect(hasFlagValue(argv, '--cap-drop', 'ALL')).toBe(true);
    expect(argv).not.toContain('--no-sandbox');
  });

  it("'sys-admin' keeps the full jail: network none, read-only, tmpfs scratch, non-root, quotas, no-new-privileges", () => {
    const argv = buildContainerRunArgv({ ...BASE, sandboxMechanism: 'sys-admin' });
    expect(hasFlagValue(argv, '--network', 'none')).toBe(true);
    expect(argv).toContain('--read-only');
    expect(valuesOf(argv, '--tmpfs').some((v) => v.startsWith(`${CONTAINER_MOUNTS.scratch}:rw,nosuid,nodev,noexec`))).toBe(true);
    expect(hasFlagValue(argv, '--user', BASE.user)).toBe(true);
    expect(hasFlagValue(argv, '--pids-limit', '256')).toBe(true);
    expect(hasFlagValue(argv, '--memory', '2048m')).toBe(true);
    expect(hasFlagValue(argv, '--memory-swap', '2048m')).toBe(true);
    expect(valuesOf(argv, '--security-opt')).toContain('no-new-privileges:true');
    expect(argv).not.toContain('--privileged');
    expect(argv).not.toContain('--no-sandbox');
  });

  it("'seccomp-profile' passes the profile via --security-opt", () => {
    const argv = buildContainerRunArgv({
      ...BASE,
      sandboxMechanism: 'seccomp-profile',
      seccompProfilePath: '/etc/chrome.seccomp.json',
    });
    expect(valuesOf(argv, '--security-opt')).toContain('seccomp=/etc/chrome.seccomp.json');
    expect(argv).not.toContain('--no-sandbox');
  });

  it("'seccomp-profile' without a path throws", () => {
    expect(() => buildContainerRunArgv({ ...BASE, sandboxMechanism: 'seccomp-profile' })).toThrow(/seccompProfilePath/);
  });
});

describe('buildContainerRunArgv — refusing to weaken the contract', () => {
  it('refuses a root user', () => {
    expect(() => buildContainerRunArgv({ ...BASE, user: '0:0' })).toThrow(/root/);
    expect(() => buildContainerRunArgv({ ...BASE, user: 'root' })).toThrow(/root/);
    expect(() => buildContainerRunArgv({ ...BASE, user: '0' })).toThrow(/root/);
  });

  it('refuses empty image / name / dirs', () => {
    expect(() => buildContainerRunArgv({ ...BASE, image: '' })).toThrow(/image/);
    expect(() => buildContainerRunArgv({ ...BASE, containerName: '' })).toThrow(/containerName/);
    expect(() => buildContainerRunArgv({ ...BASE, inputDir: '' })).toThrow(/inputDir/);
  });

  it('refuses non-positive quotas', () => {
    expect(() => buildContainerRunArgv({ ...BASE, memoryMb: 0 })).toThrow(/positive/);
    expect(() => buildContainerRunArgv({ ...BASE, pidsLimit: 0 })).toThrow(/positive/);
    expect(() => buildContainerRunArgv({ ...BASE, tmpfsScratchMb: -1 })).toThrow(/positive/);
  });
});
