/**
 * PRESERVATION PROOF for the combined-bridge rebuild — runs entirely in memory.
 *
 * The rebuild rewrites a shared, unversioned storage object. Before that is allowed to happen we
 * prove, per package, that the transform is body-preserving and protocol-upgrading:
 *
 *   • every section body survives byte-for-byte (modulo the documented trailing-whitespace
 *     normalisation, which is reported explicitly rather than hidden);
 *   • no section id is added, removed or renamed;
 *   • the rebuilt bridge really does gain the hardened capabilities (that is the POINT of the
 *     rebuild — a "preserved" bridge that gained nothing means the run is pointless);
 *   • rebuilding twice is IDEMPOTENT — a second pass changes nothing, so a re-run after a partial
 *     failure cannot accumulate whitespace or re-wrap bodies;
 *   • the entry HTML receives the current rAF gate and a bridge tag whose hash matches the bytes
 *     that would actually be written.
 *
 * Writes NOTHING to storage or the database. Optionally emits a machine-readable report.
 *
 *   tsx --env-file=../.env src/scripts/prove-sim-rebuild.ts [--json <out.json>] [--dump-dir <dir>]
 *
 * --dump-dir additionally writes the rebuilt package files to a LOCAL directory so the real
 * browser suite can serve and drive the rebuilt artefacts before anything is applied.
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { db } from '../db/index.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import {
  deriveEntryRelPath,
  parseSectionEntries,
  wrapBridgeCombined,
  computeBridgeHash,
  injectBridgeScriptTag,
  injectRafGate,
} from '../services/simulation/SimulationService.js';

const sha = (s: string | Buffer): string =>
  createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf-8') : s).digest('hex');

/** Capabilities the hardened bridge must expose — the reason the rebuild exists. */
const CAPABILITIES: { key: string; needle: string }[] = [
  { key: 'ackCapable', needle: 'SCRIPT_APPLIED' },
  { key: 'scriptMissing', needle: 'SCRIPT_MISSING' },
  { key: 'scriptError', needle: 'SCRIPT_ERROR' },
  { key: 'pauseScript', needle: 'pauseScript' },
  { key: 'demoTimer', needle: 'simDemoTimer' },
  { key: 'ownPropGuard', needle: 'hasOwnProperty' },
  { key: 'sysRaf', needle: '_sysRaf' },
];

export interface BodyDiff {
  sectionId: string;
  beforeBytes: number;
  afterBytes: number;
  identical: boolean;
  /** True when the only difference is the documented trailing-whitespace trim. */
  identicalIgnoringTrailingWs: boolean;
  beforeSha: string;
  afterSha: string;
}

export interface ProofResult {
  simulationId: string;
  name: string;
  storagePrefix: string;
  ok: boolean;
  reasons: string[];
  sections: {
    before: string[];
    after: string[];
    added: string[];
    removed: string[];
    diffs: BodyDiff[];
  };
  capabilitiesBefore: Record<string, boolean>;
  capabilitiesAfter: Record<string, boolean>;
  gained: string[];
  idempotent: boolean;
  bridge: { beforeBytes: number; afterBytes: number; beforeSha: string; afterSha: string; newHash: string };
  entry: {
    beforeBytes: number;
    afterBytes: number;
    gateBefore: number | null;
    gateAfter: number | null;
    tagHashAfter: string | null;
    tagMatchesBridge: boolean;
  };
}

const caps = (js: string): Record<string, boolean> =>
  Object.fromEntries(CAPABILITIES.map((c) => [c.key, js.includes(c.needle)]));

export async function proveAll(dumpDir?: string): Promise<ProofResult[]> {
  const storage = getStorageAdapter();
  const rows = await db.query.simulations.findMany();
  const results: ProofResult[] = [];

  for (const sim of rows) {
    const reasons: string[] = [];
    const entryRel = deriveEntryRelPath(sim.entry_file, sim.storage_prefix);
    if (!entryRel) continue;                       // no derivable entry — inventory reports it
    const entryKey = `${sim.storage_prefix}/${entryRel}`;
    const bridgeKey = `${sim.storage_prefix}/bridge.js`;

    let bridgeJs: string;
    let rawHtml: string;
    try { bridgeJs = (await storage.readObject(bridgeKey)).toString('utf-8'); } catch { continue; }
    try { rawHtml = (await storage.readObject(entryKey)).toString('utf-8'); } catch { continue; }

    const before = parseSectionEntries(bridgeJs);
    if (before.size === 0) continue;               // not a combined bridge — nothing to preserve

    // ── the rebuild transform, exactly as the apply script performs it ──────────────────
    const combined = wrapBridgeCombined(before);
    const hash = computeBridgeHash(combined);
    const entryDir = entryKey.substring(0, entryKey.lastIndexOf('/'));
    const depth = entryDir === sim.storage_prefix
      ? 0
      : entryDir.slice(sim.storage_prefix.length).split('/').filter(Boolean).length;
    const rel = (depth > 0 ? '../'.repeat(depth) : './') + 'bridge.js';
    const updatedHtml = injectBridgeScriptTag(injectRafGate(rawHtml), rel, hash);

    // ── 1. section identity: nothing added, removed or renamed ──────────────────────────
    const after = parseSectionEntries(combined);
    const beforeIds = [...before.keys()];
    const afterIds = [...after.keys()];
    const added = afterIds.filter((k) => !before.has(k));
    const removed = beforeIds.filter((k) => !after.has(k));
    if (added.length) reasons.push(`sections ADDED: ${added.join(', ')}`);
    if (removed.length) reasons.push(`sections REMOVED: ${removed.join(', ')}`);

    // ── 2. body preservation, byte for byte ────────────────────────────────────────────
    const diffs: BodyDiff[] = [];
    for (const id of beforeIds) {
      const b = before.get(id) ?? '';
      const a = after.get(id) ?? '';
      const identical = a === b;
      const trimmedEqual = a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
      diffs.push({
        sectionId: id,
        beforeBytes: Buffer.byteLength(b, 'utf-8'),
        afterBytes: Buffer.byteLength(a, 'utf-8'),
        identical,
        identicalIgnoringTrailingWs: trimmedEqual,
        beforeSha: sha(b).slice(0, 16),
        afterSha: sha(a).slice(0, 16),
      });
      if (!trimmedEqual) reasons.push(`section ${id}: BODY CHANGED (not just trailing whitespace)`);
    }

    // ── 3. the rebuild must actually gain the hardened protocol ────────────────────────
    const capsBefore = caps(bridgeJs);
    const capsAfter = caps(combined);
    const gained = CAPABILITIES.map((c) => c.key).filter((k) => !capsBefore[k] && capsAfter[k]);
    const lost = CAPABILITIES.map((c) => c.key).filter((k) => capsBefore[k] && !capsAfter[k]);
    if (lost.length) reasons.push(`capabilities LOST: ${lost.join(', ')}`);
    if (gained.length === 0) reasons.push('no capability gained — rebuild would be a no-op upgrade');

    // ── 4. idempotence: a second rebuild must be a byte-for-byte no-op ─────────────────
    const second = wrapBridgeCombined(parseSectionEntries(combined));
    const idempotent = second === combined;
    if (!idempotent) reasons.push('NOT IDEMPOTENT — a re-run would keep changing the file');
    const secondHtml = injectBridgeScriptTag(injectRafGate(updatedHtml), rel, computeBridgeHash(second));
    if (secondHtml !== updatedHtml) reasons.push('entry HTML NOT IDEMPOTENT — re-injection keeps changing it');

    // ── 5. the entry tag must reference the bytes that would actually be written ───────
    const gateBefore = /sim-raf-gate v(\d+)/i.exec(rawHtml);
    const gateAfter = /sim-raf-gate v(\d+)/i.exec(updatedHtml);
    const tagAfter = /bridge\.js\?v=([a-z0-9]+)/i.exec(updatedHtml);
    const tagMatchesBridge = !!tagAfter && hash.startsWith(tagAfter[1]);
    if (!tagMatchesBridge) reasons.push('entry bridge tag hash does not match the rebuilt bridge bytes');
    if (!gateAfter) reasons.push('rebuilt entry has NO rAF gate');

    if (dumpDir) {
      // Local copy of the rebuilt package for real-browser validation before any apply.
      const base = join(dumpDir, sim.storage_prefix);
      mkdirSync(dirname(join(base, entryRel)), { recursive: true });
      writeFileSync(join(base, entryRel), updatedHtml, 'utf-8');
      writeFileSync(join(base, 'bridge.js'), combined, 'utf-8');
    }

    results.push({
      simulationId: sim.id,
      name: sim.name,
      storagePrefix: sim.storage_prefix,
      ok: reasons.length === 0,
      reasons,
      sections: { before: beforeIds, after: afterIds, added, removed, diffs },
      capabilitiesBefore: capsBefore,
      capabilitiesAfter: capsAfter,
      gained,
      idempotent,
      bridge: {
        beforeBytes: Buffer.byteLength(bridgeJs, 'utf-8'),
        afterBytes: Buffer.byteLength(combined, 'utf-8'),
        beforeSha: sha(bridgeJs).slice(0, 16),
        afterSha: sha(combined).slice(0, 16),
        newHash: hash,
      },
      entry: {
        beforeBytes: Buffer.byteLength(rawHtml, 'utf-8'),
        afterBytes: Buffer.byteLength(updatedHtml, 'utf-8'),
        gateBefore: gateBefore ? Number(gateBefore[1]) : null,
        gateAfter: gateAfter ? Number(gateAfter[1]) : null,
        tagHashAfter: tagAfter?.[1] ?? null,
        tagMatchesBridge,
      },
    });
  }
  return results;
}

async function main(): Promise<void> {
  const jsonIdx = process.argv.indexOf('--json');
  const dumpIdx = process.argv.indexOf('--dump-dir');
  const dumpDir = dumpIdx !== -1 ? process.argv[dumpIdx + 1] : undefined;

  const results = await proveAll(dumpDir);
  console.log(`\n=== Rebuild preservation proof — ${results.length} combined package(s) ===\n`);
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}   (${r.simulationId})`);
    console.log(`   sections: ${r.sections.before.length} before → ${r.sections.after.length} after` +
      `   added=${r.sections.added.length} removed=${r.sections.removed.length}`);
    const exact = r.sections.diffs.filter((d) => d.identical).length;
    const trimmed = r.sections.diffs.filter((d) => !d.identical && d.identicalIgnoringTrailingWs).length;
    const changed = r.sections.diffs.filter((d) => !d.identicalIgnoringTrailingWs).length;
    console.log(`   bodies: ${exact} byte-identical, ${trimmed} trailing-whitespace-only, ${changed} CHANGED`);
    for (const d of r.sections.diffs) {
      const mark = d.identical ? '=' : d.identicalIgnoringTrailingWs ? '~' : '✗';
      console.log(`      ${mark} ${d.sectionId}  ${d.beforeBytes}b→${d.afterBytes}b  ${d.beforeSha}→${d.afterSha}`);
    }
    console.log(`   capabilities gained: ${r.gained.join(', ') || '(none)'}`);
    console.log(`   idempotent: ${r.idempotent}`);
    console.log(`   bridge ${r.bridge.beforeBytes}b → ${r.bridge.afterBytes}b   v=${r.bridge.newHash}`);
    console.log(`   entry  ${r.entry.beforeBytes}b → ${r.entry.afterBytes}b   gate v${r.entry.gateBefore ?? '—'} → v${r.entry.gateAfter ?? '—'}   tagMatches=${r.entry.tagMatchesBridge}`);
    for (const reason of r.reasons) console.log(`   ⚠️  ${reason}`);
    console.log('');
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`Summary: ${results.length - bad.length}/${results.length} packages PROVEN safe to rebuild.`);
  if (dumpDir) console.log(`Rebuilt copies written to ${dumpDir} (for browser validation).`);
  if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
    writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + '\n');
    console.log(`JSON written to ${process.argv[jsonIdx + 1]}`);
  }
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && process.argv[1].includes('prove-sim-rebuild')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
