import { describe, expect, it } from 'vitest';
import { classifyHost, findNonPublicUrls, isInsecureHttpUrl, isNonPublicUrl } from '../hosts.js';

describe('classifyHost', () => {
  it('flags loopback in all spellings', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(classifyHost(h), h).toBe('loopback');
    }
  });

  it('flags unspecified addresses', () => {
    expect(classifyHost('0.0.0.0')).toBe('unspecified');
    expect(classifyHost('::')).toBe('unspecified');
  });

  it('flags RFC1918 private IPv4 ranges', () => {
    for (const h of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.9.9', '192.168.1.50']) {
      expect(classifyHost(h), h).toBe('private');
    }
    for (const h of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1']) {
      expect(classifyHost(h), h).toBe('public');
    }
  });

  it('flags docker compose service names', () => {
    for (const h of ['backend', 'worker', 'nginx', 'client-web', 'admin-web']) {
      expect(classifyHost(h), h).toBe('docker-service');
    }
  });

  it('treats real production hosts as public', () => {
    for (const h of ['flowvidco.com', 'api.flowvidco.com', 'cebu-1a10f.firebaseapp.com', 'js.stripe.com', '44.225.68.155']) {
      expect(classifyHost(h), h).toBe('public');
    }
  });

  it('flags link-local', () => {
    expect(classifyHost('169.254.169.254')).toBe('link-local');
    expect(classifyHost('fe80::1')).toBe('link-local');
  });
});

describe('isNonPublicUrl', () => {
  it('matches the incident URL shapes', () => {
    expect(isNonPublicUrl('http://localhost:8080/local-storage/thumbnails/x.png')).toBe(true);
    expect(isNonPublicUrl('http://localhost:8080/local-storage/playlist-banners/y.png')).toBe(true);
    expect(isNonPublicUrl('http://localhost:8080/sim-public/z/index.html')).toBe(true);
    expect(isNonPublicUrl('http://backend:8080/health')).toBe(true);
  });

  it('passes valid cloud URLs', () => {
    expect(isNonPublicUrl('https://api.flowvidco.com/sim-public/z/index.html')).toBe(false);
    expect(isNonPublicUrl('https://abc.supabase.co/storage/v1/object/public/media/x.png')).toBe(false);
  });

  it('is false for unparseable strings', () => {
    expect(isNonPublicUrl('not a url')).toBe(false);
  });
});

describe('isInsecureHttpUrl (mixed content)', () => {
  it('flags plain http to public hosts only', () => {
    expect(isInsecureHttpUrl('http://example.com/a.js')).toBe(true);
    expect(isInsecureHttpUrl('https://example.com/a.js')).toBe(false);
    // localhost http is reported as non-public, not as mixed content.
    expect(isInsecureHttpUrl('http://localhost:8080/a.js')).toBe(false);
  });
});

describe('findNonPublicUrls', () => {
  it('scans text for every non-public class', () => {
    const text = `
      ok https://flowvidco.com/x
      bad http://localhost:8080/local-storage/a.png
      bad https://backend:8080/internal
      bad http://192.168.1.10/asset
      bad http://0.0.0.0:3000/
    `;
    const hits = findNonPublicUrls(text);
    expect(hits.map((h) => h.kind).sort()).toEqual(['docker-service', 'loopback', 'private', 'unspecified']);
  });
});
