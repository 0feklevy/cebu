/**
 * Static contract for the production audit workflow.
 *
 * Two properties are enforced here because they are cheap to break and expensive to
 * discover: the audit must stay READ-ONLY, and it must never again turn a collector
 * failure into silence.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..', '..');
const WF_DIR = join(REPO, '.github', 'workflows');
const read = (f: string) => readFileSync(join(WF_DIR, f), 'utf8');

const AUDIT = read('production-audit.yml');
const RELEASE = read('release.yml');
const ROLLBACK = read('rollback.yml');

/**
 * Executable content only — YAML/shell comment lines removed.
 *
 * These workflows deliberately document the incidents they were hardened against, and
 * those comments quote the very strings the assertions below forbid (`|| true`,
 * `AUDIT_FAILED`). Asserting over raw text would force the fix to be undocumented.
 */
const code = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const AUDIT_CODE = code(AUDIT);

describe('the production audit is read-only', () => {
  /**
   * Commands that change production. If one of these ever appears in the audit workflow,
   * the audit has stopped being an observation and become an operation — the single most
   * dangerous regression this pipeline can have, because it runs unattended on a daily
   * schedule with production credentials and no approval gate.
   */
  const MUTATING = [
    'remote-deploy',
    'remote-rollback',
    'remote-sync',
    'remote-backfill',
    'state-transition',
    'state-init',
    'docker compose up',
    'docker compose restart',
    'docker restart',
    'db:migrate',
    'drizzle-kit push',
    'sim-canary-publish',
    'seed-sim-pool-from-production',
    '--mode apply',
    'gh release create',
    'docker push',
  ];

  for (const cmd of MUTATING) {
    it(`production-audit.yml never invokes "${cmd}"`, () => {
      expect(AUDIT_CODE, `production-audit.yml must stay read-only but references "${cmd}"`).not.toContain(cmd);
    });
  }

  it('requests only read permissions', () => {
    expect(AUDIT).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(AUDIT).not.toMatch(/packages:\s*write/);
    expect(AUDIT).not.toMatch(/contents:\s*write/);
  });

  it('checks out without persisting git credentials (it never pushes)', () => {
    expect(AUDIT).toContain('persist-credentials: false');
  });

  it('only ever uses the read-only remote-audit SSH command', () => {
    const remoteCalls = [...AUDIT_CODE.matchAll(/release-cli (remote-[a-z-]+)/g)].map((m) => m[1]);
    expect(new Set(remoteCalls)).toEqual(new Set(['remote-audit']));
  });
});

describe('collector status is never erased', () => {
  it('production-audit.yml contains no `|| true`', () => {
    // `|| true` suppresses the exit code AND the status. Continuing after a failed
    // collector is correct; forgetting that it failed is what made a dead Playwright
    // indistinguishable from a passing one.
    expect(AUDIT_CODE).not.toContain('|| true');
  });

  it('every exit-code capture is pipefail-protected', () => {
    // GitHub Actions runs `run:` blocks under `bash -e`, which does NOT set pipefail. If a
    // collector command is ever piped (`cmd | tee log`), `$?` yields the LAST command's
    // status — so a collector that exited 1 with a CRITICAL production finding would be
    // recorded as PASS. Found by piping a collector during a local dry run of this very
    // workflow, which reported PASS for the live api-health 503.
    const captures = (AUDIT_CODE.match(/^\s*set \+e$/gm) ?? []).length;
    const pipefails = (AUDIT_CODE.match(/^\s*set -o pipefail$/gm) ?? []).length;
    expect(captures).toBeGreaterThan(0);
    expect(pipefails, 'every `set +e` capture block must be preceded by `set -o pipefail`').toBe(captures);
  });

  it('every collector step records an explicit outcome', () => {
    const collectors = ['endpoint-audit', 'csp-audit', 'remote-audit', 'playwright-preflight', 'browser-tests', 'playwright-summary', 'browser-audit'];
    for (const name of collectors) {
      expect(AUDIT, `no collector-record for ${name}`).toMatch(new RegExp(`--name "?${name}`));
    }
  });

  it('ends in exactly one explicit terminal state', () => {
    for (const state of ['PASS', 'BLOCKED_BY_FINDINGS', 'BLOCKED_BY_AUDIT_ERROR']) {
      expect(AUDIT).toContain(state);
    }
    // The old generic verdict must not come back as an executable value.
    expect(AUDIT_CODE).not.toContain('AUDIT_FAILED');
  });

  it('distinguishes the two blocking states in what it prints to the operator', () => {
    expect(AUDIT).toMatch(/BLOCKED_BY_FINDINGS[\s\S]{0,400}production incident/i);
    expect(AUDIT).toMatch(/BLOCKED_BY_AUDIT_ERROR[\s\S]{0,400}UNKNOWN/i);
  });
});

describe('evidence paths do not depend on the caller’s cwd', () => {
  // `pnpm --filter ops-release` sets cwd to ops/release, so any repo-relative evidence
  // path silently resolves under ops/release and yields ENOENT.
  const BAD = 'playwright-summary --report client-web/';

  for (const [name, text] of Object.entries({ 'production-audit.yml': AUDIT, 'release.yml': RELEASE, 'rollback.yml': ROLLBACK })) {
    it(`${name} passes an absolute Playwright report path`, () => {
      expect(text, `${name} still uses a cwd-relative --report path`).not.toContain(BAD);
      if (text.includes('playwright-summary')) {
        expect(text).toMatch(/--report "\$\{\{ github\.workspace \}\}[^"]*results\.json"|--report "\$PW_RESULTS"/);
      }
    });
  }
});

describe('the gate demands current evidence', () => {
  for (const [name, text] of Object.entries({ 'production-audit.yml': AUDIT, 'release.yml': RELEASE, 'rollback.yml': ROLLBACK })) {
    it(`${name} requires evidence to exist and to belong to this run`, () => {
      expect(text, `${name} gate does not use --require`).toContain('--require');
      expect(text, `${name} gate does not use --identity-bearing`).toContain('--identity-bearing');
      expect(text).toContain('--expect-run-id');
      expect(text).toContain('--expect-git-sha');
    });
  }
});

describe('Playwright runs the production config, not the full local matrix', () => {
  const PRODUCTION_CONFIG = join(REPO, 'podcast-saas', 'client-web', 'playwright.production.config.ts');

  it('the production config exists and selects only the two self-contained audit specs', () => {
    expect(existsSync(PRODUCTION_CONFIG)).toBe(true);
    const cfg = readFileSync(PRODUCTION_CONFIG, 'utf8');
    expect(cfg).toContain("testMatch: ['production-audit.spec.ts', 'production-smoke.spec.ts']");
    // Only chromium is installed by these jobs; declaring firefox/webkit would fail to launch.
    expect(cfg).not.toContain("name: 'firefox'");
    expect(cfg).not.toContain("name: 'webkit'");
    // An audit must not retry a flaky production probe until it turns green.
    expect(cfg).toMatch(/retries:\s*0/);
  });

  for (const [name, text] of Object.entries({ 'production-audit.yml': AUDIT, 'release.yml': RELEASE, 'rollback.yml': ROLLBACK })) {
    it(`${name} never runs the default (all-specs, three-engine) Playwright config`, () => {
      const bare = text.match(/^\s*npx playwright test\s*$/m);
      expect(bare, `${name} runs "npx playwright test" with the default config`).toBeNull();
      if (text.includes('npx playwright test')) {
        expect(text).toContain('--config=playwright.production.config.ts');
      }
    });
  }

  it('the audit proves specs load before paying for a browser download', () => {
    const preflight = AUDIT.indexOf('--list');
    const install = AUDIT.indexOf('playwright install');
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight, 'the preflight must run before the browser install').toBeLessThan(install);
  });
});

describe('secret hygiene', () => {
  it('never echoes the SSH key or smoke credentials', () => {
    for (const [name, text] of Object.entries({ 'production-audit.yml': AUDIT, 'release.yml': RELEASE, 'rollback.yml': ROLLBACK })) {
      expect(text, `${name} echoes a secret`).not.toMatch(/echo .*secrets\./);
      expect(text, `${name} cats the ssh key`).not.toMatch(/cat .*\.ssh-deploy-key/);
    }
  });

  it('writes SSH credentials with a restrictive umask', () => {
    expect(AUDIT).toMatch(/umask 077[\s\S]{0,200}\.ssh-deploy-key/);
  });
});
