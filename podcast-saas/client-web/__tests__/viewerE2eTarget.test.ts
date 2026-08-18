import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEWER_E2E_BASE_URL,
  resolveViewerE2eTarget,
  shouldStartViewerE2eServer,
} from '../e2e/viewerE2eTarget';

/**
 * The viewer e2e suite drives a REAL browser through a real app: it plays media, seeks, mounts
 * pooled sim iframes and asserts on live DOM. Every other Playwright config in this package
 * defaults to `https://flowvidco.com`, so the single most damaging mistake available here is
 * pointing this suite at the deployed site — a CI suite that hits production is worse than no
 * suite (audit test-quality-013).
 *
 * So the target is not a preference the environment expresses, it is an invariant the config
 * ENFORCES: loopback, or refuse to run at all.
 */

describe('resolveViewerE2eTarget — loopback or nothing', () => {
  it('defaults to a loopback origin', () => {
    expect(resolveViewerE2eTarget({})).toBe(DEFAULT_VIEWER_E2E_BASE_URL);
    expect(DEFAULT_VIEWER_E2E_BASE_URL).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it('accepts the loopback spellings a developer or runner actually uses', () => {
    expect(resolveViewerE2eTarget({ VIEWER_E2E_BASE_URL: 'http://localhost:3000' })).toBe('http://localhost:3000');
    expect(resolveViewerE2eTarget({ VIEWER_E2E_BASE_URL: 'http://127.0.0.1:3100' })).toBe('http://127.0.0.1:3100');
    expect(resolveViewerE2eTarget({ VIEWER_E2E_BASE_URL: 'http://[::1]:3000' })).toBe('http://[::1]:3000');
  });

  it('REFUSES the production site and any other non-loopback host', () => {
    for (const bad of [
      'https://flowvidco.com',
      'https://www.flowvidco.com/projects',
      'https://api.flowvidco.com',
      'http://staging.internal:3000',
      'http://169.254.169.254',
    ]) {
      expect(() => resolveViewerE2eTarget({ VIEWER_E2E_BASE_URL: bad }), bad).toThrow(/loopback/i);
    }
  });

  it('refuses a value that is not a URL at all rather than falling back to the default', () => {
    // A silent fallback would run the suite against something the operator did not ask for.
    expect(() => resolveViewerE2eTarget({ VIEWER_E2E_BASE_URL: 'flowvidco.com' })).toThrow();
  });
});

describe('shouldStartViewerE2eServer — the audited no-webServer default is preserved', () => {
  it('is OFF unless explicitly opted in', () => {
    // Starting a second Next server clobbers the .next directory of a dev server the developer is
    // already running (audited), so this must never turn itself on — not even under CI=true.
    expect(shouldStartViewerE2eServer({})).toBe(false);
    expect(shouldStartViewerE2eServer({ CI: 'true' })).toBe(false);
  });

  it('is ON when the runner opts in', () => {
    expect(shouldStartViewerE2eServer({ VIEWER_E2E_START_SERVER: '1' })).toBe(true);
  });
});
