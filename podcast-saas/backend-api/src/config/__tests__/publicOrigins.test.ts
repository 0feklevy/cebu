import { describe, it, expect, afterEach } from 'vitest';
import {
  publicApiOrigin,
  appOrigin,
  adminOrigin,
  browserOrigins,
  isNonPublicUrl,
  assertPublicOriginsForProd,
  hijackedReplyCorsHeaders,
} from '../publicOrigins.js';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

function setEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('isNonPublicUrl', () => {
  it('flags localhost/loopback and internal docker hosts', () => {
    for (const u of [
      'http://localhost:8080/local-storage/x.png',
      'https://localhost/sim-public/x',
      'http://127.0.0.1:8080/a',
      'http://0.0.0.0:3000/a',
      'http://backend:8080/api',
      'http://client-web:3000/',
    ]) {
      expect(isNonPublicUrl(u)).toBe(true);
    }
  });

  it('accepts real public origins', () => {
    for (const u of [
      'https://api.flowvidco.com/sim-public/x',
      'https://flowvidco.com/',
      'https://abc123.supabase.co/storage/v1/object/public/media/x.png',
    ]) {
      expect(isNonPublicUrl(u)).toBe(false);
    }
  });
});

describe('production origin resolution', () => {
  it('DEV: builders fall back to localhost when unset', () => {
    setEnv({ NODE_ENV: 'development', BACKEND_API_URL: undefined, NEXT_PUBLIC_APP_URL: undefined, ADMIN_ORIGIN: undefined });
    expect(publicApiOrigin()).toBe('http://localhost:8080');
    expect(appOrigin()).toBe('http://localhost:3000');
    expect(adminOrigin()).toBe('http://localhost:3001');
    expect(browserOrigins()).toContain('http://localhost:3000');
    expect(browserOrigins()).toContain('http://localhost:3001');
  });

  it('PROD: builders return the configured https origins (never localhost)', () => {
    setEnv({
      NODE_ENV: 'production',
      BACKEND_API_URL: 'https://api.flowvidco.com',
      NEXT_PUBLIC_APP_URL: 'https://flowvidco.com',
      ADMIN_ORIGIN: 'https://admin.flowvidco.com',
    });
    expect(publicApiOrigin()).toBe('https://api.flowvidco.com');
    expect(appOrigin()).toBe('https://flowvidco.com');
    const origins = browserOrigins();
    expect(origins).toEqual(['https://flowvidco.com', 'https://admin.flowvidco.com']);
    expect(origins.some((o) => o.includes('localhost'))).toBe(false);
  });

  it('PROD: a required origin that is unset throws (fail closed)', () => {
    setEnv({ NODE_ENV: 'production', BACKEND_API_URL: undefined });
    expect(() => publicApiOrigin()).toThrow(/required in production/i);
  });
});

describe('assertPublicOriginsForProd', () => {
  it('passes with real https origins', () => {
    setEnv({
      NODE_ENV: 'production',
      BACKEND_API_URL: 'https://api.flowvidco.com',
      NEXT_PUBLIC_APP_URL: 'https://flowvidco.com',
      ADMIN_ORIGIN: 'https://admin.flowvidco.com',
    });
    expect(() => assertPublicOriginsForProd()).not.toThrow();
  });

  it('throws when a browser-visible origin is localhost/unset/http in production', () => {
    setEnv({ NODE_ENV: 'production', BACKEND_API_URL: 'http://localhost:8080', NEXT_PUBLIC_APP_URL: 'https://flowvidco.com' });
    expect(() => assertPublicOriginsForProd()).toThrow(/localhost/i);

    setEnv({ NODE_ENV: 'production', BACKEND_API_URL: undefined, NEXT_PUBLIC_APP_URL: 'https://flowvidco.com' });
    expect(() => assertPublicOriginsForProd()).toThrow(/unset/i);

    setEnv({ NODE_ENV: 'production', BACKEND_API_URL: 'http://api.flowvidco.com', NEXT_PUBLIC_APP_URL: 'https://flowvidco.com' });
    expect(() => assertPublicOriginsForProd()).toThrow(/https/i);
  });

  it('is a no-op outside production', () => {
    setEnv({ NODE_ENV: 'development', BACKEND_API_URL: undefined, NEXT_PUBLIC_APP_URL: undefined });
    expect(() => assertPublicOriginsForProd()).not.toThrow();
  });
});


describe('hijackedReplyCorsHeaders — the header @fastify/cors never gets to send', () => {
  // reply.hijack() (the voice-question SSE stream, the one route in the app that calls it) skips
  // Fastify's own send pipeline, which is also the pipeline that would have written the header
  // the cors plugin computed in its onRequest hook. This is the hand-written substitute, and it
  // has to agree with the plugin's own policy exactly, or the substitute is just a different bug.
  const ENV = { ...process.env };
  afterEach(() => { process.env = { ...ENV }; });

  it('reflects the origin when it is in browserOrigins()', () => {
    setEnv({ NODE_ENV: 'production', BACKEND_API_URL: 'https://api.flowvidco.com', NEXT_PUBLIC_APP_URL: 'https://flowvidco.com', ADMIN_ORIGIN: undefined });
    expect(browserOrigins()).toContain('https://flowvidco.com');
    expect(hijackedReplyCorsHeaders('https://flowvidco.com')).toEqual({
      'Access-Control-Allow-Origin': 'https://flowvidco.com',
      Vary: 'Origin',
    });
  });

  it('omits Allow-Origin for a caller that is not one of ours, but still varies on Origin', () => {
    setEnv({ NODE_ENV: 'production', BACKEND_API_URL: 'https://api.flowvidco.com', NEXT_PUBLIC_APP_URL: 'https://flowvidco.com', ADMIN_ORIGIN: undefined });
    expect(hijackedReplyCorsHeaders('https://evil.example.com')).toEqual({ Vary: 'Origin' });
  });

  it('never reflects an origin with no Origin header at all', () => {
    expect(hijackedReplyCorsHeaders(undefined)).toEqual({ Vary: 'Origin' });
  });

  it('covers the admin origin too, when one is configured', () => {
    setEnv({ NODE_ENV: 'production', BACKEND_API_URL: 'https://api.flowvidco.com', NEXT_PUBLIC_APP_URL: 'https://flowvidco.com', ADMIN_ORIGIN: 'https://admin.flowvidco.com' });
    expect(hijackedReplyCorsHeaders('https://admin.flowvidco.com')).toEqual({
      'Access-Control-Allow-Origin': 'https://admin.flowvidco.com',
      Vary: 'Origin',
    });
  });
});
