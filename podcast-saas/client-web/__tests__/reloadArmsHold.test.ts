/**
 * Every branch that RELOADS the sim document must also arm the hold machinery.
 *
 * `useProjectPlayer` is a 2600-line hook over a live iframe pool, a video element and a bridge; the
 * behavioural proof for this invariant is the browser suite. What that suite cannot do is fail for
 * THIS reason specifically — a missing affordance shows up as a timeout somewhere else, if at all.
 * So the structural claim is pinned here instead, the same way `trustProxyWiring.test.ts` pins that
 * the hop count reaches Fastify: read the source, strip comments so prose cannot satisfy an
 * assertion, and require the two branches to name the same conditions.
 *
 * THE DEFECT THIS EXISTS FOR: `rawNeedsNav` was added to the `navigateFrame` branch and left out of
 * the arming guard. The guard tests `wasReady && wasPainted`, which describes the document that was
 * just thrown away — so for the blank one now booting, nothing armed: no `startSimPoll` (no
 * readiness/paint polling, no legacy reveal ceiling), no paint deadline, no `simColdCover` (neither
 * poster nor spinner over a blank frame), and no stall affordance or its terminal force-reveal. The
 * only remaining bound was the iframe's native `load`, which waits for every subresource.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '..', 'components', 'viewer', 'useProjectPlayer.ts'), 'utf-8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the hold machinery is armed for every document reload', () => {
  it('still has both reload conditions (this test is about them, so it fails loudly if renamed)', () => {
    expect(SRC).toMatch(/const\s+legacyNeedsNav\s*=/);
    expect(SRC).toMatch(/const\s+rawNeedsNav\s*=/);
  });

  it('reloads the frame when EITHER condition holds', () => {
    expect(SRC, 'the navigate branch no longer covers both reload conditions')
      .toMatch(/if\s*\(\s*legacyNeedsNav\s*\|\|\s*rawNeedsNav\s*\)/);
  });

  // THE REGRESSION. The arming guard must name every condition the navigate branch names.
  it('arms startSimPoll and the hold bounds for BOTH reload conditions', () => {
    const guard = SRC.match(/if\s*\(![^)]*wasReady[^)]*wasPainted[^{]*\)\s*\{\s*\n\s*startSimPoll\(/);
    expect(guard, 'could not find the arming guard that precedes startSimPoll').not.toBeNull();
    const text = guard![0];
    expect(text, 'legacyNeedsNav is not in the arming guard').toContain('legacyNeedsNav');
    expect(text,
      'rawNeedsNav reloads the document but does not arm the hold — a raw reset boots with no '
      + 'poll, no paint deadline, no poster/spinner and no stall bound')
      .toContain('rawNeedsNav');
  });

  it('a successful present-as-loaded is not reported to the parent as a failure', () => {
    const client = readFileSync(join(__dirname, '..', 'lib', 'sim', 'SimRuntimeClient.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // The parent switch treats 'script-missing' as a failure: it tears down the affordance and
    // writes a RUM failure row. The raw-presentation SUCCESS path must not use that name.
    const successBranch = client.match(/if\s*\(this\.pendingPresentAsLoaded\)\s*\{[\s\S]*?\n\s{4}\}/);
    expect(successBranch, 'could not find the presentAsLoaded success branch').not.toBeNull();
    expect(successBranch![0],
      "the success path still emits 'script-missing', so the parent's failure handler runs on it")
      .not.toContain("'script-missing'");
  });
});
