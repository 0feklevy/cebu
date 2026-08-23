/**
 * The 2026-08-23 outage class: a wrong-typed field in `avatar_config`.
 *
 * `cfg?.systemPrompt?.trim()` guards null/undefined and NOTHING else — a number in that field is
 * a statusless TypeError inside the mint, which the start catch turned into `500 Avatar session
 * failed` in ~50ms, for every viewer of the row, with the vendor never called. These tests pin
 * both halves: the sanitizer itself, and — the part that matters — that the REAL mint path now
 * survives every poison that used to kill it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeAvatarPersonaConfig } from '../sanitizeAvatarConfig.js';
import { getSessionToken, ANAM_ENV, invalidateAnamLlmCache } from '../anamService.js';

describe('sanitizeAvatarPersonaConfig', () => {
  it('drops wrong-typed values and keeps right-typed ones, field class by field class', () => {
    const out = sanitizeAvatarPersonaConfig({
      systemPrompt: 123,                    // number in a string field → dropped
      knowledge: { nested: true },          // object in a string field → dropped
      voiceId: ['v-1'],                     // array in a string field → dropped
      avatarId: 'real-avatar',              // correct → kept
      voiceSensitivity: '0.5',              // string in a number field → dropped
      maxSessionLengthSeconds: 1800,        // correct → kept
      skipGreeting: 'yes',                  // string in a boolean field → dropped
      toolIds: ['tool-1', 7, null, 'tool-2'], // wrong members filtered, right ones kept
      personaBaked: 'not-an-object',        // → dropped
      someFutureField: { anything: 1 },     // unknown key → passed through untouched
    } as never);

    expect(out).toEqual({
      avatarId: 'real-avatar',
      maxSessionLengthSeconds: 1800,
      toolIds: ['tool-1', 'tool-2'],
      someFutureField: { anything: 1 },
    });
  });

  it('scrubs personaDisplay MEMBERS — vendor-written, consumed with the same fragile trim', () => {
    // `scheduleDisplayResolve` persists `look.displayName ?? ''` — `??` passes a localized OBJECT
    // straight through — and `buildAvatarDisplay` reads it back as `d.displayName?.trim()`. A
    // vendor shape change must cost a cosmetic fallback, not the session.
    const out = sanitizeAvatarPersonaConfig({
      personaDisplay: { avatarId: 'av-1', displayName: { en: 'Einstein' }, variantName: 7, imageUrl: 'https://x/y.png' },
    } as never);
    expect(out.personaDisplay).toEqual({ avatarId: 'av-1', imageUrl: 'https://x/y.png' });
  });

  it('treats a non-object wholesale as an empty config', () => {
    for (const v of [null, undefined, 'a string', 42, ['a']]) {
      expect(sanitizeAvatarPersonaConfig(v as never)).toEqual({});
    }
  });
});

describe('the REAL mint path survives every poison that used to kill it', () => {
  const realFetch = globalThis.fetch;
  const savedEnv = { ...ANAM_ENV };
  beforeEach(() => {
    ANAM_ENV.ANAM_API_KEY = 'test-key-1234567890';
    ANAM_ENV.ANAM_AVATAR_ID = 'env-avatar-1';
    ANAM_ENV.ANAM_VOICE_ID = 'env-voice-1';
    ANAM_ENV.ANAM_LLM_ID = 'llm-default-1';
    invalidateAnamLlmCache();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ sessionToken: 'tok-clean' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; Object.assign(ANAM_ENV, savedEnv); invalidateAnamLlmCache(); });

  // Every one of these five produced `TypeError: … .trim is not a function` (status: undefined)
  // from getSessionToken before the sanitizer — reproduced against the unpatched code on
  // 2026-08-23, matching production's ~50ms bare 500s.
  for (const [label, poison] of [
    ['numeric systemPrompt', { systemPrompt: 123 }],
    ['object avatarId', { avatarId: { nested: true } }],
    ['numeric knowledge', { knowledge: 42 }],
    ['array voiceId', { voiceId: ['v-1'] }],
    ['object greeting', { greeting: { text: 'hi' } }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`${label} mints a session instead of throwing`, async () => {
      const info = await getSessionToken('einstein', poison as never);
      expect(info.token).toBe('tok-clean');
    });
  }
});
