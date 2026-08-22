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
    expect(gateText).toContain('MANIFEST=artifacts/manifest.json');
    expect(jobs.get('deploy')?.text).toContain('--manifest "$ART/manifest.json"');
  });

  it('refuses any reference that is not digest-pinned', () => {
    expect(gateText).toContain('*@sha256:*');
    expect(gateText).toContain('candidate reference is not digest-pinned');
  });

  it('refuses to proceed when the manifest is absent or of an unknown schema', () => {
    expect(gateText).toContain('cannot identify the candidate');
    expect(gateText).toContain('flowvid.image-manifest/v1');
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
    expect(gateStep).toContain('--require artifacts/candidate-smoke.json');
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
