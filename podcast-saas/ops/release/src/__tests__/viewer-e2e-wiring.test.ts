import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The viewer end-to-end suite must be RUN BY SOMETHING, and it must never be pointed at production.
 *
 * `client-web/e2e/viewer-e2e.spec.ts` is the only suite that drives the real Next route, the real
 * React viewer and the real generated bridge. It was invoked by no workflow and had no npm script,
 * so the viewer's end-to-end behaviour had zero automated coverage (audit test-quality-013) while
 * looking, from the outside, like a covered surface.
 *
 * Wiring it in is only half the job. The DEFAULT playwright config in this package targets
 * `https://flowvidco.com`, so the obvious way to "run the e2e suite in CI" is also the way to point
 * a mutating browser suite at the live site. These tests encode both halves: it runs, and it runs
 * locally.
 */

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..', '..');
const WF_DIR = join(ROOT, '.github', 'workflows');
const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));
const wf = Object.fromEntries(files.map((f) => [f, readFileSync(join(WF_DIR, f), 'utf8')]));

/** Workflows that invoke the viewer suite, by whichever route (script or direct --config). */
const invoking = Object.entries(wf).filter(
  ([, text]) => text.includes('playwright.viewer.config.ts') || text.includes('test:e2e:viewer'),
);

describe('the viewer e2e suite is wired into CI', () => {
  it('at least one workflow invokes it', () => {
    expect(
      invoking.map(([name]) => name),
      'no workflow runs client-web/e2e/viewer-e2e.spec.ts — the real viewer has no automated coverage',
    ).not.toHaveLength(0);
  });

  it('it runs on pull requests, not only at release time', () => {
    // A suite that runs only during a release cannot stop a regression from being merged.
    expect(invoking.some(([name]) => name === 'ci.yml')).toBe(true);
  });

  it('the job starts the application itself rather than assuming one is already up', () => {
    for (const [name, text] of invoking) {
      expect(text, `${name} runs the viewer suite without starting an app`).toContain(
        'VIEWER_E2E_START_SERVER',
      );
    }
  });
});

describe('the viewer e2e suite is never aimed at the deployed site', () => {
  it('no workflow overrides its base URL with a non-loopback host', () => {
    const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/;
    for (const [name, text] of Object.entries(wf)) {
      for (const m of text.matchAll(/VIEWER_E2E_BASE_URL:\s*['"]?([^'"\s#]+)/g)) {
        expect(m[1], `${name} points the viewer suite at ${m[1]}`).toMatch(LOOPBACK);
      }
    }
  });

  it('no workflow runs the viewer suite through the live-site production config', () => {
    for (const [name, text] of invoking) {
      // The bare `test:smoke` / default config default to https://flowvidco.com.
      expect(text, `${name} must not run the viewer suite via test:smoke`).not.toMatch(
        /run:[^\n]*\btest:smoke\b/,
      );
      expect(text, `${name} must not aim the viewer suite at SMOKE_BASE_URL`).not.toContain(
        'SMOKE_BASE_URL: https://flowvidco.com',
      );
    }
  });
});
