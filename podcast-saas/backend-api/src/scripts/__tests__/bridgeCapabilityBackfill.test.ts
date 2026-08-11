/**
 * The operator backfill for `simulations.bridge_ack_capable` (migration 055, audit P0.5).
 *
 * Migration 055 added the column NULLABLE and backfilled nothing, so every package already in the
 * database reads UNKNOWN — and only the packages a publication or the revision migration happens to
 * rewrite ever leave that state. This script asks the question of everything else, once, from the
 * same bytes the browser is served and with the same detector the publication path uses.
 *
 * Everything asserted here is the script's pure half: the module is written so that importing it
 * opens no database client and touches no storage, and the classification is driven through an
 * injected reader. What is NOT covered here is `main()`'s IO plumbing, which is thin by design
 * precisely so that everything worth pinning lives above it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  bridgeKeyCandidates,
  classifyPackage,
  mergedRevisionMetadata,
  parseArgs,
  planBackfill,
  type BackfillSimRow,
} from '../backfill-bridge-capabilities.js';
import { BRIDGE_CAPABILITIES_KEY } from 'shared/sim/bridgeCapability';

const REV = '11111111-1111-1111-1111-111111111111';
const PREFIX = 'simulations/proj-1/sim-1';

const row = (over: Partial<BackfillSimRow> = {}): BackfillSimRow => ({
  id: 'sim-1', name: 'A package', storage_prefix: PREFIX,
  active_revision_id: REV, bridge_ack_capable: null, ...over,
});

/** A bridge the detector recognises as acknowledging — the same marker pair it looks for. */
const ACKING = `(function(){ _post({ type: 'SCRIPT_APPLIED', script: s }); })();`;
const SILENT = `(function(){ _post({ type: 'SIM_READY' }); })();`;

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

describe('planBackfill — idempotent and bounded', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', bridge_ack_capable: true }), row({ id: 'c' })];

  it('selects only the rows still UNKNOWN, so a second run writes nothing', () => {
    const { work, alreadyRecorded } = planBackfill(rows);
    expect(work.map((r) => r.id)).toEqual(['a', 'c']);
    expect(alreadyRecorded.map((r) => r.id)).toEqual(['b']);
    // …and a run over an already-classified population is a no-op, which is what makes it safe to
    // schedule rather than to perform once by hand.
    expect(planBackfill(rows.map((r) => ({ ...r, bridge_ack_capable: false }))).work).toEqual([]);
  });

  it('`--force` re-reads everything, for bytes replaced under a recorded answer', () => {
    expect(planBackfill(rows, { force: true }).work.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(planBackfill(rows, { force: true }).alreadyRecorded).toEqual([]);
  });

  it('caps the batch at `--limit`, and successive runs make progress', () => {
    expect(planBackfill(rows, { limit: 1 }).work.map((r) => r.id)).toEqual(['a']);
    // `a` recorded by the first run drops out of the second's candidate set.
    const after = rows.map((r) => (r.id === 'a' ? { ...r, bridge_ack_capable: true } : r));
    expect(planBackfill(after, { limit: 1 }).work.map((r) => r.id)).toEqual(['c']);
  });

  it('a limit of 0 selects nothing rather than everything', () => {
    expect(planBackfill(rows, { limit: 0 }).work).toEqual([]);
  });
});

describe('classifyPackage — evidence, or nothing at all', () => {
  it('records TRUE from a bridge that posts SCRIPT_APPLIED', async () => {
    const { result, capabilities } = await classifyPackage(row(), async () => ACKING);
    expect(result.outcome).toBe('classified');
    expect(result.scriptApplied).toBe(true);
    expect(capabilities).toEqual({ scriptApplied: true });
  });

  it('records FALSE from a bridge that does not', async () => {
    const { result, capabilities } = await classifyPackage(row(), async () => SILENT);
    expect(result.scriptApplied).toBe(false);
    expect(capabilities).toEqual({ scriptApplied: false });
  });

  it('falls through to the second candidate when the first key is unreadable', async () => {
    const read = vi.fn(async (key: string) => (key.endsWith('runtime/bridge.js') ? ACKING : null));
    const { result } = await classifyPackage(row(), read);
    expect(result.bridgeKey).toBe(`${PREFIX}/revisions/${REV}/runtime/bridge.js`);
    expect(result.scriptApplied).toBe(true);
  });

  it('leaves a package UNKNOWN when no bridge can be read — it NEVER guesses false', async () => {
    // The whole point. A guessed `false` tells the viewer's gate the bridge is proven silent, and
    // the gate then reveals a pooled document's boot scene as if it were the requested section.
    const { result, capabilities } = await classifyPackage(row(), async () => null);
    expect(result.outcome).toBe('unreadable');
    expect(result.scriptApplied).toBeUndefined();
    expect(capabilities).toBeNull();
    expect(result.note).toContain('no readable bridge.js');
  });

  it('reads at most the candidates, and stops at the first hit', async () => {
    const read = vi.fn(async () => ACKING);
    await classifyPackage(row(), read);
    expect(read).toHaveBeenCalledTimes(1);
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

  it('keeps a sibling capability this script never looked at', () => {
    // `requiresImportMaps` (migration 057) shares the record. Replacing the object rather than
    // merging it would silently un-record a package's capability floor.
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
