import { describe, it, expect } from 'vitest';
import {
  MAX_UI_CONTROLS,
  SIM_UI_CONTROLS_PARAM_MAX_CHARS,
  SIM_UI_LABEL_MAX_CHARS,
  SIM_UI_SELECTOR_MAX_CHARS,
  getStoredSelection,
  kindLabel,
  mergeScans,
  normalizeSelection,
  sanitizeControls,
  selectionsEqual,
  type SimUiControl,
} from './simUiControls';

const ctl = (selector: string, kind: SimUiControl['kind'] = 'button', label = selector): SimUiControl =>
  ({ selector, kind, label });

describe('sanitizeControls', () => {
  it('accepts a valid list and trims/dedupes selectors', () => {
    const out = sanitizeControls([
      { selector: ' #run ', kind: 'button', label: 'Run' },
      { selector: '#run', kind: 'button', label: 'Run again' },   // dup after trim
      { selector: '#speed', kind: 'slider', label: '  Speed  ' },
    ]);
    expect(out).toEqual([
      { selector: '#run', kind: 'button', label: 'Run' },
      { selector: '#speed', kind: 'slider', label: 'Speed' },
    ]);
  });

  it('coerces unknown kinds to "other" and falls back label→selector', () => {
    const out = sanitizeControls([{ selector: '#x', kind: 'wheel', label: '' }]);
    expect(out).toEqual([{ selector: '#x', kind: 'other', label: '#x' }]);
  });

  it('rejects non-arrays, junk entries, and empty results', () => {
    expect(sanitizeControls(null)).toBeNull();
    expect(sanitizeControls({ controls: [] })).toBeNull();
    expect(sanitizeControls([null, 42, { kind: 'button' }, { selector: '   ' }])).toBeNull();
  });

  it('caps at MAX_UI_CONTROLS', () => {
    const raw = Array.from({ length: MAX_UI_CONTROLS + 20 }, (_, i) => ({ selector: `#c${i}`, kind: 'button', label: `c${i}` }));
    expect(sanitizeControls(raw)).toHaveLength(MAX_UI_CONTROLS);
  });

  it('enforces the backend caps: trims labels to 200 chars, drops selectors over 300', () => {
    const out = sanitizeControls([
      { selector: '#ok', kind: 'button', label: 'y'.repeat(SIM_UI_LABEL_MAX_CHARS + 50) },
      { selector: '#' + 'x'.repeat(SIM_UI_SELECTOR_MAX_CHARS), kind: 'button', label: 'too long' },
    ]);
    expect(out).toHaveLength(1);
    expect(out![0].selector).toBe('#ok');
    expect(out![0].label).toHaveLength(SIM_UI_LABEL_MAX_CHARS);
  });

  it('drops selectors containing { } < or backslash but keeps the > child combinator', () => {
    const out = sanitizeControls([
      { selector: '#a{b', kind: 'button', label: 'brace' },
      { selector: '#a}b', kind: 'button', label: 'brace2' },
      { selector: '#a<b', kind: 'button', label: 'lt' },
      { selector: '#a\\b', kind: 'button', label: 'backslash' },
      { selector: '#panel > button:nth-of-type(2)', kind: 'button', label: 'child path' },
    ]);
    expect(out).toEqual([
      { selector: '#panel > button:nth-of-type(2)', kind: 'button', label: 'child path' },
    ]);
  });

  it('exports the 8 KB ui_controls param cap the generate call pre-checks', () => {
    expect(SIM_UI_CONTROLS_PARAM_MAX_CHARS).toBe(8192);
  });

  it('passes hidden through as true (truthy coerced) and OMITS the key when false/absent', () => {
    const out = sanitizeControls([
      { selector: '#h', kind: 'slider', label: 'Wind', hidden: true },
      { selector: '#t', kind: 'button', label: 'View', hidden: 1 },     // truthy → true
      { selector: '#f', kind: 'button', label: 'Play', hidden: false }, // false → omitted
      { selector: '#a', kind: 'toggle', label: 'Wings' },               // absent → omitted
    ]);
    // toStrictEqual distinguishes a missing key from hidden: undefined — the key must be GONE.
    expect(out).toStrictEqual([
      { selector: '#h', kind: 'slider', label: 'Wind', hidden: true },
      { selector: '#t', kind: 'button', label: 'View', hidden: true },
      { selector: '#f', kind: 'button', label: 'Play' },
      { selector: '#a', kind: 'toggle', label: 'Wings' },
    ]);
  });
});

describe('normalizeSelection', () => {
  it('splits checked→show / unchecked→hide, both sorted', () => {
    const controls = [ctl('#b'), ctl('#a', 'slider'), ctl('#c', 'toggle')];
    const sel = normalizeSelection(controls, new Set(['#c', '#b']));
    expect(sel.show).toEqual(['#b', '#c']);
    expect(sel.hide).toEqual(['#a']);
    expect(sel.controls.map(c => c.selector)).toEqual(['#b', '#a', '#c']); // controls order preserved
  });

  it('ignores checked selectors not present in controls and dedupes controls', () => {
    const sel = normalizeSelection([ctl('#a'), ctl('#a')], new Set(['#a', '#ghost']));
    expect(sel.controls).toHaveLength(1);
    expect(sel.show).toEqual(['#a']);
    expect(sel.hide).toEqual([]);
  });

  it('all-unchecked puts everything in hide', () => {
    const sel = normalizeSelection([ctl('#a'), ctl('#b')], new Set());
    expect(sel.show).toEqual([]);
    expect(sel.hide).toEqual(['#a', '#b']);
  });
});

describe('selectionsEqual', () => {
  it('treats absent == absent', () => {
    expect(selectionsEqual(undefined, undefined)).toBe(true);
    expect(selectionsEqual(null, undefined)).toBe(true);
  });

  it('absent != present', () => {
    expect(selectionsEqual(undefined, { controls: [], show: ['#a'], hide: [] })).toBe(false);
    expect(selectionsEqual({ controls: [], show: [], hide: ['#a'] }, null)).toBe(false);
  });

  it('is order-insensitive on show/hide and ignores control metadata drift', () => {
    const a = { controls: [ctl('#a', 'button', 'Run')], show: ['#a', '#b'], hide: ['#c'] };
    const b = { controls: [ctl('#a', 'slider', 'Renamed')], show: ['#b', '#a'], hide: ['#c'] };
    expect(selectionsEqual(a, b)).toBe(true);
  });

  it('ignores hidden-flag drift (scan metadata — the same control can flip hidden between scans)', () => {
    const a = { controls: [{ ...ctl('#a'), hidden: true }, ctl('#b')], show: ['#a'], hide: ['#b'] };
    const b = { controls: [ctl('#a'), { ...ctl('#b'), hidden: true }], show: ['#a'], hide: ['#b'] };
    expect(selectionsEqual(a, b)).toBe(true);
  });

  it('detects a moved selector', () => {
    const a = { controls: [], show: ['#a', '#b'], hide: ['#c'] };
    const b = { controls: [], show: ['#a'], hide: ['#b', '#c'] };
    expect(selectionsEqual(a, b)).toBe(false);
  });
});

describe('mergeScans', () => {
  it('runtime wins on selector collision; union otherwise, runtime order first', () => {
    const stat = [ctl('#a', 'button', 'static A'), ctl('#b', 'input', 'static B')];
    const runtime = [ctl('#c', 'slider', 'runtime C'), ctl('#a', 'toggle', 'runtime A')];
    expect(mergeScans(stat, runtime)).toEqual([
      { selector: '#c', kind: 'slider', label: 'runtime C' },
      { selector: '#a', kind: 'toggle', label: 'runtime A' },
      { selector: '#b', kind: 'input', label: 'static B' },
    ]);
  });

  it('handles null/undefined sides', () => {
    expect(mergeScans(null, undefined)).toEqual([]);
    expect(mergeScans([ctl('#a')], null)).toEqual([ctl('#a')]);
    expect(mergeScans(undefined, [ctl('#b')])).toEqual([ctl('#b')]);
  });

  it('caps merged output at MAX_UI_CONTROLS', () => {
    const stat = Array.from({ length: 80 }, (_, i) => ctl(`#s${i}`));
    const runtime = Array.from({ length: 80 }, (_, i) => ctl(`#r${i}`));
    expect(mergeScans(stat, runtime)).toHaveLength(MAX_UI_CONTROLS);
  });

  it("runtime's hidden flag survives a collision (runtime wins — static scans can't see visibility)", () => {
    const stat = [ctl('#adv', 'slider', 'static Wind')];
    const runtime = [{ ...ctl('#adv', 'slider', 'Wind'), hidden: true }];
    expect(mergeScans(stat, runtime)).toStrictEqual([
      { selector: '#adv', kind: 'slider', label: 'Wind', hidden: true },
    ]);
  });
});

describe('kindLabel', () => {
  it('maps kinds to chip labels', () => {
    expect(kindLabel('slider')).toBe('Slider');
    expect(kindLabel('toggle')).toBe('Toggle');
    expect(kindLabel('button')).toBe('Button');
    expect(kindLabel('select')).toBe('Select');
    expect(kindLabel('input')).toBe('Input');
    expect(kindLabel('other')).toBe('Other');
  });
});

describe('getStoredSelection', () => {
  it('reads a persisted sim_meta.uiControls selection', () => {
    const simMeta = {
      planVersion: '7',
      uiControls: {
        controls: [{ selector: '#a', kind: 'slider', label: 'A' }],
        show: ['#a'],
        hide: ['#b'],
      },
    };
    expect(getStoredSelection(simMeta)).toEqual({
      controls: [{ selector: '#a', kind: 'slider', label: 'A' }],
      show: ['#a'],
      hide: ['#b'],
    });
  });

  it('returns null for absent/malformed uiControls', () => {
    expect(getStoredSelection(null)).toBeNull();
    expect(getStoredSelection({})).toBeNull();
    expect(getStoredSelection({ uiControls: 'nope' })).toBeNull();
    expect(getStoredSelection({ uiControls: { controls: [], show: [], hide: [] } })).toBeNull();
  });

  it('filters non-string selectors out of show/hide', () => {
    const sel = getStoredSelection({ uiControls: { controls: null, show: ['#a', 7, ''], hide: [null, '#b'] } });
    expect(sel).toEqual({ controls: [], show: ['#a'], hide: ['#b'] });
  });

  it('round-trips the hidden flag on stored controls (picker regrouping after restore)', () => {
    const sel = getStoredSelection({
      uiControls: {
        controls: [
          { selector: '#adv', kind: 'slider', label: 'Wind', hidden: true },
          { selector: '#play', kind: 'button', label: 'Play' },
        ],
        show: ['#play'],
        hide: ['#adv'],
      },
    });
    expect(sel?.controls).toStrictEqual([
      { selector: '#adv', kind: 'slider', label: 'Wind', hidden: true },
      { selector: '#play', kind: 'button', label: 'Play' },
    ]);
  });

  it('returns the FULL selection (controls+show+hide) so re-sending it round-trips the backend equality', () => {
    // The generate call re-sends the stored selection verbatim when the panel is untouched;
    // the backend compares sorted show+hide — the stored values must survive unchanged,
    // including runtime child-combinator structural selectors.
    const stored = {
      controls: [{ selector: '#panel > button:nth-of-type(2)', kind: 'button', label: 'Play' }],
      show: ['#panel > button:nth-of-type(2)'],
      hide: ['#hud', 'body > div:nth-of-type(3)'],
    };
    expect(getStoredSelection({ uiControls: stored })).toEqual(stored);
  });
});
