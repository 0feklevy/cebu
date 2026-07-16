/**
 * Semantic Content-Security-Policy audit — parses the header into directives and
 * checks MEANING, not text. frame-src (which iframes OUR pages may load) and
 * frame-ancestors (who may embed US) are separate directives and are audited
 * separately; the Firebase-auth incident lived exactly in that distinction.
 */
import { classifyHost, hostOfUrl } from './hosts.js';
import { finding, type Finding } from './severity.js';

export type ParsedCsp = Map<string, string[]>;

export function parseCsp(header: string): ParsedCsp {
  const map: ParsedCsp = new Map();
  for (const part of header.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    if (!map.has(name)) map.set(name, tokens.slice(1)); // first occurrence wins (CSP spec)
  }
  return map;
}

export interface CspExpectation {
  /** Which app this policy belongs to (drives Stripe requirement). */
  app: 'client-web' | 'admin-web';
  apiOrigin: string;
  /** Exact https origin of the Firebase Auth iframe (from the auth domain). */
  firebaseAuthOrigin: string;
  /** Required for client-web (Stripe checkout iframe). */
  stripeOrigin?: string;
  /** true → the policy is for production; localhost/http are then forbidden. */
  production: boolean;
}

function sourceHost(source: string): string | null {
  if (source.startsWith("'")) return null; // keyword source
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return null; // scheme source (https:, data:, blob:)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? source : `https://${source}`;
  return hostOfUrl(withScheme.replace(/\*/g, 'wildcard'));
}

function isBroadWildcard(source: string): boolean {
  if (source === '*') return true;
  // Whole-host wildcards: https://*, *.com, https://*.com — a wildcard with no
  // meaningful base domain. Subdomain wildcards on a concrete domain (e.g.
  // https://*.supabase.co) are narrow and NOT flagged here.
  return /^(?:[a-z]+:\/\/)?\*(?:[:/]|$)/i.test(source) || /^\*\.[a-z]+$/i.test(source);
}

export function auditCspHeader(header: string | null | undefined, exp: CspExpectation): Finding[] {
  const app = exp.app;
  const findings: Finding[] = [];
  if (!header) {
    findings.push(
      finding(`csp.${app}.missing-header`, 'CRITICAL', 'csp', `${app}: no Content-Security-Policy header on the page response.`),
    );
    return findings;
  }
  const csp = parseCsp(header);

  // --- frame-ancestors: who may embed US (never weakened) -----------------------
  const ancestors = csp.get('frame-ancestors');
  if (!ancestors) {
    findings.push(finding(`csp.${app}.frame-ancestors.missing`, 'HIGH', 'csp', `${app}: frame-ancestors directive is missing (clickjacking exposure).`));
  } else if (!(ancestors.length === 1 && ancestors[0] === "'none'")) {
    findings.push(
      finding(`csp.${app}.frame-ancestors.weakened`, 'HIGH', 'csp', `${app}: frame-ancestors is "${ancestors.join(' ')}" — expected 'none'.`, {
        remediation: "Keep frame-ancestors 'none'; widening it must be an explicit, documented decision.",
      }),
    );
  }

  // --- frame-src: iframes OUR pages load (auth/payments/sims core flows) --------
  const frameSrc = csp.get('frame-src') ?? csp.get('child-src') ?? csp.get('default-src');
  if (!frameSrc) {
    findings.push(finding(`csp.${app}.frame-src.missing`, 'CRITICAL', 'csp', `${app}: no frame-src (or fallback) directive — iframe policy is undefined.`));
  } else {
    const required: Array<[string, string, string]> = [
      ["'self'", 'self', 'same-origin iframes'],
      [exp.apiOrigin, 'api-origin', 'simulation iframes served from /sim-public'],
      [exp.firebaseAuthOrigin, 'firebase-auth-origin', 'the Firebase Auth iframe — sign-in breaks without it'],
    ];
    if (app === 'client-web' && exp.stripeOrigin) {
      required.push([exp.stripeOrigin, 'stripe', 'the Stripe checkout iframe']);
    }
    for (const [source, key, why] of required) {
      if (!frameSrc.includes(source)) {
        findings.push(
          finding(`csp.${app}.frame-src.missing-${key}`, 'CRITICAL', 'csp', `${app}: frame-src does not allow ${source} (${why}).`, {
            detail: `frame-src is: ${frameSrc.join(' ')}`,
            remediation: 'Fix shared/src/csp.ts inputs (never widen with wildcards).',
          }),
        );
      }
    }
  }

  // --- global source hygiene ------------------------------------------------------
  for (const [directive, sources] of csp.entries()) {
    for (const source of sources) {
      if (exp.production) {
        const host = sourceHost(source);
        if (host && host !== 'wildcard') {
          const kind = classifyHost(host);
          if (kind !== 'public') {
            findings.push(
              finding(`csp.${app}.non-public-source`, 'CRITICAL', 'csp', `${app}: ${directive} allows non-public host "${source}" (${kind}) in production.`),
            );
          }
        }
        if (source === 'http:' || /^http:\/\//i.test(source)) {
          findings.push(finding(`csp.${app}.http-source`, 'CRITICAL', 'csp', `${app}: ${directive} allows plain-http source "${source}" in production.`));
        }
      }
      if (isBroadWildcard(source)) {
        findings.push(
          finding(`csp.${app}.broad-wildcard`, 'CRITICAL', 'csp', `${app}: ${directive} uses broad wildcard "${source}" — forbidden without a documented technical requirement.`),
        );
      }
    }
  }

  return findings;
}

export interface LiveCspResult {
  url: string;
  status: number | null;
  header: string | null;
  findings: Finding[];
}

/** Fetch a page and audit its CSP header. Read-only GET; never mutates production. */
export async function auditLiveCsp(
  url: string,
  exp: CspExpectation,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveCspResult> {
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
    const header = res.headers.get('content-security-policy');
    return { url, status: res.status, header, findings: auditCspHeader(header, exp) };
  } catch (err) {
    return {
      url,
      status: null,
      header: null,
      findings: [
        finding(`csp.${exp.app}.unreachable`, 'CRITICAL', 'csp', `${exp.app}: could not fetch ${url} for CSP audit.`, {
          detail: err instanceof Error ? err.message : String(err),
        }),
      ],
    };
  }
}
