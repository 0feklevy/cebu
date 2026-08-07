/**
 * PRE-APPLY PRESERVATION PROOF for the combined-bridge rebuild — runs entirely in memory.
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
 * This tool is the PRE-apply gate ONLY. "No capability gained" is a FAILURE here, which is correct
 * before the rollout and wrong after it — a successfully rebuilt package has nothing left to gain.
 * Post-apply verification is a different question (are the STORED and SERVED bytes now hardened and
 * consistent?) and lives in verify-sim-rebuild.ts. Do not re-run this script after --apply.
 *
 * Writes NOTHING to storage or the database. Optionally emits a machine-readable report.
 *
 *   tsx --env-file=../.env src/scripts/prove-sim-rebuild.ts [--json <out.json>] [--dump-dir <dir>]
 *
 * --dump-dir additionally writes the rebuilt package files to a LOCAL directory so the real
 * browser suite can serve and drive the rebuilt artefacts before anything is applied.
 *
 * EXIT CODES — the only signal a scripted rollout reads:
 *   0  every package the inventory considers rebuildable was examined AND proven.
 *   1  anything else, including the cases that used to exit 0 having proved nothing:
 *      zero packages proven, a package silently skipped, an unreadable object, a read that
 *      threw, or an inventory-rebuildable package missing from the proof.
 *
 * Everything above main() is dependency-injected (storage / transforms / rows), so the logic is
 * unit-tested without a database, storage adapter or network. The db/storage/SimulationService
 * imports load lazily INSIDE main(), so importing this module never opens a database client.
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PackageInventory } from './inventory-sim-packages.js';

const sha = (s: string | Buffer): string =>
  createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf-8') : s).digest('hex');

/** Capabilities the hardened bridge must expose — the reason the rebuild exists. */
export const CAPABILITIES: { key: string; needle: string }[] = [
  { key: 'ackCapable', needle: 'SCRIPT_APPLIED' },
  { key: 'scriptMissing', needle: 'SCRIPT_MISSING' },
  { key: 'scriptError', needle: 'SCRIPT_ERROR' },
  { key: 'pauseScript', needle: 'pauseScript' },
  { key: 'demoTimer', needle: 'simDemoTimer' },
  { key: 'ownPropGuard', needle: 'hasOwnProperty' },
  { key: 'sysRaf', needle: '_sysRaf' },
];

// ── Injected ports (so the proof is testable without db/storage/network) ──────

export type Log = (line: string) => void;

export interface ProveStorage {
  readObject(key: string): Promise<Buffer>;
  /** The REAL serving path. Used as the read fallback, exactly as the rebuild tool does. */
  getSimPublicUrl(key: string): string;
}

/** The pure transform functions from SimulationService, injected so tests need no db import. */
export interface SimTransforms {
  deriveEntryRelPath(entryFile: string | null | undefined, storagePrefix: string): string | null;
  parseSectionEntries(bridgeJs: string): Map<string, string>;
  wrapBridgeCombined(entries: Map<string, string>): string;
  computeBridgeHash(code: string): string;
  injectBridgeScriptTag(html: string, relPath: string, bridgeHash: string): string;
  injectRafGate(html: string): string;
}

/** The subset of a simulations row the proof needs. */
export interface ProveSimRow {
  id: string;
  name: string;
  storage_prefix: string;
  entry_file: string | null;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// ── Result shapes ─────────────────────────────────────────────────────────────

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
  /** Where each file was actually read from ('storage' | 'sim-public'). */
  sources: { bridge: string; entry: string };
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

export interface SkippedPackage { simulationId: string; name: string; storagePrefix: string; reason: string }
export interface UnreadablePackage { simulationId: string; name: string; storagePrefix: string; key: string; role: 'bridge' | 'entry'; reason: string }
export interface FailedPackage { simulationId: string; name: string; storagePrefix: string; reason: string }

/**
 * Every package the run saw, in exactly one bucket. The old shape was a bare ProofResult[]: three
 * `continue` paths dropped packages out of it entirely, so a total storage outage produced an empty
 * array that printed "0/0 PROVEN" and exited 0.
 */
export interface ProofRun {
  discovered: number;
  results: ProofResult[];
  skipped: SkippedPackage[];
  unreadable: UnreadablePackage[];
  failed: FailedPackage[];
}

const caps = (js: string): Record<string, boolean> =>
  Object.fromEntries(CAPABILITIES.map((c) => [c.key, js.includes(c.needle)]));

/**
 * Read a stored object, falling back to the public serving path — the same fallback
 * rebuild-sim-bridges.ts and inventory-sim-packages.ts already have. Without it this tool
 * disagreed with the tool it is supposed to gate: rebuild --apply could rewrite a package whose
 * bytes the proof had never managed to read, and the miss looked like a silent skip.
 */
export async function readWithFallback(
  storage: ProveStorage,
  key: string,
  fetchImpl: FetchLike,
): Promise<{ text: string; source: string } | { text: null; source: string }> {
  try {
    return { text: (await storage.readObject(key)).toString('utf-8'), source: 'storage' };
  } catch (primary) {
    try {
      const res = await fetchImpl(storage.getSimPublicUrl(key));
      if (!res.ok) return { text: null, source: `storage: ${(primary as Error).message.slice(0, 60)}; sim-public: http ${res.status}` };
      return { text: await res.text(), source: 'sim-public' };
    } catch (secondary) {
      return {
        text: null,
        source: `storage: ${(primary as Error).message.slice(0, 60)}; sim-public: ${(secondary as Error).message.slice(0, 60)}`,
      };
    }
  }
}

export interface ProveOptions {
  rows: ProveSimRow[];
  storage: ProveStorage;
  transforms: SimTransforms;
  fetchImpl?: FetchLike;
  /** When given, the rebuilt bytes of each proven package are handed to this sink. */
  writeDump?: (relPath: string, contents: string) => void;
}

/** Run the rebuild transform in memory over every row, bucketing every package. Writes nothing. */
export async function proveAll(o: ProveOptions): Promise<ProofRun> {
  const fetchImpl: FetchLike = o.fetchImpl ?? ((url: string) => fetch(url));
  const t = o.transforms;
  const run: ProofRun = { discovered: o.rows.length, results: [], skipped: [], unreadable: [], failed: [] };

  for (const sim of o.rows) {
    const id = { simulationId: sim.id, name: sim.name, storagePrefix: sim.storage_prefix };
    try {
      const reasons: string[] = [];
      const entryRel = t.deriveEntryRelPath(sim.entry_file, sim.storage_prefix);
      if (!entryRel) {
        run.skipped.push({ ...id, reason: 'cannot derive entry file from entry_file/storage_prefix' });
        continue;
      }
      const entryKey = `${sim.storage_prefix}/${entryRel}`;
      const bridgeKey = `${sim.storage_prefix}/bridge.js`;

      const bridgeRead = await readWithFallback(o.storage, bridgeKey, fetchImpl);
      if (bridgeRead.text === null) {
        run.unreadable.push({ ...id, key: bridgeKey, role: 'bridge', reason: bridgeRead.source });
        continue;
      }
      const entryRead = await readWithFallback(o.storage, entryKey, fetchImpl);
      if (entryRead.text === null) {
        run.unreadable.push({ ...id, key: entryKey, role: 'entry', reason: entryRead.source });
        continue;
      }
      const bridgeJs = bridgeRead.text;
      const rawHtml = entryRead.text;

      const before = t.parseSectionEntries(bridgeJs);
      if (before.size === 0) {
        run.skipped.push({ ...id, reason: 'bridge.js has no @@SIM_BRIDGE markers — legacy/pre-combined, nothing to preserve' });
        continue;
      }

      // ── the rebuild transform, exactly as the apply script performs it ──────────────────
      const combined = t.wrapBridgeCombined(before);
      const hash = t.computeBridgeHash(combined);
      const entryDir = entryKey.substring(0, entryKey.lastIndexOf('/'));
      const depth = entryDir === sim.storage_prefix
        ? 0
        : entryDir.slice(sim.storage_prefix.length).split('/').filter(Boolean).length;
      const rel = (depth > 0 ? '../'.repeat(depth) : './') + 'bridge.js';
      const updatedHtml = t.injectBridgeScriptTag(t.injectRafGate(rawHtml), rel, hash);

      // ── 1. section identity: nothing added, removed or renamed ──────────────────────────
      const after = t.parseSectionEntries(combined);
      const beforeIds = [...before.keys()];
      const afterIds = [...after.keys()];
      const added = afterIds.filter((k) => !before.has(k));
      const removed = beforeIds.filter((k) => !after.has(k));
      if (added.length) reasons.push(`sections ADDED: ${added.join(', ')}`);
      if (removed.length) reasons.push(`sections REMOVED: ${removed.join(', ')}`);

      // ── 2. body preservation, byte for byte ────────────────────────────────────────────
      const diffs: BodyDiff[] = [];
      for (const sectionId of beforeIds) {
        const b = before.get(sectionId) ?? '';
        const a = after.get(sectionId) ?? '';
        const identical = a === b;
        const trimmedEqual = a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
        diffs.push({
          sectionId,
          beforeBytes: Buffer.byteLength(b, 'utf-8'),
          afterBytes: Buffer.byteLength(a, 'utf-8'),
          identical,
          identicalIgnoringTrailingWs: trimmedEqual,
          beforeSha: sha(b).slice(0, 16),
          afterSha: sha(a).slice(0, 16),
        });
        if (!trimmedEqual) reasons.push(`section ${sectionId}: BODY CHANGED (not just trailing whitespace)`);
      }

      // ── 3. the rebuild must actually gain the hardened protocol ────────────────────────
      const capsBefore = caps(bridgeJs);
      const capsAfter = caps(combined);
      const gained = CAPABILITIES.map((c) => c.key).filter((k) => !capsBefore[k] && capsAfter[k]);
      const lost = CAPABILITIES.map((c) => c.key).filter((k) => capsBefore[k] && !capsAfter[k]);
      if (lost.length) reasons.push(`capabilities LOST: ${lost.join(', ')}`);
      if (gained.length === 0) {
        reasons.push(
          'no capability gained — rebuild would be a no-op upgrade. If the rollout has ALREADY been ' +
          'applied this is expected; use verify-sim-rebuild.ts, not this pre-apply proof.',
        );
      }

      // ── 4. idempotence: a second rebuild must be a byte-for-byte no-op ─────────────────
      const second = t.wrapBridgeCombined(t.parseSectionEntries(combined));
      const idempotent = second === combined;
      if (!idempotent) reasons.push('NOT IDEMPOTENT — a re-run would keep changing the file');
      const secondHtml = t.injectBridgeScriptTag(t.injectRafGate(updatedHtml), rel, t.computeBridgeHash(second));
      if (secondHtml !== updatedHtml) reasons.push('entry HTML NOT IDEMPOTENT — re-injection keeps changing it');

      // ── 5. the entry tag must reference the bytes that would actually be written ───────
      const gateBefore = /sim-raf-gate v(\d+)/i.exec(rawHtml);
      const gateAfter = /sim-raf-gate v(\d+)/i.exec(updatedHtml);
      const tagAfter = /bridge\.js\?v=([a-z0-9]+)/i.exec(updatedHtml);
      const tagMatchesBridge = !!tagAfter && hash.startsWith(tagAfter[1]);
      if (!tagMatchesBridge) reasons.push('entry bridge tag hash does not match the rebuilt bridge bytes');
      if (!gateAfter) reasons.push('rebuilt entry has NO rAF gate');

      if (o.writeDump) {
        // Local copy of the rebuilt package for real-browser validation before any apply.
        o.writeDump(join(sim.storage_prefix, entryRel), updatedHtml);
        o.writeDump(join(sim.storage_prefix, 'bridge.js'), combined);
      }

      run.results.push({
        ...id,
        ok: reasons.length === 0,
        reasons,
        sources: { bridge: bridgeRead.source, entry: entryRead.source },
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
    } catch (e) {
      // A transform that threw is NOT a skip: the package was in scope and the proof does not know
      // whether the rebuild would preserve it. Always a gate failure.
      run.failed.push({ ...id, reason: `${(e as Error).message.slice(0, 160)}` });
    }
  }
  return run;
}

// ── Inventory cross-check ─────────────────────────────────────────────────────

export interface ExpectedRebuildable { simulationId: string; name: string; storagePrefix: string }

/** The minimum of inventory-sim-packages.ts's PackageInventory this cross-check reads. */
export interface InventoryLike {
  simulationId: string;
  name: string;
  storagePrefix: string;
  bridge: { combined: boolean };
  files: { entry: { present: boolean } };
}

/** Compile-time guard: the real inventory shape must stay assignable to what we consume. */
export type InventoryShapeGuard = PackageInventory extends InventoryLike ? true : never;

/**
 * The packages the inventory says a rebuild can actually touch: a combined bridge (section bodies
 * to preserve) plus an entry HTML that reads. Every one of these MUST appear in the proof — that is
 * the cross-check that makes "0 proven" impossible to mistake for "nothing to do".
 */
export function expectedRebuildableFromInventory(inv: InventoryLike[]): ExpectedRebuildable[] {
  return inv
    .filter((p) => p.bridge.combined && p.files.entry.present)
    .map((p) => ({ simulationId: p.simulationId, name: p.name, storagePrefix: p.storagePrefix }));
}

export interface ProofGate {
  ok: boolean;
  discovered: number;
  checked: number;
  proven: number;
  failed: number;
  skipped: number;
  unreadable: number;
  expectedRebuildable: number;
  /** Expected-rebuildable packages that never made it into the proven set, with why. */
  notProven: { simulationId: string; name: string; disposition: string }[];
  problems: string[];
}

/**
 * The whole point of the fix: decide the exit code from EVERY bucket, not just from
 * `results.filter(!ok)`. `expected === null` means the inventory itself could not be built, which
 * is a failure — an un-cross-checked proof cannot certify that it examined everything.
 */
export function gateProofRun(
  run: ProofRun,
  expected: ExpectedRebuildable[] | null,
  inventoryProblem?: string | null,
): ProofGate {
  const problems: string[] = [];
  const proven = run.results.filter((r) => r.ok);
  const notOk = run.results.filter((r) => !r.ok);

  for (const r of notOk) problems.push(`${r.name} [${r.simulationId}] FAILED the proof: ${r.reasons.join('; ')}`);
  for (const f of run.failed) problems.push(`${f.name} [${f.simulationId}] threw during the proof: ${f.reason}`);

  if (proven.length === 0) {
    problems.push(
      `PROVED NOTHING: 0 of ${run.discovered} discovered package(s) were proven ` +
      `(${run.skipped.length} skipped, ${run.unreadable.length} unreadable, ${run.failed.length} errored). ` +
      'An empty proof is not a proof — do NOT run rebuild --apply.',
    );
  }

  const notProven: ProofGate['notProven'] = [];
  if (inventoryProblem) {
    problems.push(`inventory cross-check unavailable — ${inventoryProblem}. The proof cannot certify it examined every rebuildable package.`);
  } else if (expected) {
    const provenIds = new Set(proven.map((r) => r.simulationId));
    const skippedById = new Map(run.skipped.map((s) => [s.simulationId, s.reason]));
    const unreadableById = new Map(run.unreadable.map((u) => [u.simulationId, `${u.role} ${u.key} unreadable (${u.reason})`]));
    const erroredById = new Map(run.failed.map((f) => [f.simulationId, f.reason]));
    const failedById = new Map(notOk.map((r) => [r.simulationId, r.reasons.join('; ')]));
    for (const e of expected) {
      if (provenIds.has(e.simulationId)) continue;
      const disposition =
        skippedById.get(e.simulationId) !== undefined ? `SKIPPED: ${skippedById.get(e.simulationId)}`
          : unreadableById.get(e.simulationId) !== undefined ? `UNREADABLE: ${unreadableById.get(e.simulationId)}`
            : erroredById.get(e.simulationId) !== undefined ? `ERRORED: ${erroredById.get(e.simulationId)}`
              : failedById.get(e.simulationId) !== undefined ? `FAILED: ${failedById.get(e.simulationId)}`
                : 'ABSENT: the package was never examined at all';
      notProven.push({ simulationId: e.simulationId, name: e.name, disposition });
      problems.push(`inventory says ${e.name} [${e.simulationId}] is REBUILDABLE but it was not proven — ${disposition}`);
    }
    if (expected.length === 0 && proven.length > 0) {
      // The two readers hit the same storage with the same fallback. Disagreeing means one of them
      // saw a different bucket/credential set, and "3/0 proven" must not read as green.
      problems.push(
        `inventory found ZERO rebuildable packages but the proof proved ${proven.length} — the two readers ` +
        'disagree about storage. Re-run step 1a and reconcile before applying.',
      );
    }
  }

  return {
    ok: problems.length === 0,
    discovered: run.discovered,
    checked: run.results.length,
    proven: proven.length,
    failed: notOk.length + run.failed.length,
    skipped: run.skipped.length,
    unreadable: run.unreadable.length,
    expectedRebuildable: expected?.length ?? 0,
    notProven,
    problems,
  };
}

/** Human-readable accounting of every bucket — no category may go unreported. */
export function reportProofRun(run: ProofRun, gate: ProofGate, log: Log, err: Log): void {
  log(`\n=== Rebuild preservation proof (PRE-APPLY) — ${run.discovered} simulation row(s) discovered ===\n`);
  for (const r of run.results) {
    log(`${r.ok ? '✅' : '❌'} ${r.name}   (${r.simulationId})`);
    log(`   read from: bridge=${r.sources.bridge}  entry=${r.sources.entry}`);
    log(`   sections: ${r.sections.before.length} before → ${r.sections.after.length} after` +
      `   added=${r.sections.added.length} removed=${r.sections.removed.length}`);
    const exact = r.sections.diffs.filter((d) => d.identical).length;
    const trimmed = r.sections.diffs.filter((d) => !d.identical && d.identicalIgnoringTrailingWs).length;
    const changed = r.sections.diffs.filter((d) => !d.identicalIgnoringTrailingWs).length;
    log(`   bodies: ${exact} byte-identical, ${trimmed} trailing-whitespace-only, ${changed} CHANGED`);
    for (const d of r.sections.diffs) {
      const mark = d.identical ? '=' : d.identicalIgnoringTrailingWs ? '~' : '✗';
      log(`      ${mark} ${d.sectionId}  ${d.beforeBytes}b→${d.afterBytes}b  ${d.beforeSha}→${d.afterSha}`);
    }
    log(`   capabilities gained: ${r.gained.join(', ') || '(none)'}`);
    log(`   idempotent: ${r.idempotent}`);
    log(`   bridge ${r.bridge.beforeBytes}b → ${r.bridge.afterBytes}b   v=${r.bridge.newHash}`);
    log(`   entry  ${r.entry.beforeBytes}b → ${r.entry.afterBytes}b   gate v${r.entry.gateBefore ?? '—'} → v${r.entry.gateAfter ?? '—'}   tagMatches=${r.entry.tagMatchesBridge}`);
    for (const reason of r.reasons) log(`   ⚠️  ${reason}`);
    log('');
  }

  if (run.skipped.length) {
    log(`── SKIPPED (${run.skipped.length}) — examined, nothing to prove:`);
    for (const s of run.skipped) log(`   ·  ${s.name} [${s.simulationId}] ${s.storagePrefix} — ${s.reason}`);
    log('');
  }
  if (run.unreadable.length) {
    err(`── UNREADABLE (${run.unreadable.length}) — neither storage nor /sim-public returned the bytes:`);
    for (const u of run.unreadable) err(`   ❌ ${u.name} [${u.simulationId}] ${u.role} ${u.key} — ${u.reason}`);
    err('');
  }
  if (run.failed.length) {
    err(`── ERRORED (${run.failed.length}) — the transform threw:`);
    for (const f of run.failed) err(`   ❌ ${f.name} [${f.simulationId}] — ${f.reason}`);
    err('');
  }

  log(
    `Accounting: ${gate.discovered} discovered = ${gate.checked} checked ` +
    `(${gate.proven} PROVEN, ${run.results.length - gate.proven} failed) ` +
    `+ ${gate.skipped} skipped + ${gate.unreadable} unreadable + ${run.failed.length} errored.`,
  );
  log(`Inventory says ${gate.expectedRebuildable} package(s) are rebuildable; ${gate.expectedRebuildable - gate.notProven.length} of them are proven.`);

  if (!gate.ok) {
    err(`\n❌ PROOF FAILED — ${gate.problems.length} problem(s):`);
    for (const p of gate.problems) err(`     ${p}`);
    err('\nDo NOT run rebuild --apply.');
  } else {
    log(`\n✅ ${gate.proven}/${gate.expectedRebuildable} rebuildable package(s) PROVEN safe to rebuild.`);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const jsonIdx = process.argv.indexOf('--json');
  const dumpIdx = process.argv.indexOf('--dump-dir');
  const dumpDir = dumpIdx !== -1 ? process.argv[dumpIdx + 1] : undefined;

  const { db } = await import('../db/index.js');
  const { getStorageAdapter } = await import('../services/storage/getStorageAdapter.js');
  const {
    deriveEntryRelPath, parseSectionEntries, wrapBridgeCombined,
    computeBridgeHash, injectBridgeScriptTag, injectRafGate,
  } = await import('../services/simulation/SimulationService.js');

  const storage = getStorageAdapter();
  const rows = (await db.query.simulations.findMany()) as unknown as ProveSimRow[];

  const run = await proveAll({
    rows,
    storage,
    transforms: {
      deriveEntryRelPath, parseSectionEntries, wrapBridgeCombined,
      computeBridgeHash, injectBridgeScriptTag, injectRafGate,
    },
    writeDump: dumpDir
      ? (relPath, contents) => {
        const abs = join(dumpDir, relPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents, 'utf-8');
      }
      : undefined,
  });

  // Cross-check against the independent inventory: the proof must have examined every package the
  // inventory considers rebuildable, or it is not a proof of the rollout — only of a subset of it.
  let expected: ExpectedRebuildable[] | null = null;
  let inventoryProblem: string | null = null;
  try {
    const { buildInventory } = await import('./inventory-sim-packages.js');
    expected = expectedRebuildableFromInventory(await buildInventory());
  } catch (e) {
    inventoryProblem = (e as Error).message.slice(0, 160);
  }

  const gate = gateProofRun(run, expected, inventoryProblem);
  reportProofRun(run, gate, (l) => console.log(l), (l) => console.error(l));

  if (dumpDir) console.log(`Rebuilt copies written to ${dumpDir} (for browser validation).`);
  if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
    writeFileSync(
      process.argv[jsonIdx + 1],
      JSON.stringify({ at: new Date().toISOString(), gate, ...run }, null, 2) + '\n',
    );
    console.log(`JSON written to ${process.argv[jsonIdx + 1]}`);
  }
  return gate.ok ? 0 : 1;
}

/** process.exit() drops buffered stdout/stderr when they are pipes — which is exactly how a
 *  rollout runs this (`… | tee rollout.log`). Drain both before exiting, so the diagnostic that
 *  explains a non-zero exit is never the thing that gets truncated. */
async function exitFlushed(code: number): Promise<never> {
  await Promise.all([
    new Promise<void>((r) => { process.stdout.write('', () => r()); }),
    new Promise<void>((r) => { process.stderr.write('', () => r()); }),
  ]);
  process.exit(code);
}

if (process.argv[1] && process.argv[1].includes('prove-sim-rebuild')) {
  main()
    .then((code) => exitFlushed(code))
    .catch(async (e) => { console.error(e); await exitFlushed(1); });
}
