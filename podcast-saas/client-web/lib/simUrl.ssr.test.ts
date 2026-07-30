// @vitest-environment node
// SSR safety: with no window, resolveSimUrl must return the URL untouched and
// simDestroyGraceMs must fall back to the desktop grace.
import { describe, expect, it } from 'vitest';
import { resolveSimUrl } from './simUrl';
import { SIM_DESTROY_GRACE_DESKTOP_MS, simDestroyGraceMs } from './simLifecycle';

describe('resolveSimUrl (SSR)', () => {
  it('returns the input unchanged when window is undefined', () => {
    const url = 'https://cdn.example.com/sims/abc/index.html?v=7';
    expect(resolveSimUrl(url)).toBe(url);
  });
});

describe('simDestroyGraceMs (SSR)', () => {
  it('falls back to the desktop grace when window is undefined', () => {
    expect(simDestroyGraceMs()).toBe(SIM_DESTROY_GRACE_DESKTOP_MS);
  });
});
