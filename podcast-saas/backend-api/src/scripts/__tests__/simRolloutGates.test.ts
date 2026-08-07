/**
 * Adversarial tests for the three GATES of the simulation rollout tooling — the checks that decide
 * whether a rollout is allowed to proceed, is confirmed, or can be undone:
 *
 *   prove-sim-rebuild.ts    — the PRE-apply proof (may never exit 0 having proved nothing)
 *   verify-sim-rebuild.ts   — the POST-apply verification (stored + served bytes agree)
 *   classify-orphan-sim-rows.ts — --apply may never lose a rollback record
 *
 * Everything runs against in-memory fakes: no database, no storage adapter, no network, no disk.
 * The scripts guard their main() behind a direct-invocation check and import db/storage/
 * SimulationService lazily, so importing them here executes nothing and opens no client.
 *
 * The properties under test:
 *   1  a proof that examined nothing exits NON-ZERO (the "expired credentials" failure)
 *   2  every discovered package lands in exactly one reported bucket
 *   3  a package the inventory calls rebuildable can never be silently skipped or unreadable
 *   4  the proof reads through the public serving path when storage.readObject fails
 *   5  post-apply, "already hardened" is SUCCESS — the inverse of the pre-apply proof
 *   6  served bytes that differ from stored bytes fail, and so does a stale served bridge
 *   7  a verification that verified nothing exits NON-ZERO
 *   8  --apply commits a durable rollback record BEFORE the first UPDATE
 *   9  a failure mid-apply leaves every modified row recoverable from that record
 *  10  a partially applied or rolled-back run exits NON-ZERO
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import {
  expectedRebuildableFromInventory,
  gateProofRun,
  proveAll,
  readWithFallback,
  reportProofRun,
  type FetchLike,
  type InventoryLike,
  type ProveSimRow,
  type ProveStorage,
  type SimTransforms,
} from '../prove-sim-rebuild.js';

import {
  gateVerifyRun,
  reportVerifyRun,
  verifyPackages,
  verifyTargetsFromInventory,
  type FetchBytes,
  type VerifyInventoryLike,
  type VerifyPackage,
  type VerifyStorage,
  type VerifyTransforms,
} from '../verify-sim-rebuild.js';

import {
  applyRepairs,
  buildRepairPlan,
  classifyOrphanRow,
  gateClassification,
  hasSectionKey,
  recoverableRowsFromManifest,
  renderManifestHeader,
  verifyManifestOnDisk,
  type ApplyOutcome,
  type ManifestFs,
  type OrphanRow,
  type PackageFacts,
  type RepairPlanItem,
  type UpdateFn,
} from '../classify-orphan-sim-rows.js';

// ── Shared fakes ──────────────────────────────────────────────────────────────

const PREFIX = 'simulations/proj-1/sim-a';
const ENTRY_KEY = `${PREFIX}/index.html`;
const BRIDGE_KEY = `${PREFIX}/bridge.js`;

const shortSha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Everything the hardened bridge template must contain (both scripts look for these needles). */
const HARDENED_PREAMBLE = [
  '/* sim-bridge v2 */',
  'function ack(){ post("SCRIPT_APPLIED"); }',
  'function miss(){ post("SCRIPT_MISSING"); }',
  'function boom(){ post("SCRIPT_ERROR"); }',
  'function pauseScript(){}',
  'var simDemoTimer = null;',
  'if (Object.prototype.hasOwnProperty.call(S, id)) {}',
  'var _sysRaf = window.requestAnimationFrame;',
  '',
].join('\n');

const LEGACY_BRIDGE = `/* legacy bridge */\n@@SEC:main@@\nconsole.log("boids");\n@@/SEC@@\n`;
const RAW_ENTRY = '<html><body><canvas id="c"></canvas></body></html>';

/** Minimal but faithful stand-ins for the SimulationService transforms. */
function fakeTransforms(over: Partial<SimTransforms> = {}): SimTransforms {
  const parse = (js: string): Map<string, string> => {
    const out = new Map<string, string>();
    const re = /@@SEC:([A-Za-z0-9_-]+)@@([\s\S]*?)@@\/SEC@@/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(js)) !== null) out.set(m[1], m[2]);
    return out;
  };
  const wrap = (entries: Map<string, string>): string =>
    HARDENED_PREAMBLE + [...entries.entries()].map(([id, body]) => `@@SEC:${id}@@${body}@@/SEC@@`).join('\n');
  return {
    deriveEntryRelPath: (entryFile, prefix) =>
      entryFile && entryFile.startsWith(`${prefix}/`) ? entryFile.slice(prefix.length + 1) : null,
    parseSectionEntries: parse,
    wrapBridgeCombined: wrap,
    computeBridgeHash: shortSha,
    injectRafGate: (html) => (html.includes('sim-raf-gate v4') ? html : `${html}<!-- sim-raf-gate v4 -->`),
    injectBridgeScriptTag: (html, rel, hash) =>
      html.replace(/<script src="[^"]*bridge\.js\?v=[a-z0-9]+"><\/script>/i, '') +
      `<script src="${rel}?v=${hash}"></script>`,
    ...over,
  };
}

const T = fakeTransforms();
/** The bytes a successful rebuild would leave in storage for the fixture package. */
const HARDENED_BRIDGE = T.wrapBridgeCombined(T.parseSectionEntries(LEGACY_BRIDGE));
const HARDENED_ENTRY = T.injectBridgeScriptTag(T.injectRafGate(RAW_ENTRY), './bridge.js', shortSha(HARDENED_BRIDGE));

interface MemObjects {
  objects: Map<string, string>;
  unreadable: Set<string>;
  /** Keys the public serving path also refuses (a wrong bucket / expired credentials). */
  unservable: Set<string>;
  /** Bytes the serving path returns INSTEAD of the stored ones (stale proxy/CDN copy). */
  servedOverride: Map<string, string>;
}

function memObjects(seed: Record<string, string> = {}): MemObjects {
  return {
    objects: new Map(Object.entries(seed)),
    unreadable: new Set(),
    unservable: new Set(),
    servedOverride: new Map(),
  };
}

function proveStorage(m: MemObjects): ProveStorage {
  return {
    async readObject(key) {
      if (m.unreadable.has(key)) throw new Error(`403 Forbidden: ${key}`);
      const v = m.objects.get(key);
      if (v === undefined) throw new Error(`404 Not Found: ${key}`);
      return Buffer.from(v, 'utf-8');
    },
    getSimPublicUrl: (key) => `https://api.example.test/sim-public/${key}`,
  };
}

const keyFromUrl = (url: string): string => url.replace('https://api.example.test/sim-public/', '');

function proveFetch(m: MemObjects): FetchLike {
  return async (url) => {
    const key = keyFromUrl(url);
    if (m.unservable.has(key)) return { ok: false, status: 403, text: async () => '' };
    const body = m.servedOverride.get(key) ?? m.objects.get(key);
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
}

function collector(): { log: (l: string) => void; lines: string[]; text: () => string } {
  const lines: string[] = [];
  return { lines, log: (l) => lines.push(l), text: () => lines.join('\n') };
}

const ROW: ProveSimRow = { id: 'sim-a', name: 'Boids 3D', storage_prefix: PREFIX, entry_file: ENTRY_KEY };
const INV_A: InventoryLike = {
  simulationId: 'sim-a', name: 'Boids 3D', storagePrefix: PREFIX,
  bridge: { combined: true }, files: { entry: { present: true } },
};

const liveObjects = (): MemObjects => memObjects({ [BRIDGE_KEY]: LEGACY_BRIDGE, [ENTRY_KEY]: RAW_ENTRY });

async function prove(m: MemObjects, rows: ProveSimRow[] = [ROW], transforms: SimTransforms = T) {
  return proveAll({ rows, storage: proveStorage(m), transforms, fetchImpl: proveFetch(m) });
}

// ══════════════════════════════════════════════════════════════════════════════
// prove-sim-rebuild — the PRE-apply proof
// ══════════════════════════════════════════════════════════════════════════════

describe('proveAll — property 2: every discovered package lands in exactly one bucket', () => {
  it('proves a legacy package and records where each file was read from', async () => {
    const run = await prove(liveObjects());
    expect(run.discovered).toBe(1);
    expect(run.results).toHaveLength(1);
    expect(run.results[0].ok).toBe(true);
    expect(run.results[0].sources).toEqual({ bridge: 'storage', entry: 'storage' });
    expect(run.results[0].gained).toContain('ackCapable');
    expect(run.skipped.concat()).toHaveLength(0);
    expect(run.unreadable).toHaveLength(0);
    expect(run.failed).toHaveLength(0);
  });

  it('buckets a package with no derivable entry as SKIPPED, with the reason', async () => {
    const run = await prove(liveObjects(), [{ ...ROW, entry_file: null }]);
    expect(run.results).toHaveLength(0);
    expect(run.skipped).toHaveLength(1);
    expect(run.skipped[0].reason).toMatch(/cannot derive entry file/);
  });

  it('buckets a legacy pre-combined bridge as SKIPPED, not as an invisible drop', async () => {
    const m = memObjects({ [BRIDGE_KEY]: '/* no markers here */', [ENTRY_KEY]: RAW_ENTRY });
    const run = await prove(m);
    expect(run.results).toHaveLength(0);
    expect(run.skipped[0].reason).toMatch(/no @@SIM_BRIDGE markers/);
  });

  it('buckets a thrown transform as FAILED — never as a skip', async () => {
    const boom = fakeTransforms({
      wrapBridgeCombined: () => { throw new Error('Unsafe sectionId: "../etc"'); },
    });
    const run = await prove(liveObjects(), [ROW], boom);
    expect(run.results).toHaveLength(0);
    expect(run.failed).toHaveLength(1);
    expect(run.failed[0].reason).toMatch(/Unsafe sectionId/);
  });

  it('reports every category in the accounting line', async () => {
    const m = memObjects({ [BRIDGE_KEY]: LEGACY_BRIDGE, [ENTRY_KEY]: RAW_ENTRY, 'p2/bridge.js': '/* nope */', 'p2/index.html': RAW_ENTRY });
    m.unreadable.add('p3/bridge.js'); m.unservable.add('p3/bridge.js');
    const run = await prove(m, [
      ROW,
      { id: 'sim-b', name: 'B', storage_prefix: 'p2', entry_file: 'p2/index.html' },
      { id: 'sim-c', name: 'C', storage_prefix: 'p3', entry_file: 'p3/index.html' },
      { id: 'sim-d', name: 'D', storage_prefix: 'p4', entry_file: null },
    ]);
    const gate = gateProofRun(run, [INV_A]);
    const out = collector();
    reportProofRun(run, gate, out.log, out.log);
    expect(out.text()).toMatch(/4 discovered = 1 checked \(1 PROVEN, 0 failed\) \+ 2 skipped \+ 1 unreadable \+ 0 errored/);
    // property 2 — discovered is fully partitioned
    expect(run.results.length + run.skipped.length + run.unreadable.length + run.failed.length).toBe(run.discovered);
  });
});

describe('proveAll — property 4: the public-URL read fallback the other two tools already had', () => {
  it('falls back to /sim-public when storage.readObject throws, and still proves the package', async () => {
    const m = liveObjects();
    m.unreadable.add(BRIDGE_KEY);
    m.unreadable.add(ENTRY_KEY);
    const run = await prove(m);
    expect(run.results).toHaveLength(1);
    expect(run.results[0].ok).toBe(true);
    expect(run.results[0].sources).toEqual({ bridge: 'sim-public', entry: 'sim-public' });
    expect(run.unreadable).toHaveLength(0);
  });

  it('records BOTH failure reasons when neither path returns the bytes', async () => {
    const m = liveObjects();
    m.unreadable.add(BRIDGE_KEY);
    m.unservable.add(BRIDGE_KEY);
    const run = await prove(m);
    expect(run.unreadable).toHaveLength(1);
    expect(run.unreadable[0].role).toBe('bridge');
    expect(run.unreadable[0].reason).toMatch(/storage: 403 Forbidden/);
    expect(run.unreadable[0].reason).toMatch(/sim-public: http 403/);
  });

  it('readWithFallback surfaces a thrown fetch rather than swallowing it into a skip', async () => {
    const storage: ProveStorage = {
      readObject: async () => { throw new Error('credentials expired'); },
      getSimPublicUrl: (k) => `https://x.invalid/${k}`,
    };
    const r = await readWithFallback(storage, BRIDGE_KEY, async () => { throw new Error('ECONNREFUSED'); });
    expect(r.text).toBeNull();
    expect(r.source).toMatch(/credentials expired/);
    expect(r.source).toMatch(/ECONNREFUSED/);
  });
});

describe('gateProofRun — property 1: a proof that examined nothing can NEVER exit 0', () => {
  it('fails on an EMPTY result set (no rows at all)', async () => {
    const run = await prove(memObjects(), []);
    const gate = gateProofRun(run, []);
    expect(gate.ok).toBe(false);
    expect(gate.proven).toBe(0);
    expect(gate.problems.join()).toMatch(/PROVED NOTHING/);
    expect(gate.problems.join()).toMatch(/do NOT run rebuild --apply/i);
  });

  it('fails on a WRONG BUCKET / expired credentials run where every key is unreadable', async () => {
    const m = liveObjects();
    for (const k of [BRIDGE_KEY, ENTRY_KEY]) { m.unreadable.add(k); m.unservable.add(k); }
    const run = await prove(m);
    const gate = gateProofRun(run, [INV_A]);
    expect(run.results).toHaveLength(0);
    expect(gate.ok).toBe(false);
    expect(gate.unreadable).toBe(1);
    expect(gate.problems.join()).toMatch(/PROVED NOTHING/);
    // property 3 — the inventory-rebuildable package is named as not proven
    expect(gate.notProven).toEqual([{ simulationId: 'sim-a', name: 'Boids 3D', disposition: expect.stringMatching(/UNREADABLE/) }]);
  });

  it('fails a PARTIAL run: one package proven, one inventory-rebuildable package unreadable', async () => {
    const m = memObjects({
      [BRIDGE_KEY]: LEGACY_BRIDGE, [ENTRY_KEY]: RAW_ENTRY,
      'p2/bridge.js': LEGACY_BRIDGE, 'p2/index.html': RAW_ENTRY,
    });
    m.unreadable.add('p2/bridge.js'); m.unservable.add('p2/bridge.js');
    const rowB: ProveSimRow = { id: 'sim-b', name: 'Murmuration', storage_prefix: 'p2', entry_file: 'p2/index.html' };
    const invB: InventoryLike = { simulationId: 'sim-b', name: 'Murmuration', storagePrefix: 'p2', bridge: { combined: true }, files: { entry: { present: true } } };

    const run = await prove(m, [ROW, rowB]);
    const gate = gateProofRun(run, [INV_A, invB]);
    expect(gate.proven).toBe(1);
    expect(gate.ok).toBe(false);
    expect(gate.problems.join()).toMatch(/Murmuration.*REBUILDABLE but it was not proven/);
    // …and the same run is clean when the inventory agrees only sim-a is rebuildable
    expect(gateProofRun(run, [INV_A]).ok).toBe(true);
  });

  it('property 3: fails when an inventory-rebuildable package was merely SKIPPED', async () => {
    const run = await prove(liveObjects(), [{ ...ROW, entry_file: null }]);
    const gate = gateProofRun(run, [INV_A]);
    expect(gate.ok).toBe(false);
    expect(gate.notProven[0].disposition).toMatch(/SKIPPED: cannot derive entry file/);
  });

  it('fails when the inventory sees NO rebuildable package but the proof proved some', async () => {
    const run = await prove(liveObjects());
    const gate = gateProofRun(run, []);
    expect(gate.proven).toBe(1);
    expect(gate.ok).toBe(false);
    expect(gate.problems.join()).toMatch(/inventory found ZERO rebuildable packages but the proof proved 1/);
  });

  it('fails when the inventory cross-check itself could not be built', async () => {
    const run = await prove(liveObjects());
    const gate = gateProofRun(run, null, 'getaddrinfo ENOTFOUND db.supabase.co');
    expect(gate.proven).toBe(1);
    expect(gate.ok).toBe(false);
    expect(gate.problems.join()).toMatch(/inventory cross-check unavailable/);
  });

  it('passes only when every expected-rebuildable package is proven', async () => {
    const run = await prove(liveObjects());
    const gate = gateProofRun(run, [INV_A]);
    expect(gate).toMatchObject({ ok: true, discovered: 1, checked: 1, proven: 1, failed: 0, skipped: 0, unreadable: 0, expectedRebuildable: 1 });
  });

  it('still fails a package whose bodies would change, exactly as before', async () => {
    const lossy = fakeTransforms({
      wrapBridgeCombined: (entries) =>
        HARDENED_PREAMBLE + [...entries.entries()].map(([id, b]) => `@@SEC:${id}@@${b.toUpperCase()}@@/SEC@@`).join('\n'),
    });
    const run = await prove(liveObjects(), [ROW], lossy);
    expect(run.results[0].ok).toBe(false);
    expect(gateProofRun(run, [INV_A]).ok).toBe(false);
  });
});

describe('prove vs verify — the pre-apply proof stays strict about "no capability gained"', () => {
  it('fails an ALREADY-HARDENED package and points the operator at verify-sim-rebuild', async () => {
    const m = memObjects({ [BRIDGE_KEY]: HARDENED_BRIDGE, [ENTRY_KEY]: HARDENED_ENTRY });
    const run = await prove(m);
    expect(run.results[0].ok).toBe(false);
    expect(run.results[0].reasons.join()).toMatch(/no capability gained/);
    expect(run.results[0].reasons.join()).toMatch(/verify-sim-rebuild/);
    expect(gateProofRun(run, [INV_A]).ok).toBe(false);
  });
});

describe('expectedRebuildableFromInventory', () => {
  it('is exactly "combined bridge + readable entry"', () => {
    const inv: InventoryLike[] = [
      INV_A,
      { simulationId: 'b', name: 'no bridge', storagePrefix: 'p2', bridge: { combined: false }, files: { entry: { present: true } } },
      { simulationId: 'c', name: 'no entry', storagePrefix: 'p3', bridge: { combined: true }, files: { entry: { present: false } } },
    ];
    expect(expectedRebuildableFromInventory(inv).map((e) => e.simulationId)).toEqual(['sim-a']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// verify-sim-rebuild — the POST-apply verification
// ══════════════════════════════════════════════════════════════════════════════

const VT: VerifyTransforms = { parseSectionEntries: T.parseSectionEntries, computeBridgeHash: shortSha };
const VPKG: VerifyPackage = { simulationId: 'sim-a', name: 'Boids 3D', storagePrefix: PREFIX, entryKey: ENTRY_KEY, bridgeKey: BRIDGE_KEY };

function verifyStorage(m: MemObjects): VerifyStorage {
  return {
    async readObject(key) {
      if (m.unreadable.has(key)) throw new Error(`403 Forbidden: ${key}`);
      const v = m.objects.get(key);
      if (v === undefined) throw new Error(`404 Not Found: ${key}`);
      return Buffer.from(v, 'utf-8');
    },
    getSimPublicUrl: (key) => `https://api.example.test/sim-public/${key}`,
  };
}

function verifyFetch(m: MemObjects): FetchBytes {
  return async (url) => {
    const key = keyFromUrl(url);
    if (m.unservable.has(key)) return { ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = m.servedOverride.get(key) ?? m.objects.get(key);
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = Buffer.from(body, 'utf-8');
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
  };
}

/** Storage AFTER a successful rebuild --apply. */
const appliedObjects = (): MemObjects => memObjects({ [BRIDGE_KEY]: HARDENED_BRIDGE, [ENTRY_KEY]: HARDENED_ENTRY });

const runVerify = (m: MemObjects, packages: VerifyPackage[] = [VPKG]) =>
  verifyPackages({ packages, storage: verifyStorage(m), transforms: VT, fetchBytes: verifyFetch(m) });

describe('verifyPackages — property 5: after the apply, ALREADY HARDENED is success', () => {
  it('verifies a correctly rolled-out package and exits 0', async () => {
    const run = await runVerify(appliedObjects());
    const gate = gateVerifyRun(run);
    expect(run.packages[0].problems).toEqual([]);
    expect(run.packages[0].ok).toBe(true);
    expect(run.packages[0].missingCapabilities).toEqual([]);
    expect(run.packages[0].sectionCount).toBe(1);
    expect(run.packages[0].servedTagMatchesServedBridge).toBe(true);
    expect(run.packages[0].bridge.servedMatchesStored).toBe(true);
    expect(run.packages[0].entry.servedMatchesStored).toBe(true);
    expect(gate).toMatchObject({ ok: true, inScope: 1, verified: 1, failed: 0 });
  });

  it('fails a package the rebuild never reached (stored bridge still legacy)', async () => {
    const m = memObjects({ [BRIDGE_KEY]: LEGACY_BRIDGE, [ENTRY_KEY]: HARDENED_ENTRY });
    const run = await runVerify(m);
    expect(run.packages[0].ok).toBe(false);
    expect(run.packages[0].missingCapabilities).toContain('ackCapable');
    expect(run.packages[0].problems.join()).toMatch(/STORED bridge is NOT hardened/);
    expect(gateVerifyRun(run).ok).toBe(false);
  });

  it('fails a half-applied package: new bridge stored, entry still tagged with the old hash', async () => {
    const m = memObjects({ [BRIDGE_KEY]: HARDENED_BRIDGE, [ENTRY_KEY]: `${RAW_ENTRY}<script src="./bridge.js?v=deadbeef0000"></script>` });
    const run = await runVerify(m);
    expect(run.packages[0].storedTagMatchesStoredBridge).toBe(false);
    expect(run.packages[0].problems.join()).toMatch(/half-applied/);
    expect(gateVerifyRun(run).ok).toBe(false);
  });

  it('fails a bridge whose section map was destroyed by the rebuild', async () => {
    const m = memObjects({ [BRIDGE_KEY]: HARDENED_PREAMBLE, [ENTRY_KEY]: RAW_ENTRY });
    const run = await runVerify(m);
    expect(run.packages[0].problems.join()).toMatch(/ZERO section bodies/);
  });
});

describe('verifyPackages — property 6: the SERVED bytes are what users actually get', () => {
  it('fails when the served entry HTML differs from the stored entry HTML', async () => {
    const m = appliedObjects();
    m.servedOverride.set(ENTRY_KEY, `${RAW_ENTRY}<script src="./bridge.js?v=${shortSha(HARDENED_BRIDGE)}"></script><!-- cdn copy -->`);
    const run = await runVerify(m);
    expect(run.packages[0].entry.servedMatchesStored).toBe(false);
    expect(run.packages[0].problems.join()).toMatch(/entry HTML: SERVED bytes differ from STORED bytes/);
    expect(gateVerifyRun(run).ok).toBe(false);
  });

  it('fails a STALE SERVED BRIDGE whose hash disagrees with the served entry tag', async () => {
    const m = appliedObjects();
    // The proxy still hands out the pre-rebuild bridge while the entry tag asks for the new one.
    m.servedOverride.set(BRIDGE_KEY, LEGACY_BRIDGE);
    const run = await runVerify(m);
    const p = run.packages[0];
    expect(p.servedEntryTagHash).toBe(shortSha(HARDENED_BRIDGE));
    expect(p.servedBridgeHash).toBe(shortSha(LEGACY_BRIDGE));
    expect(p.servedTagMatchesServedBridge).toBe(false);
    expect(p.problems.join()).toMatch(/bridge\.js: SERVED bytes differ from STORED bytes/);
    expect(p.problems.join()).toMatch(/stale bridge is being served behind a fresh entry/);
    expect(gateVerifyRun(run).ok).toBe(false);
  });

  it('fails when the serving path 404s / 502s even though storage is fine', async () => {
    const m = appliedObjects();
    m.unservable.add(BRIDGE_KEY);
    const run = await runVerify(m);
    expect(run.packages[0].problems.join()).toMatch(/SERVED path returned http 502/);
    expect(gateVerifyRun(run).ok).toBe(false);
  });

  it('fails when the stored object cannot be read at all', async () => {
    const m = appliedObjects();
    m.unreadable.add(ENTRY_KEY);
    const run = await runVerify(m);
    expect(run.packages[0].entry.storedSha).toBeNull();
    expect(run.packages[0].problems.join()).toMatch(/entry HTML: STORED bytes unreadable/);
    expect(gateVerifyRun(run).ok).toBe(false);
  });
});

describe('gateVerifyRun — property 7: verifying nothing is a failure', () => {
  it('exits non-zero on an empty scope (bad credentials / wrong bucket ⇒ empty inventory)', async () => {
    const run = await runVerify(appliedObjects(), []);
    const gate = gateVerifyRun(run);
    expect(gate).toMatchObject({ ok: false, inScope: 0, verified: 0 });
    expect(gate.problems.join()).toMatch(/VERIFIED NOTHING/);
  });

  it('names the failing package and the rollback section in the report', async () => {
    const m = appliedObjects();
    m.servedOverride.set(BRIDGE_KEY, LEGACY_BRIDGE);
    const run = await runVerify(m);
    const out = collector();
    reportVerifyRun(run, gateVerifyRun(run), out.log, out.log);
    expect(out.text()).toContain('Boids 3D');
    expect(out.text()).toContain(BRIDGE_KEY);
    expect(out.text()).toMatch(/VERIFICATION FAILED/);
    expect(out.text()).toMatch(/SIM-REBUILD-ROLLOUT\.md/);
  });
});

describe('verifyTargetsFromInventory', () => {
  it('scopes verification to the packages the rebuild could have touched', () => {
    const inv: VerifyInventoryLike[] = [
      { simulationId: 'sim-a', name: 'A', storagePrefix: PREFIX, entryKey: ENTRY_KEY, bridgeKey: BRIDGE_KEY, bridge: { combined: true }, files: { entry: { present: true } } },
      { simulationId: 'sim-b', name: 'B', storagePrefix: 'p2', entryKey: 'p2/i.html', bridgeKey: 'p2/bridge.js', bridge: { combined: false }, files: { entry: { present: true } } },
      { simulationId: 'sim-c', name: 'C', storagePrefix: 'p3', entryKey: '', bridgeKey: 'p3/bridge.js', bridge: { combined: true }, files: { entry: { present: false } } },
    ];
    expect(verifyTargetsFromInventory(inv).map((p) => p.simulationId)).toEqual(['sim-a']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// classify-orphan-sim-rows — --apply may never lose a rollback record
// ══════════════════════════════════════════════════════════════════════════════

const MANIFEST = '/rollout/orphan-rollback.jsonl';

interface MemManifestFs extends ManifestFs { map: Map<string, string>; writes: string[] }

function memManifestFs(over: Partial<ManifestFs> = {}): MemManifestFs {
  const map = new Map<string, string>();
  const writes: string[] = [];
  return {
    map, writes,
    mkdirp: () => { /* implicit */ },
    writeSync: (p, d) => { writes.push(p); map.set(p, d); },
    appendSync: (p, d) => { writes.push(p); map.set(p, (map.get(p) ?? '') + d); },
    readFile: (p) => {
      const v = map.get(p);
      if (v === undefined) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      return v;
    },
    exists: (p) => map.has(p),
    ...over,
  };
}

const PKGS: PackageFacts[] = [
  { name: 'Boids 3D', prefix: PREFIX, bridge: true, entry: true, ids: ['row-1', 'row-2', 'row-3', 'row-4'] },
  { name: 'example', prefix: 'simulations/proj-1/example', bridge: false, entry: true, ids: [] },
  { name: 'ising', prefix: 'simulations/proj-1/ising', bridge: false, entry: false, ids: [] },
];

const orphanUrl = (prefix: string): string => `https://api.example.test/sim-public/${prefix}/index.html`;

const mkOrphan = (rowId: string, prefix = PREFIX): OrphanRow =>
  classifyOrphanRow({ rowId, projectId: 'proj-1', label: null, simulationId: 'sim-a', url: orphanUrl(prefix) }, PKGS);

/** In-memory timeline_sections table. */
function memRows(ids: string[]): { urls: Map<string, string>; update: UpdateFn; snapshot: () => Map<string, string> } {
  const urls = new Map(ids.map((id) => [id, orphanUrl(PREFIX)]));
  return {
    urls,
    update: async (rowId, url) => { urls.set(rowId, url); },
    snapshot: () => new Map(urls),
  };
}

describe('classifyOrphanRow — the only repairable class is the provable one', () => {
  it('repairs only a row whose own id is a section id in the package bridge', () => {
    const r = mkOrphan('row-1');
    expect(r.classification).toBe('safely-repairable');
    expect(r.proposedUrl).toContain('section=row-1');
    expect(r.rollbackSql).toContain(orphanUrl(PREFIX));
    expect(r.rollbackSql).toContain("WHERE id = 'row-1'");
  });

  it('classifies the unprovable cases without guessing', () => {
    expect(classifyOrphanRow({ rowId: 'zz', projectId: 'p', label: null, simulationId: null, url: orphanUrl(PREFIX) }, PKGS).classification).toBe('requires-author-review');
    expect(mkOrphan('row-1', 'simulations/proj-1/example').classification).toBe('requires-regeneration');
    expect(mkOrphan('row-1', 'simulations/proj-1/ising').classification).toBe('obsolete');
    expect(classifyOrphanRow({ rowId: 'row-1', projectId: 'p', label: null, simulationId: null, url: 'https://elsewhere/x.html' }, PKGS).classification).toBe('unresolved');
  });

  it('hasSectionKey ignores rows that already have an identity, and malformed URLs', () => {
    expect(hasSectionKey('/sim-public/p/index.html?section=row-1')).toBe(true);
    expect(hasSectionKey('/sim-public/p/index.html')).toBe(false);
    expect(hasSectionKey('::::')).toBe(false);
  });

  it('buildRepairPlan carries the original URL and the rollback SQL for every planned row', () => {
    const plan = buildRepairPlan([mkOrphan('row-1'), mkOrphan('zz'), mkOrphan('row-2')]);
    expect(plan.map((p) => p.rowId)).toEqual(['row-1', 'row-2']);
    for (const p of plan) {
      expect(p.originalUrl).toBe(orphanUrl(PREFIX));
      expect(p.rollbackSql).toContain(p.rowId);
    }
  });
});

describe('applyRepairs — property 8: the rollback record is durable BEFORE the first UPDATE', () => {
  it('writes and re-reads a complete manifest before any row is touched', async () => {
    const plan = buildRepairPlan([mkOrphan('row-1'), mkOrphan('row-2')]);
    const fs = memManifestFs();
    const table = memRows(['row-1', 'row-2']);
    const seen: { manifestAtFirstUpdate: string | null } = { manifestAtFirstUpdate: null };
    let calls = 0;

    const outcome = await applyRepairs({
      plan, fs, manifestPath: MANIFEST,
      update: async (rowId, url) => {
        if (calls++ === 0) seen.manifestAtFirstUpdate = fs.map.get(MANIFEST) ?? null;
        await table.update(rowId, url);
      },
      log: () => {}, err: () => {}, now: () => '2026-08-02T00:00:00.000Z',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.manifestVerified).toBe(true);
    // The record existed, complete, before the very first write.
    const recovered = recoverableRowsFromManifest(seen.manifestAtFirstUpdate!);
    expect(recovered.map((r) => r.rowId)).toEqual(['row-1', 'row-2']);
    for (const r of recovered) expect(r.originalUrl).toBe(orphanUrl(PREFIX));
    // …and every row was checkpointed as it landed.
    const lines = fs.map.get(MANIFEST)!.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0].kind).toBe('manifest');
    expect(lines.filter((l) => l.status === 'applied').map((l) => l.rowId)).toEqual(['row-1', 'row-2']);
    expect(lines.at(-1)).toMatchObject({ kind: 'result', status: 'committed' });
  });

  it('modifies NOTHING when the manifest cannot be written', async () => {
    const plan = buildRepairPlan([mkOrphan('row-1')]);
    const fs = memManifestFs({ writeSync: () => { throw new Error('EROFS: read-only file system'); } });
    const table = memRows(['row-1']);
    const before = table.snapshot();
    const out = collector();

    const outcome = await applyRepairs({ plan, fs, manifestPath: MANIFEST, update: table.update, log: out.log, err: out.log });

    expect(outcome.ok).toBe(false);
    expect(outcome.manifestVerified).toBe(false);
    expect(table.urls).toEqual(before);
    expect(out.text()).toMatch(/could not write the rollback manifest/);
    expect(out.text()).toMatch(/NOTHING was modified/);
  });

  it('modifies NOTHING when the manifest does not read back intact', async () => {
    const plan = buildRepairPlan([mkOrphan('row-1'), mkOrphan('row-2')]);
    // Silent short write: only the first row survives the round trip.
    const fs = memManifestFs();
    const truncating = memManifestFs({
      writeSync: (p, d) => {
        const header = JSON.parse(d.trim()) as { rows: RepairPlanItem[] };
        header.rows = header.rows.slice(0, 1);
        fs.map.set(p, JSON.stringify(header) + '\n');
      },
      readFile: (p) => fs.map.get(p) ?? (() => { throw new Error('ENOENT'); })(),
      exists: (p) => fs.map.has(p),
    });
    const table = memRows(['row-1', 'row-2']);
    const before = table.snapshot();

    const outcome = await applyRepairs({ plan, fs: truncating, manifestPath: MANIFEST, update: table.update, log: () => {}, err: () => {} });

    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join()).toMatch(/recorded 1 row\(s\), the plan has 2/);
    expect(table.urls).toEqual(before);
  });

  it('verifyManifestOnDisk rejects a missing file, a non-JSON file and a swapped original URL', () => {
    const plan = buildRepairPlan([mkOrphan('row-1')]);
    const fs = memManifestFs();
    expect(verifyManifestOnDisk(fs, MANIFEST, plan)).toMatch(/does not exist/);
    fs.map.set(MANIFEST, 'not json\n');
    expect(verifyManifestOnDisk(fs, MANIFEST, plan)).toMatch(/did not read back as JSON/);
    fs.map.set(MANIFEST, renderManifestHeader([{ ...plan[0], originalUrl: 'https://wrong/' }], 'x'));
    expect(verifyManifestOnDisk(fs, MANIFEST, plan)).toMatch(/wrong original URL/);
    fs.map.set(MANIFEST, renderManifestHeader(plan, 'x'));
    expect(verifyManifestOnDisk(fs, MANIFEST, plan)).toBeNull();
  });
});

describe('applyRepairs — properties 9 + 10: a deterministic failure in the middle', () => {
  const plan = (): RepairPlanItem[] => buildRepairPlan([mkOrphan('row-1'), mkOrphan('row-2'), mkOrphan('row-3'), mkOrphan('row-4')]);

  it('stops at row 3, exits non-zero, and leaves rows 1-2 fully recoverable from the manifest', async () => {
    const p = plan();
    const fs = memManifestFs();
    const table = memRows(['row-1', 'row-2', 'row-3', 'row-4']);
    const originals = table.snapshot();
    const out = collector();

    const outcome = await applyRepairs({
      plan: p, fs, manifestPath: MANIFEST,
      update: async (rowId, url) => {
        if (rowId === 'row-3') throw new Error('deadlock detected on timeline_sections');
        await table.update(rowId, url);
      },
      log: out.log, err: out.log, now: () => '2026-08-02T00:00:00.000Z',
    });

    // property 10 — never rounded up to success
    expect(outcome.ok).toBe(false);
    expect(outcome.committed).toBe(false);
    expect(outcome.applied).toEqual(['row-1', 'row-2']);
    expect(outcome.failed).toEqual([{ rowId: 'row-3', reason: expect.stringMatching(/deadlock/) }]);
    expect(outcome.problems.join()).toMatch(/PARTIALLY APPLIED — 2\/4 row\(s\) were modified/);
    expect(out.text()).toContain(MANIFEST);

    // The database really is in the mixed state…
    expect(table.urls.get('row-1')).toContain('section=row-1');
    expect(table.urls.get('row-2')).toContain('section=row-2');
    expect(table.urls.get('row-3')).toBe(originals.get('row-3'));

    // property 9 — EVERY modified row's original value is recoverable from the durable record,
    // both from the header and from its own append-only checkpoint line.
    const raw = fs.map.get(MANIFEST)!;
    const header = recoverableRowsFromManifest(raw);
    expect(header.map((r) => r.rowId)).toEqual(['row-1', 'row-2', 'row-3', 'row-4']);
    const checkpoints = raw.trim().split('\n').slice(1).map((l) => JSON.parse(l) as Record<string, string>);
    expect(checkpoints.filter((c) => c.status === 'applied').map((c) => c.rowId)).toEqual(['row-1', 'row-2']);
    expect(checkpoints.filter((c) => c.status === 'failed').map((c) => c.rowId)).toEqual(['row-3']);
    for (const c of checkpoints) {
      expect(c.rollbackSql).toContain(c.rowId);
      expect(c.from).toBe(orphanUrl(PREFIX));
    }

    // Replaying the recorded originals restores the table byte-for-byte.
    for (const rowId of outcome.applied) {
      const rec = header.find((h) => h.rowId === rowId)!;
      await table.update(rowId, rec.originalUrl);
    }
    expect(table.urls).toEqual(originals);
  });

  it('rolls the whole batch back when a transaction is available, and still exits non-zero', async () => {
    const p = plan();
    const fs = memManifestFs();
    const table = memRows(['row-1', 'row-2', 'row-3', 'row-4']);
    const originals = table.snapshot();

    const outcome = await applyRepairs({
      plan: p, fs, manifestPath: MANIFEST,
      update: table.update,
      transaction: async (body) => {
        const before = table.snapshot();
        try {
          await body(async (rowId, url) => {
            if (rowId === 'row-3') throw new Error('deadlock detected on timeline_sections');
            await table.update(rowId, url);
          });
        } catch (e) {
          for (const [k, v] of before) table.urls.set(k, v);   // ROLLBACK
          throw e;
        }
      },
      log: () => {}, err: () => {}, now: () => '2026-08-02T00:00:00.000Z',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.transactional).toBe(true);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.rolledBackRows).toEqual(['row-1', 'row-2']);
    expect(outcome.applied).toEqual([]);
    expect(outcome.problems.join()).toMatch(/transaction rolled back/);
    expect(table.urls).toEqual(originals);       // the database is untouched
    // the record still names every row it was about to change
    expect(recoverableRowsFromManifest(fs.map.get(MANIFEST)!).map((r) => r.rowId)).toEqual(['row-1', 'row-2', 'row-3', 'row-4']);
    expect(fs.map.get(MANIFEST)!.trim().split('\n').at(-1)).toContain('"status":"rolled-back"');
  });

  it('commits all four rows through a working transaction', async () => {
    const p = plan();
    const fs = memManifestFs();
    const table = memRows(['row-1', 'row-2', 'row-3', 'row-4']);
    const outcome = await applyRepairs({
      plan: p, fs, manifestPath: MANIFEST,
      update: table.update,
      transaction: async (body) => { await body(table.update); },
      log: () => {}, err: () => {},
    });
    expect(outcome).toMatchObject({ ok: true, committed: true, rolledBack: false });
    expect(outcome.applied).toEqual(['row-1', 'row-2', 'row-3', 'row-4']);
    for (const id of outcome.applied) expect(table.urls.get(id)).toContain(`section=${id}`);
  });

  it('survives a checkpoint append that fails without losing the header record', async () => {
    const p = buildRepairPlan([mkOrphan('row-1')]);
    const fs = memManifestFs({ appendSync: () => { throw new Error('ENOSPC: no space left on device'); } });
    const table = memRows(['row-1']);
    const out = collector();
    const outcome = await applyRepairs({ plan: p, fs, manifestPath: MANIFEST, update: table.update, log: out.log, err: out.log });
    expect(outcome.applied).toEqual(['row-1']);
    expect(recoverableRowsFromManifest(fs.map.get(MANIFEST)!)[0].originalUrl).toBe(orphanUrl(PREFIX));
    expect(out.text()).toMatch(/checkpoint for row-1 could not be appended/);
  });
});

describe('gateClassification — the exit code covers unresolved rows too', () => {
  const okOutcome = (over: Partial<ApplyOutcome> = {}): ApplyOutcome => ({
    manifestPath: MANIFEST, manifestVerified: true, transactional: false,
    applied: ['row-1'], failed: [], rolledBackRows: [], rolledBack: false,
    committed: true, ok: true, problems: [], ...over,
  });

  it('passes a clean report with no unresolved row', () => {
    expect(gateClassification([mkOrphan('row-1'), mkOrphan('zz')], null).ok).toBe(true);
  });

  it('fails when a row could not be classified at all', () => {
    const orphan = classifyOrphanRow({ rowId: 'row-9', projectId: 'p', label: null, simulationId: null, url: 'https://elsewhere/x.html' }, PKGS);
    const gate = gateClassification([orphan], null);
    expect(gate.ok).toBe(false);
    expect(gate.problems.join()).toMatch(/row-9 is UNRESOLVED/);
  });

  it('propagates a partially applied run into the exit code', () => {
    const gate = gateClassification([mkOrphan('row-1')], okOutcome({ ok: false, problems: ['PARTIALLY APPLIED — 2/4 row(s) were modified'] }));
    expect(gate.ok).toBe(false);
    expect(gate.problems.join()).toMatch(/PARTIALLY APPLIED/);
  });
});
