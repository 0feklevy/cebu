/**
 * The walkthroughs as data (night run 2026-09-03 §5): every step points at a real anchor, the
 * editor tour leads with what a creator needs first, and the features that shipped in the last
 * weeks are actually mentioned. None of this reads source; it reads the same exported tables the
 * components render from.
 */
import { describe, it, expect } from 'vitest';
import { TOUR_ANCHORS, isTourAnchor, tourAnchor, tourSelector } from '../lib/tours/anchors';
import {
  EDITOR_STEPS, LIBRARY_STEPS, PERSONA_STEPS, SECTION_STEPS_BROLL, SECTION_STEPS_CLIP,
  SECTION_STEPS_GENERATED, SECTION_STEPS_IMAGE, SECTION_STEPS_SIM_ATTACHED, SECTION_STEPS_SIM_PICK,
  SETTINGS_STEPS, VIEWER_SHORTCUTS, toTourSteps, type Step,
} from '../lib/tours/steps';

const ALL_TOURS: Record<string, readonly Step[]> = {
  EDITOR_STEPS, SETTINGS_STEPS, SECTION_STEPS_BROLL, SECTION_STEPS_SIM_PICK, SECTION_STEPS_SIM_ATTACHED,
  SECTION_STEPS_IMAGE, SECTION_STEPS_CLIP, SECTION_STEPS_GENERATED, PERSONA_STEPS, LIBRARY_STEPS,
};

describe('anchors', () => {
  it('every step names a registered anchor, and no tour points at the same anchor twice', () => {
    for (const [name, steps] of Object.entries(ALL_TOURS)) {
      const seen = new Set<string>();
      for (const s of steps) {
        expect(isTourAnchor(s.anchor), `${name}: ${s.anchor}`).toBe(true);
        expect(seen.has(s.anchor), `${name}: ${s.anchor} twice`).toBe(false);
        seen.add(s.anchor);
      }
    }
  });

  it('every registered anchor is used by at least one tour — an anchor nobody points at is rot in the other direction', () => {
    const used = new Set(Object.values(ALL_TOURS).flat().map((s) => s.anchor));
    const unused = Object.keys(TOUR_ANCHORS).filter((a) => !used.has(a as keyof typeof TOUR_ANCHORS));
    expect(unused).toEqual([]);
  });

  it('the helper renders the attribute the selector finds', () => {
    expect(tourAnchor('library')).toEqual({ 'data-tour': 'library' });
    expect(tourSelector('library')).toBe('[data-tour="library"]');
    expect(toTourSteps(EDITOR_STEPS)[0]).toMatchObject({ selector: '[data-tour="library"]', title: 'Your Library' });
  });

  it('every step has a title and a body, and the body is a sentence or three — not a manual', () => {
    for (const steps of Object.values(ALL_TOURS)) {
      for (const s of steps) {
        expect(s.title.trim().length).toBeGreaterThan(2);
        expect(s.body.trim().length).toBeGreaterThan(20);
        expect(s.body.length, s.title).toBeLessThan(320);
      }
    }
  });
});

describe('the editor tour — most important first', () => {
  const order = EDITOR_STEPS.map((s) => s.anchor);

  it('leads with media in, then interactivity, then layout, then preview, share, export', () => {
    expect(order).toEqual(['library', 'simulations', 'timeline', 'preview', 'share', 'export']);
  });

  const mentions = (re: RegExp) => EDITOR_STEPS.some((s) => re.test(s.body) || re.test(s.title));

  it('mentions the features that shipped in the last three weeks', () => {
    expect(mentions(/import/i), 'the import gallery').toBe(true);
    expect(mentions(/flag/i), 'markers with notes').toBe(true);
    expect(mentions(/music|sfx/i), 'the music / SFX track').toBe(true);
    expect(mentions(/podcast/i), 'the podcast address').toBe(true);
    expect(mentions(/library of materials|Library/), 'the library mini-site').toBe(true);
    expect(mentions(/vertical/i), 'vertical video').toBe(true);
    expect(mentions(/export/i), 'export').toBe(true);
    expect(mentions(/replace/i), 'video replace').toBe(true);
  });

  it('tells the creator where the keys are', () => {
    expect(mentions(/\?/)).toBe(true);
    expect(mentions(/space/i)).toBe(true);
  });
});

describe('the settings and section tours', () => {
  it('settings covers dubbing — the card had an anchor and no step for weeks', () => {
    expect(SETTINGS_STEPS.map((s) => s.anchor)).toContain('settings-dubbing');
  });

  it('settings says a vertical project has no crop', () => {
    const crop = SETTINGS_STEPS.find((s) => s.anchor === 'settings-crop')!;
    expect(crop.body).toMatch(/vertical/i);
  });

  it('a simulation section with a simulation attached covers the Minimal-UI control picker and presets', () => {
    const anchors = [...SECTION_STEPS_SIM_PICK, ...SECTION_STEPS_SIM_ATTACHED].map((s) => s.anchor);
    expect(anchors).toEqual(['sec-sim-select', 'sec-sim-prompt', 'sec-sim-generate', 'sec-sim-controls', 'sec-sim-presets']);
  });
});

describe('the viewer’s keys', () => {
  it('lists Space, the arrows, ? and Esc', () => {
    const keys = VIEWER_SHORTCUTS.map((s) => s.keys).join(' ');
    expect(keys).toMatch(/Space/);
    expect(keys).toMatch(/←/);
    expect(keys).toMatch(/\?/);
    expect(keys).toMatch(/Esc/);
  });
});
