import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJobGraph } from '../workflow-graph.js';

/**
 * Static checks over .github/workflows/*.yml — action runtime currency,
 * credential hygiene, audit metadata, and least-privilege invariants.
 * (Run 29528323804 fixes: Node-20 action deprecations, the post-checkout
 * git-128 warning, and audits reporting UNKNOWN with no Started time.)
 */

const WF_DIR = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..', '..', '.github', 'workflows');
const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));
const wf = Object.fromEntries(files.map((f) => [f, readFileSync(join(WF_DIR, f), 'utf8')]));

describe('action runtimes are current (no Node-20-era majors)', () => {
  /** Versions the 2026-07-16 audit flagged as deprecated (or same-era peers). */
  const FORBIDDEN = [
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'actions/upload-artifact@v4',
    'actions/download-artifact@v4',
    'pnpm/action-setup@v4',
    'docker/setup-buildx-action@v3',
    'docker/login-action@v3',
    'docker/build-push-action@v6',
  ];
  /** The reviewed replacements (see release-notes evidence in the fix commit). */
  const EXPECTED = [
    'actions/checkout@v6',
    'actions/setup-node@v6',
    'actions/upload-artifact@v6',
    'pnpm/action-setup@v6',
  ];

  for (const [name, text] of Object.entries(wf)) {
    it(`${name} uses no deprecated action majors`, () => {
      for (const bad of FORBIDDEN) {
        expect(text, `${name} still uses ${bad}`).not.toContain(`uses: ${bad}`);
      }
    });
  }

  it('the audit workflow uses the reviewed replacements', () => {
    for (const good of EXPECTED) {
      expect(wf['production-audit.yml']).toContain(`uses: ${good}`);
    }
  });

  it('every action reference is pinned to a major tag (no floating latest/main)', () => {
    for (const [name, text] of Object.entries(wf)) {
      for (const m of text.matchAll(/uses:\s*([^\s#]+)/g)) {
        expect(m[1], `${name}: ${m[1]}`).toMatch(/@v\d+(\.\d+)*$/);
      }
    }
  });
});

describe('checkout credential hygiene (git-128 post-step fix)', () => {
  it('the read-only production audit never persists git credentials', () => {
    expect(wf['production-audit.yml']).toContain('persist-credentials: false');
  });

  it('ci and rollback checkouts do not persist credentials (they never push)', () => {
    // Derived from the file rather than hardcoded: the invariant is "EVERY checkout in
    // these workflows opts out", so adding a job must not mean editing a magic number
    // here — while a checkout added without the flag still fails, which is the point.
    for (const name of ['ci.yml', 'rollback.yml']) {
      const checkouts = (wf[name].match(/uses: actions\/checkout@v\d+/g) ?? []).length;
      const withoutCreds = (wf[name].match(/persist-credentials: false/g) ?? []).length;
      expect(checkouts, `${name} performs no checkout`).toBeGreaterThan(0);
      expect(withoutCreds, `${name}: every checkout must set persist-credentials: false`).toBe(checkouts);
    }
  });

  it('the CI redundancy guard can only remove proven-duplicate work, never weaken it', () => {
    const ci = wf['ci.yml'];
    // Both verification jobs must be gated on the guard, or one of them silently keeps
    // running while the other is skipped — a half-verified push that reads as green.
    for (const job of ['release-verify:', 'static-audits:']) {
      const body = ci.slice(ci.indexOf(`  ${job}`));
      expect(body.slice(0, 400), `${job} must depend on the guard`).toContain('needs: guard');
      expect(body.slice(0, 400), `${job} must be conditioned on the guard`).toContain("needs.guard.outputs.skip != 'true'");
    }
    // The guard may only skip a MERGE whose tree is byte-identical to a PR head that
    // already passed a pull_request run. Losing any of these turns it into a way to
    // skip verification outright.
    expect(ci).toContain("event==\"pull_request\"");
    expect(ci).toContain('conclusion=="success"');
    expect(ci).toContain("HEAD^2^{tree}");
    // An API failure must fall through to "not proven" (run everything), never to skip.
    expect(ci).toContain('|| echo 0');
    // The guard itself must never be the thing that decides a release is safe.
    expect(wf['release.yml']).toContain('release:verify');
  });

  it('release keeps credentials ONLY for the remote-read (plan) and tag-push (release-plan) jobs', () => {
    // Stated as the PROPERTY, not as a pair of magic totals. The previous form asserted
    // `checkouts === 7 && withoutCreds === 5`, which meant adding any job — including a new
    // *gate* — turned this test red for a reason unrelated to credentials, and the obvious
    // repair was to bump both numbers. A test whose repair is "increment the constant" stops
    // being read, and the invariant it was protecting quietly stops being checked.
    const CREDENTIALED = new Set(['plan', 'release-plan']);
    const jobs = parseJobGraph(wf['release.yml']);
    expect(jobs.size).toBeGreaterThan(0);

    for (const [name, job] of jobs) {
      if (!/uses: actions\/checkout@v\d+/.test(job.text)) continue;
      const keepsCreds = !job.text.includes('persist-credentials: false');
      expect(keepsCreds, `job "${name}" ${keepsCreds ? 'keeps' : 'drops'} checkout credentials`).toBe(
        CREDENTIALED.has(name),
      );
    }
    // Both exceptions must still justify themselves in the file the reader is looking at.
    expect(wf['release.yml']).toContain('credentials kept: preflight runs `git ls-remote');
    expect(wf['release.yml']).toContain('credentials kept: this job pushes the annotated release tag');
  });
});

describe('audit report metadata (no UNKNOWN state, no missing Started)', () => {
  it('production audit records a start time and reports with --kind audit', () => {
    expect(wf['production-audit.yml']).toContain('AUDIT_STARTED_AT=$(date -u');
    expect(wf['production-audit.yml']).toContain('--kind audit');
    expect(wf['production-audit.yml']).toContain('--started-at "${AUDIT_STARTED_AT}"');
  });

  it('rollback records a start time and reports with --kind rollback', () => {
    expect(wf['rollback.yml']).toContain('ROLLBACK_STARTED_AT=$(date -u');
    expect(wf['rollback.yml']).toContain('--kind rollback');
  });
});

describe('least-privilege permissions are preserved', () => {
  for (const [name, text] of Object.entries(wf)) {
    it(`${name} defaults to contents: read`, () => {
      expect(text).toMatch(/^permissions:\n\s+contents: read/m);
    });
  }

  it('packages: write appears only in the image-build job; contents: write only for tag/publish/deploy', () => {
    expect((wf['release.yml'].match(/packages: write/g) ?? []).length).toBe(1);
    // THREE, deliberately, as of 2026-08-25 — tag, publish, and now deploy. The deploy job's
    // write exists for exactly one push: advancing refs/deployed/production after the
    // post-deploy gate passes, which is what anchors the next release's risk window to what is
    // actually RUNNING rather than to the last tag (the tagged-but-undeployed hole, run
    // 32854681109). Widening this number further is a review event, which is the point of
    // counting rather than merely matching.
    expect((wf['release.yml'].match(/contents: write/g) ?? []).length).toBe(3);
    // And the deploy job's write must be paired with the ref-advance step it exists for — a
    // fourth job acquiring write without a stated single purpose should fail here, not pass
    // because the total happens to be right.
    expect(wf['release.yml']).toContain('refs/deployed/production');
    // Assert the PERMISSION, not the substring. The bare `not.toContain('write')` also
    // forbade the word in comments, so documenting why the audit is read-only broke the
    // least-privilege test. This checks what the test actually means: no permission scope
    // in the audit workflow grants write.
    const auditPermissions = [...wf['production-audit.yml'].matchAll(/^\s*([a-z-]+):\s*(read|write|none)\s*$/gm)];
    expect(auditPermissions.length).toBeGreaterThan(0);
    for (const [, scope, level] of auditPermissions) {
      expect(level, `production-audit.yml grants ${scope}: ${level}`).not.toBe('write');
    }
  });
});

describe('a job that does not check out cannot use the repo-relative default', () => {
  /**
   * THE BUG THIS PINS, and it is the expensive kind: the failure looked like the feature working.
   *
   * `defaults.run.working-directory: podcast-saas` applies to EVERY job. The human-approval job
   * exists only to hold the deployment-environment gate, so it checks nothing out — and its step
   * died with "An error occurred trying to start process '/usr/bin/bash' … No such file or
   * directory" BEFORE the environment could request a review. The job failed, `deploy` was skipped
   * as a dependency, and the release report said approval had not been given.
   *
   * Which is true, and useless: nobody was ever ASKED. Two releases (v0.2.4 and the 2026-08-26
   * run) were read as "waiting on the owner" while no approval request existed anywhere in GitHub.
   * A gate that cannot ask is indistinguishable from one that was refused.
   */
  const workflow = wf['release.yml'];

  /** Job bodies, split on two-space-indented job keys. */
  function jobBodies(text: string): Map<string, string> {
    const out = new Map<string, string>();
    const re = /\n {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9-]*:\n|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.set(m[1], m[2]);
    return out;
  }

  it('the workflow-level default is repo-relative, which is the precondition for this trap', () => {
    // If this ever stops being true the rule below becomes unnecessary rather than wrong — but it
    // should be a deliberate change, not a silent one.
    expect(workflow).toMatch(/^defaults:\n {2}run:\n {4}working-directory: podcast-saas$/m);
  });

  it('every job that runs a command without checking out overrides working-directory', () => {
    const offenders: string[] = [];
    for (const [name, body] of jobBodies(workflow)) {
      // Comments are stripped inline: a `# … run: …` line in prose would otherwise read as a
      // command, and a job explaining why it has none would fail its own rule.
      const text = body.replace(/^\s*#.*$/gm, '');
      if (!/^\s+run:/m.test(text)) continue;                    // no commands, nothing to break
      if (/uses: actions\/checkout/.test(text)) continue;        // has a repo, default is fine
      if (!/working-directory:\s*\.\s*$/m.test(text)) offenders.push(name);
    }
    expect(offenders, 'these jobs run commands with no checkout and no working-directory override')
      .toEqual([]);
  });
});

describe('release artifacts never dirty the release checkout (run 29602969853 fix)', () => {
  const REPO_ROOT = join(WF_DIR, '..', '..');

  /** Text of one job in release.yml (two-space-indented job keys delimit sections). */
  function releaseJob(name: string): string {
    const m = wf['release.yml'].match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z][a-z-]*:\\n|$)`));
    if (!m) throw new Error(`job ${name} not found in release.yml`);
    return m[0];
  }

  it('every artifact-staging workflow keeps $ART at <workspace>/release-artifacts', () => {
    for (const name of ['release.yml', 'rollback.yml', 'production-audit.yml']) {
      expect(wf[name], name).toContain('ART: ${{ github.workspace }}/release-artifacts');
    }
  });

  it('the repo root gitignores /release-artifacts/ (else preflight flags its own plan/state files)', () => {
    const rootIgnore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(rootIgnore).toMatch(/^\/release-artifacts\/$/m);
  });

  it('plan.json and state.json land in $ART before preflight runs (the order that failed)', () => {
    const plan = releaseJob('plan');
    const iPlan = plan.indexOf('release-cli plan --bump');
    const iState = plan.indexOf('release-cli state-init');
    const iPreflight = plan.indexOf('release-cli preflight');
    expect(iPlan).toBeGreaterThan(-1);
    expect(iState).toBeGreaterThan(iPlan);
    expect(iPreflight).toBeGreaterThan(iState);
  });

  it('no tag is created when preflight fails: tagging lives only in release-plan, gated on the plan job', () => {
    expect((wf['release.yml'].match(/git tag -a/g) ?? []).length).toBe(1);
    const releasePlan = releaseJob('release-plan');
    expect(releasePlan).toContain('git tag -a');
    expect(releasePlan).toMatch(/needs: \[plan, verify, build-images\]/);
  });
});

describe('a failed remote-sync never touches containers and never stays stuck in DEPLOYING', () => {
  /** Text of one job in release.yml (two-space-indented job keys delimit sections). */
  function releaseJob(name: string): string {
    const m = wf['release.yml'].match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z][a-z-]*:\\n|$)`));
    if (!m) throw new Error(`job ${name} not found in release.yml`);
    return m[0];
  }
  const deploy = releaseJob('deploy');

  it('remote-sync is a gated, non-fatal step with an explicit id', () => {
    expect(deploy).toMatch(/id: remote_sync\n\s+continue-on-error: true/);
  });

  it('remote-deploy (the only step that touches containers) runs ONLY when remote-sync succeeded', () => {
    // The single remote-deploy step is gated on the sync outcome, so a sync failure can
    // never reach the pull/retag/migrate/recreate path.
    const deployStep = deploy.match(/- name: Deploy exact digests[\s\S]*?run: pnpm[^\n]*remote-deploy[^\n]*/);
    expect(deployStep, 'remote-deploy step not found').toBeTruthy();
    expect(deployStep![0]).toContain("if: steps.remote_sync.outcome == 'success'");
  });

  it('a failed remote-sync transitions the release to FAILED before remote-deploy (no stuck DEPLOYING)', () => {
    const iFailHandler = deploy.indexOf("if: steps.remote_sync.outcome != 'success'");
    const iDeployCmd = deploy.indexOf('remote-deploy $REMOTE'); // the actual container-touching call
    expect(iFailHandler).toBeGreaterThan(-1);
    expect(iDeployCmd).toBeGreaterThan(iFailHandler); // the guard runs before the deploy call
    // …and the guard is what records FAILED.
    const guard = deploy.slice(iFailHandler, iDeployCmd);
    expect(guard).toMatch(/state-transition[\s\S]*--to FAILED/);
    expect(guard).toMatch(/exit 1/);
  });
});

/**
 * EVERY BROWSER SUITE IS EITHER RUN BY A WORKFLOW OR EXPLICITLY EXCUSED.
 *
 * `client-web` carries eleven Playwright configs. On 2026-08-26 an audit found that **eight of
 * them were invoked by nothing** — including `playwright.authoring.config.ts`, the only place the
 * control-picker's badge geometry is checked anywhere, which had caught a real product bug (a
 * queued rAF rebuilding the overlay after DISARM) on the day it was written and could then have
 * regressed silently forever.
 *
 * This is the second time in this package. `viewer-e2e` exists because audit test-quality-013
 * found exactly the same thing about the viewer suite: 363 tests, passing locally, wired to no
 * workflow. Finding it once is bad luck; finding it twice means the repository needs a rule
 * rather than another audit.
 *
 * THE RULE: a config is either referenced by a workflow, or named below with a reason. There is
 * no third state, and "nobody noticed" stops being reachable.
 */
describe('no Playwright config is invoked by nothing', () => {
  const CLIENT_WEB = join(WF_DIR, '..', '..', 'podcast-saas', 'client-web');

  /**
   * Configs deliberately NOT run per PR, each with the reason it is not a gate.
   *
   * These are not exemptions from testing — they are statements about WHERE the test belongs. A
   * soak suite in a per-PR gate buys a slow signal that gets re-run until it is green, which is
   * worse than no signal because it looks like one.
   */
  const NOT_A_PR_GATE: Record<string, string> = {
    'playwright.config.ts':
      'the default config has no testMatch and its base URL defaults to the LIVE SITE — running it ' +
      'aims every spec in e2e/ at production. It must never be wired to anything.',
    'playwright.canary.config.ts': 'soak suite, 900s timeout — scheduled, not per-PR',
    'playwright.leak.config.ts': 'memory-leak soak, 900s-1800s timeouts — scheduled, not per-PR',
    'playwright.protocol.config.ts': 'protocol soak, 1500s timeout — scheduled, not per-PR',
    'playwright.rebuilt.config.ts': 'rebuilds packages, 180s timeout, needs stored artefacts — not per-PR',
    'playwright.production.config.ts': 'targets the DEPLOYED site by design — release workflow only',
    'playwright.candidate.config.ts': 'exercises candidate images — release workflow only',
  };

  const configs = readdirSync(CLIENT_WEB).filter(
    (f) => f.startsWith('playwright.') && f.endsWith('.config.ts'),
  );

  const scripts: Record<string, string> = JSON.parse(
    readFileSync(join(CLIENT_WEB, 'package.json'), 'utf8'),
  ).scripts ?? {};

  /**
   * COMMENTS ARE NOT INVOCATIONS, and this line is the whole reason the gate means anything.
   *
   * The first version of this check matched the workflow text as a whole. Every job here carries
   * a long explanatory comment naming the suites it runs, so deleting `authoring` from the matrix
   * — the exact regression this exists to catch — still passed: the word survived in the prose.
   * A gate that reads its own documentation as evidence reports on nothing. Mutation-checked
   * both ways after this line was added.
   */
  const codeOnly = (text: string): string =>
    text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  /** The values of a `strategy.matrix` key, read from the list literal rather than from prose. */
  function matrixValues(text: string, key: string): string[] {
    const m = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, 'm').exec(text);
    return m ? m[1].split(',').map((v) => v.trim()).filter(Boolean) : [];
  }

  /**
   * Is this config actually invoked? Follows the indirection a workflow really uses.
   *
   * A workflow rarely names a config file; it runs a package script (`test:e2e:authoring`) whose
   * command names the config — and often through a matrix (`test:e2e:${{ matrix.suite }}`). All
   * three forms count; nothing else does.
   */
  function isWired(config: string, text: string): boolean {
    const code = codeOnly(text);
    if (code.includes(config)) return true;
    for (const [name, cmd] of Object.entries(scripts)) {
      if (!cmd.includes(config)) continue;
      if (code.includes(name)) return true;
      const split = /^(.*?:)([a-z0-9-]+)$/.exec(name);
      if (!split) continue;
      const [, prefix, leaf] = split;
      const expansion = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\$\\{\\{\\s*matrix\\.(\\w+)`).exec(code);
      if (expansion && matrixValues(code, expansion[1]).includes(leaf)) return true;
    }
    return false;
  }

  it('finds the configs at all (a rename must not silently empty this gate)', () => {
    // Without this the whole describe passes vacuously the moment the directory moves — the same
    // "zero specs collected exits 0" failure the workflows themselves guard against.
    expect(configs.length).toBeGreaterThan(5);
  });

  it('every config is referenced by a workflow or excused with a reason', () => {
    const allWorkflowText = Object.values(wf).join('\n');
    const orphans = configs.filter(
      (c) => !isWired(c, allWorkflowText) && !(c in NOT_A_PR_GATE),
    );
    expect(
      orphans,
      `these Playwright configs are invoked by no workflow and carry no documented reason: ` +
        `${orphans.join(', ')}. Either wire the suite into .github/workflows/, or add it to ` +
        `NOT_A_PR_GATE with the reason it is not a gate.`,
    ).toEqual([]);
  });

  it('the excuse list names only configs that exist', () => {
    // A stale excuse is how a suite gets deleted, replaced under a new name, and silently loses
    // its coverage while this gate keeps reporting green.
    const ghosts = Object.keys(NOT_A_PR_GATE).filter((c) => !configs.includes(c));
    expect(ghosts, `excused configs that no longer exist: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('the three self-contained suites are named in ci.yml\'s matrix, not merely in its prose', () => {
    const code = codeOnly(wf['ci.yml'] ?? '');
    expect(code).toContain('test:e2e:${{ matrix.suite }}');
    expect(matrixValues(code, 'suite').sort()).toEqual(['authoring', 'transitions', 'transport']);
  });
});
