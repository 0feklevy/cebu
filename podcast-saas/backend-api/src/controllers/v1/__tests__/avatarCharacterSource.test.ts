/**
 * `characterId` answers WHICH PROMPT the session runs. It does not answer WHO THE OWNER CHOSE,
 * and for a long time those two facts travelled as one field.
 *
 * A project that configured no persona resolves to the fallback `einstein` — it must, because a
 * session has to run as something — and the client, given only the id, rendered it as an
 * identity: "Ask Albert Einstein", the portrait, "Connecting to Einstein…", for a video whose
 * owner had picked nobody. The id was never wrong; it was answering a different question.
 *
 * `resolveCharacter` returns both facts, and this pins the distinction the client depends on.
 */
import { describe, it, expect } from 'vitest';
import { resolveCharacter } from '../avatar.controller.js';
import { CHARACTERS } from '../../../services/avatar/characters.js';
import { bakedCharacterId } from '../../../services/avatar/personaFingerprint.js';

describe('resolveCharacter separates the routing id from its provenance', () => {
  it('a project that configured a character owns the decision', () => {
    expect(resolveCharacter({ characterId: 'darwin' }, 'napoleon'))
      .toEqual({ id: 'darwin', source: 'configured' });
  });

  it('the configured character wins over a caller-supplied one', () => {
    // A reconnect echoes back whatever the first start resolved; it must never redefine the
    // owner's persona.
    expect(resolveCharacter({ characterId: 'einstein' }, 'darwin').id).toBe('einstein');
  });

  it('a request may still SELECT one where the project names none — that is a choice', () => {
    expect(resolveCharacter(undefined, 'darwin'))
      .toEqual({ id: 'darwin', source: 'requested' });
  });

  it('nothing configured and nothing requested is a DEFAULT, and says so', () => {
    // The id is still einstein — the session must run as something. The `source` is what stops
    // the client presenting that as the owner's choice.
    expect(resolveCharacter(undefined, undefined))
      .toEqual({ id: 'einstein', source: 'default' });
    expect(resolveCharacter({}, undefined).source).toBe('default');
  });

  it('an unknown character id is not honoured from either side', () => {
    expect(resolveCharacter({ characterId: 'nobody-real' }, undefined).source).toBe('default');
    expect(resolveCharacter(undefined, 'nobody-real').source).toBe('default');
  });
});

/**
 * THE SAME FABRICATION, ONE LAYER EARLIER AND FAR MORE DURABLE.
 *
 * The config PUT used to run the character through `projectCharacterId`, which returns the
 * DEFAULT when handed nothing. So saving the settings form at all — changing only the greeting,
 * never opening the character picker — persisted `characterId: 'einstein'`. From then on the
 * project was indistinguishable from one whose owner had deliberately chosen Einstein, and every
 * viewer was shown "Ask Albert Einstein" on the strength of a choice nobody made.
 *
 * The rule the write must now obey, expressed against the same normalizer the read path uses.
 */
describe('the config write never invents a character', () => {
  // The stored value, as the PUT handler now computes it.
  const stored = (incoming?: string, existing?: string): string | undefined => {
    const requested = (incoming ?? existing)?.trim();
    return requested && CHARACTERS[requested] ? requested : undefined;
  };

  it('saving with no character chosen stores NOTHING — not the default', () => {
    expect(stored(undefined, undefined)).toBeUndefined();
    // …and that absence reads back as a default, never as a choice.
    expect(resolveCharacter({ characterId: stored(undefined, undefined) }).source).toBe('default');
  });

  it('a character the owner picked is stored and reads back as configured', () => {
    expect(stored('darwin', undefined)).toBe('darwin');
    expect(resolveCharacter({ characterId: stored('darwin', undefined) }))
      .toEqual({ id: 'darwin', source: 'configured' });
  });

  it('an existing choice survives a save that does not mention the character', () => {
    expect(stored(undefined, 'napoleon')).toBe('napoleon');
  });

  it('an unrecognized id is DROPPED, not rewritten to the default', () => {
    // Rewriting it would put a character in the config that the owner never sent — the same
    // fabrication in a different disguise.
    expect(stored('nobody-real', undefined)).toBeUndefined();
    expect(resolveCharacter({ characterId: stored('nobody-real', undefined) }).source).toBe('default');
  });

  it('the bake still resolves to something concrete when nothing is stored', () => {
    // The invariant the old write-normalization was protecting: config and fingerprint must not
    // disagree. They cannot — there is one stored value and one normalizer.
    expect(bakedCharacterId({ characterId: stored(undefined, undefined) })).toBe('einstein');
    expect(bakedCharacterId({ characterId: stored('darwin', undefined) })).toBe('darwin');
  });
});
