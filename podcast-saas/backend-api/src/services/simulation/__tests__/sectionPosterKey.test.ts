/**
 * ONE poster identity for the player, the export and the editor's capture (night run §6).
 *
 * The property under test is that the helper computes exactly the identity `buildPlayerConfig`
 * used to compute inline — rebuilt here from the shared primitives rather than pasted — and that
 * each axis (variant, hide list, aspect) really moves the key.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PRESENTATION_CONFIG, computeConfigHash } from 'shared/sim/simIdentity';
import { posterIdentityString } from 'shared/sim/posterIdentity';
import { posterAspectFor, posterKeyForSection, uiHideFromMeta } from '../sectionPosterKey.js';

const section = {
  id: 'sec-1', simulation_url: 'https://x/sim.html', sim_script: 'main',
  simple_ui: true, auto_script: true, sim_meta: { uiControls: { hide: ['#b', '#a'] } },
};

describe('posterKeyForSection', () => {
  it('is the identity the player has always looked up: variant from the section, config from the row, quality high', () => {
    const key = posterKeyForSection(section, 'rev-16chars-00001', 'wide');
    expect(key).toEqual({
      packageRevision: 'rev-16chars-00001',
      variantKey: 'sec-1',   // no ?section= on the URL and sim_script 'main' → the section id
      configHash: computeConfigHash({
        ...DEFAULT_PRESENTATION_CONFIG, simpleUi: true, hideSelectors: ['#b', '#a'], autoScript: true, quality: 'high', aspect: 'wide',
      }),
      aspectProfile: 'wide',
      qualityProfile: 'high',
    });
    expect(posterIdentityString(key)).toContain('wide');
  });

  it('every axis moves the identity: the hide list, simple_ui, the aspect, the revision', () => {
    const base = posterIdentityString(posterKeyForSection(section, 'rev-a', 'wide'));
    expect(posterIdentityString(posterKeyForSection({ ...section, sim_meta: null }, 'rev-a', 'wide'))).not.toBe(base);
    expect(posterIdentityString(posterKeyForSection({ ...section, simple_ui: false }, 'rev-a', 'wide'))).not.toBe(base);
    expect(posterIdentityString(posterKeyForSection(section, 'rev-a', 'portrait'))).not.toBe(base);
    expect(posterIdentityString(posterKeyForSection(section, 'rev-b', 'wide'))).not.toBe(base);
  });

  it('a portrait project captures and looks up the portrait profile', () => {
    expect(posterAspectFor('portrait')).toBe('portrait');
    expect(posterAspectFor('landscape')).toBe('wide');
  });
});

describe('uiHideFromMeta', () => {
  it('returns the cleaned hide list, or undefined when there is nothing usable', () => {
    expect(uiHideFromMeta({ uiControls: { hide: ['#a', '', 3, '#b'] } })).toEqual(['#a', '#b']);
    expect(uiHideFromMeta({ uiControls: { hide: [] } })).toBeUndefined();
    expect(uiHideFromMeta({ uiControls: { hide: 'nope' } })).toBeUndefined();
    expect(uiHideFromMeta(null)).toBeUndefined();
  });
});
