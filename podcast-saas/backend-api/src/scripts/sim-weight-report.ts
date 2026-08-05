/**
 * Measure a real published package's weight, and optionally compare two of them.
 *
 * READ-ONLY. It lists and reads objects; it never writes, publishes or deletes. The point is
 * before/after evidence for an optimisation claim that is a comparison of MEASUREMENTS — the sizes
 * and content types of the exact bytes being served — rather than of estimates.
 *
 *   pnpm tsx --env-file=../.env src/scripts/sim-weight-report.ts <simulationId> [<simulationId2>]
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { simulations } from '../db/schema.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { analyzeWeight, compareWeight } from 'shared/sim/packageWeight';
import { SIM_MANIFEST_VERSION, type SimManifest, type SimManifestFile } from 'shared/sim/simManifest';
import { getSimulationContentType } from '../services/simulation/SimulationService.js';
import { revisionIdFromKey } from 'shared/sim/simRevision';

/**
 * Build a manifest from what is ACTUALLY stored under a simulation's prefix.
 *
 * A published revision already has a verified manifest; a legacy package has none, and this is how
 * one gets measured without republishing it. Sizes come from `headObject` where the adapter can
 * report them and from the object length otherwise — never from a guess.
 */
async function manifestFromStorage(simId: string): Promise<{ manifest: SimManifest; prefix: string } | null> {
  const [sim] = await db.select({
    id: simulations.id, storage_prefix: simulations.storage_prefix, entry_file: simulations.entry_file,
  }).from(simulations).where(eq(simulations.id, simId));
  if (!sim) return null;

  const storage = getStorageAdapter();
  const prefix = sim.storage_prefix.replace(/\/+$/, '');
  const keys = (await storage.listObjects(prefix)).filter((k) => revisionIdFromKey(k) === null);

  const files: SimManifestFile[] = [];
  for (const key of keys) {
    const rel = key.slice(prefix.length + 1);
    if (!rel) continue;
    let bytes = 0;
    let contentType = getSimulationContentType(key);
    try {
      const head = await storage.headObject(key);
      if (head?.size != null) bytes = head.size;
      if (head?.contentType) contentType = head.contentType;
      if (bytes === 0) bytes = (await storage.readObject(key)).length;
    } catch { continue; }
    const isEntry = sim.entry_file?.includes(rel) ?? false;
    files.push({
      path: rel,
      role: isEntry ? 'entry' : /^(runtime\/)?(bridge|guidance)\.js$/i.test(rel) ? 'runtime' : 'asset',
      // A DISTINCT synthetic hash per path.
      //
      // Duplicate detection compares hashes, so a shared placeholder made every file look identical
      // and produced a confident, entirely false "27 paths share identical bytes". Real duplicate
      // detection needs real content hashes, which exist at publication (RevisionService verifies
      // them) and are deliberately not recomputed here — reading every byte to answer a question
      // about SIZE would cost far more than the answer is worth. A path-derived hash keeps the size
      // and category numbers exact while making the duplicate check honestly inert.
      hash: createHash('sha256').update(key).digest('hex'),
      bytes,
      contentType,
      cacheControl: '',
    });
  }
  return {
    prefix,
    manifest: {
      manifestVersion: SIM_MANIFEST_VERSION, simulationId: sim.id, projectId: '',
      revisionId: '', revisionNumber: 0, bridgeProtocolVersion: 0, runtimeProtocolVersion: 0,
      entry: files.find((f) => f.role === 'entry')?.path ?? '', runtime: [],
      files, variants: [{ variantKey: 'main', configHashes: [] }], posters: [],
      qualityProfiles: ['high'], externalDependencies: [], generatedFrom: {},
      canary: { classification: null, ranAt: null, engine: null },
      createdAt: new Date().toISOString(), createdBy: null,
    },
  };
}

const fmt = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;

/**
 * BEFORE/AFTER for a real optimisation, measured rather than estimated.
 *
 * Downloads the package, applies a transformation LOCALLY, and re-measures. Nothing is uploaded and
 * no stored object is touched — the point is to prove a saving is real before anyone commits to it.
 *
 * The transformation here is `gzip`, chosen because it is exactly what a CDN would apply and
 * because it is lossless: the saving is available with no change to what the package does. Findings
 * that require judgement (dropping an unused model, re-encoding audio) are reported for a human,
 * never applied automatically to a customer's own files.
 */
async function optimizedComparison(simId: string): Promise<void> {
  const first = await manifestFromStorage(simId);
  if (!first) { console.error(`simulation ${simId} not found`); process.exit(1); }
  const storage = getStorageAdapter();
  const before = analyzeWeight(first.manifest);

  const after: SimManifestFile[] = [];
  let compressible = 0;
  for (const f of first.manifest.files) {
    const key = `${first.prefix}/${f.path}`;
    let bytes = f.bytes;
    try {
      const raw = await storage.readObject(key);
      // Only text-shaped assets benefit; already-compressed media does not, and claiming a saving
      // there would be the kind of number that evaporates in production.
      if (/\.(js|mjs|css|html?|json|svg|md|txt)$/i.test(f.path)) {
        bytes = gzipSync(raw, { level: 9 }).length;
        compressible += 1;
      } else {
        bytes = raw.length;
      }
    } catch { /* unreadable object keeps its reported size */ }
    after.push({ ...f, bytes });
  }

  const afterReport = analyzeWeight({ ...first.manifest, files: after });
  const c = compareWeight(before, afterReport);
  console.log(`\nBEFORE / AFTER — gzip on ${compressible} text assets (measured, nothing uploaded)`);
  console.log(`  before     ${fmt(before.totalBytes)}`);
  console.log(`  after      ${fmt(afterReport.totalBytes)}`);
  console.log(`  delta      ${c.deltaBytes >= 0 ? '+' : '-'}${fmt(Math.abs(c.deltaBytes))} (${c.percentChange}%)`);
  console.log(`  improved   ${c.improved}`);
  console.log('  by category:');
  for (const cat of Object.keys(before.byCategory) as (keyof typeof before.byCategory)[]) {
    const b = before.byCategory[cat]; const a = afterReport.byCategory[cat];
    if (b.count === 0) continue;
    const d = a.bytes - b.bytes;
    console.log(`    ${String(cat).padEnd(8)} ${fmt(b.bytes).padStart(10)} -> ${fmt(a.bytes).padStart(10)}`
      + `  ${d === 0 ? '(no change)' : `${d < 0 ? '-' : '+'}${fmt(Math.abs(d))}`}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--optimize')) {
    const id = process.argv.slice(2).find((x) => !x.startsWith('--'));
    if (!id) { console.error('usage: --optimize <simulationId>'); process.exit(1); }
    await optimizedComparison(id);
    process.exit(0);
  }
  const [a, b] = process.argv.slice(2);
  if (!a) { console.error('usage: sim-weight-report.ts <simulationId> [<simulationId2>]'); process.exit(1); }

  const first = await manifestFromStorage(a);
  if (!first) { console.error(`simulation ${a} not found`); process.exit(1); }
  const ra = analyzeWeight(first.manifest);

  console.log(`\nPACKAGE ${a}`);
  console.log(`  prefix     ${first.prefix}`);
  console.log(`  total      ${fmt(ra.totalBytes)} across ${ra.fileCount} files`);
  for (const [cat, v] of Object.entries(ra.byCategory)) {
    if (v.count > 0) console.log(`    ${cat.padEnd(8)} ${fmt(v.bytes).padStart(10)}  (${v.count})`);
  }
  console.log('  largest:');
  for (const e of ra.largest.slice(0, 8)) console.log(`    ${fmt(e.bytes).padStart(10)}  ${e.path}`);
  console.log('  NOTE duplicate detection is inert here (see manifestFromStorage) — it runs at');
  console.log('       publication, where verified content hashes already exist.');
  if (ra.findings.length) {
    console.log('  findings (advisory — never blocks a publication):');
    for (const f of ra.findings) {
      console.log(`    ${f.code}: ${f.detail}${f.recoverableBytes ? ` (recoverable ${fmt(f.recoverableBytes)})` : ''}`);
    }
  }

  if (b) {
    const second = await manifestFromStorage(b);
    if (!second) { console.error(`simulation ${b} not found`); process.exit(1); }
    const rb = analyzeWeight(second.manifest);
    const c = compareWeight(ra, rb);
    console.log(`\nCOMPARISON ${a} -> ${b}`);
    console.log(`  ${fmt(ra.totalBytes)} -> ${fmt(rb.totalBytes)}`);
    console.log(`  delta      ${c.deltaBytes >= 0 ? '+' : ''}${fmt(Math.abs(c.deltaBytes))} (${c.percentChange}%)`);
    console.log(`  files      ${c.deltaFiles >= 0 ? '+' : ''}${c.deltaFiles}`);
    console.log(`  improved   ${c.improved}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
