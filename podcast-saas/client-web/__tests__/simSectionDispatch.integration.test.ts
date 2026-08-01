/**
 * INTEGRATION: two timeline sections that share ONE simulation package must display DIFFERENT
 * sub-simulations.
 *
 * This is the regression that shipped with the adaptive pool: sections share a package, the pool
 * loads ONE document per package, and every section was dispatched with the stored
 * `sim_script = 'main'` — which a v2 bridge resolves to the LOADED URL's `?section=` default, i.e.
 * the FIRST-pooled section. Every section therefore ran the first section's body. A test that only
 * asserts "a simulation appears" passes happily through that bug, so this one asserts WHICH body
 * runs.
 *
 * It chains the two halves of the real mechanism:
 *   1. the real `collectSimPool` / `dynamicScriptFor` from lib/simPool (the player's half), and
 *   2. the generated bridge's dispatch rule (the simulation's half):
 *        var fn = SCRIPTS[name] || _sectionBody(name) || SCRIPTS.main;
 *      pinned against the real template by bridgeIntegration.test.ts [7] in backend-api, so this
 *      harness cannot silently drift from what the backend actually generates.
 */
import { describe, it, expect } from 'vitest';
import { collectSimPool, dynamicScriptFor, packageKeyOf } from '../lib/simPool';
import type { PlayerConfig, PlayerSegment, SimulationOverlay } from '../components/viewer/types';

// ── The package: one entry document serving two sections ────────────────────────────────

const PKG = 'https://api.flowvidco.com/sim-public/simulations/p1/s1/boids-3d/index.html';
const SECTION_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SECTION_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** Sections exactly as the backend stores them: sim_script is the literal 'main' on every row. */
const section = (id: string, urlSectionId: string): SimulationOverlay => ({
  id,
  start_sec: 0,
  end_sec: 10,
  simulation_url: `${PKG}?section=${urlSectionId}&v=abc123`,
  simulation_id: 'sim-1',
  sim_script: 'main',
  simple_ui: false,
  auto_script: true,
  label: null,
  type: 'simulation',
} as SimulationOverlay);

const secA = section(SECTION_A, SECTION_A);
const secB = section(SECTION_B, SECTION_B);

const config = {
  segments: [{
    id: 'seg1', label: 'seg1', duration_sec: 60, hls_url: null, fallback_url: null,
    hls_status: 'ready', simulations: [secA, secB],
  } as unknown as PlayerSegment],
} as unknown as PlayerConfig;

// ── A faithful stand-in for the generated bridge document ───────────────────────────────

/**
 * Mirrors the generated bridge: `__SECTIONS__` keyed by timeline-section id, `SCRIPTS.main`
 * bound to the LOADED URL's `?section=` default, and the pinned resolution order.
 */
function bootBridgeDocument(bootUrl: string, bodies: Record<string, (log: string[]) => void>) {
  const defaultSectionId = new URL(bootUrl).searchParams.get('section');
  const ran: string[] = [];
  const sectionBody = (name: string | null) =>
    name && Object.prototype.hasOwnProperty.call(bodies, name) ? bodies[name] : null;
  const SCRIPTS: Record<string, (log: string[]) => void> = {
    main: (log) => { const b = sectionBody(defaultSectionId); if (b) b(log); },
  };
  return {
    ran,
    /** The bridge's `startScript` message handler. */
    startScript(name: string) {
      const fn = SCRIPTS[name] ?? sectionBody(name) ?? SCRIPTS.main;
      fn(ran);
    },
  };
}

const BODIES = {
  [SECTION_A]: (log: string[]) => log.push('A: orbit camera + separation sliders'),
  [SECTION_B]: (log: string[]) => log.push('B: top-down view + cohesion only'),
};

// ── Tests ───────────────────────────────────────────────────────────────────────────────

describe('two sections sharing one package render DIFFERENT sub-simulations', () => {
  it('pools ONE document for both sections (no iframe-per-section)', () => {
    const pool = collectSimPool(config);
    expect(pool).toHaveLength(1);
    expect(pool[0].key).toBe(packageKeyOf(PKG));
    // The single frame boots on the FIRST section's URL — which is exactly why dispatch matters.
    expect(pool[0].src).toBe(secA.simulation_url);
  });

  it('END TO END: each section runs its OWN body inside that one document', () => {
    const pool = collectSimPool(config);
    const doc = bootBridgeDocument(pool[0].src, BODIES);

    // Activate section A (the boot default) …
    doc.startScript(dynamicScriptFor(secA));
    // … then section B in the SAME document — no reload, no second iframe.
    doc.startScript(dynamicScriptFor(secB));

    expect(doc.ran).toEqual([
      'A: orbit camera + separation sliders',
      'B: top-down view + cohesion only',
    ]);
    // The decisive assertion: the two sections produced DIFFERENT output.
    expect(doc.ran[0]).not.toBe(doc.ran[1]);
  });

  it('works in either activation order (B first, then A)', () => {
    const pool = collectSimPool(config);
    const doc = bootBridgeDocument(pool[0].src, BODIES);
    doc.startScript(dynamicScriptFor(secB));
    doc.startScript(dynamicScriptFor(secA));
    expect(doc.ran).toEqual([
      'B: top-down view + cohesion only',
      'A: orbit camera + separation sliders',
    ]);
  });

  it('REGRESSION GUARD: the old \'main\' dispatch collapses both sections onto the first', () => {
    // Proof that this test can actually FAIL on the bug — the pre-fix player sent sim_script,
    // which is 'main' on every row, and the bridge resolved it to the boot URL's default.
    const pool = collectSimPool(config);
    const doc = bootBridgeDocument(pool[0].src, BODIES);
    doc.startScript(secA.sim_script!);   // 'main'
    doc.startScript(secB.sim_script!);   // 'main'
    expect(doc.ran[0]).toBe(doc.ran[1]);                       // both ran section A — the bug
    expect(doc.ran[1]).not.toBe('B: top-down view + cohesion only');
    // …and the fixed dispatch never sends 'main' for a sectioned URL.
    expect(dynamicScriptFor(secB)).toBe(SECTION_B);
    expect(dynamicScriptFor(secB)).not.toBe('main');
  });

  it('a DUPLICATED section dispatches the body its URL points at, not its own row id', () => {
    // Copy-created sections keep the ORIGINAL's URL; their own row id has no bridge body, so
    // dispatching by row id would fall back to the boot default and collapse again.
    const copy = section('cccccccc-3333-4333-8333-cccccccccccc', SECTION_B);
    const doc = bootBridgeDocument(secA.simulation_url!, BODIES);
    doc.startScript(dynamicScriptFor(copy));
    expect(doc.ran).toEqual(['B: top-down view + cohesion only']);
  });
});
