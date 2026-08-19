/**
 * THE DEFAULT PERSONA MUST BE ONE THE INTERFACE CAN NAME HONESTLY.
 *
 * The default is worn by every project whose owner expressed no preference. It used to be
 * Einstein, whose prompt says "You are Einstein. Always. Never say you are an AI" and who opens
 * with "Guten Tag!". Two consequences, both reported by the owner:
 *
 *   • the product asserted an identity nobody had chosen — "Ask Albert Einstein" over a video
 *     about something else entirely; and
 *   • every attempt to soften that in the UI produced a label the persona then contradicted out
 *     loud, which read as a screen stuck loading.
 *
 * A default cannot be a character that denies what it is. That is the invariant here — not the
 * particular name, which may change, but the property that makes naming it honest.
 */
import { describe, it, expect } from 'vitest';
import { CHARACTERS, DEFAULT_CHARACTER_ID } from '../characters.js';

describe('the default persona', () => {
  const def = CHARACTERS[DEFAULT_CHARACTER_ID];

  it('exists', () => {
    expect(def, `DEFAULT_CHARACTER_ID '${DEFAULT_CHARACTER_ID}' names no character`).toBeTruthy();
  });

  it('does not impersonate a real person', () => {
    // The historical personas are legitimate CHOICES. None of them may be the fallback.
    expect(DEFAULT_CHARACTER_ID).not.toBe('einstein');
    for (const impersonator of ['einstein', 'darwin', 'napoleon', 'archimedes']) {
      expect(DEFAULT_CHARACTER_ID).not.toBe(impersonator);
    }
  });

  it('is allowed to admit what it is', () => {
    // The disqualifying property, stated directly: a default that is forbidden to say it is an AI
    // cannot be labelled honestly by anything on the screen.
    expect(def!.systemPrompt).not.toMatch(/never say you are an ai/i);
    expect(def!.systemPrompt).toMatch(/\bAI\b/);
  });

  it('claims no biography — no birthplace, no dates, no "you were born"', () => {
    expect(def!.systemPrompt).not.toMatch(/you were born/i);
    expect(def!.personaName).not.toMatch(/—\s*(Princeton|Down House|Saint Helena|Syracuse)/);
  });

  it('greets in the viewer\'s language, not a character\'s', () => {
    expect(def!.initialMessage).not.toMatch(/guten tag|entrez|by the gods/i);
  });

  it('the historical characters are still available to choose', () => {
    for (const id of ['einstein', 'darwin', 'napoleon', 'archimedes']) {
      expect(CHARACTERS[id], `${id} must remain selectable`).toBeTruthy();
    }
  });
});
