import { describe, it, expect, afterEach, vi } from 'vitest';
import { canWarmUnpaused } from '../lib/simCapability';

/** Temporarily define a navigator property (jsdom getters aren't spyable). */
function withNavProp(prop: string, value: unknown, run: () => void) {
  const had = Object.prototype.hasOwnProperty.call(navigator, prop);
  const prev = (navigator as unknown as Record<string, unknown>)[prop];
  Object.defineProperty(navigator, prop, { value, configurable: true, writable: true });
  try { run(); }
  finally {
    if (had) Object.defineProperty(navigator, prop, { value: prev, configurable: true, writable: true });
    else delete (navigator as unknown as Record<string, unknown>)[prop];
  }
}

describe('canWarmUnpaused — when it is worth warming a hidden sim unpaused', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a boolean and never throws in a jsdom environment', () => {
    expect(typeof canWarmUnpaused()).toBe('boolean');
  });

  it('skips warming under Data Saver', () => {
    withNavProp('connection', { saveData: true }, () => expect(canWarmUnpaused()).toBe(false));
  });

  it('skips warming on low-memory devices (deviceMemory <= 4)', () => {
    withNavProp('deviceMemory', 4, () => expect(canWarmUnpaused()).toBe(false));
  });

  it('skips warming on coarse-pointer (touch) devices', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse') }) as MediaQueryList);
    expect(canWarmUnpaused()).toBe(false);
  });

  it('warms on a capable device (fine pointer, ample memory, no Data Saver)', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }) as MediaQueryList);
    withNavProp('deviceMemory', 8, () =>
      withNavProp('connection', undefined, () => expect(canWarmUnpaused()).toBe(true)),
    );
  });
});
