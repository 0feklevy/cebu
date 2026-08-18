/**
 * The durable persona invariant.
 *
 * /avatar/start has two shapes: a STATEFUL mint (one vendor round-trip, ~118-byte body that just
 * references the persona already saved in the Anam account) and an EPHEMERAL mint (three to six
 * round-trips carrying a ~30 KB inline persona). The stateful shape is only correct if the saved
 * persona really was baked from the configuration the viewer is about to get — including the
 * caption transcript, which is what the avatar answers questions about.
 *
 * The old code had no way to know that, so it guessed from one proxy (`knowledgeToolId` present?)
 * and threw the pre-baked personaId away whenever the guess said "maybe not". That discard is the
 * measured root cause of the slow start.
 *
 * The invariant replacing the guess: a persona id is only trusted while a persisted fingerprint of
 * the exact semantic inputs — every behaviour-changing field plus the transcript revision — still
 * matches, and while the exact tool ids that were baked are still the ones wanted. The fingerprint
 * is written ONLY after the vendor upsert succeeded.
 */
import { describe, it, expect } from 'vitest';
import {
  personaFingerprint, verifyStatefulPersona, bakedStateFor, desiredToolIds, hashTranscript, bakedCharacterId,
} from '../personaFingerprint.js';
import { DEFAULT_CHARACTER_ID } from '../characters.js';
import type { AvatarPersonaConfig } from '../anamService.js';

const BASE: AvatarPersonaConfig = {
  characterId: 'einstein',
  name: 'Albert',
  systemPrompt: 'You are Albert.',
  knowledge: 'Course notes.',
  greeting: 'Hello there',
  languageCode: 'en',
  avatarId: 'av-1',
  avatarModel: 'cara-3',
  voiceId: 'vo-1',
  llmId: 'llm-1',
  toolIds: ['tool-end-call'],
  knowledgeToolId: 'tool-rag-1',
  transcriptHash: 'th-aaa',
};

/** A config whose persona was baked from exactly BASE. */
function baked(cfg: AvatarPersonaConfig = BASE): AvatarPersonaConfig {
  return { ...cfg, personaId: 'persona-1', personaBaked: bakedStateFor(cfg) };
}

describe('personaFingerprint — what counts as "the same persona"', () => {
  it('is stable across repeated computation and key order', () => {
    const reordered: AvatarPersonaConfig = { transcriptHash: 'th-aaa', voiceId: 'vo-1', ...BASE };
    expect(personaFingerprint(BASE)).toBe(personaFingerprint(reordered));
  });

  it('ignores cosmetic and per-session fields (they must never force a re-bake)', () => {
    const fp = personaFingerprint(BASE);
    const cosmetic: AvatarPersonaConfig = {
      ...BASE,
      avatarName: 'Julia', avatarVariantName: 'Studio', avatarImageUrl: 'https://img/x.png',
      voiceName: 'Julia voice', voiceSensitivity: 0.9, maxSessionLengthSeconds: 900,
      personaDisplay: { avatarId: 'av-1', displayName: 'Julia', variantName: '', imageUrl: 'https://img/x.png' },
      avatarCircles: { enabled: true, count: 1 },
      personaId: 'persona-9', transcriptDocId: 'doc-1', knowledgeGroupId: 'grp-1',
    };
    expect(personaFingerprint(cosmetic)).toBe(fp);
  });

  it.each([
    ['systemPrompt', { systemPrompt: 'You are Charles.' }],
    ['knowledge', { knowledge: 'Different notes.' }],
    ['greeting', { greeting: 'Good day' }],
    ['skipGreeting', { skipGreeting: true }],
    ['uninterruptibleGreeting', { uninterruptibleGreeting: true }],
    ['languageCode', { languageCode: 'es' }],
    ['avatarId', { avatarId: 'av-2' }],
    ['avatarModel', { avatarModel: 'cara-4-latest' }],
    ['voiceId', { voiceId: 'vo-2' }],
    ['llmId', { llmId: 'llm-2' }],
    ['name', { name: 'Al' }],
    ['toolIds', { toolIds: ['tool-change-language'] }],
    ['knowledgeToolId', { knowledgeToolId: 'tool-rag-2' }],
    ['transcriptHash', { transcriptHash: 'th-bbb' }],
  ])('changes when the behaviour-changing field %s changes', (_label, patch) => {
    expect(personaFingerprint({ ...BASE, ...patch })).not.toBe(personaFingerprint(BASE));
  });

  it('changes with the character (it selects the default brain and greeting)', () => {
    expect(personaFingerprint({ ...BASE, characterId: 'darwin' })).not.toBe(personaFingerprint(BASE));
  });

  it('reads the character from the CONFIG and normalizes an unknown one', () => {
    // A per-request character_id is a session choice; it must never redefine what the project's
    // persona is, or two clients disagreeing would re-bake it back and forth forever. Likewise an
    // unrecognised stored character resolves to the default exactly as the mint does, so a start
    // and a bake can never disagree about which character was baked.
    expect(bakedCharacterId({ characterId: 'darwin' })).toBe('darwin');
    expect(bakedCharacterId({ characterId: 'not-a-character' })).toBe(DEFAULT_CHARACTER_ID);
    expect(bakedCharacterId({})).toBe(DEFAULT_CHARACTER_ID);
    expect(personaFingerprint({ ...BASE, characterId: 'not-a-character' }))
      .toBe(personaFingerprint({ ...BASE, characterId: DEFAULT_CHARACTER_ID }));
  });
});

describe('hashTranscript — the transcript revision that rides in the fingerprint', () => {
  it('is empty for no transcript and stable for the same text', () => {
    expect(hashTranscript(null)).toBe('');
    expect(hashTranscript('')).toBe('');
    expect(hashTranscript('abc')).toBe(hashTranscript('abc'));
  });

  it('differs for different transcripts and does not embed the text', () => {
    const h = hashTranscript('the photoelectric effect');
    expect(h).not.toBe(hashTranscript('the photoelectric effects'));
    expect(h).not.toContain('photoelectric');
    expect(h).toMatch(/^[0-9a-f]{32,64}$/);
  });
});

describe('desiredToolIds — the exact tool ids a bake must carry', () => {
  it('puts the RAG knowledge tool first and dedupes', () => {
    expect(desiredToolIds({ knowledgeToolId: 't-rag', toolIds: ['t-end', 't-rag'] })).toEqual(['t-rag', 't-end']);
  });
  it('is empty when nothing is attached', () => {
    expect(desiredToolIds({})).toEqual([]);
  });
});

describe('verifyStatefulPersona — the gate the start path consults', () => {
  it('healthy when the stored fingerprint still describes the config', () => {
    expect(verifyStatefulPersona(baked())).toBe('healthy');
  });

  it('no_persona when the project never had a persona id', () => {
    expect(verifyStatefulPersona(BASE)).toBe('no_persona');
  });

  it('never_fingerprinted for a legacy row that has a persona id but no baked record', () => {
    expect(verifyStatefulPersona({ ...BASE, personaId: 'persona-1' })).toBe('never_fingerprinted');
  });

  it('config_changed when a behaviour field moved since the bake', () => {
    const cfg = { ...baked(), systemPrompt: 'You are someone else.' };
    expect(verifyStatefulPersona(cfg)).toBe('config_changed');
  });

  it('config_changed when the transcript revision moved since the bake (the avatar would answer from a stale script)', () => {
    const cfg = { ...baked(), transcriptHash: 'th-newer' };
    expect(verifyStatefulPersona(cfg)).toBe('config_changed');
  });

  it('tools_changed when the bake did not actually carry the wanted tool ids', () => {
    // The mint retries WITHOUT toolIds on a vendor 400, so "wanted" and "baked" can diverge
    // even though every other field matches. That persona cannot search the knowledge base.
    const cfg = baked();
    cfg.personaBaked = { ...cfg.personaBaked!, toolIds: [] };
    expect(verifyStatefulPersona(cfg)).toBe('tools_changed');
  });

  it('tool order alone is not a change', () => {
    const cfg = baked();
    cfg.personaBaked = { ...cfg.personaBaked!, toolIds: [...cfg.personaBaked!.toolIds].reverse() };
    expect(verifyStatefulPersona(cfg)).toBe('healthy');
  });

  it('a character changed in the config invalidates the persona', () => {
    expect(verifyStatefulPersona({ ...baked(), characterId: 'darwin' })).toBe('config_changed');
  });
});

describe('bakedStateFor — only a successful vendor upsert may produce one', () => {
  it('records the fingerprint, the exact tool ids, the transcript revision and a monotonic revision', () => {
    const first = bakedStateFor(BASE);
    expect(first.fingerprint).toBe(personaFingerprint(BASE));
    expect(first.toolIds).toEqual(['tool-rag-1', 'tool-end-call']);
    expect(first.transcriptHash).toBe('th-aaa');
    expect(first.revision).toBe(1);
    expect(Date.parse(first.bakedAt)).not.toBeNaN();

    const second = bakedStateFor(BASE, first.revision);
    expect(second.revision).toBe(2);
  });
});
