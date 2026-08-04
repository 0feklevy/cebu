/**
 * The publish gate's DECISION logic, tested on the pure parts.
 *
 * `main()` is glue: read a file, print, call two services, exit. What actually protects the product
 * is the set of refusals in front of it, and every one of those is reachable from a pure function
 * here. Testing `main()` through a process spawn would mostly assert that `process.exit` exits.
 *
 * The refusal that matters most is the last one: a package may not be granted the modern path while
 * missing the posters its own failure policy offers as the FIRST recovery action. Granting it
 * publishes a promise the runtime cannot keep — the user hits a failed activation and is offered
 * "show the poster" with no poster behind it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRenditions, parseArgs, planFromReport } from '../sim-canary-publish.js';
import { CANARY_STEPS, type CanaryCaseResult, type CanaryReport } from 'shared/src/sim/canaryContract';
import { DEFAULT_PRESENTATION_CONFIG, computeConfigHash } from 'shared/src/sim/simIdentity';
import { posterIdentityString, type PosterKey } from 'shared/src/sim/posterIdentity';
import { NO_CAPABILITIES, type SimRuntimeCapabilities } from 'shared/src/sim/runtimeProtocol';

const FULL_CAPS: SimRuntimeCapabilities = {
  activationScoped: true, managedLifecycle: true, onDemandRender: true,
  contextEvents: true, suspendable: true, audioControl: true, qualityControl: true,
};

const KEY: PosterKey = {
  packageRevision: 'rev0123456789abcd',
  variantKey: 'V3A',
  configHash: computeConfigHash(DEFAULT_PRESENTATION_CONFIG),
  aspectProfile: 'wide',
  qualityProfile: 'high',
};
const IDENTITY = posterIdentityString(KEY);

function passingCase(overrides: Partial<CanaryCaseResult> = {}): CanaryCaseResult {
  return {
    case: {
      variantKey: KEY.variantKey,
      config: { ...DEFAULT_PRESENTATION_CONFIG },
      aspectProfile: 'wide',
      qualityProfile: 'high',
    },
    steps: CANARY_STEPS.map((step) => ({ step, status: 'pass' as const })),
    capabilities: FULL_CAPS,
    errors: [],
    countsAfterDispose: null,
    leaked: [],
    posterIdentity: IDENTITY,
    ...overrides,
  };
}

function report(overrides: Partial<CanaryReport> = {}): CanaryReport {
  return {
    packageRevision: KEY.packageRevision,
    simulationId: 'sim-1',
    storagePrefix: 'simulations/proj-1/sim-1',
    classification: 'managed-presentable',
    cases: [passingCase()],
    assets: [{ path: 'index.html', ok: true, status: 200, contentType: 'text/html' }],
    aborted: null,
    startedAt: '2026-08-03T00:00:00.000Z',
    finishedAt: '2026-08-03T00:01:00.000Z',
    engine: 'chromium',
    ...overrides,
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'canary-publish-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writePoster(identity: string, file: string, bytes = 'png-bytes'): void {
  const d = join(dir, identity);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), bytes);
}

describe('parseArgs', () => {
  it('requires both --report and --sim', () => {
    expect(parseArgs(['--report', 'r.json'])).toBeNull();
    expect(parseArgs(['--sim', 'sim-1'])).toBeNull();
    expect(parseArgs([])).toBeNull();
  });

  it('defaults to a DRY RUN — writing must be opted into explicitly', () => {
    const args = parseArgs(['--report', 'r.json', '--sim', 'sim-1']);
    expect(args?.apply).toBe(false);
    expect(args?.prune).toBe(false);
  });

  it('does not treat a following flag as a value', () => {
    // `--report --sim x` would otherwise resolve reportPath to the literal string '--sim'.
    const args = parseArgs(['--report', '--apply', '--sim', 'sim-1']);
    expect(args?.reportPath.endsWith('--apply')).toBe(true);
  });

  it('reads --apply and --prune', () => {
    const args = parseArgs(['--report', 'r.json', '--sim', 'sim-1', '--apply', '--prune']);
    expect(args?.apply).toBe(true);
    expect(args?.prune).toBe(true);
  });
});

describe('collectRenditions', () => {
  it('returns nothing when the identity directory does not exist', () => {
    expect(collectRenditions(dir, IDENTITY, false, 'wide')).toEqual([]);
  });

  it('reads the standard and compact renditions with the sizes the profile defines', () => {
    writePoster(IDENTITY, 'standard.png');
    writePoster(IDENTITY, 'compact.png');
    const out = collectRenditions(dir, IDENTITY, false, 'wide');
    expect(out.map((r) => r.size).sort()).toEqual(['compact', 'standard']);
    const standard = out.find((r) => r.size === 'standard')!;
    expect([standard.width, standard.height]).toEqual([1280, 720]);
    const compact = out.find((r) => r.size === 'compact')!;
    expect([compact.width, compact.height]).toEqual([640, 360]);
  });

  it('uses the PORTRAIT dimensions for a portrait aspect profile', () => {
    writePoster(IDENTITY, 'standard.png');
    const [r] = collectRenditions(dir, IDENTITY, false, 'portrait');
    expect([r.width, r.height]).toEqual([720, 1280]);
  });

  it('drops a format the transparency setting does not allow', () => {
    writePoster(IDENTITY, 'standard.webp');
    // A transparent simulation renders over video, so its cover must be PNG — a WebP rendition for
    // a transparent capture would paint an opaque rectangle over the video underneath.
    expect(collectRenditions(dir, IDENTITY, true, 'wide')).toEqual([]);
    expect(collectRenditions(dir, IDENTITY, false, 'wide')).toHaveLength(1);
  });

  it('ignores files that are not renditions and sizes the profile does not define', () => {
    writePoster(IDENTITY, 'standard.png');
    writePoster(IDENTITY, 'notes.txt');
    writePoster(IDENTITY, 'gigantic.png');
    expect(collectRenditions(dir, IDENTITY, false, 'wide')).toHaveLength(1);
  });

  it('stamps transparency onto every rendition it returns', () => {
    writePoster(IDENTITY, 'standard.png');
    expect(collectRenditions(dir, IDENTITY, true, 'wide')[0].transparent).toBe(true);
  });
});

describe('planFromReport', () => {
  it('grants the modern path for a clean report whose posters are present', () => {
    writePoster(IDENTITY, 'standard.png');
    writePoster(IDENTITY, 'compact.png');
    const plan = planFromReport(report(), dir);
    expect(plan.classification).toBe('managed-presentable');
    expect(plan.mayPublishAsModern).toBe(true);
    expect(plan.missingPosters).toEqual([]);
    expect(plan.posters).toEqual([{ identity: IDENTITY, renditions: 2 }]);
  });

  it('reports the missing poster when the capture is absent — the case a grant must not survive', () => {
    const plan = planFromReport(report(), dir);
    expect(plan.mayPublishAsModern).toBe(true);
    expect(plan.missingPosters).toEqual([IDENTITY]);
    // main() turns exactly this combination into EXIT.POSTERS_MISSING. Asserting both halves here
    // is what pins the refusal: a plan that says "grant" and "missing" together is the input the
    // gate exists to reject.
  });

  it('names the case when the report recorded no poster identity at all', () => {
    const plan = planFromReport(report({ cases: [passingCase({ posterIdentity: null })] }), dir);
    expect(plan.missingPosters[0]).toContain(KEY.variantKey);
  });

  it('withholds the modern path for an aborted run and says why', () => {
    const plan = planFromReport(
      report({ aborted: { reason: 'browser crashed' }, classification: 'failed' }),
      dir,
    );
    expect(plan.classification).toBe('failed');
    expect(plan.mayPublishAsModern).toBe(false);
    expect(plan.reasons.join(' ')).toMatch(/abort|crash/i);
  });

  it('withholds the modern path for a package with no handshake', () => {
    const plan = planFromReport(
      report({
        classification: 'legacy-cooperative',
        cases: [passingCase({ capabilities: { ...NO_CAPABILITIES } })],
      }),
      dir,
    );
    expect(plan.mayPublishAsModern).toBe(false);
  });

  it('withholds the modern path when the stamped classification is a forgery', () => {
    // The stamp says managed-presentable; the steps say otherwise. Trusting the stamp would make
    // publishing a package a matter of editing one string in a JSON file.
    const cases = [passingCase({
      steps: CANARY_STEPS.map((step) => ({
        step,
        status: step === 'section-presented' ? ('fail' as const) : ('pass' as const),
      })),
    })];
    const plan = planFromReport(report({ cases, classification: 'managed-presentable' }), dir);
    expect(plan.mayPublishAsModern).toBe(false);
  });

  it('carries the package revision through, so posters and the verdict agree on what was certified', () => {
    writePoster(IDENTITY, 'standard.png');
    const plan = planFromReport(report(), dir);
    expect(plan.packageRevision).toBe(KEY.packageRevision);
  });

  it('does not confuse two cases that differ only in quality profile', () => {
    const otherKey: PosterKey = { ...KEY, qualityProfile: 'low' };
    const otherIdentity = posterIdentityString(otherKey);
    expect(otherIdentity).not.toBe(IDENTITY);
    writePoster(IDENTITY, 'standard.png');
    writePoster(otherIdentity, 'standard.png');

    const plan = planFromReport(
      report({
        cases: [
          passingCase(),
          passingCase({
            case: {
              variantKey: KEY.variantKey,
              config: { ...DEFAULT_PRESENTATION_CONFIG },
              aspectProfile: 'wide',
              qualityProfile: 'low',
            },
            posterIdentity: otherIdentity,
          }),
        ],
      }),
      dir,
    );
    expect(plan.posters.map((p) => p.identity).sort()).toEqual([IDENTITY, otherIdentity].sort());
    expect(plan.missingPosters).toEqual([]);
  });
});
