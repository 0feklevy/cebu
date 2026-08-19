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
