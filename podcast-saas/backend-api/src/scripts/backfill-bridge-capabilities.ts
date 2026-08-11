/**
 * Backfill `simulations.bridge_ack_capable` for packages that were published before migration 055
 * (audit P0.5).
 *
 *   pnpm --filter backend-api sims:backfill-ack                        # DRY RUN — reports only
 *   pnpm --filter backend-api sims:backfill-ack -- --apply             # write the records
 *   pnpm --filter backend-api sims:backfill-ack -- --limit=50          # bound the batch
 *   pnpm --filter backend-api sims:backfill-ack -- --apply --force     # re-classify recorded rows too
 *
 * WHY THIS SCRIPT EXISTS
 * Migration 055 added the column NULLABLE and backfilled nothing, so every package already in the
 * database reads UNKNOWN. UNKNOWN is a real state and the viewer's apply gate handles it — it holds
 * the switch, bounded, and concludes the bridge is silent when the bound expires with no
 * acknowledgement. But concluding costs a real wait on every entry to a section the package could
 * answer for instantly if anyone had ever asked its bytes. Nobody had: `RevisionMigration`
 * classifies only the packages it happens to rewrite, and a publication classifies only what it
 * publishes. This asks the question of everything else, once.
 *
 * WHAT IT ANSWERS THE QUESTION FROM
 * `detectBridgeCapabilities`, the same function the publication path and the revision migration
 * use, run over the same bytes the browser is actually served. Nothing here re-implements the
 * detection, and nothing guesses: a package whose bridge cannot be read is REPORTED and left
 * UNKNOWN, because a guessed `false` is a wrong reveal waiting for a section switch.
 *
 * WHERE IT WRITES
 *   • `sim_revisions.metadata.bridgeCapabilities` on the ACTIVE revision — the fact belongs to the
 *     bytes, so a later rollback to this revision re-projects the right answer instead of the
 *     answer of whatever else was live. Merged into the existing metadata key, never replacing it:
 *     `requiresImportMaps` may already be recorded there by 057's own path.
 *   • `simulations.bridge_ack_capable` — the projection the read paths use.
 * Both in ONE transaction per package, so a projection can never name a capability no revision
 * records. A package with no active revision (never migrated to immutable revisions) has no
 * revision row to write to and gets the projection only, which is the same shape the pre-revision
 * world has for every other derived scalar.
 *
 * IDEMPOTENT: a second run selects only rows still NULL, so it reports every package as already
 * recorded and writes nothing. `--force` re-reads and re-writes regardless, for the case where a
 * package's bytes were replaced underneath a recorded answer.
 *
 * BOUNDED: `--limit=N` caps the batch, and the default is a full pass in DRY RUN, which touches
 * storage read-only. Ordering is by `created_at` so successive bounded runs make progress.
 *
 * DELIBERATELY NOT `requires_import_maps` (migration 057). Its UNKNOWN is the state that leaves a
 * package rendering exactly as it does today — unknown is never read as "requires" — so there is no
 * defect to close there, and widening an operator script that writes to published revisions to
 * cover a second column would double what a bad run can do for no user-visible gain.
 *
 * Everything above `main()` is pure or dependency-injected, so it is unit-tested with no database
 * and no storage (src/scripts/__tests__/bridgeCapabilityBackfill.test.ts). The db/storage imports
 * are loaded lazily INSIDE main() so importing this module never opens a database client.
 */
import {
  BRIDGE_CAPABILITIES_KEY,
  detectBridgeCapabilities,
  type BridgeCapabilities,
} from 'shared/sim/bridgeCapability';
import { revisionPrefix } from 'shared/sim/simRevision';

// ── the row shape this needs, and nothing more ────────────────────────────────

export interface BackfillSimRow {
  id: string;
  name: string;
  storage_prefix: string;
  /** The immutable-revision pointer, or null for a package still served from its legacy prefix. */
  active_revision_id: string | null;
  bridge_ack_capable: boolean | null;
}

export type BackfillOutcome =
  /** Already recorded, and `--force` was not given. */
  | 'already-recorded'
  /** The bridge was read and classified. */
  | 'classified'
  /** No bridge.js could be read. Left UNKNOWN — never guessed. */
  | 'unreadable';

export interface BackfillResult {
  simId: string;
  name: string;
  outcome: BackfillOutcome;
  /** The classification, when one was reached. */
  scriptApplied?: boolean;
  /** Which key the bytes came from, for an operator reading the report. */
  bridgeKey?: string;
  note?: string;
}

/**
 * Where a package's assembled bridge lives, most-likely first.
 *
 * TWO LAYOUTS, BOTH REAL. Inside a revision the bridge sits at the package root
 * (`<revision>/package/bridge.js`) — the same spot `<prefix>/bridge.js` occupied before revisions
 * existed — while `RevisionMigration` files a legacy copy under the `runtime` role. Both are
 * offered rather than guessed at, and the legacy prefix is always offered LAST so a revisioned
 * package can never be classified from the mutable bytes its pointer no longer names.
 */
export function bridgeKeyCandidates(row: BackfillSimRow): string[] {
  const prefix = row.storage_prefix.replace(/\/+$/, '');
  if (!row.active_revision_id) return [`${prefix}/bridge.js`];
  const rev = revisionPrefix(prefix, row.active_revision_id);
  return [`${rev}/package/bridge.js`, `${rev}/runtime/bridge.js`];
}

/** Rows this run will actually look at, in a stable order, capped by `--limit`. */
export function planBackfill(
  rows: readonly BackfillSimRow[],
  opts: { limit?: number; force?: boolean } = {},
): { work: BackfillSimRow[]; alreadyRecorded: BackfillSimRow[] } {
  const alreadyRecorded = opts.force ? [] : rows.filter((r) => r.bridge_ack_capable !== null);
  const candidates = opts.force ? [...rows] : rows.filter((r) => r.bridge_ack_capable === null);
  const work = opts.limit !== undefined && opts.limit >= 0 ? candidates.slice(0, opts.limit) : candidates;
  return { work, alreadyRecorded };
}

/**
 * Fold a fresh classification into a revision's existing metadata.
 *
 * MERGE, NEVER REPLACE, at both levels. `metadata` carries `migratedFromLegacyPrefix`,
 * `legacyBridgeHash` and whatever else a publication path recorded, and
 * `metadata.bridgeCapabilities` may already hold `requiresImportMaps` from 057's own path. Writing
 * a fresh object at either level would silently drop a fact this script never looked at.
 */
export function mergedRevisionMetadata(
  metadata: unknown,
  capabilities: BridgeCapabilities,
): Record<string, unknown> {
  const base = (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  const priorCaps = base[BRIDGE_CAPABILITIES_KEY];
  const caps = (priorCaps && typeof priorCaps === 'object' && !Array.isArray(priorCaps))
    ? { ...(priorCaps as Record<string, unknown>) }
    : {};
  base[BRIDGE_CAPABILITIES_KEY] = { ...caps, ...capabilities };
  return base;
}

/**
 * Classify ONE package from its bytes. Pure apart from the injected reader, which returns null for
 * a key it cannot read (missing object, denied GetObject, anything else) rather than throwing.
 */
export async function classifyPackage(
  row: BackfillSimRow,
  readObject: (key: string) => Promise<string | null>,
): Promise<{ result: BackfillResult; capabilities: BridgeCapabilities | null }> {
  for (const key of bridgeKeyCandidates(row)) {
    const bytes = await readObject(key);
    if (bytes === null) continue;
    const capabilities = detectBridgeCapabilities(bytes);
    return {
      result: {
        simId: row.id, name: row.name, outcome: 'classified',
        scriptApplied: capabilities.scriptApplied, bridgeKey: key,
      },
      capabilities,
    };
  }
  return {
    result: {
      simId: row.id, name: row.name, outcome: 'unreadable',
      note: `no readable bridge.js at ${bridgeKeyCandidates(row).join(' | ')}`,
    },
    capabilities: null,
  };
}

/** Argument parsing, extracted so the bounds are testable without a process. */
export function parseArgs(argv: readonly string[]): { apply: boolean; force: boolean; limit?: number } {
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const parsed = limitArg ? Number.parseInt(limitArg.slice('--limit='.length), 10) : NaN;
  return {
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    // A malformed --limit is IGNORED rather than silently treated as 0: a run that quietly does
    // nothing looks exactly like a run that found nothing to do.
    ...(Number.isFinite(parsed) && parsed >= 0 ? { limit: parsed } : {}),
  };
}

// ── the IO half ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { apply, force, limit } = parseArgs(process.argv.slice(2));

  const [{ db }, schema, { getStorageAdapter }, { eq, asc }] = await Promise.all([
    import('../db/index.js'),
    import('../db/schema.js'),
    import('../services/storage/getStorageAdapter.js'),
    import('drizzle-orm'),
  ]);
  const { simulations, sim_revisions } = schema;
  const storage = getStorageAdapter();

  const rows = await db.query.simulations.findMany({
    columns: {
      id: true, name: true, storage_prefix: true, active_revision_id: true, bridge_ack_capable: true,
    },
    orderBy: [asc(simulations.created_at)],
  });
  const { work, alreadyRecorded } = planBackfill(rows, { force, ...(limit !== undefined ? { limit } : {}) });

  console.log(`\n=== bridge_ack_capable backfill (${apply ? 'APPLY' : 'DRY RUN'}) — `
    + `${rows.length} simulation(s), ${work.length} to classify, ${alreadyRecorded.length} already recorded ===\n`);

  const read = async (key: string): Promise<string | null> => {
    try { return (await storage.readObject(key)).toString('utf-8'); } catch { return null; }
  };

  const results: BackfillResult[] = [];
  let acking = 0, silent = 0, unreadable = 0, failed = 0;

  for (const row of work) {
    const { result, capabilities } = await classifyPackage(row, read);
    results.push(result);
    if (!capabilities) { unreadable++; continue; }
    if (capabilities.scriptApplied) acking++; else silent++;
    if (!apply) continue;

    try {
      // ONE TRANSACTION per package: the revision's record and the projection of it must not be
      // able to disagree, which is the same invariant the pointer flip keeps at publication.
      await db.transaction(async (tx) => {
        if (row.active_revision_id) {
          const rev = await tx.query.sim_revisions.findFirst({
            where: eq(sim_revisions.id, row.active_revision_id!),
            columns: { id: true, metadata: true },
          });
          if (rev) {
            await tx.update(sim_revisions)
              .set({ metadata: mergedRevisionMetadata(rev.metadata, capabilities) })
              .where(eq(sim_revisions.id, rev.id));
          }
        }
        await tx.update(simulations)
          .set({ bridge_ack_capable: capabilities.scriptApplied })
          .where(eq(simulations.id, row.id));
      });
    } catch (err) {
      failed++;
      result.outcome = 'unreadable';
      result.note = `write failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  for (const r of results) {
    const verb = r.outcome === 'classified'
      ? `${apply ? 'RECORDED' : 'WOULD RECORD'} scriptApplied=${r.scriptApplied}`
      : `LEFT UNKNOWN`;
    console.log(`  ${verb.padEnd(34)} ${r.simId}  "${r.name}"${r.note ? ` — ${r.note}` : ''}`);
  }

  console.log(`\nSummary: acking: ${acking}, silent: ${silent}, unreadable (left UNKNOWN): ${unreadable}`
    + `, write failures: ${failed}`);
  if (!apply && acking + silent > 0) {
    console.log('DRY RUN — nothing was written. Re-run with `-- --apply` to record the classifications.');
  }
  // A package left UNKNOWN is not a failure of this run: the gate handles unknown, and guessing
  // would be the actual defect. Only a WRITE failure is an error exit.
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

// Only when executed directly — importing this module for its pure half must not run a backfill.
if (process.argv[1] && /backfill-bridge-capabilities\.ts$|backfill-bridge-capabilities\.js$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
