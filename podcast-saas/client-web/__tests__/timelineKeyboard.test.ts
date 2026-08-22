/**
 * The rules that decide what a keypress on a timeline handle means.
 *
 * Two things are being pinned, and the second is the one that gets broken later: that the module
 * ACTS on the keys it owns, and that it stays out of the way of every key it does not. A timeline
 * that swallows Cmd+Left breaks text navigation for the whole page.
 */
import { describe, it, expect } from 'vitest';
import {
  timelineKeyAction,
  formatTimecode,
  handleLabel,
  TIMELINE_STEP_SEC,
  TIMELINE_COARSE_STEP_SEC,
} from '../lib/timelineKeyboard';

const press = (key: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) =>
  timelineKeyAction({ key, ...mods });

describe('what the arrows do', () => {
  it('moves back and forward by one fine step', () => {
    expect(press('ArrowLeft')).toEqual({ kind: 'nudge', deltaSec: -TIMELINE_STEP_SEC });
    expect(press('ArrowRight')).toEqual({ kind: 'nudge', deltaSec: TIMELINE_STEP_SEC });
  });

  it('takes the vertical axis too, because a slider does', () => {
    // Someone reaching for Down on a control announced as a slider must not find nothing there.
    expect(press('ArrowDown')).toEqual(press('ArrowLeft'));
    expect(press('ArrowUp')).toEqual(press('ArrowRight'));
  });

  it('makes Shift coarse, in the same direction', () => {
    expect(press('ArrowRight', { shiftKey: true })).toEqual({ kind: 'nudge', deltaSec: TIMELINE_COARSE_STEP_SEC });
    expect(press('ArrowLeft', { shiftKey: true })).toEqual({ kind: 'nudge', deltaSec: -TIMELINE_COARSE_STEP_SEC });
  });

  it('keeps the coarse step a multiple of the fine one', () => {
    // So the two are one gesture at two scales rather than two numbers to learn.
    expect(TIMELINE_COARSE_STEP_SEC / TIMELINE_STEP_SEC).toBe(10);
    expect(TIMELINE_STEP_SEC).toBeLessThanOrEqual(0.1);
  });

  it('makes Page keys coarse whether or not Shift is held', () => {
    // That is what they mean on every other slider; making Shift+PageUp a third size would invent
    // a rule this control does not need.
    expect(press('PageUp')).toEqual({ kind: 'nudge', deltaSec: TIMELINE_COARSE_STEP_SEC });
    expect(press('PageUp', { shiftKey: true })).toEqual({ kind: 'nudge', deltaSec: TIMELINE_COARSE_STEP_SEC });
    expect(press('PageDown')).toEqual({ kind: 'nudge', deltaSec: -TIMELINE_COARSE_STEP_SEC });
  });

  it('sends Home and End to the ends of the legal range', () => {
    expect(press('Home')).toEqual({ kind: 'jump', to: 'min' });
    expect(press('End')).toEqual({ kind: 'jump', to: 'max' });
  });
});

describe('the keys it must NOT take', () => {
  it('ignores Ctrl and Meta entirely', () => {
    // Cmd+Left is "beginning of line" on macOS and Ctrl+Left is word-jump elsewhere. A component
    // that eats them breaks the surrounding page for everyone, not only for timeline users.
    for (const mod of ['ctrlKey', 'metaKey'] as const) {
      for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp']) {
        expect(press(key, { [mod]: true }), `${mod}+${key}`).toBeNull();
      }
    }
  });

  it('ignores Alt, because Alt+Left is browser BACK on Windows and Linux', () => {
    // Binding a trim there means one mistimed press loses the editor and whatever was unsaved.
    expect(press('ArrowLeft', { altKey: true })).toBeNull();
    expect(press('ArrowRight', { altKey: true })).toBeNull();
  });

  it('passes every other key through untouched', () => {
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'a', 'F5', 'Delete', 'Backspace']) {
      expect(press(key), key).toBeNull();
    }
  });
});

describe('what a screen reader says out loud', () => {
  it('reads a timecode the way the rest of the editor writes one', () => {
    expect(formatTimecode(0)).toBe('0:00.0');
    expect(formatTimecode(9.4)).toBe('0:09.4');
    expect(formatTimecode(83.44)).toBe('1:23.4');
    expect(formatTimecode(600)).toBe('10:00.0');
  });

  it('keeps the tenth, because that is what one arrow press moves', () => {
    // Rounding to whole seconds would make a fine nudge inaudible: the control would announce the
    // same value twice and read as broken.
    expect(formatTimecode(1)).not.toBe(formatTimecode(1 + TIMELINE_STEP_SEC));
  });

  it('never announces a negative or a NaN as a time', () => {
    expect(formatTimecode(-5)).toBe('0:00.0');
    expect(formatTimecode(NaN)).toBe('0:00.0');
    expect(formatTimecode(Infinity)).toBe('0:00.0');
  });

  it('leads with WHICH handle, not with the section name', () => {
    // All three handles sit on the same section. Leading with the name announces "Introduction"
    // three times running and tells a listener nothing about where they have landed.
    expect(handleLabel('move', 'Introduction', 2, 8)).toMatch(/^Move Introduction/);
    expect(handleLabel('trim-start', 'Introduction', 2, 8)).toMatch(/^Trim start of Introduction/);
    expect(handleLabel('trim-end', 'Introduction', 2, 8)).toMatch(/^Trim end of Introduction/);
  });

  it('gives the move handle the whole span and each trim handle only its own edge', () => {
    // A trim handle that announced both edges would make it ambiguous which one the arrows move.
    expect(handleLabel('move', 'Intro', 2, 8)).toContain('0:02.0 to 0:08.0');
    expect(handleLabel('trim-start', 'Intro', 2, 8)).toContain('0:02.0');
    expect(handleLabel('trim-start', 'Intro', 2, 8)).not.toContain('0:08.0');
    expect(handleLabel('trim-end', 'Intro', 2, 8)).toContain('0:08.0');
    expect(handleLabel('trim-end', 'Intro', 2, 8)).not.toContain('0:02.0');
  });
});
