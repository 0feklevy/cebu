import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Regression for the PR #2 CI failure:
 *   release-verify.sh: line 68/76: ${#MOVED[@]:-0}: bad substitution
 * (invalid bash — array-length expansion cannot take a `:-` default; macOS
 * bash 3.2 tolerated it, the CI runner's bash 5 fails).
 *
 * These tests run the REAL release-verify.sh inside a sandbox repo tree with a
 * stubbed `pnpm` (and stubbed bundle scan), proving the .env.local isolation
 * contract on the host's actual /bin/bash:
 *   - zero .env.local files → clean run, "(none present)", no bad substitution;
 *   - multiple .env.local files → moved for the build, RESTORED on success;
 *   - an early command failure → the EXIT trap still restores every file.
 */

const APP_ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..');
const REAL_SCRIPT = join(APP_ROOT, 'deploy', 'scripts', 'release-verify.sh');

let sandbox: string;

function makeSandbox(): void {
  sandbox = mkdtempSync(join(tmpdir(), 'relverify-'));
  mkdirSync(join(sandbox, 'deploy', 'scripts'), { recursive: true });
  mkdirSync(join(sandbox, 'client-web'), { recursive: true });
  mkdirSync(join(sandbox, 'admin-web'), { recursive: true });
  mkdirSync(join(sandbox, 'bin'), { recursive: true });

  copyFileSync(REAL_SCRIPT, join(sandbox, 'deploy', 'scripts', 'release-verify.sh'));

  // Stubs: pnpm honours STUB_FAIL=1 (first invocation fails → early exit under set -e);
  // the bundle scan always passes (its own logic is covered elsewhere).
  writeFileSync(join(sandbox, 'bin', 'pnpm'), '#!/bin/bash\nif [ "${STUB_FAIL:-0}" = "1" ]; then exit 1; fi\nexit 0\n');
  chmodSync(join(sandbox, 'bin', 'pnpm'), 0o755);
  writeFileSync(join(sandbox, 'deploy', 'scripts', 'scan-bundle-localhost.sh'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(sandbox, 'deploy', 'scripts', 'scan-bundle-localhost.sh'), 0o755);
}

function runScript(env: Record<string, string> = {}): { status: number; output: string } {
  const res = spawnSync('/bin/bash', [join(sandbox, 'deploy', 'scripts', 'release-verify.sh')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(sandbox, 'bin')}:${process.env.PATH}`, ...env },
    timeout: 60_000,
  });
  return { status: res.status ?? -1, output: `${res.stdout}\n${res.stderr}` };
}

const ENV_LOCALS = ['.env.local', 'client-web/.env.local', 'admin-web/.env.local'];

/** Distinctive but fake dev values — this is test fixture data, not a real env file. */
function plantEnvLocals(): void {
  for (const rel of ENV_LOCALS) {
    writeFileSync(join(sandbox, rel), `# fixture ${rel}\nNEXT_PUBLIC_API_URL=http://localhost:8080\n`);
  }
}

beforeEach(makeSandbox);

describe('release-verify.sh .env.local isolation (bash-5-safe)', () => {
  it('bash -n parses the script (syntax)', () => {
    expect(() => execFileSync('/bin/bash', ['-n', REAL_SCRIPT])).not.toThrow();
  });

  it('zero .env.local files: succeeds, reports "(none present)", no bad substitution', () => {
    const { status, output } = runScript();
    expect(output).not.toMatch(/bad substitution/i);
    expect(output).toContain('(none present)');
    expect(status).toBe(0);
  });

  it('three .env.local files: moved during the run and restored after SUCCESS', () => {
    plantEnvLocals();
    const { status, output } = runScript();
    expect(output).not.toMatch(/bad substitution/i);
    expect(status).toBe(0);
    expect(output).toContain('restored 3 .env.local file(s)');
    for (const rel of ENV_LOCALS) {
      expect(existsSync(join(sandbox, rel)), `${rel} must be restored`).toBe(true);
      expect(existsSync(join(sandbox, `${rel}.release-bak`)), `${rel}.release-bak must be gone`).toBe(false);
    }
  });

  it('early command failure (install fails): EXIT trap still restores every file', () => {
    plantEnvLocals();
    const { status, output } = runScript({ STUB_FAIL: '1' });
    expect(output).not.toMatch(/bad substitution/i);
    expect(status).not.toBe(0); // the failure itself must still fail the gate
    expect(output).toContain('restored 3 .env.local file(s)');
    for (const rel of ENV_LOCALS) {
      expect(existsSync(join(sandbox, rel)), `${rel} must be restored after failure`).toBe(true);
      expect(existsSync(join(sandbox, `${rel}.release-bak`))).toBe(false);
    }
  });
});
