// jsdom (vitest default env per vitest.config.ts) — SSR behavior is covered in
// simUrl.ssr.test.ts under the node environment.
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSimUrl } from './simUrl';
import { SIM_DESTROY_GRACE_DESKTOP_MS, SIM_DESTROY_GRACE_LOW_MS, simDestroyGraceMs } from './simLifecycle';

const touched: Array<{ target: object; key: string }> = [];

function stub(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  touched.push({ target, key });
}

afterEach(() => {
  // Deleting the own property restores any prototype-provided value (jsdom defaults).
  for (const { target, key } of touched.splice(0)) Reflect.deleteProperty(target, key);
});

function params(href: string): URLSearchParams {
  return new URL(href).searchParams;
}

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

    stub(window, 'devicePixelRatio', 1.33333);
    expect(params(resolveSimUrl('https://x.test/a.html')).get('dpr')).toBe('1.33');
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

  it('resolves relative URLs against window.location', () => {
    stub(navigator, 'hardwareConcurrency', 8);
    const href = resolveSimUrl('/sim-public/abc/index.html?v=2');
    const u = new URL(href);
    expect(u.origin).toBe(window.location.origin);
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
