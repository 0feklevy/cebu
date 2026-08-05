/**
 * Publish existing legacy sim packages as immutable revisions (Priority 7.7).
 *
 *   pnpm tsx src/scripts/migrate-sim-revisions.ts --dry-run
 *   pnpm tsx src/scripts/migrate-sim-revisions.ts --sim <id>
 *   pnpm tsx src/scripts/migrate-sim-revisions.ts --limit 10
 *
 * THIS SCRIPT NEVER ACTIVATES ANYTHING. It copies each simulation's current bytes into a revision
 * prefix, verifies every byte against the manifest, and stops. The published revision is inert
 * until someone activates it explicitly.
 *
 * That separation is not caution for its own sake. Activation switches the package identity axis
 * from sha256(simId ∥ bridgeHash) to sha256('rev' ∥ revisionId), and every `sim_posters` row for
 * that package is keyed on the OLD value with no fallback in the lookup — so activating before a
 * canary and poster re-capture have run leaves every section of that package posterless. The gap
 * between publish and activate is where that work goes.
 *
 * `--dry-run` is the default posture for a first pass: it lists exactly what would be written, with
 * the entry path and role assignment resolved, without creating a draft or moving a byte.
 */

import { isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { simulations } from '../db/schema.js';
import { RevisionMigration, type MigrationResult } from '../services/simulation/RevisionMigration.js';

interface Args { simId?: string; limit: number; dryRun: boolean; force: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 25, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--sim') out.simId = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i] ?? 25);
  }
  return out;
}

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function report(r: MigrationResult): void {
  const tag = r.error ? 'FAIL' : r.skipped ? 'SKIP' : 'OK  ';
  const detail = r.error
    ? r.error.slice(0, 160)
    : r.skipped
      ? r.skipped
      : `rev ${r.revisionNumber} ${r.revisionId} · ${r.filesCopied} files · ${fmtBytes(r.bytesCopied)} · entry ${r.entryPath}`;
  process.stdout.write(`${tag}  ${r.simulationId}  ${detail}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const migration = new RevisionMigration();

  const ids = args.simId
    ? [args.simId]
    : (await db
        .select({ id: simulations.id })
        .from(simulations)
        // Only simulations still on the legacy path. `active_revision_id IS NULL` is precisely the
        // state `packageRevisionFor` falls back for, so this list is exactly the un-migrated set.
        .where(isNull(simulations.active_revision_id))
        .limit(args.limit)
      ).map((r) => r.id);

  if (ids.length === 0) {
    process.stdout.write('nothing to migrate\n');
    return;
  }

  process.stdout.write(
    `${args.dryRun ? 'DRY RUN — ' : ''}${ids.length} simulation(s); nothing will be activated\n\n`,
  );

  let ok = 0; let skipped = 0; let failed = 0; let bytes = 0;
  for (const id of ids) {
    // Sequentially, deliberately. Each file is copied through the Node heap (there is no
    // CopyObject), so running these in parallel multiplies peak memory by the concurrency for no
    // throughput gain against a single-connection storage adapter.
    const res = await migration.publishLegacyAsRevision({
      simulationId: id, dryRun: args.dryRun, force: args.force, createdBy: 'migrate-sim-revisions',
    });
    report(res);
    if (res.error) failed += 1;
    else if (res.skipped) skipped += 1;
    else { ok += 1; bytes += res.bytesCopied; }
  }

  process.stdout.write(`\n${ok} published · ${skipped} skipped · ${failed} failed · ${fmtBytes(bytes)} copied\n`);
  if (ok > 0 && !args.dryRun) {
    process.stdout.write(
      'Published revisions are INERT. Before activating any of them, run a canary and re-capture\n' +
      'posters for the new identity — the poster lookup has no fallback across an identity change.\n',
    );
  }
  // A non-zero exit on any failure so this is usable from a pipeline without parsing stdout.
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
