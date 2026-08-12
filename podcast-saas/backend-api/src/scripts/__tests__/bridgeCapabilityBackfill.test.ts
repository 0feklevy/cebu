/**
 * The operator backfill for the published-capability record — `simulations.bridge_ack_capable`
 * (migration 055, audit P0.5) and `simulations.requires_import_maps` (migration 057, audit P0.8).
 *
 * Both migrations added their column NULLABLE and backfilled nothing, so every package already in
 * the database reads UNKNOWN for both, and only the packages a publication or the revision
 * migration happens to rewrite ever leave that state. This script asks the questions of everything
 * else, once, from the same bytes the browser is served and with the same two detectors the
 * publication path uses.
 *
 * The `requires_import_maps` half matters MORE than the ack half and is easy to under-read: the
 * floor blocks only on `=== true`, so an unrecorded requirement makes P0.8 inert — the flagship
 * import-map packages the feature was written for keep painting nothing on Safari/iOS <= 16.3.
 *
 * Everything asserted here is the script's pure half: the module is written so that importing it
 * opens no database client and touches no storage, and both classifications are driven through an
 * injected reader (and, for the entry key, an injected path deriver). What is NOT covered here is
 * `main()`'s IO plumbing, which is thin by design precisely so that everything worth pinning lives
 * above it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  bridgeKeyCandidates,
  classifyPackage,
  entryKeyCandidates,
  factsToLearn,
  mergedRevisionMetadata,
  parseArgs,
  planBackfill,
  type BackfillSimRow,
  type ClassifyDeps,
} from '../backfill-bridge-capabilities.js';
import { deriveEntryRelPath } from '../../services/simulation/SimulationService.js';
import { BRIDGE_CAPABILITIES_KEY } from 'shared/sim/bridgeCapability';

const REV = '11111111-1111-1111-1111-111111111111';
const PREFIX = 'simulations/proj-1/sim-1';
const REV_ENTRY_KEY = `${PREFIX}/revisions/${REV}/package/index.html`;

const row = (over: Partial<BackfillSimRow> = {}): BackfillSimRow => ({
  id: 'sim-1', name: 'A package', storage_prefix: PREFIX,
  entry_file: `${PREFIX}/index.html`,
  active_revision_id: REV, active_revision_entry_key: REV_ENTRY_KEY,
  bridge_ack_capable: null, requires_import_maps: null, ...over,
});

/** A bridge the detector recognises as acknowledging — the same marker pair it looks for. */
const ACKING = `(function(){ _post({ type: 'SCRIPT_APPLIED', script: s }); })();`;
const SILENT = `(function(){ _post({ type: 'SIM_READY' }); })();`;

/** An entry document that cannot run without import maps, and one that can. */
const MAPPED = `<!doctype html><script type="importmap">{"imports":{"three":"/t.js"}}</script>`;
const PLAIN = `<!doctype html><script type="module" src="./app.js"></script>`;

/** The real deriver, injected exactly as `main()` injects it — no second copy of the path rule. */
const deps = (readObject: ClassifyDeps['readObject']): ClassifyDeps => ({ readObject, deriveEntryRelPath });

/** Serve different bytes per key, and null for anything not listed. */
const serve = (map: Record<string, string>) =>
  vi.fn(async (key: string): Promise<string | null> => map[key] ?? null);

describe('bridgeKeyCandidates — both real layouts, and never the mutable bytes of a revisioned package', () => {
  it('offers the revision package root first, then the runtime role', () => {
    expect(bridgeKeyCandidates(row())).toEqual([
      `${PREFIX}/revisions/${REV}/package/bridge.js`,
      `${PREFIX}/revisions/${REV}/runtime/bridge.js`,
    ]);
  });

  it('offers only the legacy prefix for a package with no active revision', () => {
    expect(bridgeKeyCandidates(row({ active_revision_id: null }))).toEqual([`${PREFIX}/bridge.js`]);
  });

  it('never offers the mutable legacy path for a REVISIONED package', () => {
    // The pointer names the bytes the browser gets. Classifying a revisioned package from
    // `<prefix>/bridge.js` would record a fact about bytes nobody is served — and that path is
    // exactly where a "replace simulation" upload lands.
    expect(bridgeKeyCandidates(row())).not.toContain(`${PREFIX}/bridge.js`);
  });

  it('tolerates a stored prefix with a trailing slash', () => {
    expect(bridgeKeyCandidates(row({ storage_prefix: `${PREFIX}//`, active_revision_id: null })))
      .toEqual([`${PREFIX}/bridge.js`]);
  });
});

describe('entryKeyCandidates — the pointer, or nothing', () => {
  it('uses the active revision entry key verbatim, because that IS the live document', () => {
    expect(entryKeyCandidates(row(), deriveEntryRelPath)).toEqual([REV_ENTRY_KEY]);
  });

  it('never falls back to the mutable prefix for a REVISIONED package', () => {
    // Same rule as the bridge: a pointer with no key offers no candidate at all rather than
    // classifying the entry a "replace simulation" upload may have left on the legacy path.
    expect(entryKeyCandidates(row({ active_revision_entry_key: null }), deriveEntryRelPath)).toEqual([]);
  });

  it('derives the legacy entry from entry_file, as a storage key or a full public URL', () => {
    const legacy = { active_revision_id: null, active_revision_entry_key: null };
    expect(entryKeyCandidates(row({ ...legacy }), deriveEntryRelPath))
      .toEqual([`${PREFIX}/index.html`]);
    expect(entryKeyCandidates(
      row({ ...legacy, entry_file: `https://cdn.example.com/sim-public/${PREFIX}/app/main.html?v=9` }),
      deriveEntryRelPath,
    )).toEqual([`${PREFIX}/app/main.html`]);
  });

  it('offers nothing when the entry cannot be located at all', () => {
    expect(entryKeyCandidates(
      row({ active_revision_id: null, active_revision_entry_key: null, entry_file: null }),
      deriveEntryRelPath,
    )).toEqual([]);
  });
});

describe('planBackfill — idempotent and bounded', () => {
  const recorded = { bridge_ack_capable: true, requires_import_maps: false };
  const rows = [row({ id: 'a' }), row({ id: 'b', ...recorded }), row({ id: 'c' })];

  it('selects only the rows still UNKNOWN, so a second run writes nothing', () => {
    const { work, alreadyRecorded } = planBackfill(rows);
    expect(work.map((r) => r.id)).toEqual(['a', 'c']);
    expect(alreadyRecorded.map((r) => r.id)).toEqual(['b']);
    // …and a run over a fully classified population is a no-op, which is what makes it safe to
    // schedule rather than to perform once by hand.
    expect(planBackfill(rows.map((r) => ({ ...r, ...recorded }))).work).toEqual([]);
  });

  it('still selects a row whose ACK is recorded but whose capability floor is not', () => {
    // THE 057 GAP. 055's own backfill run leaves exactly this population: an ack for every package
    // and `requires_import_maps` NULL for every package. A plan keyed on the ack alone reports the
    // whole fleet "already recorded" and P0.8 stays inert for all of it.
    const only055 = [row({ id: 'a', bridge_ack_capable: true })];
    expect(planBackfill(only055).work.map((r) => r.id)).toEqual(['a']);
    expect(planBackfill(only055).alreadyRecorded).toEqual([]);
  });

  it('`--force` re-reads everything, for bytes replaced under a recorded answer', () => {
    expect(planBackfill(rows, { force: true }).work.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(planBackfill(rows, { force: true }).alreadyRecorded).toEqual([]);
  });

  it('caps the batch at `--limit`, and successive runs make progress', () => {
    expect(planBackfill(rows, { limit: 1 }).work.map((r) => r.id)).toEqual(['a']);
    // `a` recorded by the first run drops out of the second's candidate set.
    const after = rows.map((r) => (r.id === 'a' ? { ...r, ...recorded } : r));
    expect(planBackfill(after, { limit: 1 }).work.map((r) => r.id)).toEqual(['c']);
  });

  it('a limit of 0 selects nothing rather than everything', () => {
    expect(planBackfill(rows, { limit: 0 }).work).toEqual([]);
  });
});

describe('factsToLearn — a run asks only what it does not already know', () => {
  it('asks both of a wholly unrecorded package', () => {
    expect(factsToLearn(row())).toEqual({ scriptApplied: true, requiresImportMaps: true });
  });

  it('asks only the capability floor when 055 already recorded the ack', () => {
    expect(factsToLearn(row({ bridge_ack_capable: false })))
      .toEqual({ scriptApplied: false, requiresImportMaps: true });
  });

  it('`--force` re-asks both regardless', () => {
    expect(factsToLearn(row({ bridge_ack_capable: false, requires_import_maps: true }), true))
      .toEqual({ scriptApplied: true, requiresImportMaps: true });
  });
});

describe('classifyPackage — evidence, or nothing at all', () => {
  const bridgeKey = `${PREFIX}/revisions/${REV}/package/bridge.js`;

  it('records both facts from the two published artefacts', async () => {
    const { result, capabilities } = await classifyPackage(
      row(), deps(serve({ [bridgeKey]: ACKING, [REV_ENTRY_KEY]: MAPPED })),
    );
    expect(result.outcome).toBe('classified');
    expect(result.scriptApplied).toBe(true);
    expect(result.requiresImportMaps).toBe(true);
    expect(capabilities).toEqual({ scriptApplied: true, requiresImportMaps: true });
    expect(result.bridgeKey).toBe(bridgeKey);
    expect(result.entryKey).toBe(REV_ENTRY_KEY);
  });

  it('records FALSE from a bridge that does not ack and an entry with no import map', async () => {
    const { capabilities } = await classifyPackage(
      row(), deps(serve({ [bridgeKey]: SILENT, [REV_ENTRY_KEY]: PLAIN })),
    );
    expect(capabilities).toEqual({ scriptApplied: false, requiresImportMaps: false });
  });

  it('reads the ENTRY document, not the bridge, for the import-map requirement', async () => {
    // The detector is `detectEntryCapabilities` over the entry HTML. Pointing it at the bridge
    // would answer `false` for every package in the fleet, which is indistinguishable from a
    // correct answer and would make the whole backfill a very convincing no-op.
    const { capabilities } = await classifyPackage(
      row(), deps(serve({ [bridgeKey]: ACKING, [REV_ENTRY_KEY]: MAPPED })),
    );
    expect(capabilities?.requiresImportMaps).toBe(true);
  });

  it('falls through to the second bridge candidate when the first key is unreadable', async () => {
    const runtimeKey = `${PREFIX}/revisions/${REV}/runtime/bridge.js`;
    const { result } = await classifyPackage(row(), deps(serve({ [runtimeKey]: ACKING })));
    expect(result.bridgeKey).toBe(runtimeKey);
    expect(result.scriptApplied).toBe(true);
  });

  it('classifies the readable artefact when the OTHER one cannot be read', async () => {
    // Two independent questions. A missing bridge must not cost the capability floor its answer.
    const entryOnly = await classifyPackage(row(), deps(serve({ [REV_ENTRY_KEY]: MAPPED })));
    expect(entryOnly.capabilities).toEqual({ requiresImportMaps: true });
    expect(entryOnly.result.outcome).toBe('classified');
    expect(entryOnly.result.scriptApplied).toBeUndefined();
    expect(entryOnly.result.note).toContain('no readable bridge.js');

    const bridgeOnly = await classifyPackage(row(), deps(serve({ [bridgeKey]: ACKING })));
    expect(bridgeOnly.capabilities).toEqual({ scriptApplied: true });
    expect(bridgeOnly.result.requiresImportMaps).toBeUndefined();
    expect(bridgeOnly.result.note).toContain('no readable entry document');
  });

  it('leaves a package wholly UNKNOWN when nothing can be read — it NEVER guesses', async () => {
    // The whole point. A guessed `scriptApplied: false` tells the viewer's gate the bridge is proven
    // silent, and the gate then reveals a pooled document's boot scene as if it were the requested
    // section. A guessed `requiresImportMaps: true` replaces a working simulation with a still image.
    const { result, capabilities } = await classifyPackage(row(), deps(serve({})));
    expect(result.outcome).toBe('unreadable');
    expect(result.scriptApplied).toBeUndefined();
    expect(result.requiresImportMaps).toBeUndefined();
    expect(capabilities).toBeNull();
  });

  it('reads nothing at all for a fact it was not asked to learn', async () => {
    const read = serve({ [bridgeKey]: ACKING, [REV_ENTRY_KEY]: MAPPED });
    const { capabilities } = await classifyPackage(
      row({ bridge_ack_capable: true }), deps(read),
      factsToLearn(row({ bridge_ack_capable: true })),
    );
    expect(capabilities).toEqual({ requiresImportMaps: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(REV_ENTRY_KEY);
  });

  it('stops at the first readable candidate for each artefact', async () => {
    const read = serve({ [bridgeKey]: ACKING, [REV_ENTRY_KEY]: PLAIN });
    await classifyPackage(row(), deps(read));
    expect(read).toHaveBeenCalledTimes(2);   // one bridge hit, one entry hit — no runtime/ probe
  });
});

describe('mergedRevisionMetadata — the record is folded in, never written over', () => {
  it('keeps unrelated metadata keys', () => {
    const merged = mergedRevisionMetadata(
      { migratedFromLegacyPrefix: PREFIX, legacyBridgeHash: 'h' },
      { scriptApplied: true },
    );
    expect(merged.migratedFromLegacyPrefix).toBe(PREFIX);
    expect(merged.legacyBridgeHash).toBe('h');
    expect(merged[BRIDGE_CAPABILITIES_KEY]).toEqual({ scriptApplied: true });
  });

  it('keeps a sibling capability this run never looked at', () => {
    // A run that only had to learn the ack must not un-record a capability floor 057's own
    // publication path already wrote.
    const merged = mergedRevisionMetadata(
      { [BRIDGE_CAPABILITIES_KEY]: { requiresImportMaps: true } },
      { scriptApplied: false },
    );
    expect(merged[BRIDGE_CAPABILITIES_KEY]).toEqual({ requiresImportMaps: true, scriptApplied: false });
  });

  it('overwrites only the fact it re-measured', () => {
    const merged = mergedRevisionMetadata(
      { [BRIDGE_CAPABILITIES_KEY]: { scriptApplied: false, requiresImportMaps: false } },
      { scriptApplied: true },
    );
    expect(merged[BRIDGE_CAPABILITIES_KEY]).toEqual({ scriptApplied: true, requiresImportMaps: false });
  });

  it('survives metadata that is null, an array, or not an object at all', () => {
    for (const junk of [null, undefined, [], 'text', 42]) {
      expect(mergedRevisionMetadata(junk, { scriptApplied: true })[BRIDGE_CAPABILITIES_KEY])
        .toEqual({ scriptApplied: true });
    }
  });
});

describe('parseArgs — a dry run unless the operator says otherwise', () => {
  it('defaults to reporting only', () => {
    expect(parseArgs([])).toEqual({ apply: false, force: false });
  });

  it('reads --apply, --force and --limit', () => {
    expect(parseArgs(['--apply', '--force', '--limit=25']))
      .toEqual({ apply: true, force: true, limit: 25 });
  });

  it('IGNORES a malformed --limit rather than treating it as zero', () => {
    // A run that quietly does nothing looks exactly like a run that found nothing to do.
    expect(parseArgs(['--limit=abc'])).toEqual({ apply: false, force: false });
    expect(parseArgs(['--limit=-3'])).toEqual({ apply: false, force: false });
  });
});
