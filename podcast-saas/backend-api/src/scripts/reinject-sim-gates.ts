/**
 * Re-run the system-owned entry-HTML injections (head rAF gate + inline bridge v2 template)
 * for every simulation with status 'ready', in place.
 *
 * LOCALLY (a dev machine, against a local DATABASE_URL):
 *   pnpm --filter backend-api sims:reinject-gates              # DRY RUN (default) — reports only
 *   pnpm --filter backend-api sims:reinject-gates -- --apply   # actually uploads updated entry HTML
 *
 * ON THE PRODUCTION VM the package script above DOES NOT WORK, and the reason is worth stating
 * because the first operator to try it lost time to a wrong error (2026-08-30):
 *   - the VM host has no Node and no pnpm at all — everything runs inside the `backend` container;
 *   - inside that container the app is not laid out as the repo is, so the package script's
 *     `tsx --env-file=../.env` names a path that does not exist there. The env is already in the
 *     container's environment, so the file is not needed — only the script is.
 * Run it in the container, invoking the script directly (VERIFIED on production 2026-08-30 —
 * 9 ready simulations, 7 updated, 2 already current, then a second pass reporting all 9 unchanged):
 *   docker compose exec backend pnpm --filter backend-api exec tsx src/scripts/reinject-sim-gates.ts
 *   docker compose exec backend pnpm --filter backend-api exec tsx src/scripts/reinject-sim-gates.ts --apply
 *
 * Idempotent by construction:
 *   - injectRafGate is marker-guarded (<!-- sim-raf-gate v1 -->) — re-running strips any existing
 *     gate block and re-inserts exactly one at the start of <head>.
 *   - injectInlineBridge refreshes an existing inline "sim-bridge v2" block in place, and SKIPS
 *     the inline template entirely when the combined bridge.js marker block is present.
 *   - Existing bridge.js / guidance.js script tags (SIM_BRIDGE_SCRIPT_* / SIM_GUIDANCE_SCRIPT_*
 *     marker blocks, including their current ?v= hashes) are never touched.
 * A second run therefore reports every sim as "unchanged".
 *
 * Config (DB + storage credentials) comes from the standard runtime env plumbing — the package
 * script runs this via `tsx --env-file=../.env`, same as every other script here, which is exactly
 * the part that does not transfer into the container (see above). This file never opens or reads
 * any .env file itself; it only reads what is already in `process.env`.
 */
import { db } from '../db/index.js';
import { simulations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import {
  deriveEntryRelPath,
  injectInlineBridge,
  injectRafGate,
  type BridgeFunction,
} from '../services/simulation/SimulationService.js';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const storage = getStorageAdapter();
  const rows = await db.query.simulations.findMany({ where: eq(simulations.status, 'ready') });

  console.log(`\n=== Sim entry-HTML re-injection (${APPLY ? 'APPLY' : 'DRY RUN'}) — ${rows.length} ready simulation(s) ===\n`);

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  const notes: string[] = [];

  for (const sim of rows) {
    const label = `${sim.id}  "${sim.name}"`;
    try {
      const entryRel = deriveEntryRelPath(sim.entry_file, sim.storage_prefix);
      if (!entryRel) {
        skipped++;
        notes.push(`  SKIP     ${label} — cannot determine entry file from "${sim.entry_file}"`);
        continue;
      }
      const entryKey = `${sim.storage_prefix}/${entryRel}`;

      // Read via the storage API; fall back to the public URL when GetObject is denied
      // (write-only tokens) — the same fallback the generate/publish flows use.
      let html: string;
      try {
        html = (await storage.readObject(entryKey)).toString('utf-8');
      } catch {
        const res = await fetch(storage.getSimPublicUrl(entryKey)).catch(() => null);
        if (!res || !res.ok) {
          skipped++;
          notes.push(`  SKIP     ${label} — entry HTML unreadable (${entryKey})`);
          continue;
        }
        html = await res.text();
      }

      const fns = (Array.isArray(sim.bridge_functions) ? sim.bridge_functions : []) as BridgeFunction[];
      const next = injectInlineBridge(injectRafGate(html), fns);

      if (next === html) {
        unchanged++;
        continue;
      }

      if (APPLY) {
        await storage.uploadFile(entryKey, Buffer.from(next, 'utf-8'), 'text/html; charset=utf-8');
        updated++;
        notes.push(`  UPDATED  ${label} — ${entryKey}`);
      } else {
        updated++;
        notes.push(`  WOULD UPDATE ${label} — ${entryKey}`);
      }
    } catch (err) {
      failed++;
      notes.push(`  FAIL     ${label} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  notes.forEach((n) => console.log(n));
  console.log(`\nSummary: ${rows.length} ready sim(s) — ` +
    `${APPLY ? 'updated' : 'would update'}: ${updated}, unchanged: ${unchanged}, skipped: ${skipped}, failed: ${failed}`);
  if (!APPLY && updated > 0) {
    console.log('DRY RUN — nothing was written. Re-run with `-- --apply` to upload the updated entry HTML.');
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
