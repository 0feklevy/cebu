/**
 * Rebuild every ready simulation's combined bridge.js with the CURRENT template — without
 * touching any section body. Used to roll out bridge-protocol upgrades (e.g. v2 dynamic
 * section dispatch: startScript(sectionId) on one resident document) to already-generated
 * simulations. Mirrors uploadSectionBridge's merge exactly, minus the body change:
 * parseSectionEntries(existing) → wrapBridgeCombined(same entries) → upload + re-inject
 * the entry HTML with the new hash (gate refreshed too, both marker-guarded/idempotent).
 *
 *   Report:  tsx --env-file=../.env src/scripts/rebuild-sim-bridges.ts
 *   Apply:   tsx --env-file=../.env src/scripts/rebuild-sim-bridges.ts --apply
 *
 * Take a rollback point first — this tool overwrites objects in place in a bucket with no
 * versioning and has no undo of its own:
 *   tsx --env-file=../.env src/scripts/backup-sim-packages.ts backup ./sim-backup-<date>
 *
 * The pure helpers below are exported and unit-tested (src/scripts/lib/__tests__/
 * simRolloutTooling.test.ts); the db/storage imports load lazily inside main() so importing
 * this module never opens a database client.
 */

const APPLY = process.argv.includes('--apply');

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Relative href from the entry HTML back up to <prefix>/bridge.js — the entry may be nested. */
export function bridgeRelPathFor(entryKey: string, storagePrefix: string): string {
  const entryDir = entryKey.substring(0, entryKey.lastIndexOf('/'));
  const depth = entryDir === storagePrefix
    ? 0
    : entryDir.slice(storagePrefix.length).split('/').filter(Boolean).length;
  return (depth > 0 ? '../'.repeat(depth) : './') + 'bridge.js';
}

export type RebuildAction = 'unchanged' | 'update';

/**
 * BOTH files must already be current to skip. Comparing only bridge.js made a partially applied
 * package (new bridge written, entry upload then failed) report UNCHANGED forever: the tool could
 * never repair the state it had itself created, while calling it healthy.
 */
export function decideRebuildAction(i: {
  bridgeJs: string; combined: string; rawHtml: string; updatedHtml: string;
}): RebuildAction {
  return i.combined === i.bridgeJs && i.updatedHtml === i.rawHtml ? 'unchanged' : 'update';
}

/**
 * Optimistic-concurrency check for the read-modify-write. The live generation path does the same
 * merge under an in-process lock (uploadSectionBridge/withBridgeLock, GuidanceService's
 * withGuidanceLock) precisely because concurrent merges lose work; a separate process cannot join
 * those locks, so both files are re-read immediately before the PUTs and the package is skipped if
 * either moved under us. bridge.js drift = a user generation would be silently reverted; entry
 * HTML drift = a guidance publish (which rewrites the SAME entry HTML to carry the
 * guidance.js?v=<hash> tag) would be silently reverted.
 */
export function detectConflicts(i: {
  expectedBridge: string; currentBridge: string; expectedHtml: string; currentHtml: string;
}): string[] {
  const out: string[] = [];
  if (i.currentBridge !== i.expectedBridge) out.push('bridge.js changed during the rebuild (generation in flight)');
  if (i.currentHtml !== i.expectedHtml) out.push('entry HTML changed during the rebuild (guidance publish or generation in flight)');
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { db } = await import('../db/index.js');
  const { simulations } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const { getStorageAdapter } = await import('../services/storage/getStorageAdapter.js');
  const {
    deriveEntryRelPath, parseSectionEntries, wrapBridgeCombined,
    computeBridgeHash, injectBridgeScriptTag, injectRafGate,
  } = await import('../services/simulation/SimulationService.js');

  const storage = getStorageAdapter();
  const rows = await db.query.simulations.findMany({ where: eq(simulations.status, 'ready') });
  console.log(`\n=== Combined-bridge rebuild (${APPLY ? 'APPLY' : 'DRY RUN'}) — ${rows.length} ready simulation(s) ===\n`);

  /** Read the stored object, falling back to the public serving path. */
  const read = async (key: string): Promise<string | null> => {
    try { return (await storage.readObject(key)).toString('utf-8'); }
    catch {
      const res = await fetch(storage.getSimPublicUrl(key));
      return res.ok ? await res.text() : null;
    }
  };

  let updated = 0, skipped = 0, failed = 0;
  for (const sim of rows) {
    const label = `${sim.id}  "${sim.name}"`;
    try {
      const entryRel = deriveEntryRelPath(sim.entry_file, sim.storage_prefix);
      if (!entryRel) { skipped++; console.log(`  SKIP     ${label} — cannot derive entry file`); continue; }
      const entryKey = `${sim.storage_prefix}/${entryRel}`;
      const bridgeKey = `${sim.storage_prefix}/bridge.js`;

      const bridgeJs = await read(bridgeKey);
      if (bridgeJs === null) { skipped++; console.log(`  SKIP     ${label} — no bridge.js`); continue; }
      const entries = parseSectionEntries(bridgeJs);
      if (entries.size === 0) { skipped++; console.log(`  SKIP     ${label} — no section entries parsed`); continue; }

      const combined = wrapBridgeCombined(entries);
      const hash = computeBridgeHash(combined);

      const rawHtml = await read(entryKey);
      if (rawHtml === null) { skipped++; console.log(`  SKIP     ${label} — entry HTML unreadable`); continue; }
      const rel = bridgeRelPathFor(entryKey, sim.storage_prefix);
      const updatedHtml = injectBridgeScriptTag(injectRafGate(rawHtml), rel, hash);

      if (decideRebuildAction({ bridgeJs, combined, rawHtml, updatedHtml }) === 'unchanged') {
        skipped++; console.log(`  UNCHANGED ${label}`); continue;
      }

      if (APPLY) {
        const conflicts = detectConflicts({
          expectedBridge: bridgeJs, currentBridge: (await read(bridgeKey)) ?? '',
          expectedHtml: rawHtml, currentHtml: (await read(entryKey)) ?? '',
        });
        if (conflicts.length) {
          failed++;
          console.log(`  CONFLICT ${label} — ${conflicts.join('; ')}; re-run`);
          continue;
        }
        await storage.uploadFile(bridgeKey, Buffer.from(combined, 'utf-8'), 'application/javascript');
        await storage.uploadFile(entryKey, Buffer.from(updatedHtml, 'utf-8'), 'text/html; charset=utf-8');
        console.log(`  UPDATED  ${label} — ${entries.size} section(s), v=${hash}`);
      } else {
        console.log(`  WOULD UPDATE ${label} — ${entries.size} section(s)`);
      }
      updated++;
    } catch (e) {
      failed++;
      console.log(`  FAIL     ${label} — ${(e as Error).message.slice(0, 120)}`);
    }
  }
  console.log(`\nSummary: ${APPLY ? 'updated' : 'would update'}: ${updated}, skipped/unchanged: ${skipped}, failed: ${failed}`);
  if (failed > 0) {
    // The exit code is the ONLY signal a scripted rollout reads. Exiting 0 with failures told
    // `backup && rebuild --apply && deploy` chains that the storage rollout had completed.
    console.error(`\n${failed} package(s) failed — storage rollout is INCOMPLETE. Do not proceed.`);
  }
  return failed > 0 ? 1 : 0;
}

/** process.exit() drops buffered stdout/stderr when they are pipes — which is exactly how a
 *  rollout runs this (`… | tee rollout.log`). Drain both first, so the "storage rollout is
 *  INCOMPLETE" line can never be the output that gets truncated. */
async function exitFlushed(code: number): Promise<never> {
  await Promise.all([
    new Promise<void>((r) => { process.stdout.write('', () => r()); }),
    new Promise<void>((r) => { process.stderr.write('', () => r()); }),
  ]);
  process.exit(code);
}

// Only run when invoked directly, so tests can import the pure helpers above without a rollout.
if (process.argv[1] && process.argv[1].includes('rebuild-sim-bridges')) {
  main()
    .then((code) => exitFlushed(code))
    .catch(async (e) => { console.error(e); await exitFlushed(1); });
}
