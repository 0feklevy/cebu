import { lookup } from 'dns/promises';
import net from 'net';

// SSRF guard: validate that a user-supplied URL is http(s) and resolves only to
// public addresses, so server-side fetches can't be pointed at loopback, the cloud
// metadata endpoint (169.254.169.254), or other internal hosts. Ports fiji's
// UrlPreviewService.assertPublicHost pattern (DNS-rebind-aware: resolves and checks
// every A/AAAA record, not just the literal hostname).

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;          // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;          // private
  if (a === 100 && b >= 64 && b <= 127) return true;// CGNAT
  if (a >= 224) return true;                         // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80')) return true;            // link-local
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique-local fc00::/7
  if (s.startsWith('::ffff:')) return isPrivateIPv4(s.slice('::ffff:'.length));
  return false;
}

function isPrivate(ip: string): boolean {
  return net.isIPv4(ip) ? isPrivateIPv4(ip) : isPrivateIPv6(ip);
}

/**
 * Throws if `rawUrl` is not http(s) or resolves to a private/loopback/link-local
 * address. Returns the parsed URL on success. Call before any server-side fetch of
 * a user-controlled URL.
 */
export async function assertPublicHost(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    throw new Error('Host not allowed');
  }

  const ips: string[] = [];
  if (net.isIP(host)) {
    ips.push(host);
  } else {
    const records = await lookup(host, { all: true });
    for (const r of records) ips.push(r.address);
  }
  if (ips.length === 0) throw new Error('Host did not resolve');
  for (const ip of ips) {
    if (isPrivate(ip)) throw new Error('Host resolves to a private address');
  }
  return url;
}
