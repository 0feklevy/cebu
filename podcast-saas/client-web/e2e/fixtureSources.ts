/**
 * Every backend source the generated e2e fixture bytes are built from — in ONE place.
 *
 * WHY THIS EXISTS
 * Each fixture-building spec decides whether `.sim-fixture/` is stale by comparing mtimes against a
 * list of sources. When that list lived in the specs, it drifted: three of them stat'd only
 * `gen-sim-fixture.ts`, but the emitted bridge embeds `buildChildRuntimeSource()` verbatim — so a
 * change to the child runtime left the generator's mtime untouched, the fixture was declared fresh,
 * and the suite silently exercised the PREVIOUS runtime.
 *
 * That is the most expensive kind of false signal a gate can give. It bit three separate suites in
 * one session: two child-runtime fixes were re-run against pre-fix bytes and reported as still
 * failing, and a publication gate certified a runtime that was no longer what shipped. In both
 * cases the available conclusion — "the fix did not work", "the package is fine" — was wrong.
 *
 * So the list is data, shared, and asserted. `assertSourcesExist` fails loudly if an entry stops
 * resolving, because a path that silently drops out of the list reintroduces exactly the same
 * blindness a rename at a time.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Absolute paths of every source that changes the fixture bytes.
 *
 * @param backendRoot absolute path of the backend-api package
 */
export function fixtureSourceFiles(backendRoot: string): string[] {
  return [
    // The generator itself: package list, section ids, section bodies.
    join(backendRoot, 'src', 'scripts', 'gen-sim-fixture.ts'),
    // wrapBridgeCombined / buildSectionEntry / the rAF gate — the bridge envelope and the gate.
    join(backendRoot, 'src', 'services', 'simulation', 'SimulationService.ts'),
    // buildChildRuntimeSource — embedded verbatim in every v3 package's bridge.
    join(backendRoot, 'src', 'services', 'simulation', 'simRuntimeChild.ts'),
    // injectSimBootSnippet is baked into the served entry HTML the fixtures imitate.
    join(backendRoot, 'src', 'controllers', 'sim-public.controller.ts'),
  ];
}

/**
 * Newest mtime across every fixture source.
 *
 * Throws when a listed source is missing rather than skipping it: a path that quietly stops
 * resolving reintroduces the staleness blindness one rename at a time, and a fixture gate that
 * cannot see one of its inputs is not a gate.
 */
export function newestFixtureSourceMtime(backendRoot: string): number {
  const files = fixtureSourceFiles(backendRoot);
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    throw new Error(
      `e2e fixture freshness cannot be determined — these sources are missing:\n  ${missing.join('\n  ')}\n` +
      'Update client-web/e2e/fixtureSources.ts if a file moved.',
    );
  }
  return files.reduce((max, f) => Math.max(max, statSync(f).mtimeMs), 0);
}

/**
 * Is a built fixture still current?
 *
 * `SIM_FIXTURE_FORCE=1` forces a rebuild — the escape hatch for the case where a source changed in
 * a way mtime cannot see (a checkout that restored an older file with a newer timestamp).
 */
export function fixtureIsFresh(backendRoot: string, stampPath: string): boolean {
  if (process.env.SIM_FIXTURE_FORCE) return false;
  if (!existsSync(stampPath)) return false;
  return newestFixtureSourceMtime(backendRoot) <= statSync(stampPath).mtimeMs;
}
