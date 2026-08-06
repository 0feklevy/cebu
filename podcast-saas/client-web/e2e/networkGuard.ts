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

/** Why one URL was admitted or refused. `host` is null exactly when no hostname was parsed. */
export type GuardVerdict =
  | { allow: true; why: 'local-scheme'; host: null }
  | { allow: true; why: 'loopback'; host: string }
  | { allow: false; why: 'non-loopback'; host: string }
  | { allow: false; why: 'unparseable'; host: null };

/**
 * The guard's entire admission rule, as a pure function. It lived inline in the route closure,
 * where no unit test could reach it and no mutation could be cheaply killed — the same defect the
 * hermeticity predicate had before `hermeticHosts.ts`. The route handler below applies this
 * verdict verbatim; it adds recording and abortion, never policy.
 */
export function classifyGuardUrl(url: string): GuardVerdict {
  const scheme = url.slice(0, url.indexOf(':') + 1);
  if (LOCAL_SCHEMES.has(scheme)) return { allow: true, why: 'local-scheme', host: null };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // An unparseable URL is not something a loopback-only run should be issuing.
    return { allow: false, why: 'unparseable', host: null };
  }
  if (LOOPBACK.has(host)) return { allow: true, why: 'loopback', host };
  return { allow: false, why: 'non-loopback', host };
}

export async function installLoopbackGuard(page: Page, testInfo?: TestInfo): Promise<NetworkGuard> {
  const seen: string[] = [];
  const bad: string[] = [];

  // AWAITED. `page.route` round-trips to the browser to enable interception; returning before it
  // resolves left a window in which the very first navigation could be dispatched unintercepted —
  // and the first thing every test does is page.goto.
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    const verdict = classifyGuardUrl(url);
    if (verdict.why === 'local-scheme') return route.continue();
    if (verdict.host !== null && !seen.includes(verdict.host)) seen.push(verdict.host);
    if (verdict.allow) return route.continue();

    // The marker recorded for an unparseable URL is sanitized to scheme+path, never a query
    // string, which could carry a token into a diagnostic line.
    const marker = verdict.host ?? url.split('?')[0]!.slice(0, 100);
    if (!bad.includes(marker)) bad.push(marker);
    // Aborted, not continued: a violation must not be able to succeed even once, because the
    // response could change what the rest of the test observes.
    if (testInfo) testInfo.annotations.push({ type: 'network-violation', description: marker });
    return route.abort('blockedbyclient');
  });

  // ROUTE HANDLERS DO NOT SEE REDIRECT HOPS. Playwright calls the handler only for the first URL
  // when the response is a redirect, so a 302 from a loopback URL to a remote host would be
  // followed without ever reaching the code above. Responses are therefore observed independently:
  // anything that RESOLVED off-loopback is recorded as a violation even though it was never routed.
  page.on('response', (res) => {
    let host: string;
    try { host = new URL(res.url()).hostname; } catch { return; }
    if (!seen.includes(host)) seen.push(host);
    if (!LOOPBACK.has(host) && !bad.includes(host)) {
      bad.push(host);
      if (testInfo) testInfo.annotations.push({ type: 'network-violation-redirect', description: host });
    }
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
