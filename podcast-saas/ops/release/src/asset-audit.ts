/**
 * Browser/asset audit — consumes the JSON emitted by the Playwright production
 * suite (client-web/e2e/production-audit.spec.ts) and maps observed browser
 * failures to severity findings. An HTTP-200 health check is necessary but NOT
 * sufficient; nothing is "green" until a real browser saw no critical failure.
 *
 * 4xx classification is CONTEXT-AWARE (incident: production-audit run
 * 29528323804 flagged expected anonymous 401s from auth-required API routes as
 * broken required resources):
 *   - 401/403/404 on static resources (image/media/stylesheet/script/font) → HIGH, always;
 *   - 401/403 on an explicitly-listed PROTECTED first-party API route (fetch/XHR)
 *     during an ANONYMOUS audit → expected authentication rejection → INFO diagnostic;
 *   - the same 401/403 after the audit has AUTHENTICATED → HIGH;
 *   - any 4xx on a declared public/required API route → HIGH;
 *   - 404s are never downgraded; 5xx / localhost / mixed content / CSP keep their
 *     existing (blocking) severities.
 * The protected-route list is explicit (see config.ts) — no blanket /api/v1 rule.
 */
import { RELEASE_CONFIG, type ReleaseConfig } from './config.js';
import { hostOfUrl } from './hosts.js';
import { finding, type Finding } from './severity.js';

export type AuditAuthContext = 'anonymous' | 'authenticated';

export interface PageAudit {
  url: string;
  status: number | null;
  /** Auth context the page was audited under. Absent (old reports) → anonymous. */
  authContext?: AuditAuthContext;
  consoleErrors: string[];
  consoleSecurityWarnings: string[];
  pageErrors: string[];
  cspViolations: string[];
  mixedContent: string[];
  requestsFailed: Array<{ url: string; error: string }>;
  responses5xx: Array<{ url: string; status: number }>;
  unexpected4xx: Array<{ url: string; status: number; type?: string }>;
  /** Pre-classified by the spec: protected-route 401/403 while anonymous. */
  expectedAuthRejections?: Array<{ url: string; status: number }>;
  /** Exactly-matched known-benign browser messages (e.g. the Firebase COOP poll). */
  knownBenignWarnings?: string[];
  nonPublicRequests: Array<{ url: string; kind: string }>;
  brokenImages: string[];
  iframes: string[];
  serviceWorkers: number;
}

export interface BrowserAuditReport {
  schema: 'flowvid.browser-audit/v1';
  baseUrl: string;
  generatedAt?: string;
  pages: PageAudit[];
}

export function parseBrowserAudit(json: string): BrowserAuditReport {
  const r = JSON.parse(json) as BrowserAuditReport;
  if (r.schema !== 'flowvid.browser-audit/v1') {
    throw new Error(`Unknown browser-audit schema: ${String((r as { schema?: unknown }).schema)}`);
  }
  return r;
}

/** CSP violations against these are broken CORE flows (auth, payments, sims). */
const CORE_CSP = /(firebaseapp\.com|stripe\.com|frame-src|api\.flowvidco\.com)/i;

/**
 * The exact, known-benign Chrome message emitted while Firebase signInWithPopup
 * polls popup.closed against Google's sign-in popup (which serves
 * Cross-Origin-Opener-Policy: same-origin-allow-popups). Verified 2026-07-16:
 * neither flowvidco.com nor the Firebase auth iframe origin send any COOP header,
 * and the popup/iframe flow is functional (see csp-audit's COOP guard, which
 * flags a strict COOP on OUR pages — the case that WOULD break the flow).
 */
export const COOP_WINDOW_CLOSED_RE = /Cross-Origin-Opener-Policy policy would block the window\.closed call/i;

/** Browser-generated console line for a failed network resource with 401/403. */
const CONSOLE_AUTH_LOAD_FAILURE_RE = /Failed to load resource:.*\b(401|403)\b/i;

/** Static resource types whose 4xx is a broken page regardless of auth context. */
const STATIC_RESOURCE_TYPES = new Set(['image', 'media', 'stylesheet', 'script', 'font']);

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0];
  }
}

function isFirstPartyApi(url: string, config: ReleaseConfig): boolean {
  return hostOfUrl(url) === hostOfUrl(config.endpoints.api);
}

export function isProtectedApiRoute(url: string, config: ReleaseConfig): boolean {
  if (!isFirstPartyApi(url, config)) return false;
  const path = pathOf(url);
  return config.api.protectedRoutes.some((re) => re.test(path));
}

export function isRequiredPublicApiRoute(url: string, config: ReleaseConfig): boolean {
  if (!isFirstPartyApi(url, config)) return false;
  const path = pathOf(url);
  return config.api.requiredPublicRoutes.some((re) => re.test(path));
}

export type FourXxClass = 'expected-auth-rejection' | 'required-resource-failure';

/**
 * Deterministic 4xx classifier. Only 401/403, only fetch/XHR (or untyped legacy
 * entries), only explicitly-listed protected routes, and only while ANONYMOUS
 * are downgraded to an expected rejection. Everything else stays a failure.
 */
export function classify4xx(
  entry: { url: string; status: number; type?: string },
  authContext: AuditAuthContext,
  config: ReleaseConfig,
): FourXxClass {
  if (entry.status !== 401 && entry.status !== 403) return 'required-resource-failure';
  if (entry.type !== undefined && STATIC_RESOURCE_TYPES.has(entry.type)) return 'required-resource-failure';
  if (authContext !== 'anonymous') return 'required-resource-failure';
  if (isRequiredPublicApiRoute(entry.url, config)) return 'required-resource-failure';
  if (!isProtectedApiRoute(entry.url, config)) return 'required-resource-failure';
  return 'expected-auth-rejection';
}

export function auditBrowserReport(report: BrowserAuditReport, config: ReleaseConfig = RELEASE_CONFIG): Finding[] {
  const findings: Finding[] = [];

  for (const page of report.pages) {
    const at = `page ${page.url}`;
    const authContext: AuditAuthContext = page.authContext ?? 'anonymous';

    if (page.status === null || (page.status !== null && page.status >= 500)) {
      findings.push(
        finding('browser.page-unavailable', 'CRITICAL', 'browser', `${at}: page unavailable (status ${page.status ?? 'unreachable'}).`),
      );
    }

    if (page.nonPublicRequests.length > 0) {
      findings.push(
        finding('browser.non-public-request', 'CRITICAL', 'browser', `${at}: browser issued ${page.nonPublicRequests.length} request(s) to localhost/private/docker hosts.`, {
          detail: page.nonPublicRequests.slice(0, 5).map((r) => `${r.url} (${r.kind})`).join('; '),
        }),
      );
    }

    for (const v of page.cspViolations) {
      findings.push(
        finding(CORE_CSP.test(v) ? 'browser.csp-core-flow-blocked' : 'browser.csp-violation', CORE_CSP.test(v) ? 'CRITICAL' : 'HIGH', 'csp', `${at}: CSP violation.`, {
          detail: v,
        }),
      );
    }

    if (page.mixedContent.length > 0) {
      findings.push(
        finding('browser.mixed-content', 'CRITICAL', 'browser', `${at}: ${page.mixedContent.length} mixed-content violation(s).`, {
          detail: page.mixedContent.slice(0, 5).join('; '),
        }),
      );
    }

    for (const r of page.responses5xx) {
      findings.push(finding('browser.http-5xx', 'HIGH', 'browser', `${at}: HTTP ${r.status} from ${r.url}.`));
    }

    // ── Context-aware 4xx classification ─────────────────────────────────────
    const expectedRejections: Array<{ url: string; status: number }> = [...(page.expectedAuthRejections ?? [])];
    for (const r of page.unexpected4xx) {
      if (classify4xx(r, authContext, config) === 'expected-auth-rejection') {
        expectedRejections.push({ url: r.url, status: r.status });
      } else {
        findings.push(finding('browser.required-resource-4xx', 'HIGH', 'assets', `${at}: required resource returned ${r.status}: ${r.url}.`));
      }
    }

    // Correlate the browser's own "Failed to load resource … 401/403" console lines
    // with the expected rejections so ONE expected event cannot surface twice
    // (once as a 4xx finding, once as console noise). At most one console line per
    // rejection is absorbed; every other console error is preserved untouched.
    let consoleErrors = page.consoleErrors;
    let absorbedConsole = 0;
    if (expectedRejections.length > 0) {
      const kept: string[] = [];
      for (const msg of consoleErrors) {
        if (absorbedConsole < expectedRejections.length && CONSOLE_AUTH_LOAD_FAILURE_RE.test(msg)) {
          absorbedConsole += 1;
        } else {
          kept.push(msg);
        }
      }
      consoleErrors = kept;
    }

    if (expectedRejections.length > 0) {
      findings.push(
        finding('browser.expected-auth-rejection', 'INFO', 'browser', `${at}: ${expectedRejections.length} expected authentication rejection(s) from protected API routes during an ${authContext} audit (diagnostic, non-blocking).`, {
          detail: expectedRejections.slice(0, 5).map((r) => `${r.status} ${r.url}`).join('; ') + (absorbedConsole > 0 ? ` (+${absorbedConsole} matching console line(s) absorbed)` : ''),
        }),
      );
    }

    // ── Known-benign browser messages (exact matches only) ───────────────────
    const benign: string[] = [...(page.knownBenignWarnings ?? [])];
    const isBenign = (m: string) => COOP_WINDOW_CLOSED_RE.test(m);
    const security = page.consoleSecurityWarnings.filter((m) => {
      if (isBenign(m)) {
        benign.push(m);
        return false;
      }
      return true;
    });
    consoleErrors = consoleErrors.filter((m) => {
      if (isBenign(m)) {
        benign.push(m);
        return false;
      }
      return true;
    });
    if (benign.length > 0) {
      findings.push(
        finding('browser.known-benign-warning', 'INFO', 'browser', `${at}: ${benign.length} known-benign browser message(s) (Firebase signInWithPopup COOP poll).`, {
          detail: benign[0],
        }),
      );
    }

    if (page.brokenImages.length > 0) {
      findings.push(
        finding('browser.broken-images', 'HIGH', 'assets', `${at}: ${page.brokenImages.length} image(s) failed to render (thumbnails/banners/avatars).`, {
          detail: page.brokenImages.slice(0, 5).join('; '),
        }),
      );
    }

    if (page.pageErrors.length > 0) {
      findings.push(
        finding('browser.page-errors', 'HIGH', 'browser', `${at}: ${page.pageErrors.length} uncaught page error(s).`, {
          detail: page.pageErrors.slice(0, 3).join('; '),
        }),
      );
    }

    if (security.length > 0) {
      findings.push(
        finding('browser.security-warnings', 'HIGH', 'browser', `${at}: ${security.length} security-relevant console warning(s).`, {
          detail: security.slice(0, 3).join('; '),
        }),
      );
    }

    if (page.requestsFailed.length > 0) {
      findings.push(
        finding('browser.requests-failed', 'WARNING', 'browser', `${at}: ${page.requestsFailed.length} network request(s) failed.`, {
          detail: page.requestsFailed.slice(0, 5).map((r) => `${r.url}: ${r.error}`).join('; '),
        }),
      );
    }

    if (consoleErrors.length > 0) {
      findings.push(
        finding('browser.console-errors', 'WARNING', 'browser', `${at}: ${consoleErrors.length} console error(s).`, {
          detail: consoleErrors.slice(0, 3).join('; '),
        }),
      );
    }

    if (page.serviceWorkers > 0) {
      findings.push(finding('browser.stale-service-worker', 'WARNING', 'browser', `${at}: ${page.serviceWorkers} service worker(s) still registered — the app ships none.`));
    }
  }

  return findings;
}

export interface AssetCheckResult {
  url: string;
  status: number | null;
  ok: boolean;
}

/** HEAD-check a list of asset URLs (read-only). */
export async function headCheckAssets(urls: string[], fetchImpl: typeof fetch = fetch): Promise<AssetCheckResult[]> {
  const out: AssetCheckResult[] = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
      out.push({ url, status: res.status, ok: res.ok });
    } catch {
      out.push({ url, status: null, ok: false });
    }
  }
  return out;
}
