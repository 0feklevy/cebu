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

describe('infrastructure failures never become production findings', () => {
  it('the browser install has its own collector and its exit code is captured', () => {
    // Discarding the install's exit code inverted the result model: a failed install let
    // `playwright test` run against a missing browser, every spec failed, results.json was
    // still written, and the run classified as FINDING — paging the on-call for a healthy
    // production because an apt mirror hiccupped.
    expect(AUDIT_CODE).toMatch(/npx playwright install[\s\S]{0,120}?inst=\$\?/);
    expect(AUDIT_CODE).toMatch(/--name browser-install/);
  });

  it('a failed browser install short-circuits before the suite can manufacture failures', () => {
    expect(AUDIT_CODE).toMatch(/if \[ "\$inst" -ne 0 \][\s\S]{0,600}?--status ERROR/);
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

  it('the daily audit demands the same release-blocking flows the release does', () => {
    // The audit ran GREEN for days while skipping project pages, playlists and admin preview,
    // because every one of those checks is `test.skip(!process.env.SMOKE_PUBLIC_PATH, …)` and
    // those repository variables are unset. A green audit that verified nothing is worse than a
    // red one that says so — and unlike the release path this audit only reports, so a CRITICAL
    // turns the run red and changes nothing in production.
    //
    // The two lists must stay in step: a flow the release blocks on but the daily audit ignores
    // is one that can rot for a month and only surface during a deploy.
    const flows = /--require-tests\s+'([^']+)'/.exec(AUDIT)?.[1];
    expect(flows, 'the daily audit requires no release-blocking flow to have run').toBeTruthy();
    const releaseFlows = /--require-tests\s+'([^']+)'/.exec(RELEASE)?.[1];
    expect(flows, 'the audit and the release disagree about which flows are release-blocking')
      .toBe(releaseFlows);
  });

  it('EVERY config a workflow names selects only self-contained specs', () => {
    // The rule below is applied to the production config by name. It has to apply to every config
    // CI actually invokes, or the next one added — candidate-smoke was exactly that — inherits the
    // danger with none of the protection. These jobs install neither backend-api nor shared/sim,
    // so a spec importing either dies during collection, before any browser opens, taking the
    // whole suite with it and producing no report at all.
    const CI_DIR = join(PRODUCTION_CONFIG, '..');
    const named = new Set<string>();
    for (const text of [AUDIT, RELEASE, ROLLBACK]) {
      for (const m of text.matchAll(/--config=(playwright\.[a-z-]+\.config\.ts)/g)) named.add(m[1]);
    }
    expect(named.size, 'no Playwright config is invoked by any workflow').toBeGreaterThan(0);

    for (const cfgName of named) {
      const cfgPath = join(CI_DIR, cfgName);
      expect(existsSync(cfgPath), `${cfgName} is invoked by a workflow but does not exist`).toBe(true);
      const cfg = readFileSync(cfgPath, 'utf8');
      const match = /testMatch:\s*\[([^\]]*)\]/.exec(cfg);
      expect(match, `${cfgName} declares no testMatch — it would collect every spec`).not.toBeNull();
      for (const spec of [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1])) {
        const file = join(CI_DIR, 'e2e', spec);
        expect(existsSync(file), `${cfgName} lists ${spec}, which does not exist`).toBe(true);
        for (const imp of [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])) {
          const ok = imp.startsWith('.') || imp === '@playwright/test' || imp.startsWith('node:');
          expect(ok, `${spec} (via ${cfgName}) imports "${imp}", which CI does not install`).toBe(true);
        }
      }
    }
  });

  it('the production config selects only SELF-CONTAINED specs, whatever the list is', () => {
    // Stated as the property rather than as the literal two-item list it used to pin. The reason
    // the list mattered was never its length: these jobs install neither backend-api nor
    // shared/sim, so a spec importing either dies during COLLECTION — before any browser opens,
    // taking the whole suite with it and producing no report at all. Adding a legitimate new
    // production spec turned the old assertion red for a reason unrelated to that danger, and
    // the obvious repair — paste the new filename in — quietly re-pinned the list without ever
    // checking the thing that actually breaks.
    expect(existsSync(PRODUCTION_CONFIG)).toBe(true);
    const cfg = readFileSync(PRODUCTION_CONFIG, 'utf8');

    const match = /testMatch:\s*\[([^\]]*)\]/.exec(cfg);
    expect(match, 'the production config declares no testMatch — it would collect every spec').not.toBeNull();
    const specs = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(specs.length, 'testMatch is empty').toBeGreaterThan(0);

    const E2E_DIR = join(PRODUCTION_CONFIG, '..', 'e2e');
    for (const spec of specs) {
      const file = join(E2E_DIR, spec);
      expect(existsSync(file), `${spec} is in testMatch but does not exist`).toBe(true);
      const src = readFileSync(file, 'utf8');
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec2 of imports) {
        const local = spec2.startsWith('.');
        const allowed = spec2 === '@playwright/test' || spec2.startsWith('node:');
        expect(
          local || allowed,
          `${spec} imports "${spec2}" — production jobs install neither backend-api nor shared, so this dies during collection`,
        ).toBe(true);
      }
    }

    // Only chromium is installed by these jobs; declaring firefox/webkit would fail to launch.
    expect(cfg).not.toContain("name: 'firefox'");
    expect(cfg).not.toContain("name: 'webkit'");
    // An audit must not retry a flaky production probe until it turns green.
    expect(cfg).toMatch(/retries:\s*0/);
  });

  for (const [name, text] of Object.entries({ 'production-audit.yml': AUDIT, 'release.yml': RELEASE, 'rollback.yml': ROLLBACK })) {
    it(`${name} never runs the default (all-specs, three-engine) Playwright config`, () => {
      // EVERY invocation must name a config, not just one of them. The previous form asserted
      // that the file CONTAINED `--config=playwright.production.config.ts` somewhere — so a
      // second, unconfigured `npx playwright test` added anywhere else in the same workflow was
      // satisfied by the first one's flag. release.yml now has two invocations, and adding the
      // second is exactly the edit that would have slipped through.
      const invocations = [...text.matchAll(/npx playwright test([^\n]*)/g)].map((m) => m[1]);
      for (const args of invocations) {
        expect(args, `${name} runs "npx playwright test" with no --config`).toMatch(
          /--config=playwright\.[a-z-]+\.config\.ts/,
        );
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

describe('identity-bearing evidence is actually stamped by its producer', () => {
  // A gate that declares a file identity-bearing while its producer never stamps identity
  // yields evidence.no-identity => CRITICAL => blocked => shouldRollback. In release.yml
  // that meant EVERY release would fail its post-deploy gate and auto-roll-back.
  for (const [name, text] of Object.entries({ 'production-audit.yml': AUDIT, 'release.yml': RELEASE, 'rollback.yml': ROLLBACK })) {
    it(`${name}: every --identity-bearing artifact has a producer that stamps it`, () => {
      const declared = [...text.matchAll(/--identity-bearing "([^"]+)"/g)].flatMap((m) => m[1].split(','));
      if (declared.length === 0) return;
      const producerFor: Record<string, RegExp> = {
        'endpoints.json': /release-cli endpoint-audit[\s\S]{0,200}?--run-id[\s\S]{0,200}?--git-sha/,
        'playwright-summary.json': /release-cli playwright-summary[\s\S]{0,300}?--run-id[\s\S]{0,300}?--git-sha/,
      };
      for (const artifact of declared) {
        const pattern = producerFor[artifact.trim()];
        expect(pattern, `no producer pattern known for ${artifact}`).toBeDefined();
        expect(text, `${name} declares ${artifact} identity-bearing but never stamps it with --run-id/--git-sha`).toMatch(pattern);
      }
    });
  }
});

describe('artifact uploads cannot publish production credentials', () => {
  // production-audit.spec.ts signs in with the real SMOKE_ADMIN_PASSWORD, and
  // `trace: retain-on-failure` captures DOM/network/cookies for failing runs — the exact
  // runs that get uploaded. A whole-directory upload therefore publishes the production
  // admin password to anyone with repository read access.
  for (const [name, text] of Object.entries({ 'production-audit.yml': AUDIT, 'release.yml': RELEASE, 'rollback.yml': ROLLBACK })) {
    it(`${name} never uploads the raw e2e-results directory`, () => {
      const bad = /path:\s*podcast-saas\/client-web\/e2e-results\s*(,|})|^\s*podcast-saas\/client-web\/e2e-results\s*$/m;
      expect(text, `${name} uploads Playwright traces/screenshots wholesale`).not.toMatch(bad);
    });
  }
});
