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
 */
import { db } from '../db/index.js';
import { simulations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import {
  deriveEntryRelPath,
  parseSectionEntries,
  wrapBridgeCombined,
  computeBridgeHash,
  injectBridgeScriptTag,
  injectRafGate,
} from '../services/simulation/SimulationService.js';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const storage = getStorageAdapter();
  const rows = await db.query.simulations.findMany({ where: eq(simulations.status, 'ready') });
  console.log(`\n=== Combined-bridge rebuild (${APPLY ? 'APPLY' : 'DRY RUN'}) — ${rows.length} ready simulation(s) ===\n`);

  let updated = 0, skipped = 0, failed = 0;
  for (const sim of rows) {
    const label = `${sim.id}  "${sim.name}"`;
    try {
      const entryRel = deriveEntryRelPath(sim.entry_file, sim.storage_prefix);
      if (!entryRel) { skipped++; console.log(`  SKIP     ${label} — cannot derive entry file`); continue; }
      const entryKey = `${sim.storage_prefix}/${entryRel}`;
      const bridgeKey = `${sim.storage_prefix}/bridge.js`;

      let bridgeJs: string;
      try { bridgeJs = (await storage.readObject(bridgeKey)).toString('utf-8'); }
      catch {
        const res = await fetch(storage.getSimPublicUrl(bridgeKey));
        if (!res.ok) { skipped++; console.log(`  SKIP     ${label} — no bridge.js (${res.status})`); continue; }
        bridgeJs = await res.text();
      }
      const entries = parseSectionEntries(bridgeJs);
      if (entries.size === 0) { skipped++; console.log(`  SKIP     ${label} — no section entries parsed`); continue; }

      const combined = wrapBridgeCombined(entries);
      const hash = computeBridgeHash(combined);

      let rawHtml: string;
      try { rawHtml = (await storage.readObject(entryKey)).toString('utf-8'); }
      catch {
        const res = await fetch(storage.getSimPublicUrl(entryKey));
        if (!res.ok) { skipped++; console.log(`  SKIP     ${label} — entry HTML unreadable`); continue; }
        rawHtml = await res.text();
      }
      const entryDir = entryKey.substring(0, entryKey.lastIndexOf('/'));
      const depth = entryDir === sim.storage_prefix ? 0 : entryDir.slice(sim.storage_prefix.length).split('/').filter(Boolean).length;
      const rel = (depth > 0 ? '../'.repeat(depth) : './') + 'bridge.js';
      const updatedHtml = injectBridgeScriptTag(injectRafGate(rawHtml), rel, hash);

      // BOTH files must already be current to skip. Comparing only bridge.js made a partially
      // applied package (new bridge written, entry upload then failed) report UNCHANGED forever:
      // the tool could never repair the state it had itself created, while calling it healthy.
      if (combined === bridgeJs && updatedHtml === rawHtml) { skipped++; console.log(`  UNCHANGED ${label}`); continue; }

      if (APPLY) {
        // Optimistic-concurrency check. The live generation path does this same read-modify-write
        // under an in-process bridge lock (uploadSectionBridge/withBridgeLock) precisely because
        // concurrent merges lose sections; a separate process cannot join that lock, so re-read
        // immediately before the PUT and abort if the bytes moved under us. Without this, a user
        // generation landing between our read and write is silently reverted.
        let current = '';
        try { current = (await storage.readObject(bridgeKey)).toString('utf-8'); }
        catch {
          const res = await fetch(storage.getSimPublicUrl(bridgeKey));
          current = res.ok ? await res.text() : '';
        }
        if (current !== bridgeJs) {
          failed++;
          console.log(`  CONFLICT ${label} — bridge.js changed during the rebuild (generation in flight); re-run`);
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
  console.log(`\nSummary: updated: ${updated}, skipped/unchanged: ${skipped}, failed: ${failed}`);
  if (failed > 0) {
    // The exit code is the ONLY signal a scripted rollout reads. Exiting 0 with failures told
    // `backup && rebuild --apply && deploy` chains that the storage rollout had completed.
    console.error(`\n${failed} package(s) failed — storage rollout is INCOMPLETE. Do not proceed.`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
