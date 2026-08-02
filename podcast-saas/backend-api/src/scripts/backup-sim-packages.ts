/**
 * Backup / restore the STORED (not served) bridge.js + entry HTML of every ready simulation.
 * This is the rollback companion to rebuild-sim-bridges.ts, which has no backup of its own.
 *
 *   Backup (run BEFORE a rebuild --apply):
 *     tsx --env-file=../.env src/scripts/backup-sim-packages.ts backup ./sim-backup-<date>
 *   Restore (rollback a rebuild):
 *     tsx --env-file=../.env src/scripts/backup-sim-packages.ts restore ./sim-backup-<date>
 *
 * It reads/writes the exact stored objects via the storage adapter (storage.readObject /
 * uploadFile), so a restore reproduces the pre-rebuild bytes byte-for-byte. Only bridge.js and
 * the entry HTML are touched — the two files rebuild-sim-bridges.ts overwrites. Generated
 * guidance and every user asset are left alone by both tools.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { db } from '../db/index.js';
import { simulations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { deriveEntryRelPath, getSimulationContentType } from '../services/simulation/SimulationService.js';

interface Entry { simId: string; name: string; key: string; local: string; bytes: number }

const FORCE = process.argv.includes('--force');

async function main(): Promise<void> {
  const mode = process.argv[2];
  const dir = process.argv[3];
  if ((mode !== 'backup' && mode !== 'restore') || !dir) {
    console.error('usage: backup-sim-packages.ts <backup|restore> <dir>');
    process.exit(1);
  }
  const storage = getStorageAdapter();
  const manifestPath = join(dir, 'manifest.json');

  if (mode === 'backup') {
    // Never overwrite an existing backup. Re-running into the same directory AFTER a rebuild
    // --apply (shell history, tab completion) would replace the only copy of the pre-rebuild
    // bytes with the post-rebuild ones and make rollback permanently impossible — silently.
    if (existsSync(manifestPath) && !FORCE) {
      console.error(`refusing to overwrite the existing backup in ${dir} (manifest.json present).`);
      console.error('Use a new directory, or pass --force if you are certain it is disposable.');
      process.exit(1);
    }
    const rows = await db.query.simulations.findMany({ where: eq(simulations.status, 'ready') });
    const entries: Entry[] = [];
    const unreadable: string[] = [];
    for (const sim of rows) {
      const entryRel = deriveEntryRelPath(sim.entry_file, sim.storage_prefix);
      const keys = [`${sim.storage_prefix}/bridge.js`, ...(entryRel ? [`${sim.storage_prefix}/${entryRel}`] : [])];
      for (const key of keys) {
        try {
          const buf = await storage.readObject(key);
          const local = join(dir, key);
          mkdirSync(dirname(local), { recursive: true });
          writeFileSync(local, buf);
          entries.push({ simId: sim.id, name: sim.name, key, local: key, bytes: buf.length });
          console.log(`  saved ${buf.length}b  ${key}`);
        } catch (err) {
          // A read failure here is NOT benign: rebuild --apply overwrites these keys in place in
          // a bucket with no versioning, and rebuild has a public-proxy read fallback that this
          // tool lacks — so it can rewrite an object this run never captured. Any unreadable key
          // means the backup is incomplete and rollback would be partial.
          unreadable.push(`${key} — ${(err as Error).message.slice(0, 100)}`);
          console.log(`  UNREADABLE ${key}`);
        }
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ at: new Date().toISOString(), entries, unreadable }, null, 2) + '\n');
    if (unreadable.length) {
      console.error(`\n❌ INCOMPLETE backup: ${entries.length} saved, ${unreadable.length} unreadable:`);
      for (const u of unreadable) console.error(`     ${u}`);
      console.error('Rollback would be PARTIAL. Do NOT run rebuild --apply until every key reads.');
      process.exit(1);
    }
    console.log(`\n✅ backed up ${entries.length} files for ${rows.length} simulations → ${dir}`);
    process.exit(0);
  }

  // restore
  if (!existsSync(manifestPath)) { console.error(`no manifest.json in ${dir}`); process.exit(1); }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entries: Entry[] };
  // Pre-flight: read EVERY file before uploading any. A missing/corrupt file discovered halfway
  // through leaves the package split across two generations — the worst state to debug a
  // rollback from, and precisely when the operator has the least room to improvise.
  const payloads: { key: string; buf: Buffer }[] = [];
  const missing: string[] = [];
  for (const e of manifest.entries) {
    try { payloads.push({ key: e.key, buf: readFileSync(join(dir, e.local)) }); }
    catch (err) { missing.push(`${e.local} — ${(err as Error).message.slice(0, 100)}`); }
  }
  if (missing.length) {
    console.error(`\n❌ backup is incomplete — ${missing.length} file(s) unreadable; nothing was restored:`);
    for (const m of missing) console.error(`     ${m}`);
    process.exit(1);
  }
  for (const p of payloads) {
    await storage.uploadFile(p.key, p.buf, getSimulationContentType(p.key));
    console.log(`  restored ${p.buf.length}b  ${p.key}`);
  }
  console.log(`\n✅ restored ${payloads.length} files from ${dir}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
