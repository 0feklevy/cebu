/**
 * MIGRATION INVARIANTS — every simulation surface delegates its lifecycle to the shared runtime.
 *
 * These used to grep the players' own source for the orderings they implemented by hand. That
 * machinery now lives in `lib/sim/SimRuntimeClient.ts`, and its behaviour is pinned properly (by
 * execution, not by string match) in `simRuntimeClient.test.ts`. What still needs pinning is the
 * thing a behavioural test of the runtime cannot see: that each SURFACE actually routes through it
 * and has not quietly regrown a private copy.
 *
 * That regression is the whole reason the runtime exists — three consecutive audits each found a
 * defect that existed only because one surface implemented a rule the others did not. A surface
 * that reintroduces its own message listener, its own paint latch or its own reveal timer would
 * pass every behavioural suite in the repo while recreating exactly that class of bug.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8');

/** Every shipping surface that hosts a simulation iframe. */
const SURFACES = {
  viewer: 'components/viewer/useProjectPlayer.ts',
  editor: 'components/VideoPlayer.tsx',
  sectionEditor: 'components/SectionEditor.tsx',
  avatar: 'components/avatar/SimulationOverlay.tsx',
} as const;

/**
 * Strip comments before scanning. Otherwise a doc comment mentioning a forbidden token — and these
 * files explain the rules at length — reads as a violation, and the tests become unmaintainable
 * noise that gets deleted rather than trusted.
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('every simulation surface routes through the shared runtime', () => {
  for (const [name, rel] of Object.entries(SURFACES)) {
    it(`${name} imports the shared runtime`, () => {
      expect(read(rel)).toMatch(/from\s+['"][^'"]*lib\/sim\/(SimRuntimeClient|useSimRuntime|SimSurface)['"]/);
    });
  }
});

describe('no surface keeps a private simulation message listener', () => {
  // The runtime scopes every event to its OWN document by e.source. A second, unscoped listener is
  // how the section editor once answered the timeline player's handshake as if it were its own.
  const SIM_EVENTS = /SIM_READY|SIM_PAINTED|SCRIPT_APPLIED|SCRIPT_MISSING|SCRIPT_ERROR/;

  for (const [name, rel] of Object.entries(SURFACES)) {
    it(`${name} does not handle sim lifecycle messages itself`, () => {
      const src = code(read(rel));
      const listens = /addEventListener\(\s*['"]message['"]/.test(src);
      if (!listens) return;                       // no listener at all — nothing to check
      // A surface may still listen for NON-lifecycle messages (guidance cues, the Minimal-UI
      // control scan, branching). It must not interpret the lifecycle protocol.
      expect(SIM_EVENTS.test(src), `${name} still handles a lifecycle message itself`).toBe(false);
    });
  }
});

describe('no surface reimplements the reveal or cleanup machinery', () => {
  const FORBIDDEN: { token: RegExp; why: string }[] = [
    { token: /simPaintedRef/, why: 'a private paint latch — the runtime owns `painted`' },
    { token: /pendingApplyRef/, why: 'a private ack hold — the runtime owns the apply gate' },
    { token: /simActivationTokenRef/, why: 'private activation tokens — the runtime mints them' },
    { token: /PING_SIM_PAINTED|PING_SIM_READY/, why: 'a private paint poll — use startPaintRecovery()' },
    { token: /type:\s*['"]startScript['"]/, why: 'a raw startScript post — use runtime.activate()' },
    { token: /type:\s*['"]stopScript['"]/, why: 'a raw stopScript post — use deactivate()/stopNow()' },
    { token: /type:\s*['"]simMute['"]|type:\s*['"]simUnmute['"]/, why: 'raw mute posts — the runtime latches mute' },
  ];

  for (const [name, rel] of Object.entries(SURFACES)) {
    for (const { token, why } of FORBIDDEN) {
      it(`${name} has no ${token.source}`, () => {
        expect(token.test(code(read(rel))), `${name} reintroduced ${why}`).toBe(false);
      });
    }
  }
});

describe('surface-specific behaviour that must SURVIVE the migration', () => {
  // These have no counterpart in the runtime by design. Losing them silently would be a
  // regression the runtime's own tests cannot detect.
  it('the editor keeps its destroy grace — the runtime never unmounts a frame', () => {
    const src = code(read(SURFACES.editor));
    expect(src).toMatch(/simDestroyGraceMs/);
    expect(src, 'the grace must still clear the URL so the WebGL context is freed').toMatch(/setSimUrl\(null\)/);
  });

  it('the editor keeps the preview coordination pact with the section editor', () => {
    expect(code(read(SURFACES.editor))).toMatch(/sim-preview-active/);
    expect(code(read(SURFACES.sectionEditor))).toMatch(/sim-preview-active/);
  });

  it('the section editor keeps the Minimal-UI control scan (a DIFFERENT protocol)', () => {
    expect(code(read(SURFACES.sectionEditor))).toMatch(/simControlsList/);
  });

  it('the viewer keeps pooling, warming and residency planning', () => {
    const src = code(read(SURFACES.viewer));
    for (const token of ['dropPooled', 'planWindowResidency', 'navigateFrame']) {
      expect(src, `the viewer lost ${token}`).toMatch(new RegExp(token));
    }
  });

  it('the viewer keeps guidance gating and branching', () => {
    const src = code(read(SURFACES.viewer));
    expect(src).toMatch(/guidance/i);
    expect(src).toMatch(/branch/i);
  });
});

describe('the runtime is the single authority for the presentation gate', () => {
  it('ONLY the runtime consumes applyGateFor', () => {
    // Two copies of this rule is precisely the duplication the consolidation removed — and the
    // rule itself is the one that decides whether a wrong sub-simulation can reach the screen.
    const consumers = Object.entries(SURFACES)
      .filter(([, rel]) => /applyGateFor/.test(code(read(rel))))
      .map(([n]) => n);
    expect(consumers, `applyGateFor is called directly by: ${consumers.join(', ')}`).toEqual([]);
    expect(code(read('lib/sim/SimRuntimeClient.ts'))).toMatch(/applyGateFor/);
  });

  it('the viewer delegates the bulk of its lifecycle to the runtime', () => {
    const src = code(read(SURFACES.viewer));
    // Positive proof of delegation, so the "known gap" above cannot quietly become "no migration".
    expect(src).toMatch(/new SimRuntimeClient/);
    for (const call of ['.activate(', '.deactivate(', '.startPaintRecovery(', '.handleFrameLoad(']) {
      expect(src, `the viewer no longer delegates ${call}`).toContain(call);
    }
    // The things it must NOT have taken back.
    expect(src).not.toMatch(/simActivationTokenRef/);
    expect(src).not.toMatch(/PING_SIM_PAINTED/);
    expect(src).not.toMatch(/type:\s*['"]startScript['"]/);
  });

  it('the timings are defined once, in the protocol module', () => {
    const protocol = read('lib/sim/protocol.ts');
    for (const c of ['SIM_FADE_MS', 'SIM_EXIT_STOP_MS', 'SIM_APPLY_STALL_MS', 'SIM_LEGACY_REVEAL_MS']) {
      expect(protocol, `${c} missing from protocol.ts`).toMatch(new RegExp(`export const ${c}`));
    }
    // No surface may redefine them — divergent literals are how the exit fade and the deferred
    // teardown drifted apart in the first place.
    for (const [name, rel] of Object.entries(SURFACES)) {
      for (const c of ['SIM_EXIT_STOP_MS', 'SIM_APPLY_STALL_MS']) {
        expect(code(read(rel)), `${name} redefines ${c}`).not.toMatch(new RegExp(`const ${c}\\s*=`));
      }
    }
  });
});
