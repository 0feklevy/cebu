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
    const rows = await db.query.simulations.findMany({ where: eq(simulations.status, 'ready') });
    const entries: Entry[] = [];
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
        } catch {
          console.log(`  SKIP (unreadable) ${key}`);
        }
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ at: new Date().toISOString(), entries }, null, 2) + '\n');
    console.log(`\n✅ backed up ${entries.length} files for ${rows.length} simulations → ${dir}`);
    process.exit(0);
  }

  // restore
  if (!existsSync(manifestPath)) { console.error(`no manifest.json in ${dir}`); process.exit(1); }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entries: Entry[] };
  for (const e of manifest.entries) {
    const buf = readFileSync(join(dir, e.local));
    await storage.uploadFile(e.key, buf, getSimulationContentType(e.key));
    console.log(`  restored ${buf.length}b  ${e.key}`);
  }
  console.log(`\n✅ restored ${manifest.entries.length} files from ${dir}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
