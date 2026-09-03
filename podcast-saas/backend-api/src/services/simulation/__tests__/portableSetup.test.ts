/**
 * Where a saved setup lands, and how its simulation gets there.
 *
 * The rule that matters most is the one that says NO: a section that already has a simulation is
 * never swapped for the setup's — the creator is looking at that package, and a load that
 * replaced it would be a different thing happening than the one they asked for.
 */
import { describe, it, expect } from 'vitest';
import { describeSetupTarget, resolveSetupTarget, type SetupSourceFacts, type TargetProjectFacts } from '../portableSetup.js';

const source = (over: Partial<SetupSourceFacts> = {}): SetupSourceFacts => ({
  sourceSimulationId: 'sim-source', sourceSimulationName: 'Boids', sourceExists: true, ...over,
});
const target = (over: Partial<TargetProjectFacts> = {}): TargetProjectFacts => ({
  sectionSimulationId: null, sourceIsInThisProject: false, existingImportId: null, ...over,
});

describe('resolveSetupTarget', () => {
  it('a section that already has a simulation keeps it — bringing never swaps what is on screen', () => {
    expect(resolveSetupTarget(source(), target({ sectionSimulationId: 'sim-here' }), true))
      .toEqual({ use: 'section', simulationId: 'sim-here', brought: false });
    expect(resolveSetupTarget(source(), target({ sectionSimulationId: 'sim-here', sourceIsInThisProject: true }), true))
      .toEqual({ use: 'section', simulationId: 'sim-here', brought: false });
  });

  it('a fresh section without the intent to bring is refused, and the message says how to proceed', () => {
    const t = resolveSetupTarget(source(), target(), false);
    expect(t.use).toBe('refuse');
    expect(t).toMatchObject({ reason: expect.stringContaining('bring the simulation too') });
  });

  it('the setup’s own simulation, already in this project, is attached rather than copied', () => {
    expect(resolveSetupTarget(source(), target({ sourceIsInThisProject: true }), true))
      .toEqual({ use: 'source', simulationId: 'sim-source', brought: false });
  });

  it('a copy this project already received is reused — a second load mints no second row', () => {
    expect(resolveSetupTarget(source(), target({ existingImportId: 'sim-copy' }), true))
      .toEqual({ use: 'existing-import', simulationId: 'sim-copy', brought: false });
  });

  it('otherwise the source is imported', () => {
    expect(resolveSetupTarget(source(), target(), true))
      .toEqual({ use: 'import', sourceSimulationId: 'sim-source', brought: true });
  });

  it('a setup whose simulation was deleted cannot bring anything, and says so', () => {
    const gone = resolveSetupTarget(source({ sourceExists: false }), target(), true);
    expect(gone.use).toBe('refuse');
    expect(gone).toMatchObject({ reason: expect.stringContaining('no longer exists') });
    const never = resolveSetupTarget(source({ sourceSimulationId: null, sourceExists: false }), target(), true);
    expect(never.use).toBe('refuse');
    // Without the intent to bring, the refusal is the plain one — not a lecture about a package.
    expect(resolveSetupTarget(source({ sourceExists: false }), target(), false))
      .toMatchObject({ reason: 'This section has no simulation to load onto.' });
  });
});

describe('describeSetupTarget', () => {
  it('names the package and promises nothing is stored twice, per path', () => {
    expect(describeSetupTarget({ use: 'section', simulationId: 's', brought: false }, 'Boids')).toMatch(/this section’s simulation/);
    expect(describeSetupTarget({ use: 'source', simulationId: 's', brought: false }, 'Boids')).toMatch(/already has/);
    expect(describeSetupTarget({ use: 'existing-import', simulationId: 's', brought: false }, 'Boids')).toMatch(/already received/);
    const imported = describeSetupTarget({ use: 'import', sourceSimulationId: 's', brought: true }, 'Boids');
    expect(imported).toMatch(/Brings “Boids”/);
    expect(imported).toMatch(/nothing is stored twice/);
    expect(describeSetupTarget({ use: 'import', sourceSimulationId: 's', brought: true }, null)).toMatch(/its simulation/);
    expect(describeSetupTarget({ use: 'refuse', reason: 'because' }, 'Boids')).toBe('because');
  });
});
