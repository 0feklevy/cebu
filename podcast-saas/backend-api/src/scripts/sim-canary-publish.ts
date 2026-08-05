/**
 * Apply a publish-time canary result: store the posters it captured, and record the verdict that
 * decides whether the player may use the activation-scoped path for this package.
 *
 * THIS IS THE GATE. Nothing else in the pipeline grants `managed-presentable`. The player refuses
 * to offer a v3 bootstrap for any other class, so a package that has never been through this script
 * runs on v2 no matter what its bridge is capable of. That ordering is the point: capability is
 * what a package CAN do, classification is what it has been OBSERVED doing, and only the second is
 * allowed to change how the player behaves.
 *
 * SAFETY POSTURE, matching the Priority 1 rollout tooling:
 *   • DRY RUN BY DEFAULT. Nothing is written without `--apply`.
 *   • Refuses to write a verdict the report does not support (`classificationIsHonest`), so a
 *     hand-edited `classification` field cannot publish a package the run did not certify.
 *   • Refuses an incomplete run outright — an aborted canary observed nothing, and "observed
 *     nothing" must never be recorded as a legacy class, which is a statement that the package was
 *     seen behaving cooperatively.
 *   • Poster objects are written BEFORE the row that references them, and the previous revision's
 *     posters are invalidated only AFTER the new verdict is durable, so there is no window where a
 *     section resolves to a poster whose bytes are gone.
 *
 * Usage:
 *   tsx src/scripts/sim-canary-publish.ts --report <path> --sim <simulationId> [--apply]
 *   tsx src/scripts/sim-canary-publish.ts --report <path> --sim <id> --apply --prune
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { simulations } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { posterService, type PosterRendition } from '../services/simulation/PosterService.js';
import {
  classificationIsHonest,
  describeCanaryDecision,
  isCanaryReportComplete,
  judgeCanaryReport,
  summarizeCanary,
} from '../services/simulation/canaryJudge.js';
import type { CanaryReport } from 'shared/src/sim/canaryContract';
import {
  POSTER_SIZES,
  formatsFor,
  type PosterFormat,
  type PosterKey,
  type PosterSizeName,
} from 'shared/src/sim/posterIdentity';
import { computeConfigHash } from 'shared/src/sim/simIdentity';
import { canaryReportPrepareMs } from 'shared/src/sim/prepareBudget';

/** Exit codes, so a rollout script can branch without parsing text. */
export const EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  REPORT_UNREADABLE: 3,
  REPORT_INCOMPLETE: 4,
  REPORT_DISHONEST: 5,
  SIM_NOT_FOUND: 6,
  POSTERS_MISSING: 7,
  WRITE_FAILED: 8,
} as const;

interface Args {
  reportPath: string;
  simulationId: string;
  apply: boolean;
  prune: boolean;
  posterDir: string | null;
}

export function parseArgs(argv: readonly string[]): Args | null {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const reportPath = get('--report');
  const simulationId = get('--sim');
  if (!reportPath || !simulationId) return null;
  return {
    reportPath: resolve(reportPath),
    simulationId,
    apply: argv.includes('--apply'),
    prune: argv.includes('--prune'),
    posterDir: get('--posters'),
  };
}

/**
 * Locate the PNG renditions the canary captured for one case.
 *
 * The canary writes them under `<resultsDir>/posters/<identity>/<size>.png`. A case whose posters
 * are missing is NOT quietly skipped: a `managed-presentable` package with no poster cannot use
 * the poster-only fallback its own failure policy promises, so the absence is an error.
 */
export function collectRenditions(
  posterRoot: string,
  identity: string,
  transparent: boolean,
  aspect: PosterKey['aspectProfile'],
): PosterRendition[] {
  const dir = join(posterRoot, identity);
  if (!existsSync(dir)) return [];
  const allowedFormats = new Set<PosterFormat>(formatsFor(transparent));
  const sizes = POSTER_SIZES[aspect];
  const out: PosterRendition[] = [];

  for (const entry of readdirSync(dir)) {
    const m = /^([^.]+)\.(webp|avif|png)$/.exec(entry);
    if (!m) continue;
    const sizeName = m[1] as PosterSizeName;
    const format = m[2] as PosterFormat;
    if (!allowedFormats.has(format)) continue;
    const spec = sizes.find((s) => s.name === sizeName);
    if (!spec) continue;
    const full = join(dir, entry);
    if (!statSync(full).isFile()) continue;
    out.push({
      size: sizeName,
      format,
      bytes: readFileSync(full),
      width: spec.width,
      height: spec.height,
      transparent,
    });
  }
  return out;
}

export interface PublishPlan {
  simulationId: string;
  packageRevision: string;
  classification: CanaryReport['classification'];
  mayPublishAsModern: boolean;
  posters: { identity: string; renditions: number }[];
  missingPosters: string[];
  reasons: readonly string[];
}

/** Build the plan WITHOUT touching storage or the database. This is what `--apply` executes. */
export function planFromReport(report: CanaryReport, posterRoot: string): PublishPlan {
  const decision = judgeCanaryReport(report);
  const posters: PublishPlan['posters'] = [];
  const missingPosters: string[] = [];

  for (const c of report.cases) {
    const identity = c.posterIdentity;
    if (!identity) { missingPosters.push(`${c.case.variantKey} (no poster identity recorded)`); continue; }
    const renditions = collectRenditions(
      posterRoot,
      identity,
      c.case.config.transparent === true,
      c.case.aspectProfile,
    );
    if (renditions.length === 0) { missingPosters.push(identity); continue; }
    posters.push({ identity, renditions: renditions.length });
  }

  return {
    simulationId: report.simulationId,
    packageRevision: report.packageRevision,
    classification: report.classification,
    mayPublishAsModern: decision.mayPublishAsModern,
    posters,
    missingPosters,
    reasons: decision.reasons ?? [],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(
      'usage: sim-canary-publish --report <path> --sim <simulationId> [--posters <dir>] [--apply] [--prune]\n',
    );
    process.exit(EXIT.BAD_ARGS);
  }

  let report: CanaryReport;
  try {
    report = JSON.parse(readFileSync(args.reportPath, 'utf8')) as CanaryReport;
  } catch (err) {
    process.stderr.write(`cannot read canary report at ${args.reportPath}: ${String(err)}\n`);
    process.exit(EXIT.REPORT_UNREADABLE);
    return;
  }

  const summary = summarizeCanary(report);
  const decision = judgeCanaryReport(report);
  process.stdout.write(`${describeCanaryDecision(decision)}\n`);
  process.stdout.write(`cases=${summary.cases} engine=${report.engine} revision=${report.packageRevision}\n`);

  if (!isCanaryReportComplete(report)) {
    // An aborted or partial run observed nothing. Recording ANY class from it — even a pessimistic
    // one — would be asserting an observation that was never made.
    process.stderr.write('REFUSED: the canary report is incomplete. Re-run the canary.\n');
    process.exit(EXIT.REPORT_INCOMPLETE);
  }
  if (!classificationIsHonest(report)) {
    process.stderr.write(
      'REFUSED: the report\'s stamped classification does not match what its own steps support.\n',
    );
    process.exit(EXIT.REPORT_DISHONEST);
  }

  const sim = await db.query.simulations.findFirst({ where: eq(simulations.id, args.simulationId) });
  if (!sim) {
    process.stderr.write(`REFUSED: simulation ${args.simulationId} not found.\n`);
    process.exit(EXIT.SIM_NOT_FOUND);
    return;
  }

  // MUST match what the canary actually writes: e2e-results/sim-canary-posters/<identity>/<size>.png
  // (client-web/e2e/sim-canary.spec.ts POSTER_ROOT). The default was `posters/`, a directory nothing
  // creates — so an operator following the rollout verbatim hit EXIT.POSTERS_MISSING on every
  // managed-presentable package, making Stage 3's documented outcome unreachable. Nothing in the
  // repo passes --posters, and the test always passed an explicit tmpdir, so the default was never
  // exercised by anything.
  const posterRoot = args.posterDir
    ? resolve(args.posterDir)
    : join(args.reportPath, '..', 'sim-canary-posters');
  const plan = planFromReport(report, posterRoot);

  process.stdout.write(`\nPLAN for ${sim.name} (${sim.id})\n`);
  process.stdout.write(`  classification : ${plan.classification}\n`);
  process.stdout.write(`  modern path    : ${plan.mayPublishAsModern ? 'GRANTED' : 'withheld'}\n`);
  process.stdout.write(`  posters        : ${plan.posters.length} identities\n`);
  for (const p of plan.posters) process.stdout.write(`      ${p.identity} (${p.renditions} renditions)\n`);
  if (plan.missingPosters.length) {
    process.stdout.write(`  MISSING posters: ${plan.missingPosters.join(', ')}\n`);
  }

  if (plan.mayPublishAsModern && plan.missingPosters.length) {
    // A modern package's failure policy offers `poster-only` as its FIRST recovery action. Granting
    // the modern path without the poster that action depends on publishes a promise the runtime
    // cannot keep.
    process.stderr.write(
      'REFUSED: this package would be granted the modern path but is missing posters for ' +
      `${plan.missingPosters.length} case(s). Fix the canary capture and re-run.\n`,
    );
    process.exit(EXIT.POSTERS_MISSING);
  }

  if (!args.apply) {
    process.stdout.write('\nDRY RUN — nothing written. Re-run with --apply to execute.\n');
    process.exit(EXIT.OK);
  }

  try {
    // Posters FIRST: a row that references bytes which do not exist renders a broken cover, while
    // bytes with no row are merely invisible until the next sweep.
    for (const c of report.cases) {
      if (!c.posterIdentity) continue;
      const transparent = c.case.config.transparent === true;
      const renditions = collectRenditions(posterRoot, c.posterIdentity, transparent, c.case.aspectProfile);
      if (!renditions.length) continue;
      const key: PosterKey = {
        packageRevision: report.packageRevision,
        variantKey: c.case.variantKey,
        // Recomputed from the case's OWN config rather than trusted from the file: a hand-edited
        // hash would otherwise mint a poster at a path no activation will ever ask for.
        configHash: computeConfigHash(c.case.config),
        aspectProfile: c.case.aspectProfile,
        qualityProfile: c.case.qualityProfile,
      };
      // `transparent` is DERIVED by storePoster from the renditions themselves (they must agree),
      // so passing it here would be a second, unchecked source for the same fact.
      await posterService.storePoster(sim.id, sim.storage_prefix, key, renditions, {
        capturedAt: new Date(report.finishedAt),
      });
      process.stdout.write(`  stored poster ${c.posterIdentity}\n`);
    }

    await db.update(simulations).set({
      package_class: report.classification,
      canary_report: report as unknown as Record<string, unknown>,
      canary_at: new Date(),
      // Derived ONCE, here, so the player's hottest read path reads an integer instead of parsing
      // this report. Null when the run produced no usable preparation steps, which the client reads
      // as "no lab data" rather than as "instantaneous".
      prepare_budget_ms: canaryReportPrepareMs(report),
    }).where(eq(simulations.id, sim.id));
    process.stdout.write(`  recorded verdict ${report.classification}\n`);

    if (args.prune) {
      // Only AFTER the new verdict is durable. Pruning first would leave a live section resolving
      // to a poster whose bytes had already been deleted.
      const pruned = await posterService.invalidate(sim.id, report.packageRevision);
      process.stdout.write(
        `  pruned ${pruned.deletedIdentities.length} stale poster identity/ies, ` +
        `${pruned.deletedObjects.length} object(s)\n`,
      );
    }
  } catch (err) {
    logger.error({ err, simulationId: sim.id }, 'sim-canary-publish: write failed');
    process.stderr.write(`WRITE FAILED: ${String(err)}\n`);
    process.exit(EXIT.WRITE_FAILED);
  }

  process.stdout.write('\nDONE.\n');
  process.exit(EXIT.OK);
}

// Only run when invoked directly — importing this module from a test must not execute it.
if (process.argv[1] && process.argv[1].includes('sim-canary-publish')) {
  void main();
}
