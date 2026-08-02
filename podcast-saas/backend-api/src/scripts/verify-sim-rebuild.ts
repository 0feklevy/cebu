/**
 * POST-APPLY VERIFICATION for the combined-bridge rebuild — the inverse of prove-sim-rebuild.ts.
 *
 * prove-sim-rebuild.ts is the PRE-apply gate: it fails a package that would gain no capability,
 * because rebuilding an already-hardened package is a pointless write. Re-running it AFTER the
 * rollout therefore turns a SUCCESSFUL rollout into a red run — every package now gains nothing.
 * This script answers the post-apply question instead, where "already hardened" is the SUCCESS
 * condition:
 *
 *   1. STORED bytes — every rebuildable package's bridge.js now carries the hardened protocol
 *      (SCRIPT_APPLIED / SCRIPT_MISSING / SCRIPT_ERROR / pauseScript / simDemoTimer / _sysRaf).
 *   2. SERVED bytes — the entry HTML and bridge.js fetched through the REAL serving path
 *      (storage.getSimPublicUrl → /sim-public/* or the public bucket URL) are byte-identical to
 *      what is stored. prove-sim-rebuild only ever read storage.readObject; a proxy or CDN holding
 *      a stale copy is invisible to that check and completely visible to users.
 *   3. SERVED consistency — the served entry's `bridge.js?v=<hash>` tag matches the hash of the
 *      SERVED bridge bytes. A stale cached bridge behind a fresh entry (or the reverse) is the
 *      exact failure that makes a "successful" rollout render the old protocol in the browser.
 *
 * Reads only. Writes nothing to storage or the database.
 *
 *   tsx --env-file=../.env src/scripts/verify-sim-rebuild.ts [--json <out.json>]
 *
 * EXIT CODES:
 *   0  every rebuildable package is hardened in storage AND served consistently.
 *   1  any mismatch, any unreadable/unfetchable package, or ZERO packages verified — an empty
 *      verification is not a verification, exactly as with the pre-apply proof.
 *
 * Everything above main() is dependency-injected, so it is unit-tested without a database, storage
 * adapter or network; db/storage/SimulationService load lazily INSIDE main().
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { PackageInventory } from './inventory-sim-packages.js';

export type Log = (line: string) => void;

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** The capabilities the rollout exists to add. All must be present AFTER --apply. */
export const HARDENED_CAPABILITIES: { key: string; needle: string }[] = [
  { key: 'ackCapable', needle: 'SCRIPT_APPLIED' },
  { key: 'scriptMissing', needle: 'SCRIPT_MISSING' },
  { key: 'scriptError', needle: 'SCRIPT_ERROR' },
  { key: 'pauseScript', needle: 'pauseScript' },
  { key: 'demoTimer', needle: 'simDemoTimer' },
  { key: 'sysRaf', needle: '_sysRaf' },
];

// ── Injected ports ────────────────────────────────────────────────────────────

export interface VerifyStorage {
  readObject(key: string): Promise<Buffer>;
  /** The REAL serving path a browser hits. */
  getSimPublicUrl(key: string): string;
}

export interface VerifyTransforms {
  parseSectionEntries(bridgeJs: string): Map<string, string>;
  computeBridgeHash(code: string): string;
}

export type FetchBytes = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** One package in scope: exactly the set rebuild-sim-bridges.ts can have rewritten. */
export interface VerifyPackage {
  simulationId: string;
  name: string;
  storagePrefix: string;
  entryKey: string;
  bridgeKey: string;
}

/** The minimum of inventory-sim-packages.ts's PackageInventory this script consumes. */
export interface VerifyInventoryLike {
  simulationId: string;
  name: string;
  storagePrefix: string;
  entryKey: string;
  bridgeKey: string;
  bridge: { combined: boolean };
  files: { entry: { present: boolean } };
}

/** Compile-time guard: the real inventory shape must stay assignable to what we consume. */
export type InventoryShapeGuard = PackageInventory extends VerifyInventoryLike ? true : never;

/**
 * Scope the verification to what the rebuild could actually have touched — the same definition
 * prove-sim-rebuild cross-checks against (combined bridge + readable entry). Anything else was
 * never part of the rollout and must not be able to redden a good run, nor hide a bad one: a
 * package that drops OUT of this set after the apply shows up as "0 verified" or as a shrunken
 * count, both of which fail the gate.
 */
export function verifyTargetsFromInventory(inv: VerifyInventoryLike[]): VerifyPackage[] {
  return inv
    .filter((p) => p.bridge.combined && p.files.entry.present)
    .map((p) => ({
      simulationId: p.simulationId,
      name: p.name,
      storagePrefix: p.storagePrefix,
      entryKey: p.entryKey,
      bridgeKey: p.bridgeKey,
    }));
}

// ── Result shapes ─────────────────────────────────────────────────────────────

export interface FileCheck {
  key: string;
  storedBytes: number | null;
  storedSha: string | null;
  servedUrl: string;
  servedBytes: number | null;
  servedSha: string | null;
  /** null when either side could not be read. */
  servedMatchesStored: boolean | null;
  problem: string | null;
}

export interface PackageVerification {
  simulationId: string;
  name: string;
  storagePrefix: string;
  bridge: FileCheck;
  entry: FileCheck;
  /** Capability → present in the STORED bridge bytes. */
  hardened: Record<string, boolean>;
  missingCapabilities: string[];
  sectionCount: number;
  /** `bridge.js?v=` hash found in the SERVED entry HTML. */
  servedEntryTagHash: string | null;
  /** computeBridgeHash of the SERVED bridge bytes. */
  servedBridgeHash: string | null;
  servedTagMatchesServedBridge: boolean;
  /** `bridge.js?v=` hash in the STORED entry vs the STORED bridge — catches a half-applied package. */
  storedTagMatchesStoredBridge: boolean;
  ok: boolean;
  problems: string[];
}

export interface VerifyRun {
  inScope: number;
  packages: PackageVerification[];
}

export interface VerifyGate {
  ok: boolean;
  inScope: number;
  verified: number;
  failed: number;
  problems: string[];
}

const TAG_RE = /bridge\.js\?v=([a-z0-9]+)/i;

async function checkFile(
  storage: VerifyStorage,
  fetchBytes: FetchBytes,
  key: string,
): Promise<{ check: FileCheck; stored: Buffer | null; served: Buffer | null }> {
  const servedUrl = storage.getSimPublicUrl(key);
  const check: FileCheck = {
    key, storedBytes: null, storedSha: null, servedUrl,
    servedBytes: null, servedSha: null, servedMatchesStored: null, problem: null,
  };

  let stored: Buffer | null = null;
  try {
    stored = await storage.readObject(key);
    check.storedBytes = stored.length;
    check.storedSha = sha256(stored);
  } catch (e) {
    check.problem = `STORED bytes unreadable — ${(e as Error).message.slice(0, 120)}`;
    return { check, stored: null, served: null };
  }

  let served: Buffer | null = null;
  try {
    const res = await fetchBytes(servedUrl);
    if (!res.ok) {
      check.problem = `SERVED path returned http ${res.status} for ${servedUrl}`;
      return { check, stored, served: null };
    }
    served = Buffer.from(await res.arrayBuffer());
    check.servedBytes = served.length;
    check.servedSha = sha256(served);
  } catch (e) {
    check.problem = `SERVED path unreachable (${servedUrl}) — ${(e as Error).message.slice(0, 120)}`;
    return { check, stored, served: null };
  }

  check.servedMatchesStored = check.servedSha === check.storedSha;
  if (!check.servedMatchesStored) {
    check.problem =
      `SERVED bytes differ from STORED bytes — stored ${check.storedBytes}b sha:${check.storedSha!.slice(0, 16)}…, ` +
      `served ${check.servedBytes}b sha:${check.servedSha!.slice(0, 16)}… (stale proxy/CDN copy, or the upload never landed)`;
  }
  return { check, stored, served };
}

export interface VerifyOptions {
  packages: VerifyPackage[];
  storage: VerifyStorage;
  transforms: VerifyTransforms;
  fetchBytes?: FetchBytes;
}

/** Read stored + served bytes for every in-scope package and check all three properties. */
export async function verifyPackages(o: VerifyOptions): Promise<VerifyRun> {
  const fetchBytes: FetchBytes = o.fetchBytes ?? ((url: string) => fetch(url));
  const run: VerifyRun = { inScope: o.packages.length, packages: [] };

  for (const pkg of o.packages) {
    const problems: string[] = [];
    const bridgeRes = await checkFile(o.storage, fetchBytes, pkg.bridgeKey);
    const entryRes = await checkFile(o.storage, fetchBytes, pkg.entryKey);
    if (bridgeRes.check.problem) problems.push(`bridge.js: ${bridgeRes.check.problem}`);
    if (entryRes.check.problem) problems.push(`entry HTML: ${entryRes.check.problem}`);

    const storedBridgeJs = bridgeRes.stored?.toString('utf-8') ?? '';
    const storedEntryHtml = entryRes.stored?.toString('utf-8') ?? '';
    const servedBridgeJs = bridgeRes.served?.toString('utf-8') ?? null;
    const servedEntryHtml = entryRes.served?.toString('utf-8') ?? null;

    // 1. STORED bytes must be hardened. "Already hardened" is the SUCCESS condition here.
    const hardened = Object.fromEntries(
      HARDENED_CAPABILITIES.map((c) => [c.key, storedBridgeJs.includes(c.needle)]),
    );
    const missingCapabilities = HARDENED_CAPABILITIES.filter((c) => !hardened[c.key]).map((c) => c.key);
    if (bridgeRes.stored && missingCapabilities.length) {
      problems.push(`STORED bridge is NOT hardened — missing: ${missingCapabilities.join(', ')} (the rebuild did not land on this package)`);
    }

    let sectionCount = 0;
    if (bridgeRes.stored) {
      try { sectionCount = o.transforms.parseSectionEntries(storedBridgeJs).size; }
      catch (e) { problems.push(`STORED bridge no longer parses into section bodies — ${(e as Error).message.slice(0, 120)}`); }
      if (sectionCount === 0) problems.push('STORED bridge parses to ZERO section bodies — the rebuild destroyed the section map');
    }

    // 2. Stored self-consistency: entry tag vs stored bridge (catches bridge written, entry not).
    const storedTag = TAG_RE.exec(storedEntryHtml)?.[1] ?? null;
    const storedBridgeHash = bridgeRes.stored ? o.transforms.computeBridgeHash(storedBridgeJs) : null;
    const storedTagMatchesStoredBridge = !!storedTag && !!storedBridgeHash && storedBridgeHash.startsWith(storedTag);
    if (bridgeRes.stored && entryRes.stored && !storedTagMatchesStoredBridge) {
      problems.push(
        `STORED entry references bridge.js?v=${storedTag ?? '(no tag)'} but the STORED bridge hashes to ` +
        `${storedBridgeHash ?? '—'} — the package is half-applied (bridge and entry are from different generations)`,
      );
    }

    // 3. SERVED consistency: the tag users receive must describe the bridge users receive.
    const servedEntryTagHash = servedEntryHtml === null ? null : (TAG_RE.exec(servedEntryHtml)?.[1] ?? null);
    const servedBridgeHash = servedBridgeJs === null ? null : o.transforms.computeBridgeHash(servedBridgeJs);
    const servedTagMatchesServedBridge =
      !!servedEntryTagHash && !!servedBridgeHash && servedBridgeHash.startsWith(servedEntryTagHash);
    if (servedEntryHtml !== null && servedBridgeJs !== null && !servedTagMatchesServedBridge) {
      problems.push(
        `SERVED entry asks for bridge.js?v=${servedEntryTagHash ?? '(no tag)'} but the SERVED bridge hashes to ` +
        `${servedBridgeHash ?? '—'} — a stale bridge is being served behind a fresh entry (proxy/CDN cache)`,
      );
    }

    run.packages.push({
      simulationId: pkg.simulationId,
      name: pkg.name,
      storagePrefix: pkg.storagePrefix,
      bridge: bridgeRes.check,
      entry: entryRes.check,
      hardened,
      missingCapabilities,
      sectionCount,
      servedEntryTagHash,
      servedBridgeHash,
      servedTagMatchesServedBridge,
      storedTagMatchesStoredBridge,
      ok: problems.length === 0,
      problems,
    });
  }
  return run;
}

/** Exit-code decision. Zero verified packages is a FAILURE, never a quiet green. */
export function gateVerifyRun(run: VerifyRun): VerifyGate {
  const problems: string[] = [];
  const verified = run.packages.filter((p) => p.ok);
  for (const p of run.packages.filter((x) => !x.ok)) {
    for (const problem of p.problems) problems.push(`${p.name} [${p.simulationId}] — ${problem}`);
  }
  if (verified.length === 0) {
    problems.push(
      `VERIFIED NOTHING: 0 of ${run.inScope} in-scope package(s) verified. Either the inventory found no ` +
      'rebuildable package (credentials / bucket / status filter) or every one of them failed. ' +
      'Treat the rollout as UNVERIFIED and consider rolling back.',
    );
  }
  return {
    ok: problems.length === 0,
    inScope: run.inScope,
    verified: verified.length,
    failed: run.packages.length - verified.length,
    problems,
  };
}

export function reportVerifyRun(run: VerifyRun, gate: VerifyGate, log: Log, err: Log): void {
  log(`\n=== Stored-bridge rollout verification (POST-APPLY) — ${run.inScope} rebuildable package(s) in scope ===\n`);
  for (const p of run.packages) {
    log(`${p.ok ? '✅' : '❌'} ${p.name}   (${p.simulationId})`);
    log(`   bridge stored ${p.bridge.storedBytes ?? '—'}b sha:${p.bridge.storedSha?.slice(0, 16) ?? '—'}` +
      `   served ${p.bridge.servedBytes ?? '—'}b sha:${p.bridge.servedSha?.slice(0, 16) ?? '—'}   match=${p.bridge.servedMatchesStored ?? '—'}`);
    log(`   entry  stored ${p.entry.storedBytes ?? '—'}b sha:${p.entry.storedSha?.slice(0, 16) ?? '—'}` +
      `   served ${p.entry.servedBytes ?? '—'}b sha:${p.entry.servedSha?.slice(0, 16) ?? '—'}   match=${p.entry.servedMatchesStored ?? '—'}`);
    log(`   served via: ${p.bridge.servedUrl}`);
    log(`   hardened: ${HARDENED_CAPABILITIES.map((c) => `${c.key}=${p.hardened[c.key]}`).join(' ')}`);
    log(`   sections: ${p.sectionCount}   servedTag=${p.servedEntryTagHash ?? '—'} servedBridgeHash=${p.servedBridgeHash ?? '—'} match=${p.servedTagMatchesServedBridge}`);
    for (const problem of p.problems) err(`   ⚠️  ${problem}`);
    log('');
  }
  log(`Accounting: ${gate.inScope} in scope, ${gate.verified} VERIFIED, ${gate.failed} failed.`);
  if (!gate.ok) {
    err(`\n❌ VERIFICATION FAILED — ${gate.problems.length} problem(s):`);
    for (const p of gate.problems) err(`     ${p}`);
    err('\nThe rollout is NOT confirmed. See §6 of md-files/SIM-REBUILD-ROLLOUT.md for the rollback.');
  } else {
    log(`\n✅ ${gate.verified}/${gate.inScope} package(s) hardened in storage and served consistently.`);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const jsonIdx = process.argv.indexOf('--json');

  const { getStorageAdapter } = await import('../services/storage/getStorageAdapter.js');
  const { parseSectionEntries, computeBridgeHash } = await import('../services/simulation/SimulationService.js');
  const { buildInventory } = await import('./inventory-sim-packages.js');

  const storage = getStorageAdapter();
  const packages = verifyTargetsFromInventory(await buildInventory());

  const run = await verifyPackages({
    packages,
    storage,
    transforms: { parseSectionEntries, computeBridgeHash },
  });
  const gate = gateVerifyRun(run);
  reportVerifyRun(run, gate, (l) => console.log(l), (l) => console.error(l));

  if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
    writeFileSync(
      process.argv[jsonIdx + 1],
      JSON.stringify({ at: new Date().toISOString(), gate, ...run }, null, 2) + '\n',
    );
    console.log(`JSON written to ${process.argv[jsonIdx + 1]}`);
  }
  return gate.ok ? 0 : 1;
}

/** process.exit() drops buffered stdout/stderr when they are pipes (`… | tee rollout.log`). */
async function exitFlushed(code: number): Promise<never> {
  await Promise.all([
    new Promise<void>((r) => { process.stdout.write('', () => r()); }),
    new Promise<void>((r) => { process.stderr.write('', () => r()); }),
  ]);
  process.exit(code);
}

if (process.argv[1] && process.argv[1].includes('verify-sim-rebuild')) {
  main()
    .then((code) => exitFlushed(code))
    .catch(async (e) => { console.error(e); await exitFlushed(1); });
}
