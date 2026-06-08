import { describe, it, expect } from 'vitest';
import { buildAvatarDisplay } from '../anamService.js';

describe('buildAvatarDisplay — Ask-the-Avatar identity', () => {
  it('returns the selected avatar name + portrait when identity is resolved', () => {
    const d = buildAvatarDisplay('einstein', { avatarId: 'a1', avatarName: 'Julia', avatarImageUrl: 'https://img/julia.png' }, 0.5);
    expect(d?.displayName).toBe('Julia');
    expect(d?.portrait).toBe('https://img/julia.png');
    expect(d?.nametag).toContain('Julia');
  });

  it('includes the variant in the nametag', () => {
    const d = buildAvatarDisplay('einstein', { avatarId: 'a1', avatarName: 'Julia', avatarVariantName: 'Studio', avatarImageUrl: 'x' }, 0.5);
    expect(d?.nametag).toBe('Julia · Studio');
  });

  it('without an avatarId returns only sensitivity (default character is used by the UI)', () => {
    const d = buildAvatarDisplay('einstein', {}, 0.7);
    expect(d).toEqual({ voiceSensitivity: 0.7 });
  });

  it('REGRESSION: avatarId set but identity missing yields no portrait override → UI must enrich first', () => {
    // This is the pre-fix state that caused the popup to keep the default
    // (Einstein) image. The session handler now enriches these fields from Anam
    // before calling buildAvatarDisplay so displayName/portrait are populated.
    const d = buildAvatarDisplay('einstein', { avatarId: 'a1' }, 0.5);
    expect(d?.displayName).toBe('the avatar');
    expect(d?.portrait).toBeUndefined(); // no override → characterMeta keeps default image
  });
});
