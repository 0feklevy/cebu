/**
 * The shared revision-pointer resolver (audit §9.6, Stage 0).
 *
 * This logic was a private closure inside buildPlayerConfig, so the VIEWER resolved the pointer and
 * the EDITOR — which reads `timeline_sections` straight from the DB — served whatever URL was
 * stored, i.e. a retired revision's bytes after any republish or rollback. Extracting it changed
 * nothing about what it does, and these tests pin exactly that: the semantics below are the
 * closure's, restated so a future edit cannot quietly drift them.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSimulationUrl,
  simRevisionPointers,
  simulationUrlResolver,
  withServedSimulationUrls,
} from '../simulation/simulationUrlResolver.js';

const storage = { getSimPublicUrl: (key: string) => `https://cdn.example.com/sim-public/${key}` };

const REV = '11111111-1111-1111-1111-111111111111';
const ENTRY_KEY = `simulations/proj-1/sim-1/revisions/${REV}/package/index.html`;
const SERVED = `https://cdn.example.com/sim-public/${ENTRY_KEY}`;

const pointer = { active_revision_entry_key: ENTRY_KEY };
const legacy = { active_revision_entry_key: null };

describe('resolveSimulationUrl — a simulation WITH an active revision', () => {
  it('serves from the revision entry key', () => {
    expect(resolveSimulationUrl('https://x/sim.html', pointer, storage)).toBe(SERVED);
  });

  it('preserves ?section= and ?v= verbatim', () => {
    // The viewer's pool dispatches on ?section= and the poster/variant identity axis reads it.
    // Dropping the query collapses every section of a package onto one variant key.
    expect(resolveSimulationUrl('https://x/sim.html?section=sec-1&v=H1', pointer, storage))
      .toBe(`${SERVED}?section=sec-1&v=H1`);
  });

  it('preserves an arbitrary query byte-for-byte, including a fragment after it', () => {
    const stored = 'https://x/sim.html?section=sec-1&v=H1&g=abc#simboot';
    expect(resolveSimulationUrl(stored, pointer, storage)).toBe(`${SERVED}?section=sec-1&v=H1&g=abc#simboot`);
  });

  it('emits no query at all when the stored url had none', () => {
    expect(resolveSimulationUrl('https://x/sim.html', pointer, storage)).not.toContain('?');
  });

  it('keeps a bare "?" as the empty query it is, rather than inventing one', () => {
    expect(resolveSimulationUrl('https://x/sim.html?', pointer, storage)).toBe(`${SERVED}?`);
  });
});

describe('resolveSimulationUrl — everything else is untouched', () => {
  it('returns a LEGACY (un-revisioned) simulation\'s stored url byte-identically', () => {
    // Every package that predates migration 050 is in this state, and every sim_posters row is
    // keyed on the pre-revision identity, so any change here is silently wrong for all of them.
    const stored = 'https://x/legacy/index.html?section=sec-1&v=H1';
    expect(resolveSimulationUrl(stored, legacy, storage)).toBe(stored);
  });

  it('returns the stored url when there is no simulation row at all', () => {
    const stored = 'https://x/legacy/index.html';
    expect(resolveSimulationUrl(stored, undefined, storage)).toBe(stored);
    expect(resolveSimulationUrl(stored, null, storage)).toBe(stored);
  });

  it('returns null for a section with no stored url, pointer or not', () => {
    expect(resolveSimulationUrl(null, pointer, storage)).toBeNull();
    expect(resolveSimulationUrl(undefined, legacy, storage)).toBeNull();
  });

  it('passes an empty stored url straight through, exactly as the closure did', () => {
    // Not a null: `url ?? null` returned '' for an empty string, and this is a semantics-preserving
    // extraction, not a cleanup. A section with '' has no simulation to serve either way.
    expect(resolveSimulationUrl('', pointer, storage)).toBe('');
  });
});

describe('simulationUrlResolver — one batch of pointers, many sections', () => {
  const resolve = simulationUrlResolver(
    simRevisionPointers([
      { id: 'sim-1', active_revision_entry_key: ENTRY_KEY },
      { id: 'sim-2', active_revision_entry_key: null },
    ]),
    storage,
  );

  it('resolves per simulation id', () => {
    expect(resolve('sim-1', 'https://x/a.html?section=a')).toBe(`${SERVED}?section=a`);
    expect(resolve('sim-2', 'https://x/b.html?section=b')).toBe('https://x/b.html?section=b');
  });

  it('leaves a section whose simulation is missing from the batch alone', () => {
    // A degraded pointer read produces exactly this state, and serving the stored (legacy) package
    // is the safe direction.
    expect(resolve('sim-404', 'https://x/c.html')).toBe('https://x/c.html');
  });

  it('leaves a section with no simulation_id alone', () => {
    expect(resolve(null, 'https://x/d.html')).toBe('https://x/d.html');
  });
});

describe('withServedSimulationUrls — the editor shape', () => {
  const sections = [
    { id: 'sec-1', simulation_id: 'sim-1', simulation_url: 'https://x/a.html?section=sec-1&v=H1', label: 'A' },
    { id: 'sec-2', simulation_id: 'sim-2', simulation_url: 'https://x/b.html?section=sec-2', label: 'B' },
    { id: 'sec-3', simulation_id: null, simulation_url: null, label: 'C' },
  ];
  const rows = [
    { id: 'sim-1', active_revision_entry_key: ENTRY_KEY },
    { id: 'sim-2', active_revision_entry_key: null },
  ];

  it('adds the served url without touching the stored one', () => {
    // THE INVARIANT. The editor copies `simulation_url` verbatim into PATCH (undo/redo restore) and
    // POST (duplicate section) bodies, and both endpoints store an explicit value as given — so
    // overwriting this field on read would let a GET→PATCH round-trip persist a resolved URL.
    const out = withServedSimulationUrls(sections, rows, storage);
    expect(out.map(s => s.simulation_url)).toEqual(sections.map(s => s.simulation_url));
    expect(out[0].simulation_served_url).toBe(`${SERVED}?section=sec-1&v=H1`);
  });

  it('serves the stored url for a legacy simulation and null for a non-simulation section', () => {
    const out = withServedSimulationUrls(sections, rows, storage);
    expect(out[1].simulation_served_url).toBe('https://x/b.html?section=sec-2');
    expect(out[2].simulation_served_url).toBeNull();
  });

  it('carries every other column through unchanged', () => {
    const out = withServedSimulationUrls(sections, rows, storage);
    expect(out.map(({ simulation_served_url: _ignored, ...rest }) => rest)).toEqual(sections);
  });

  it('falls back to stored urls when the pointer batch is empty (degraded read)', () => {
    const out = withServedSimulationUrls(sections, [], storage);
    expect(out.map(s => s.simulation_served_url)).toEqual(sections.map(s => s.simulation_url));
  });
});
