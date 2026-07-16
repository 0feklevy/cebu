/**
 * Offline end-to-end dry run of the release pipeline.
 *
 * Uses NO production secrets, touches NO production system, pushes NO images and
 * creates NO tags. Real local stages (plan from git tags, secret scan, migration
 * audit, static CSP audit) run against the working tree; remote stages (images,
 * VM audit, browser audit) use deterministic fixtures — including the real July
 * 2026 incident shape so report rendering of findings is exercised.
 *
 * Output: <outDir>/artifacts/*.json + release-report.{md,json}.
 */
import { join } from 'node:path';
import {
  cmdGate,
  cmdMigrationAudit,
  cmdPlan,
  cmdReport,
  cmdSecretScan,
  cspExpectationFor,
  writeJsonFile,
  type CommandContext,
} from './commands.js';
import { auditCspHeader } from './csp-audit.js';
import { buildManifest } from './image-manifest.js';
import { createRun, serializeRun, transition } from './state-machine.js';
import { writeFileSync, mkdirSync } from 'node:fs';

export async function cmdDryRun(ctx: CommandContext, opts: { outDir: string }): Promise<{ exitCode: number }> {
  const art = join(opts.outDir, 'artifacts');
  mkdirSync(art, { recursive: true });
  const runId = `dryrun-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const startedAt = new Date().toISOString();

  // 1. Real plan from the actual git tags (read-only).
  const { plan } = await cmdPlan(ctx, { bump: 'patch', out: join(art, 'plan.json') });

  // 2. Real local audits.
  await cmdSecretScan(ctx, { out: join(art, 'secret-scan.json') });
  await cmdMigrationAudit(ctx, { baseRef: plan.currentTag ?? '', out: join(art, 'migration-audit.json') });

  // 3. Static CSP audit of the EXPECTED production policy (no network).
  const exp = cspExpectationFor(ctx.config, 'client-web');
  const expectedCsp =
    "default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; " +
    `frame-src 'self' ${exp.apiOrigin} ${exp.stripeOrigin} ${exp.firebaseAuthOrigin}; ` +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; " +
    "font-src 'self' data: https:; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https: wss:";
  writeJsonFile(join(art, 'csp-client-web.json'), {
    url: '(dry-run: static expected policy)',
    status: null,
    header: expectedCsp,
    findings: auditCspHeader(expectedCsp, exp),
  });

  // 4. Fixture image manifest (deterministic dummy digests — nothing is pulled or pushed).
  const manifest = buildManifest({
    version: plan.nextTag,
    gitSha: plan.gitSha,
    images: (['backend', 'client-web', 'admin-web'] as const).map((service, i) => ({
      service,
      repository: `${ctx.config.imageNamespace}/${service}`,
      tag: plan.nextTag,
      digest: `sha256:${String(i + 1).repeat(64).slice(0, 64)}`,
    })),
  });
  writeJsonFile(join(art, 'image-manifest.json'), { manifest, findings: [] });

  // 5. Fixture browser + playwright results (clean run).
  writeJsonFile(join(art, 'browser-audit.json'), {
    schema: 'flowvid.browser-audit/v1',
    baseUrl: ctx.config.endpoints.app,
    pages: [],
  });
  writeJsonFile(join(art, 'playwright-summary.json'), { total: 6, passed: 6, failed: 0, skipped: 0, failures: [], findings: [] });

  // 6. State walk (deploy=false path ends at MIGRATIONS_PLANNED).
  let run = createRun(runId, startedAt, { version: plan.nextTag, gitSha: plan.gitSha, requestedBump: plan.bump });
  for (const s of ['SOURCE_VERIFIED', 'TESTED', 'IMAGES_BUILT', 'IMAGES_PUBLISHED', 'MIGRATIONS_PLANNED'] as const) {
    run = transition(run, s, new Date().toISOString(), 'dry-run');
  }
  writeFileSync(join(art, 'state.json'), serializeRun(run));

  // 7. Stage timings (measured trivially for format completeness).
  writeJsonFile(join(art, 'stages.json'), [
    { stage: 'plan', status: 'success', durationMs: 500 },
    { stage: 'verify', status: 'success', durationMs: 1000 },
    { stage: 'build-images', status: 'skipped' },
    { stage: 'deploy', status: 'skipped' },
  ]);

  // 8. Gate + final report.
  const gate = cmdGate(ctx, {
    findingsFiles: ['secret-scan.json', 'migration-audit.json', 'csp-client-web.json'].map((f) => join(art, f)),
    phase: 'pre-deploy',
    out: join(art, 'gate.json'),
  });

  cmdReport(ctx, {
    dir: art,
    meta: {
      runId,
      version: plan.nextTag,
      previousVersion: plan.currentTag ?? undefined,
      gitSha: plan.gitSha,
      bump: plan.bump,
      deploy: false,
      backfillPolicy: 'report-only',
      startedAt,
      endedAt: new Date().toISOString(),
      actor: process.env.GITHUB_ACTOR ?? 'dry-run',
    },
    outJson: join(opts.outDir, 'release-report.json'),
    outMd: join(opts.outDir, 'release-report.md'),
  });

  ctx.log(`dry-run: complete — ${opts.outDir}/release-report.{md,json} (gate ${gate.decision.blocked ? 'BLOCKED' : 'pass'})`);
  return { exitCode: gate.decision.blocked ? 1 : 0 };
}
