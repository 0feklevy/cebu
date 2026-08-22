import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gateIsEnforced, parseJobGraph, transitiveNeeds, withoutComments } from '../workflow-graph.js';

/**
 * The pre-deploy candidate-image gate.
 *
 * This job replaces a human clicking "Approve and deploy". The owner's own account of that
 * click: it was made without an additional review, so it protected nothing while *looking*
 * like protection. Replacing it is only an improvement if the replacement genuinely cannot
 * be walked past — which is what this file pins.
 *
 * The property under test is not "the job exists". It is: **a candidate that was not
 * successfully exercised cannot reach production.** Every assertion below is one way that
 * property has a hole, and each hole is one a real edit could open without looking wrong.
 */

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..', '..');
const releaseYml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const composeSource = readFileSync(join(ROOT, 'podcast-saas', 'deploy', 'docker-compose.candidate.yml'), 'utf8');
/**
 * The compose file's DIRECTIVES, without its prose. The comments in that file explain at length
 * which settings would break it — `STORAGE_BACKEND: local`, a production hostname — so an
 * assertion reading the raw text matches the warning against the mistake and calls it the mistake.
 */
const compose = withoutComments(composeSource);
const jobs = parseJobGraph(releaseYml);
const candidateSpec = readFileSync(
  join(ROOT, 'podcast-saas', 'client-web', 'e2e', 'candidate-smoke.spec.ts'),
  'utf8',
);

/** What a job RUNS, with its explanatory prose removed — see withoutComments. */
const runsOf = (job: string) => withoutComments(jobs.get(job)?.text ?? '');

const GATE = 'candidate-smoke';

describe('the candidate gate stands between the images and production', () => {
  it('deploy cannot start until the candidate images have been exercised', () => {
    expect(jobs.has(GATE)).toBe(true);
    expect(transitiveNeeds(jobs, 'deploy')).toContain(GATE);
  });

  it('the gate does not wait on itself (a self-need never starts, and is valid YAML)', () => {
    expect(() => transitiveNeeds(jobs, GATE)).not.toThrow();
    expect(jobs.get(GATE)?.needs).not.toContain(GATE);
  });

  it("deploy's if: still requires the gate to have SUCCEEDED", () => {
    // `needs:` is worth nothing beside `if: always()`. That is the cheapest way to silently
    // un-gate the pipeline: one word, in a job that still lists the gate in `needs`.
    //
    // deploy legitimately carries `!cancelled()` so it can tolerate a SKIPPED risk-review, so
    // the assertion cannot simply be "no status function". It is the precise thing instead:
    // whatever the spelling, candidate-smoke's success must remain a precondition.
    expect(gateIsEnforced(jobs.get('deploy')?.ifExpr ?? null, GATE)).toBe(true);
  });

  it('the gate runs whenever a deploy is attempted, so it can never be the skipped one', () => {
    // If the gate were conditional on something narrower than the deploy itself, a *skipped*
    // gate would satisfy `needs` and the deploy would sail past it.
    expect(jobs.get(GATE)?.ifExpr).toBe('${{ inputs.deploy }}');
    expect(jobs.get('deploy')?.ifExpr ?? '').toContain('inputs.deploy');
  });
});

describe('human approval is reserved for releases where a human changes the outcome', () => {
  it('the approval job exists, carries an environment, and is conditional', () => {
    const review = jobs.get('risk-review');
    expect(review, 'no risk-review job').toBeDefined();
    // Conditional is the whole point. An approval job with no `if:` is the unconditional click
    // the owner described as protecting nothing.
    expect(review?.ifExpr).toContain("requires_human == 'true'");
    expect(review?.text).toContain('production-approval');
  });

  it('a flow with NO FIXTURE is excluded from the requirement rather than blocking the release', () => {
    // Two wrong answers were tried before this one.
    //
    // First: nothing. `--require-tests` makes a SKIPPED release-blocking flow CRITICAL and the
    // post-deploy gate turns CRITICAL into an automatic rollback — so a missing repository
    // variable would have rolled back a perfectly healthy deploy.
    //
    // Then: refuse to release at all. That closed the rollback trap and opened a worse one — it
    // blocks security fixes behind a configuration task, and the person who can do the
    // configuring is not always there.
    //
    // The requirement is now passed downstream ONLY for flows that have somewhere to run. A flow
    // with no fixture is reported loudly and excluded; a flow that HAS a fixture and still did
    // not run stays CRITICAL, and the rollback then means what it says.
    const plan = withoutComments(jobs.get('plan')?.text ?? '');
    for (const v of ['SMOKE_PUBLIC_PATH', 'SMOKE_PLAYLIST_PATH', 'SMOKE_ADMIN_PREVIEW_PATH']) {
      expect(plan, `${v} is never checked, so its absence is invisible`)
        .toMatch(new RegExp(`\\[ -n "\\$\\{\\{ vars\\.${v} \\}\\}" \\]`));
    }
    // It must WARN, not fail — a step that exits non-zero here blocks the release.
    const step = plan.split('- name:').find((x) => x.includes('vars.SMOKE_PUBLIC_PATH')) ?? '';
    expect(step, 'the fixture check blocks the release instead of warning').not.toMatch(/\bexit 1\b/);
    expect(step, 'the gap is not reported anywhere a human would see it').toContain('::warning::');
    expect(step, 'the gap is not recorded in the run summary').toContain('GITHUB_STEP_SUMMARY');
  });

  it('the post-deploy requirement comes FROM that check, not from a hard-coded list', () => {
    // A hard-coded list in the deploy job cannot know whether a fixture exists, which is exactly
    // how the rollback trap was built the first time.
    expect(jobs.get('plan')?.text).toContain("require_tests: ${{ steps.fixtures.outputs.require_tests }}");
    expect(withoutComments(jobs.get('deploy')?.text ?? '')).toContain('needs.plan.outputs.require_tests');
  });

  it('the approval verdict is computed from evidence, not from a human deciding to skip it', () => {
    // `plan` must actually run release-risk, and expose it. A hand-set output would make the
    // whole mechanism a switch someone can flip.
    expect(withoutComments(jobs.get('plan')?.text ?? '')).toContain('release-cli release-risk');
    expect(jobs.get('plan')?.text).toContain("requires_human: ${{ steps.risk.outputs.requires_human }}");
  });

  it('deploy tolerates a SKIPPED approval but never a failed one', () => {
    const ifExpr = (jobs.get('deploy')?.ifExpr ?? '').replace(/\s+/g, ' ');
    expect(ifExpr).toContain("needs.risk-review.result == 'success' || needs.risk-review.result == 'skipped'");
    // 'failure' and 'cancelled' must NOT appear as accepted results for the approval job.
    expect(ifExpr).not.toContain("needs.risk-review.result == 'failure'");
  });

  it('the approval job cannot deploy anything itself', () => {
    // It exists to pause, not to act. A step that touches the VM here would run BEFORE approval
    // on a re-run, and would sit outside every audit the deploy job performs.
    const text = withoutComments(jobs.get('risk-review')?.text ?? '');
    for (const forbidden of ['remote-deploy', 'remote-sync', 'remote-rollback', 'docker']) {
      expect(text, `risk-review references ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('it tests the images that will actually be deployed', () => {
  const gateText = jobs.get(GATE)?.text ?? '';

  it('pins the candidate from the same manifest remote-deploy pins from', () => {
    // A gate that reads a *different* artifact can bless one set of digests while production
    // pulls another. Both must name manifest.json.
    expect(gateText).toContain('MANIFEST="$ART/manifest.json"');
    expect(jobs.get('deploy')?.text).toContain('--manifest "$ART/manifest.json"');
  });

  it('reads and writes evidence through ABSOLUTE paths, never workspace-relative ones', () => {
    // COST A FULL BUILD TO LEARN. The workflow sets `defaults.run.working-directory:
    // podcast-saas`, so every `run:` step starts one directory DOWN — while
    // `actions/download-artifact` writes relative to the workspace ROOT. A relative
    // `artifacts/manifest.json` therefore looked in `podcast-saas/artifacts/` and found nothing.
    //
    // The gate failed closed and the deploy was skipped, which is the system working exactly as
    // designed. It is still an hour of build time to discover something a string check catches,
    // and the same trap is waiting for every future step in this job.
    const gate = runsOf(GATE);
    const relative = [...gate.matchAll(/(?:^|\s)(?:--(?:out|findings|require|report)\s+|MANIFEST=)"?([A-Za-z][\w./-]*\.json)/g)]
      .map((m) => m[1])
      .filter((path) => !path.startsWith('$') && !path.startsWith('release-artifacts/'));
    expect(relative, `these evidence paths are workspace-relative in a job that runs one directory down: ${relative.join(', ')}`).toEqual([]);
  });

  it('downloads the release artifacts where $ART actually points', () => {
    // `$ART` is `${{ github.workspace }}/release-artifacts`. Downloading to any other path means
    // every `$ART/...` read in this job resolves to an empty directory.
    expect(runsOf(GATE)).toContain('path: release-artifacts');
    expect(releaseYml).toContain('ART: ${{ github.workspace }}/release-artifacts');
  });

  it('refuses any reference that is not digest-pinned', () => {
    expect(gateText).toContain('*@sha256:*');
    expect(gateText).toContain('candidate reference is not digest-pinned');
  });

  it("applies this build's migrations with the command production uses", () => {
    // Migrations do NOT run at boot — the VM applies them as a separate step. So a candidate
    // stack that only starts the containers has an EMPTY database, and a test claiming to verify
    // "migrations against a real Postgres" verifies nothing. That was the first version of this
    // job: a false claim, which is worse than a missing one because it reads as covered.
    //
    // The command must match deploy-images.sh, verbatim. A different invocation here — a
    // different entry file, an added flag — tests a path the VM never takes, which is the same
    // category of mistake as not running them at all, only harder to notice.
    const gate = runsOf(GATE);
    expect(gate).toContain('run --rm --no-deps backend node dist/db/migrate.js');

    const deployScript = readFileSync(join(ROOT, 'podcast-saas', 'deploy', 'scripts', 'deploy-images.sh'), 'utf8');
    expect(deployScript, 'the deploy script no longer runs the command this gate mirrors').toContain(
      'run --rm --no-deps backend node dist/db/migrate.js',
    );
  });

  it('a failing migration is not swallowed', () => {
    // `|| true` on that step would turn the single highest-value check in this job into a log
    // line. A migration that cannot apply to an empty, real Postgres must never reach one with
    // data in it.
    const step = runsOf(GATE).split('- name:').find((s) => s.includes('dist/db/migrate.js')) ?? '';
    expect(step).not.toMatch(/migrate\.js.*\|\|\s*true/);
    expect(step).not.toContain('continue-on-error: true');
  });

  it('refuses to proceed when the manifest is absent or of an unknown schema', () => {
    expect(gateText).toContain('cannot identify the candidate');
    expect(gateText).toContain('flowvid.image-manifest/v1');
  });

  it('the image bundle scan uses the pattern the repo already proved correct', () => {
    // `scan-bundle-localhost.sh` carries hard-won knowledge in one regex: a BARE
    // `http://localhost` is not a defect, because the Firebase SDK ships one in its own
    // internals. A naive "no localhost anywhere" check would fail this gate on every release —
    // and the candidate spec was written that way first, until this script's comments said
    // otherwise. Keeping the two in step means the lesson is only learned once.
    const scanner = readFileSync(join(ROOT, 'podcast-saas', 'deploy', 'scripts', 'scan-bundle-localhost.sh'), 'utf8');
    const PORTS = '(localhost|127\\.0\\.0\\.1):(8080|3000|3001)';
    const HOSTS = '(backend|worker|nginx|client-web|admin-web)';
    for (const [name, text] of [['scanner', scanner], ['candidate spec', candidateSpec]] as const) {
      expect(text, `${name} no longer requires a port on a loopback host`).toContain(PORTS.replace(/\\\\/g, '\\'));
      expect(text, `${name} no longer names the internal Docker hosts`).toContain(HOSTS);
    }
  });

  it('never falls back to a floating tag', () => {
    expect(runsOf(GATE)).not.toMatch(/:latest\b/);
  });
});

describe('the compose stack cannot boot anything but the candidate', () => {
  it('requires both image references — no default, no fallback', () => {
    // `${VAR:?message}` aborts compose when VAR is empty. `${VAR:-something}` would silently
    // substitute, and the gate would green-light a stack built from whatever that default was.
    expect(compose).toMatch(/BACKEND_IMAGE:\?/);
    expect(compose).toMatch(/CLIENT_WEB_IMAGE:\?/);
    expect(compose).not.toMatch(/\$\{BACKEND_IMAGE:-/);
    expect(compose).not.toMatch(/\$\{CLIENT_WEB_IMAGE:-/);
  });

  it('never reaches production storage, queues, or database', () => {
    expect(compose).toContain('QUEUE_DRIVER: inline');
    // The one place a candidate stack could do real damage is by being pointed at a real
    // DATABASE_URL or a real bucket. Its postgres and its S3 are throwaway containers on tmpfs,
    // and no production hostname may appear anywhere in the file.
    expect(compose).toMatch(/tmpfs/);
    expect(compose).not.toMatch(/flowvidco\.com|supabase\.co|r2\.cloudflarestorage/);
    expect(compose).toMatch(/SUPABASE_S3_ENDPOINT:\s*http:\/\/minio:9000/);
  });

  it('runs the image as production runs it, with a storage backend that can boot', () => {
    // These two are ONE constraint, and getting either alone wrong is fatal in a different way.
    //
    // NODE_ENV must be production, or the gate stops testing the artifact and starts testing a
    // development configuration of it. And under NODE_ENV=production, getStorageAdapter refuses
    // local disk unconditionally — so `STORAGE_BACKEND: local`, the obvious choice for a
    // throwaway stack, makes the backend fail to boot and blocks every release on the gate's own
    // configuration. The candidate therefore runs the real Supabase adapter against its own S3.
    expect(compose).toMatch(/NODE_ENV:\s*production/);
    expect(compose, 'local-disk storage cannot boot under NODE_ENV=production').not.toMatch(
      /STORAGE_BACKEND:\s*local/,
    );
    expect(compose).toMatch(/STORAGE_BACKEND:\s*supabase/);
  });

  it('the browser-visible origins satisfy the production boot guard', () => {
    // The THIRD way this stack could refuse to start. `assertPublicOriginsForProd` exits the
    // process when NODE_ENV=production and these name localhost, an internal Docker service, or
    // anything not https. A loopback value is the natural thing to write for a local stack and
    // would block every release — with a failure that reads as "the image is broken".
    // EVERY occurrence, in every service — not the first match. The first version of this test
    // used `RegExp.exec`, which returns one hit, so it passed while the client-web service still
    // carried loopback origins and could not start: `next.config.ts` is loaded by `next start`
    // and throws on them exactly as the backend's guard does. A per-service guard needs a
    // per-service assertion, or it checks whichever service happens to be written first.
    const ORIGIN_KEYS = ['BACKEND_API_URL', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_APP_URL', 'PUBLIC_SITE_URL'];
    let checked = 0;
    for (const key of ORIGIN_KEYS) {
      // ANCHORED TO THE START OF THE LINE. An unanchored `BACKEND_API_URL:` also matches
      // `X_BACKEND_API_URL:` — so a renamed or prefixed variable, which the backend would no
      // longer read at all, still satisfied this loop with its old value. Found by mutating the
      // names away and watching the test stay green.
      for (const m of compose.matchAll(new RegExp(`^\\s*${key}:\\s*(\\S+)`, 'gm'))) {
        checked += 1;
        const value = m[1];
        expect(value, `${key}=${value} is not https — the guard rejects it`).toMatch(/^https:\/\//);
        expect(value, `${key}=${value} names a host the guard treats as non-public`).not.toMatch(
          /localhost|127\.0\.0\.1|0\.0\.0\.0|\/\/(backend|worker|client-web|admin-web|postgres|nginx)[:/]/,
        );
        // ...and never a host that could actually resolve. `.invalid` is reserved by RFC 2606.
        expect(value, `${key}=${value} could resolve to a real host`).toMatch(/\.invalid(:|\/|$)/);
      }
    }
    // Both services must have been covered — a rename that made every match disappear would
    // otherwise turn this into a loop over nothing, and pass.
    expect(checked, 'no browser-visible origins were found to check').toBeGreaterThanOrEqual(6);
  });

  it('the Firebase credential is generated by the workflow, never committed', () => {
    // `getFirebaseAdmin()` parses the PEM at boot, so the stack genuinely needs one — which makes
    // "just paste a key in the compose file" the obvious and wrong fix. It would be real key
    // material in the repository even though it authenticates nothing, and the release's own
    // secret scan would flag it.
    expect(compose).toMatch(/FIREBASE_PRIVATE_KEY:\s*\$\{CANDIDATE_FIREBASE_CREDENTIAL:\?/);
    expect(compose, 'a PEM was committed into the compose file').not.toContain('BEGIN PRIVATE KEY');
    expect(compose, 'a PEM was committed into the compose file').not.toContain('BEGIN RSA PRIVATE KEY');

    const gate = withoutComments(jobs.get(GATE)?.text ?? '');
    expect(gate, 'nothing generates the credential the stack requires').toContain('openssl genpkey');
    // Masked before it reaches a log. Worthless key or not, an unmasked PEM in a public build log
    // is a pattern that should never be established in this repository.
    expect(gate).toContain('::add-mask::');
  });

  it('the backend waits for the bucket to exist, not merely for S3 to be up', () => {
    // A bucket created concurrently with the backend's first write is an intermittent gate
    // failure — the least debuggable kind, and the kind that gets a gate disabled.
    expect(compose).toMatch(/minio-init:\n\s+condition:\s+service_completed_successfully/);
  });
});

describe('evidence is demanded even when the run went badly', () => {
  const gateText = jobs.get(GATE)?.text ?? '';
  /** Step blocks of the gate job, split on the `- name:`/`- uses:` list markers. */
  const steps = gateText.split(/\n {6}- (?=name:|uses:)/).slice(1);
  const stepWith = (needle: string) => steps.find((s) => s.includes(needle));

  it('summarizes and gates with if: always() — a dead browser still owes a verdict', () => {
    // Without always(), a failed Playwright step skips the gate, the job fails, and the
    // *reason* is a step failure rather than a recorded finding. The evidence artifacts —
    // the thing a later audit reads — would simply not exist.
    const gateStep = stepWith('release-cli gate --phase pre-deploy');
    expect(gateStep, 'no pre-deploy gate step in the job').toBeDefined();
    expect(gateStep).toContain('if: always()');
  });

  it('requires the summary as identity-bearing evidence stamped with THIS run and commit', () => {
    // These four flags are what turn "a file exists" into "a file this run produced from this
    // commit". Dropping --expect-run-id alone would let a stale artifact from an earlier,
    // greener run satisfy the gate. checkRequiredEvidence raises evidence.stale-run for it.
    const gateStep = stepWith('release-cli gate --phase pre-deploy') ?? '';
    expect(gateStep).toContain('--require "$ART/candidate-smoke.json"');
    expect(gateStep).toContain('--identity-bearing candidate-smoke.json');
    expect(gateStep).toContain('--expect-run-id "$RUN_ID"');
    expect(gateStep).toContain('--expect-git-sha');
  });

  it('tears the stack down only after the verdict is recorded', () => {
    // `down -v` before the gate destroys the containers whose logs explain the failure, and
    // on a `continue-on-error` future edit could also destroy the report being summarized.
    const gateIdx = steps.findIndex((s) => s.includes('release-cli gate --phase pre-deploy'));
    const downIdx = steps.findIndex((s) => s.includes('compose.candidate.yml down'));
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(downIdx).toBeGreaterThan(gateIdx);
  });

  it('keeps the candidate images out of the deploy job entirely', () => {
    // The gate must not mutate anything the deploy consumes. Its only output is evidence.
    expect(runsOf(GATE)).not.toContain('remote-deploy');
    expect(runsOf(GATE)).not.toContain('remote-sync');
  });
});
