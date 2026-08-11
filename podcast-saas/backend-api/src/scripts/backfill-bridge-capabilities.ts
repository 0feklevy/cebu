/**
 * Backfill the published-capability record for packages that predate migrations 055 and 057 —
 * `simulations.bridge_ack_capable` (audit P0.5) and `simulations.requires_import_maps` (audit P0.8).
 *
 *   pnpm --filter backend-api sims:backfill-ack                        # DRY RUN — reports only
 *   pnpm --filter backend-api sims:backfill-ack -- --apply             # write the records
 *   pnpm --filter backend-api sims:backfill-ack -- --limit=50          # bound the batch
 *   pnpm --filter backend-api sims:backfill-ack -- --apply --force     # re-classify recorded rows too
 *
 * WHY THIS SCRIPT EXISTS
 * Both migrations added their column NULLABLE and backfilled nothing, so every package already in
 * the database reads UNKNOWN for both, and only the packages a publication or the revision
 * migration happens to rewrite ever leave that state. `RevisionMigration` classifies only what it
 * rewrites, and a publication classifies only what it publishes. This asks the question of
 * everything else, once.
 *
 * WHAT AN UNKNOWN COSTS, PER FACT — they are not the same, and that is why both are here now:
 *   • `bridge_ack_capable` UNKNOWN is handled: the apply gate holds the switch, bounded, and
 *     concludes the bridge is silent when the bound expires. Correct, but it pays a real wait on
 *     every entry to a section the package could have answered for instantly.
 *   • `requires_import_maps` UNKNOWN is INERT, and that is worse. `evaluateFloor` blocks only on
 *     `=== true`, so P0.8 — written for the flagship import-map packages — does nothing at all for
 *     any of them until each is republished. On Safari/iOS <= 16.3 those packages keep painting
 *     nothing behind a cover that promises a frame which can never arrive. The feature is shipped
 *     and, for the entire existing population, switched off. This is what switches it on.
 *
 * WHAT IT ANSWERS THE QUESTIONS FROM
 * `detectBridgeCapabilities` over the assembled bridge and `detectEntryCapabilities` over the
 * published ENTRY document — the same two functions the publication path calls
 * (`SimulationService.assembleBridgeAndEntry`), run over the same bytes the browser is served.
 * Nothing here re-implements either detector, and nothing guesses: an artefact that cannot be read
 * is REPORTED and its fact left UNKNOWN. A guessed `scriptApplied: false` is a wrong reveal waiting
 * for a section switch; a guessed `requiresImportMaps: true` replaces a working simulation with a
 * still image. The two facts are learned INDEPENDENTLY — an unreadable bridge does not stop the
 * entry from being classified, or the reverse.
 *
 * WHICH BYTES
 *   • the bridge — `<revision>/package/bridge.js`, then the migration's `runtime/` copy, and only
 *     for an un-revisioned package the legacy `<prefix>/bridge.js` (`bridgeKeyCandidates`);
 *   • the entry — `simulations.active_revision_entry_key`, which is the pointer AT the live entry
 *     document and therefore needs no guessing at all; for an un-revisioned package, the entry
 *     under the legacy prefix (`entryKeyCandidates`).
 * A revisioned package is NEVER classified from mutable legacy bytes on either axis: that path is
 * exactly where a "replace simulation" upload lands, so it can hold bytes nobody is served.
 *
 * WHERE IT WRITES
 *   • `sim_revisions.metadata.bridgeCapabilities` on the ACTIVE revision — the facts belong to the
 *     bytes, so a later rollback to this revision re-projects the right answers instead of the
 *     answers of whatever else was live. Merged into the existing metadata key, never replacing
 *     it, and only the facts this run actually measured.
 *   • `simulations.bridge_ack_capable` / `simulations.requires_import_maps` — the projections the
 *     read paths use.
 * Both in ONE transaction per package, so a projection can never name a capability no revision
 * records. A package with no active revision (never migrated to immutable revisions) has no
 * revision row to write to and gets the projections only, which is the same shape the pre-revision
 * world has for every other derived scalar.
 *
 * IDEMPOTENT, PER FACT. A row is selected while EITHER column is still NULL, and a selected row is
 * only asked the questions it does not already have answers to — so a second run over a fully
 * recorded population reads no storage and writes nothing, and a run over a population where 055's
 * backfill already ran reads only entry documents. `--force` re-reads and re-writes both regardless,
 * for the case where a package's bytes were replaced underneath a recorded answer.
 *
 * BOUNDED: `--limit=N` caps the batch, and the default is a full pass in DRY RUN, which touches
 * storage read-only. Ordering is by `created_at` so successive bounded runs make progress.
 *
 * Everything above `main()` is pure or dependency-injected, so it is unit-tested with no database
 * and no storage (src/scripts/__tests__/bridgeCapabilityBackfill.test.ts). The db/storage imports
 * are loaded lazily INSIDE main() so importing this module never opens a database client — which is
 * also why `deriveEntryRelPath` is INJECTED rather than imported: it lives in `SimulationService`,
 * whose module scope opens a database client.
 */
import {
  BRIDGE_CAPABILITIES_KEY,
  detectBridgeCapabilities,
  detectEntryCapabilities,
  type BridgeCapabilities,
} from 'shared/sim/bridgeCapability';
import { revisionPrefix } from 'shared/sim/simRevision';

// ── the row shape this needs, and nothing more ────────────────────────────────

export interface BackfillSimRow {
  id: string;
  name: string;
  storage_prefix: string;
  /** `simulations.entry_file` — a storage key on new rows, a full public URL on legacy ones. */
  entry_file: string | null;
  /** The immutable-revision pointer, or null for a package still served from its legacy prefix. */
  active_revision_id: string | null;
  /** The storage key of the LIVE entry document, set with the pointer at every activation. */
  active_revision_entry_key: string | null;
  bridge_ack_capable: boolean | null;
  requires_import_maps: boolean | null;
}

/** `SimulationService.deriveEntryRelPath`, injected — see the note about module scope above. */
export type EntryRelPathDeriver =
  (entryFile: string | null | undefined, storagePrefix: string) => string | null;

/** The two artefacts this script reads, and the deriver it needs to find one of them. */
export interface ClassifyDeps {
  /** Read one storage object as text, returning null for anything it cannot read. */
  readObject: (key: string) => Promise<string | null>;
  deriveEntryRelPath: EntryRelPathDeriver;
}

/**
 * Which facts a run still owes a given row.
 *
 * PER FACT, not per row, and that is the whole reason this exists: 055's backfill may already have
 * recorded `bridge_ack_capable` for a package whose `requires_import_maps` is still NULL, and
 * re-reading its bridge to re-derive an answer already in the database is a storage read for
 * nothing. It also keeps the write minimal — a run never overwrites a recorded fact it was not
 * asked to re-measure.
 */
export interface FactsToLearn {
  scriptApplied: boolean;
  requiresImportMaps: boolean;
}

export function factsToLearn(row: BackfillSimRow, force = false): FactsToLearn {
  return {
    scriptApplied: force || row.bridge_ack_capable === null,
    requiresImportMaps: force || row.requires_import_maps === null,
  };
}

export type BackfillOutcome =
  /** Both facts already recorded, and `--force` was not given. */
  | 'already-recorded'
  /** At least one artefact was read and classified. */
  | 'classified'
  /** Nothing could be read. Left UNKNOWN — never guessed. */
  | 'unreadable';

export interface BackfillResult {
  simId: string;
  name: string;
  outcome: BackfillOutcome;
  /** The bridge's classification, when one was reached. */
  scriptApplied?: boolean;
  /** The entry document's classification, when one was reached. */
  requiresImportMaps?: boolean;
  /** Which keys the bytes came from, for an operator reading the report. */
  bridgeKey?: string;
  entryKey?: string;
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

/**
 * Where a package's published ENTRY document lives.
 *
 * THE POINTER, WHEN THERE IS ONE. `active_revision_entry_key` is set with the pointer at every
 * activation and IS the key of the live entry document, so a revisioned package needs no guessing
 * and offers exactly one candidate. A revisioned package whose pointer key is somehow missing
 * offers NONE rather than falling back to the legacy prefix — the same rule `bridgeKeyCandidates`
 * keeps, and for the same reason: the mutable path is where a "replace simulation" upload lands, so
 * classifying from it would record a fact about bytes nobody is served.
 *
 * For a package still on the legacy mutable path, the entry is wherever `entry_file` says relative
 * to the package prefix — a storage key on new rows, a full public URL on old ones, which is the
 * pair `deriveEntryRelPath` exists to normalise.
 */
export function entryKeyCandidates(row: BackfillSimRow, derive: EntryRelPathDeriver): string[] {
  if (row.active_revision_id) {
    return row.active_revision_entry_key ? [row.active_revision_entry_key] : [];
  }
  const prefix = row.storage_prefix.replace(/\/+$/, '');
  const rel = derive(row.entry_file, prefix);
  return rel ? [`${prefix}/${rel}`] : [];
}

/**
 * Rows this run will actually look at, in a stable order, capped by `--limit`.
 *
 * A row is work while EITHER column is still NULL — 055's own backfill may have recorded the ack
 * and left the capability floor unknown, and that row still has something to learn. `alreadyRecorded`
 * is therefore the rows that have BOTH.
 */
export function planBackfill(
  rows: readonly BackfillSimRow[],
  opts: { limit?: number; force?: boolean } = {},
): { work: BackfillSimRow[]; alreadyRecorded: BackfillSimRow[] } {
  const fullyRecorded = (r: BackfillSimRow) =>
    r.bridge_ack_capable !== null && r.requires_import_maps !== null;
  const alreadyRecorded = opts.force ? [] : rows.filter(fullyRecorded);
  const candidates = opts.force ? [...rows] : rows.filter((r) => !fullyRecorded(r));
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
  capabilities: Partial<BridgeCapabilities>,
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

/** The first candidate key that yields bytes, with those bytes. Null when none can be read. */
async function firstReadable(
  keys: readonly string[],
  readObject: ClassifyDeps['readObject'],
): Promise<{ key: string; bytes: string } | null> {
  for (const key of keys) {
    const bytes = await readObject(key);
    if (bytes !== null) return { key, bytes };
  }
  return null;
}

/**
 * Classify ONE package from its bytes. Pure apart from the injected reader, which returns null for
 * a key it cannot read (missing object, denied GetObject, anything else) rather than throwing.
 *
 * TWO INDEPENDENT QUESTIONS, ASKED SEPARATELY. The bridge answers `scriptApplied` and the entry
 * document answers `requiresImportMaps`; a package whose bridge is unreadable can still have its
 * capability floor recorded, and the reverse. Folding them into one all-or-nothing outcome would
 * mean a single missing object leaves a fact UNKNOWN that the other artefact could have answered.
 *
 * `want` bounds the work: a fact already recorded (and no `--force`) is neither read nor re-derived.
 */
export async function classifyPackage(
  row: BackfillSimRow,
  deps: ClassifyDeps,
  want: FactsToLearn = { scriptApplied: true, requiresImportMaps: true },
): Promise<{ result: BackfillResult; capabilities: Partial<BridgeCapabilities> | null }> {
  const capabilities: Partial<BridgeCapabilities> = {};
  const result: BackfillResult = { simId: row.id, name: row.name, outcome: 'unreadable' };
  const unread: string[] = [];

  if (want.scriptApplied) {
    const keys = bridgeKeyCandidates(row);
    const hit = await firstReadable(keys, deps.readObject);
    if (hit) {
      capabilities.scriptApplied = detectBridgeCapabilities(hit.bytes).scriptApplied;
      result.scriptApplied = capabilities.scriptApplied;
      result.bridgeKey = hit.key;
    } else {
      unread.push(`no readable bridge.js at ${keys.join(' | ') || '(no candidate key)'}`);
    }
  }

  if (want.requiresImportMaps) {
    const keys = entryKeyCandidates(row, deps.deriveEntryRelPath);
    const hit = await firstReadable(keys, deps.readObject);
    if (hit) {
      // The SAME detector the publication path runs, over the same document. Its limits (a runtime-
      // injected map reads false, a map inside a <template> reads true) are part of its contract and
      // are not re-litigated here — a second implementation is how a recorded capability becomes a
      // guess that disagrees with the bytes.
      capabilities.requiresImportMaps = detectEntryCapabilities(hit.bytes).requiresImportMaps;
      result.requiresImportMaps = capabilities.requiresImportMaps;
      result.entryKey = hit.key;
    } else {
      unread.push(`no readable entry document at ${keys.join(' | ') || '(no candidate key)'}`);
    }
  }

  if (unread.length > 0) result.note = unread.join('; ');
  if (Object.keys(capabilities).length === 0) return { result, capabilities: null };
  result.outcome = 'classified';
  return { result, capabilities };
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

  // `deriveEntryRelPath` comes from SimulationService, whose module scope opens a database client —
  // hence lazily, here, with the rest of the IO, and injected into the pure half.
  const [{ db }, schema, { getStorageAdapter }, { eq, asc }, { deriveEntryRelPath }] = await Promise.all([
    import('../db/index.js'),
    import('../db/schema.js'),
    import('../services/storage/getStorageAdapter.js'),
    import('drizzle-orm'),
    import('../services/simulation/SimulationService.js'),
  ]);
  const { simulations, sim_revisions } = schema;
  const storage = getStorageAdapter();

  const rows = await db.query.simulations.findMany({
    columns: {
      id: true, name: true, storage_prefix: true, entry_file: true,
      active_revision_id: true, active_revision_entry_key: true,
      bridge_ack_capable: true, requires_import_maps: true,
    },
    orderBy: [asc(simulations.created_at)],
  });
  const { work, alreadyRecorded } = planBackfill(rows, { force, ...(limit !== undefined ? { limit } : {}) });

  console.log(`\n=== published-capability backfill (${apply ? 'APPLY' : 'DRY RUN'}) — `
    + `${rows.length} simulation(s), ${work.length} to classify, ${alreadyRecorded.length} already recorded ===\n`);

  const read = async (key: string): Promise<string | null> => {
    try { return (await storage.readObject(key)).toString('utf-8'); } catch { return null; }
  };
  const deps: ClassifyDeps = { readObject: read, deriveEntryRelPath };

  const results: BackfillResult[] = [];
  let acking = 0, silent = 0, needsMaps = 0, noMaps = 0, unreadable = 0, failed = 0;

  for (const row of work) {
    const { result, capabilities } = await classifyPackage(row, deps, factsToLearn(row, force));
    results.push(result);
    if (!capabilities) { unreadable++; continue; }
    if (capabilities.scriptApplied === true)  acking++;
    if (capabilities.scriptApplied === false) silent++;
    if (capabilities.requiresImportMaps === true)  needsMaps++;
    if (capabilities.requiresImportMaps === false) noMaps++;
    if (!apply) continue;

    // Only the columns this run actually MEASURED. A fact left unlearned (already recorded, or its
    // artefact unreadable) must not be written at all — `undefined` in a Drizzle `.set()` would be
    // dropped silently anyway, but stating it here is what makes "never guessed" checkable.
    const projection: { bridge_ack_capable?: boolean; requires_import_maps?: boolean } = {};
    if (capabilities.scriptApplied !== undefined)      projection.bridge_ack_capable  = capabilities.scriptApplied;
    if (capabilities.requiresImportMaps !== undefined) projection.requires_import_maps = capabilities.requiresImportMaps;

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
        await tx.update(simulations).set(projection).where(eq(simulations.id, row.id));
      });
    } catch (err) {
      failed++;
      result.outcome = 'unreadable';
      result.note = `write failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  for (const r of results) {
    // PER FACT, because a partial classification is a real and common outcome: one artefact read,
    // the other not. A single verb would have to pick one of the two to report and silently drop
    // the other, which is exactly how an operator concludes a column was written when it was not.
    const facts = [
      r.scriptApplied      !== undefined ? `scriptApplied=${r.scriptApplied}` : null,
      r.requiresImportMaps !== undefined ? `requiresImportMaps=${r.requiresImportMaps}` : null,
    ].filter(Boolean).join(' ');
    const verb = r.outcome === 'classified'
      ? `${apply ? 'RECORDED' : 'WOULD RECORD'} ${facts}`
      : `LEFT UNKNOWN`;
    console.log(`  ${verb.padEnd(52)} ${r.simId}  "${r.name}"${r.note ? ` — ${r.note}` : ''}`);
  }

  console.log(`\nSummary: bridge — acking: ${acking}, silent: ${silent}`
    + `; entry — needs import maps: ${needsMaps}, does not: ${noMaps}`
    + `; nothing readable (left UNKNOWN): ${unreadable}, write failures: ${failed}`);
  if (!apply && acking + silent + needsMaps + noMaps > 0) {
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
