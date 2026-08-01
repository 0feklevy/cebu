// jsdom (vitest default env per vitest.config.ts) — SSR behavior is covered in
// simUrl.ssr.test.ts under the node environment.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSimUrl, __resetDprSnapshotForTests } from './simUrl';
import { SIM_DESTROY_GRACE_DESKTOP_MS, SIM_DESTROY_GRACE_LOW_MS, simDestroyGraceMs } from './simLifecycle';

const touched: Array<{ target: object; key: string }> = [];

function stub(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  touched.push({ target, key });
}

beforeEach(() => {
  // dpr is SNAPSHOTTED once per page (a live value silently reloaded resident iframes on
  // zoom/monitor changes — audited); tests reset the snapshot to observe their own stub.
  __resetDprSnapshotForTests();
});

afterEach(() => {
  // Deleting the own property restores any prototype-provided value (jsdom defaults).
  for (const { target, key } of touched.splice(0)) Reflect.deleteProperty(target, key);
  __resetDprSnapshotForTests();
});

function params(href: string): URLSearchParams {
  return new URL(href).searchParams;
}

// Mirror of the module's API_BASE resolution — release verification runs these
// tests under production-like env (NEXT_PUBLIC_API_URL set), so expectations
// must derive the origin the same way instead of hard-coding localhost.
const EXPECTED_API_ORIGIN = new URL(
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080',
  'http://localhost:3000/',
).origin;

describe('resolveSimUrl origin rebase', () => {
  it('rebases a /sim-public/ URL saved under a FOREIGN origin onto the current API origin', () => {
    const out = new URL(resolveSimUrl('https://foreign-env.example.com/sim-public/simulations/p1/s1/index.html?section=abc&v=9'));
    expect(out.origin).toBe(EXPECTED_API_ORIGIN);
    expect(out.pathname).toBe('/sim-public/simulations/p1/s1/index.html');
    expect(out.searchParams.get('section')).toBe('abc');
    expect(out.searchParams.get('v')).toBe('9');
  });

  it('leaves same-origin /sim-public/ URLs on their origin', () => {
    const out = new URL(resolveSimUrl(`${EXPECTED_API_ORIGIN}/sim-public/simulations/p1/s1/index.html`));
    expect(out.origin).toBe(EXPECTED_API_ORIGIN);
  });

  it('never rebases non-sim-public paths', () => {
    const out = new URL(resolveSimUrl('https://cdn.example.com/sims/abc/index.html'));
    expect(out.origin).toBe('https://cdn.example.com');
  });
});

describe('resolveSimUrl', () => {
  it('always appends dpr and preserves existing query params', () => {
    stub(window, 'devicePixelRatio', 2);
    const out = params(resolveSimUrl('https://cdn.example.com/sims/abc/index.html?v=7&foo=bar'));
    expect(out.get('v')).toBe('7');
    expect(out.get('foo')).toBe('bar');
    expect(out.get('dpr')).toBe('2');
  });

  it('caps dpr at 3 and rounds to 2 decimals', () => {
    stub(window, 'devicePixelRatio', 3.75);
    expect(params(resolveSimUrl('https://x.test/a.html')).get('dpr')).toBe('3');

    __resetDprSnapshotForTests();          // snapshot-per-page: a later live change is ignored
    stub(window, 'devicePixelRatio', 1.33333);
    expect(params(resolveSimUrl('https://x.test/a.html')).get('dpr')).toBe('1.33');
  });

  it('SNAPSHOTS dpr per page — a mid-session devicePixelRatio change never changes the src', () => {
    stub(window, 'devicePixelRatio', 2);
    const first = resolveSimUrl('https://x.test/a.html');
    stub(window, 'devicePixelRatio', 3);   // zoom / monitor move
    expect(resolveSimUrl('https://x.test/a.html')).toBe(first);   // no iframe reload
  });

  it('omits lowend and mem on a capable device', () => {
    stub(window, 'devicePixelRatio', 2);
    stub(navigator, 'hardwareConcurrency', 8);
    // deviceMemory left undefined → treated as NOT low, and no mem param.
    const out = params(resolveSimUrl('https://x.test/a.html'));
    expect(out.get('lowend')).toBeNull();
    expect(out.get('mem')).toBeNull();
  });

  it('sets lowend=1 and mem when deviceMemory <= 4', () => {
    stub(navigator, 'hardwareConcurrency', 8);
    stub(navigator, 'deviceMemory', 4);
    const out = params(resolveSimUrl('https://x.test/a.html'));
    expect(out.get('lowend')).toBe('1');
    expect(out.get('mem')).toBe('4');
  });

  it('sets lowend=1 when hardwareConcurrency <= 4', () => {
    stub(navigator, 'hardwareConcurrency', 4);
    const out = params(resolveSimUrl('https://x.test/a.html'));
    expect(out.get('lowend')).toBe('1');
    expect(out.get('mem')).toBeNull();   // deviceMemory undefined → no mem param
  });

  it('sets lowend=1 when Save-Data is on', () => {
    stub(navigator, 'hardwareConcurrency', 8);
    stub(navigator, 'connection', { saveData: true });
    expect(params(resolveSimUrl('https://x.test/a.html')).get('lowend')).toBe('1');
  });

  it('resolves relative /sim-public/ URLs onto the API origin (the app origin does not serve them)', () => {
    stub(navigator, 'hardwareConcurrency', 8);
    const href = resolveSimUrl('/sim-public/abc/index.html?v=2');
    const u = new URL(href);
    expect(u.origin).toBe(EXPECTED_API_ORIGIN);
    expect(u.pathname).toBe('/sim-public/abc/index.html');
    expect(u.searchParams.get('v')).toBe('2');
    expect(u.searchParams.get('dpr')).not.toBeNull();
  });

  it('returns the input unchanged when the URL cannot be parsed', () => {
    expect(resolveSimUrl('http://')).toBe('http://');
  });
});

describe('simDestroyGraceMs', () => {
  it('is 45s on a desktop-class device (fine pointer, no low-memory hint)', () => {
    stub(window, 'matchMedia', () => ({ matches: false }));
    expect(simDestroyGraceMs()).toBe(SIM_DESTROY_GRACE_DESKTOP_MS);
  });

  it('is 700ms on coarse-pointer (touch) devices', () => {
    stub(window, 'matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' }));
    expect(simDestroyGraceMs()).toBe(SIM_DESTROY_GRACE_LOW_MS);
  });

  it('is 700ms when deviceMemory <= 4, and 45s when deviceMemory is higher', () => {
    stub(window, 'matchMedia', () => ({ matches: false }));
    stub(navigator, 'deviceMemory', 4);
    expect(simDestroyGraceMs()).toBe(SIM_DESTROY_GRACE_LOW_MS);

    stub(navigator, 'deviceMemory', 8);
    expect(simDestroyGraceMs()).toBe(SIM_DESTROY_GRACE_DESKTOP_MS);
  });
});
