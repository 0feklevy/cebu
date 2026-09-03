/**
 * The responsive variants the layout is built on actually compile under the REAL Tailwind config.
 *
 * v0.3.0 shipped with every `min-[…]:` and `max-[…]:` class in the app silently disabled: a
 * `theme.extend.screens` entry with a `raw` media query (added for the car-mode player) makes
 * Tailwind refuse the arbitrary min/max variants, because it can no longer order the screens.
 * Nothing failed — the classes simply produced no CSS — and the Export / Preview labels
 * (`hidden min-[390px]:inline`) and the panels laid out with those variants vanished in
 * production. This test compiles a probe through the config itself, so a screens change that
 * costs a variant is a red test rather than a broken editor.
 */
import { describe, it, expect } from 'vitest';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import config from '../tailwind.config';

const PROBE = [
  'hidden', 'min-[390px]:inline', 'max-[640px]:hidden',
  'sm:block', 'md:block', 'lg:w-[320px]', 'xl:flex-row',
  '[@media(orientation:landscape)_and_(max-height:560px)]:flex-row',
].join(' ');

async function compile(): Promise<string> {
  const result = await postcss([
    tailwind({ ...config, content: [{ raw: `<div class="${PROBE}"></div>`, extension: 'html' }] }),
  ]).process('@tailwind utilities;', { from: undefined });
  return result.css;
}

describe('Tailwind responsive variants', () => {
  it('arbitrary min-[…] and max-[…] variants emit CSS under the real config', async () => {
    const css = await compile();
    expect(css, 'min-[390px]: — the Export / Preview labels').toContain('@media (min-width: 390px)');
    expect(css, 'max-[640px]:').toContain('@media (max-width: 640px)');
  });

  it('the named breakpoints and the car-mode media variant still emit', async () => {
    const css = await compile();
    for (const px of [640, 768, 1024, 1280]) expect(css).toContain(`@media (min-width: ${px}px)`);
    expect(css).toMatch(/orientation:\s*landscape\)\s*and\s*\(max-height:\s*560px\)/);
  });

  it('no screen carries a raw media query — that is what disables the arbitrary variants', () => {
    const screens = { ...(config.theme?.screens ?? {}), ...((config.theme?.extend as { screens?: Record<string, unknown> } | undefined)?.screens ?? {}) };
    for (const [name, value] of Object.entries(screens)) {
      expect(typeof value === 'object' && value !== null && 'raw' in value, `${name} is a raw screen`).toBe(false);
    }
  });
});
