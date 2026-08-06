/**
 * LOOPBACK-ONLY ENFORCEMENT for browser gates that claim to run against a local stack.
 *
 * A suite that merely POINTS at localhost proves nothing about where the page then went: one
 * absolute URL baked into a fixture, one analytics beacon, one CDN font, and the run is quietly
 * touching the public internet while reporting green. This aborts any such request and fails the
 * test with the offending host named, so the claim "nothing left loopback" is enforced rather than
 * asserted.
 *
 * Non-http schemes (data:, blob:, about:, filesystem:) are allowed: they never leave the process.
 */
import type { Page, TestInfo } from '@playwright/test';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Schemes that cannot reach a network peer. */
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:', 'filesystem:', 'chrome:', 'webkit:']);

export interface NetworkGuard {
  /** Every host the page actually contacted, in first-seen order. */
  hosts(): string[];
  /** Non-loopback hosts that were blocked. Empty is the passing condition. */
  violations(): string[];
  /** Throws with a precise message if anything left loopback. */
  assertLoopbackOnly(): void;
}

export function installLoopbackGuard(page: Page, testInfo?: TestInfo): NetworkGuard {
  const seen: string[] = [];
  const bad: string[] = [];

  void page.route('**/*', async (route) => {
    const url = route.request().url();
    const scheme = url.slice(0, url.indexOf(':') + 1);
    if (LOCAL_SCHEMES.has(scheme)) return route.continue();

    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      // An unparseable URL is not something a loopback-only run should be issuing.
      if (!bad.includes(url)) bad.push(url);
      return route.abort('blockedbyclient');
    }

    if (!seen.includes(host)) seen.push(host);
    if (LOOPBACK.has(host)) return route.continue();

    if (!bad.includes(host)) bad.push(host);
    // Aborted, not continued: a violation must not be able to succeed even once, because the
    // response could change what the rest of the test observes.
    if (testInfo) testInfo.annotations.push({ type: 'network-violation', description: host });
    return route.abort('blockedbyclient');
  });

  const guard: NetworkGuard = {
    hosts: () => [...seen],
    violations: () => [...bad],
    assertLoopbackOnly: () => {
      if (bad.length > 0) {
        throw new Error(
          `network guard: request(s) left loopback — ${bad.join(', ')}. `
          + `All hosts observed: ${seen.join(', ') || '(none)'}`,
        );
      }
    },
  };
  return guard;
}
