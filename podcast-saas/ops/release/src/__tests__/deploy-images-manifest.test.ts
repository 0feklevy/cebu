import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Incident 9 (release v0.1.4, commit 2b830fd) — the image-manifest parser inside
 * deploy-images.sh was an f-string with backslash-escaped double quotes embedded in a
 * bash single-quoted `python3 -c` string. Bash passes single-quoted text verbatim, so
 * python3 received literal backslashes and died with:
 *
 *   SyntaxError: unexpected character after line continuation character
 *
 * remote-sync had already completed; remote-deploy failed before touching containers.
 * `bash -n` can never catch this class of bug (the Python program is just a quoted
 * bash argument), so these tests run the REAL embedded Python and the REAL script
 * (with docker mocked) instead of only linting.
 */

const APP_ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..');
const SCRIPT_PATH = join(APP_ROOT, 'deploy', 'scripts', 'deploy-images.sh');
const script = readFileSync(SCRIPT_PATH, 'utf8');

// --- The exact embedded Python program, extracted from the script -----------------

/** Pull the python3 -c program that feeds IMAGES= out of the script text. */
function extractImagesParser(): string {
  const m = script.match(/IMAGES="\$\(printf '%s' "\$\{ENVELOPE\}" \| python3 -c '([^']+)'\s*\)"/);
  expect(m, 'IMAGES parser (single-quoted python3 -c block) not found in deploy-images.sh').toBeTruthy();
  return m![1];
}

function runParser(input: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('python3', ['-c', extractImagesParser()], { input, encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;
const goodManifest = {
  schema: 'flowvid.image-manifest/v1',
  version: 'v0.1.4',
  gitSha: '2b830fd8cdfee4aae503e28d3e42bbf6501c1ab5',
  images: [
    { service: 'backend', repository: 'ghcr.io/0feklevy/cebu/backend', tag: 'v0.1.4', digest: DIGEST('a') },
    { service: 'client-web', repository: 'ghcr.io/0feklevy/cebu/client-web', tag: 'v0.1.4', digest: DIGEST('b') },
    { service: 'admin-web', repository: 'ghcr.io/0feklevy/cebu/admin-web', tag: 'v0.1.4', digest: DIGEST('c') },
  ],
};

describe('the embedded manifest parser is valid Python and shell-safe', () => {
  it('bash -n parses deploy-images.sh', () => {
    expect(() => execFileSync('/bin/bash', ['-n', SCRIPT_PATH])).not.toThrow();
  });

  it('the extracted parser compiles as Python (the v0.1.4 failure was a SyntaxError here)', () => {
    const src = extractImagesParser();
    expect(() => execFileSync('python3', ['-c', `import ast; ast.parse(${JSON.stringify(src)})`])).not.toThrow();
  });

  it('a valid manifest yields exact service<TAB>repository<TAB>digest rows', () => {
    const r = runParser(JSON.stringify({ manifest: goodManifest }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        `backend\tghcr.io/0feklevy/cebu/backend\t${DIGEST('a')}`,
        `client-web\tghcr.io/0feklevy/cebu/client-web\t${DIGEST('b')}`,
        `admin-web\tghcr.io/0feklevy/cebu/admin-web\t${DIGEST('c')}`,
      ].join('\n') + '\n',
    );
  });

  it('malformed JSON exits non-zero', () => {
    const r = runParser('{"manifest": not-json');
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toContain('SyntaxError'); // JSON errors, never Python source errors
  });

  for (const missing of ['service', 'repository', 'digest'] as const) {
    it(`an image entry missing "${missing}" exits non-zero and names the field`, () => {
      const images = goodManifest.images.map((i) => {
        const { [missing]: _dropped, ...rest } = i;
        return rest;
      });
      const r = runParser(JSON.stringify({ manifest: { ...goodManifest, images } }));
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(missing); // KeyError names the missing key
    });
  }
});

describe('the historical escaped f-string cannot re-enter deploy-images.sh', () => {
  it('no backslash-escaped double quotes inside dictionary subscripts', () => {
    expect(script).not.toContain('[\\"');
  });

  it('no f-strings at all in embedded python (single-quote AND double-quote forms break the bash quoting)', () => {
    expect(script).not.toMatch(/print\(f["']/);
    expect(script).not.toContain('print(f"{i');
  });

  it('the IMAGES parse failure dies with an explicit message', () => {
    expect(script).toMatch(/\|\| die "Manifest image list is invalid\."/);
  });
});

// --- Behavioral tests: the real script with docker mocked -------------------------

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * Build an isolated fake repo containing the REAL deploy-images.sh + _lib.sh, dummy
 * env fixtures (never the project's actual .env files), and a mock `docker` first on
 * PATH that records every invocation and never talks to a daemon.
 */
function makeSandbox(): { dir: string; dockerLog: string } {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-images-test-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'repo', 'deploy', 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  copyFileSync(SCRIPT_PATH, join(dir, 'repo', 'deploy', 'scripts', 'deploy-images.sh'));
  copyFileSync(join(APP_ROOT, 'deploy', 'scripts', '_lib.sh'), join(dir, 'repo', 'deploy', 'scripts', '_lib.sh'));
  // Dummy fixture env files (required to exist by require_env_file; contents fake).
  writeFileSync(join(dir, 'repo', 'deploy', '.env'), 'DOMAIN_ROOT=example.test\nAPP_VERSION=v0.1.3\n');
  writeFileSync(join(dir, 'repo', '.env'), '# fixture only\n');

  const dockerLog = join(dir, 'docker.log');
  writeFileSync(dockerLog, '');
  // Mock docker: records argv, drains stdin on login (never records it), and fails
  // login so a successful parse stops at "GHCR login failed" instead of deploying.
  const mock = [
    '#!/usr/bin/env bash',
    'printf \'docker %s\\n\' "$*" >> "${DOCKER_LOG}"',
    'case "${1:-}" in',
    '  info) exit 0 ;;',
    '  login) cat > /dev/null; exit 1 ;;',
    '  logout) exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n');
  writeFileSync(join(dir, 'bin', 'docker'), mock + '\n');
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  return { dir, dockerLog };
}

/** Run the sandboxed script with the envelope on stdin. */
async function runScript(envelope: string): Promise<{ code: number; stdout: string; stderr: string; dockerCalls: string[] }> {
  const sb = makeSandbox();
  const envelopeFile = join(sb.dir, 'envelope.json');
  writeFileSync(envelopeFile, envelope);
  const scriptFile = join(sb.dir, 'repo', 'deploy', 'scripts', 'deploy-images.sh');
  let code = 0;
  let stdout: string;
  let stderr: string;
  try {
    const r = await execFileAsync(
      '/bin/bash',
      ['-c', 'exec /bin/bash "$1" --stdin-envelope < "$2"', 'wrapper', scriptFile, envelopeFile],
      {
        env: {
          PATH: `${join(sb.dir, 'bin')}:${process.env.PATH ?? ''}`,
          HOME: sb.dir,
          DOCKER_LOG: sb.dockerLog,
          SKIP_CERT_CHECK: '1',
        },
      },
    );
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    code = typeof err.code === 'number' ? err.code : 1;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
  }
  const dockerCalls = readFileSync(sb.dockerLog, 'utf8').split('\n').filter(Boolean);
  return { code, stdout, stderr, dockerCalls };
}

const goodEnvelope = JSON.stringify({
  ghcrUser: '0feklevy',
  ghcrToken: 'mock-ghcr-token-value',
  manifest: goodManifest,
  skipMigrations: false,
});

describe('deploy-images.sh behavior with docker mocked', () => {
  it('a fixture equivalent to the failed v0.1.4 manifest parses cleanly and reaches docker login (no SyntaxError)', async () => {
    const r = await runScript(goodEnvelope);
    expect(r.stderr).not.toContain('SyntaxError');
    expect(r.stderr).not.toContain('line continuation character');
    // The mock fails login, so a fully-parsed run dies exactly there.
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('GHCR login failed');
    expect(r.dockerCalls.some((c) => c.startsWith('docker login ghcr.io') && c.includes('--password-stdin'))).toBe(true);
    // Parsing succeeded — but nothing was pulled, migrated, or recreated.
    expect(r.dockerCalls.every((c) => !c.includes('pull') && !c.includes('compose'))).toBe(true);
    // The registry token travels on stdin only — never in argv, logs, or output.
    for (const text of [r.stdout, r.stderr, r.dockerCalls.join('\n')]) {
      expect(text).not.toContain('mock-ghcr-token-value');
    }
  }, 30_000);

  it('malformed envelope JSON dies before ANY docker operation beyond the daemon guard', async () => {
    const r = await runScript('{"manifest": definitely-not-json');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Envelope JSON is invalid');
    expect(r.dockerCalls).toEqual(['docker info']);
  }, 30_000);

  it('an image entry missing "digest" dies at manifest parsing — no login, pull, migration, or compose', async () => {
    const images = goodManifest.images.map(({ digest: _d, ...rest }) => rest);
    const envelope = JSON.stringify({
      ghcrUser: '0feklevy',
      ghcrToken: 'mock-ghcr-token-value',
      manifest: { ...goodManifest, images },
    });
    const r = await runScript(envelope);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Manifest image list is invalid');
    expect(r.dockerCalls).toEqual(['docker info']);
  }, 30_000);
});
