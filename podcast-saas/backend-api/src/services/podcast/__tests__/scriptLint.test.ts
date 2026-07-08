import { describe, it, expect } from 'vitest';
import { lintScript, type LintTurn } from '../scriptLint.js';

const t = (speaker: 'teacher' | 'learner', text: string, overlap = false): LintTurn => ({ speaker, text, overlap });

describe('lintScript', () => {
  it('passes a clean, human script', () => {
    const turns = [
      t('teacher', 'Somewhere over Kansas, a pilot looks down and sees his own house.'),
      t('learner', 'Wait — from a plane?'),
      t('teacher', 'From a plane. And that one glance is about to cost the airline four million dollars.'),
      t('learner', 'Okay, you have to explain that.'),
    ];
    expect(lintScript(turns)).toEqual([]);
  });

  it('flags banned stock phrases', () => {
    const f = lintScript([t('teacher', "Let's take a deep dive into matrices.")]);
    expect(f.some((x) => x.rule === 'banned_phrase')).toBe(true);
  });

  it('flags greeting cold-opens in the first 3 turns only', () => {
    const early = lintScript([t('teacher', 'Welcome to the show, everyone!')]);
    expect(early.some((x) => x.rule === 'greeting_open')).toBe(true);
    const late = lintScript([
      t('teacher', 'A man walks into a bank vault.'),
      t('learner', 'Okay…'),
      t('teacher', 'He is carrying a fish.'),
      t('learner', 'A warm welcome for the fish, I hope.'), // 4th turn — allowed
    ]);
    expect(late.some((x) => x.rule === 'greeting_open')).toBe(false);
  });

  it('flags serial affirmation openers', () => {
    const turns = [
      t('teacher', 'The seats are numbered.'),
      t('learner', 'Right, so each seat has an address.'),
      t('teacher', 'Exactly. And the addresses have two parts.'),
      t('learner', 'Totally, row and column.'),
      t('teacher', 'Right, row first.'),
    ];
    expect(lintScript(turns).some((x) => x.rule === 'affirmation_density')).toBe(true);
  });

  it('flags fake lived experiences', () => {
    const f = lintScript([t('learner', 'When I was in college I failed this exact class.')]);
    expect(f.some((x) => x.rule === 'fake_experience')).toBe(true);
  });

  it('flags a 4-turn monologue run (overlaps do not break the run)', () => {
    const turns = [
      t('teacher', 'First point.'),
      t('teacher', 'Second point.'),
      t('learner', 'mm-hm', true),          // backchannel — not a floor change
      t('teacher', 'Third point.'),
      t('teacher', 'Fourth point.'),
    ];
    expect(lintScript(turns).some((x) => x.rule === 'monologue_run')).toBe(true);
  });

  it('flags an unanchored cold open ("Round three… last time…") when there is no series memory', () => {
    const turns = [
      t('learner', 'Round three. Every cupcake sealed in plastic — not a whiff.'),
      t('teacher', 'Wait. If the smell is gone, which way do you even step?'),
    ];
    const f = lintScript(turns);
    expect(f.some((x) => x.rule === 'unanchored_open')).toBe(true);
  });

  it('allows continuity callbacks in the open when the show HAS series memory', () => {
    const turns = [
      t('learner', 'Last time, biology beat everyone by following the smell.'),
      t('teacher', 'And today their trick stops working.'),
    ];
    expect(lintScript(turns, { hasSeriesMemory: true }).some((x) => x.rule === 'unanchored_open')).toBe(false);
  });

  it('does not flag continuity words later in the episode (only the first 3 turns)', () => {
    const turns = [
      t('teacher', 'A dean scatters cupcakes across a park and blindfolds three departments.'),
      t('learner', 'Find them by smell alone?'),
      t('teacher', 'Exactly the game. One point per cupcake.'),
      t('learner', 'So round two is where it gets interesting.'), // 4th turn — established by now
    ];
    expect(lintScript(turns).some((x) => x.rule === 'unanchored_open')).toBe(false);
  });
});
