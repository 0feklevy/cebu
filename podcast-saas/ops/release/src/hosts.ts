/**
 * Host classification shared by every audit: which hosts must never appear in a
 * production browser context (bundles, CSP headers, DB URL columns, live requests).
 *
 * Non-public classes:
 *   loopback        localhost, *.localhost, 127.0.0.0/8, ::1
 *   unspecified     0.0.0.0, ::
 *   private         RFC1918 IPv4 (10/8, 172.16/12, 192.168/16), fc00::/7
 *   link-local      169.254.0.0/16, fe80::/10
 *   docker-service  compose service names (backend, worker, nginx, client-web, admin-web)
 */
import { DOCKER_SERVICE_HOSTS } from './config.js';

export type HostClass = 'public' | 'loopback' | 'unspecified' | 'private' | 'link-local' | 'docker-service';

const DOCKER_HOSTS = new Set<string>(DOCKER_SERVICE_HOSTS);

export function classifyHost(rawHost: string): HostClass {
  const host = rawHost.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return 'public';

  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (host === '::1') return 'loopback';
  if (host === '::' || host === '0.0.0.0') return 'unspecified';
  if (DOCKER_HOSTS.has(host)) return 'docker-service';

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127) return 'loopback';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    return 'public';
  }

  if (/^fe80:/i.test(host)) return 'link-local';
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return 'private';

  return 'public';
}

export function isNonPublicHost(host: string): boolean {
  return classifyHost(host) !== 'public';
}

export function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** True when the URL parses and its host is loopback/private/docker-internal. */
export function isNonPublicUrl(url: string): boolean {
  const host = hostOfUrl(url);
  return host !== null && isNonPublicHost(host);
}

/** True for a plain-http URL to a PUBLIC host — mixed content on an https page. */
export function isInsecureHttpUrl(url: string): boolean {
  const host = hostOfUrl(url);
  return host !== null && url.toLowerCase().startsWith('http://') && !isNonPublicHost(host);
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>()\\]+/gi;

export interface UrlHit {
  url: string;
  host: string;
  kind: HostClass;
}

/** Scan arbitrary text (bundle excerpts, headers, JSON) for non-public URLs. */
export function findNonPublicUrls(text: string): UrlHit[] {
  const hits: UrlHit[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    const host = hostOfUrl(url);
    if (!host) continue;
    const kind = classifyHost(host);
    if (kind !== 'public') hits.push({ url, host, kind });
  }
  return hits;
}
