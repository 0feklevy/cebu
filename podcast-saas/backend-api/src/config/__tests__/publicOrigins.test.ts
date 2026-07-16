import { describe, it, expect, afterEach } from 'vitest';
import {
  publicApiOrigin,
  appOrigin,
  adminOrigin,
  browserOrigins,
  isNonPublicUrl,
  assertPublicOriginsForProd,
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
