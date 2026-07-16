/**
 * Browser/asset audit — consumes the JSON emitted by the Playwright production
 * suite (client-web/e2e/production-audit.spec.ts) and maps observed browser
 * failures to severity findings. An HTTP-200 health check is necessary but NOT
 * sufficient; nothing is "green" until a real browser saw no critical failure.
 */
import { finding, type Finding } from './severity.js';

export interface PageAudit {
  url: string;
  status: number | null;
  consoleErrors: string[];
  consoleSecurityWarnings: string[];
  pageErrors: string[];
  cspViolations: string[];
  mixedContent: string[];
  requestsFailed: Array<{ url: string; error: string }>;
  responses5xx: Array<{ url: string; status: number }>;
  unexpected4xx: Array<{ url: string; status: number }>;
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

export function auditBrowserReport(report: BrowserAuditReport): Finding[] {
  const findings: Finding[] = [];

  for (const page of report.pages) {
    const at = `page ${page.url}`;

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

    for (const r of page.unexpected4xx) {
      findings.push(finding('browser.required-resource-4xx', 'HIGH', 'assets', `${at}: required resource returned ${r.status}: ${r.url}.`));
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

    if (page.consoleSecurityWarnings.length > 0) {
      findings.push(
        finding('browser.security-warnings', 'HIGH', 'browser', `${at}: ${page.consoleSecurityWarnings.length} security-relevant console warning(s).`, {
          detail: page.consoleSecurityWarnings.slice(0, 3).join('; '),
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

    if (page.consoleErrors.length > 0) {
      findings.push(
        finding('browser.console-errors', 'WARNING', 'browser', `${at}: ${page.consoleErrors.length} console error(s).`, {
          detail: page.consoleErrors.slice(0, 3).join('; '),
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
