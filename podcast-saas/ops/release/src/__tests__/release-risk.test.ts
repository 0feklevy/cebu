import { describe, expect, it } from 'vitest';
import { assessReleaseRisk, type ReleaseRiskInput } from '../release-risk.js';
import type { Finding, Severity } from '../severity.js';

/**
 * Which releases still need a person.
 *
 * The whole value of this module is that its FALSE answer is trusted enough to deploy on. So the
 * tests are weighted toward the direction that costs something: a risky release scored as routine
 * ships an unreviewed destructive migration, while a routine release scored as risky merely
 * annoys someone. Every ambiguous case below therefore asserts `requiresHuman === true`.
 */

const finding = (id: string, severity: Severity = 'HIGH'): Finding =>
  ({ id, severity, area: 'migrations', message: `synthetic ${id}` }) as Finding;

const routine: ReleaseRiskInput = {
  findings: [],
  backfillPolicy: 'report-only',
  approveHigh: false,
  changedPaths: ['podcast-saas/client-web/src/components/Button.tsx'],
};

describe('a routine release needs nobody', () => {
  it('no findings, no backfill, no sensitive paths ⇒ automatic', () => {
    const v = assessReleaseRisk(routine);
    expect(v.requiresHuman).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it('an ordinary migration is not by itself a reason to stop', () => {
    // Adding a nullable column is the common case and must stay automatic, or the gate is once
    // again something people click through.
    const v = assessReleaseRisk({ ...routine, changedPaths: ['podcast-saas/backend-api/src/db/migrations/071_add_column.sql'] });
    expect(v.requiresHuman).toBe(false);
  });
});

describe('a release a human could actually change the outcome of stops', () => {
  it.each([
    ['migrations.destructive'],
    ['migrations.compat-risk'],
    ['migrations.runner-incompatible'],
    ['migrations.history-rewrite'],
  ])('%s requires acceptance', (id) => {
    const v = assessReleaseRisk({ ...routine, findings: [finding(id)] });
    expect(v.requiresHuman).toBe(true);
    expect(v.reasons.join(' ')).toContain(id);
  });

  it.each([['allow-safe'], ['require-approval']])('backfill_policy=%s can write data', (policy) => {
    const v = assessReleaseRisk({ ...routine, backfillPolicy: policy as ReleaseRiskInput['backfillPolicy'] });
    expect(v.requiresHuman).toBe(true);
    expect(v.reasons.join(' ')).toContain('modify production data');
  });

  it('approve_high is itself a human acceptance, so a human must make it', () => {
    // Automating the acceptance of findings that exist to be accepted is a contradiction: it
    // would turn the safety valve into a default.
    const v = assessReleaseRisk({ ...routine, approveHigh: true });
    expect(v.requiresHuman).toBe(true);
  });

  it.each([
    ['podcast-saas/backend-api/src/services/storage/mediaAccess.ts', 'media token'],
    ['podcast-saas/backend-api/src/middleware/authGuard.ts', 'auth'],
    ['podcast-saas/backend-api/src/config/publicOrigins.ts', 'public origin'],
    ['podcast-saas/deploy/docker-compose.prod.yml', 'deployment configuration'],
    ['podcast-saas/.env.example', 'environment-variable contract'],
    ['podcast-saas/backend-api/src/controllers/stripeWebhook.ts', 'billing'],
  ])('%s is a security-sensitive surface', (path, expectedWhy) => {
    const v = assessReleaseRisk({ ...routine, changedPaths: [path] });
    expect(v.requiresHuman, `${path} was scored routine`).toBe(true);
    expect(v.reasons.join(' ').toLowerCase()).toContain(expectedWhy.toLowerCase());
  });

  it('a HIGH finding from any audit needs acceptance, not only a migration one', () => {
    const v = assessReleaseRisk({ ...routine, findings: [finding('secrets.possible-key', 'HIGH')] });
    expect(v.requiresHuman).toBe(true);
  });

  it('reports every reason, not just the first', () => {
    // The person being asked has to see the whole picture. A verdict that stops at the first
    // reason trains them to fix one thing and re-run.
    const v = assessReleaseRisk({
      ...routine,
      findings: [finding('migrations.destructive')],
      backfillPolicy: 'allow-safe',
      changedPaths: ['podcast-saas/backend-api/src/services/storage/mediaAccess.ts'],
    });
    expect(v.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('reasons and the verdict can never disagree', () => {
  it('requiresHuman is true exactly when there is a reason', () => {
    // A verdict of "risky, and here is why: (nothing)" is unactionable, and "routine, reasons:
    // [destructive migration]" is dangerous. They are one fact and must be derived from one place.
    for (const input of [
      routine,
      { ...routine, approveHigh: true },
      { ...routine, findings: [finding('migrations.destructive')] },
      { ...routine, backfillPolicy: 'require-approval' as const },
    ]) {
      const v = assessReleaseRisk(input);
      expect(v.requiresHuman).toBe(v.reasons.length > 0);
    }
  });
});
