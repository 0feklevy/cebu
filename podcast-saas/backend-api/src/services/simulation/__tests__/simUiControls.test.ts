/**
 * Minimal-UI control picker — static scanner, selection contract, prompt block, and the
 * wrap templates' mechanical params.hideSelectors hide.
 *
 * Covers:
 *  (a) scanSimUiControls fixtures — buttons/sliders/toggles/selects/inputs, aria/label-for/
 *      text/title/placeholder/name/id label preference, UNAMBIGUOUS selectors only
 *      (#id / [name] — unnamed controls are dropped; the runtime scan covers them),
 *      unsafe-character filtering, dedupe, the 100 cap, and gate/bridge stripping
 *      (injected system scripts contribute nothing)
 *  (b) SimUiSelectionSchema — oversized/garbage/unsafe-selector rejection
 *  (c) normalize + simUiSelectionsEqual — the canReuse equality matrix (show/hide only;
 *      controls metadata drift never busts reuse)
 *  (d) buildUiControlsPromptBlock — one compact block, '' when no selection
 *  (e) wrapBridgeMainBody / wrapBridgeCombined — __simHideUi style logic + selector
 *      sanitization present in BOTH template variants, _lastSig semantics untouched
 */
import { describe, it, expect } from 'vitest';
import {
  SIM_UI_CONTROLS_MAX,
  SimUiSelectionSchema,
  buildUiControlsPromptBlock,
  normalizeSimUiSelection,
  prettifyIdentifier,
  readStoredUiControls,
  scanSimUiControls,
  simUiSelectionsEqual,
  type SimUiSelection,
} from '../SimUiControls.js';
import {
  injectInlineBridge,
  injectRafGate,
  wrapBridgeCombined,
  wrapBridgeMainBody,
} from '../SimulationService.js';

// ── (a) Static scanner ────────────────────────────────────────────────────────

const FIXTURE_HTML = [
  '<!doctype html>',
  '<html>',
  '<head><title>Sim</title></head>',
  '<body>',
  '  <div id="controls">',
  '    <label for="gravity">Gravity (m/s²)</label>',
  '    <input type="range" id="gravity" min="0" max="20">',
  '    <input type="checkbox" id="trails">',
  '    <label for="trails">Show trails</label>',
  '    <button id="resetBtn">Reset</button>',
  '    <button>Play</button>',
  '    <button id="pauseBtn" title="Pause the sim"></button>',
  '    <select name="preset"><option>A</option></select>',
  '    <input type="text" id="objName" placeholder="Object name">',
  '    <input type="hidden" name="csrf" value="x">',
  '    <input type="color" name="bgColor">',
  '    <a class="btn primary" href="#">Fullscreen</a>',
  '    <div role="button" aria-label="Zoom in" id="zoomBtn"></div>',
  '    <span role="slider" id="speedKnob"></span>',
  '    <div role="switch" title="Sound on"></div>',
  '    <textarea name="notes"></textarea>',
  '  </div>',
  '  <div id="footer">',
  '    <button>Outside</button>',
  '  </div>',
  '</body>',
  '</html>',
].join('\n');

describe('scanSimUiControls — kinds, labels, selectors', () => {
  const controls = scanSimUiControls(FIXTURE_HTML);
  const bySelector = new Map(controls.map(c => [c.selector, c]));

  it('maps element kinds per the contract', () => {
    expect(bySelector.get('#gravity')?.kind).toBe('slider');            // input[type=range]
    expect(bySelector.get('#trails')?.kind).toBe('toggle');             // input[type=checkbox]
    expect(bySelector.get('#resetBtn')?.kind).toBe('button');           // <button>
    expect(bySelector.get('[name="preset"]')?.kind).toBe('select');     // <select>
    expect(bySelector.get('[name="bgColor"]')?.kind).toBe('input');     // input[type=color]
    expect(bySelector.get('[name="notes"]')?.kind).toBe('input');       // <textarea>
    expect(bySelector.get('#speedKnob')?.kind).toBe('slider');          // role=slider
    expect(bySelector.get('#zoomBtn')?.kind).toBe('button');            // role=button
  });

  it('prefers aria-label → label[for] → text (buttons) → title → placeholder → name → id', () => {
    expect(bySelector.get('#zoomBtn')?.label).toBe('Zoom in');          // aria-label beats id
    expect(bySelector.get('#gravity')?.label).toBe('Gravity (m/s²)');   // label[for]
    expect(bySelector.get('#trails')?.label).toBe('Show trails');       // label[for]
    expect(bySelector.get('#resetBtn')?.label).toBe('Reset');           // text content
    expect(bySelector.get('#pauseBtn')?.label).toBe('Pause the sim');   // title beats id
    expect(bySelector.get('#objName')?.label).toBe('Object name');      // placeholder beats id
    expect(bySelector.get('[name="bgColor"]')?.label).toBe('Bg Color'); // name prettified
    expect(bySelector.get('#speedKnob')?.label).toBe('Speed Knob');     // id prettified
  });

  it('emits ONLY unambiguous #id / [name] selectors — unnamed controls are dropped', () => {
    expect(bySelector.has('#gravity')).toBe(true);
    expect(bySelector.has('[name="preset"]')).toBe(true);
    // Regex parsing cannot build a reliable structural path: no nth-of-type fallbacks.
    expect(controls.some(c => c.selector.includes(':nth-of-type('))).toBe(false);
    // The unnamed <button>Play</button>, a.btn, role=switch and footer button are gone —
    // the runtime (live-DOM) scanner covers those with exact child-combinator paths.
    for (const dropped of ['Play', 'Fullscreen', 'Sound on', 'Outside']) {
      expect(controls.some(c => c.label === dropped)).toBe(false);
    }
  });

  it('skips input[type=hidden] entirely', () => {
    expect(controls.some(c => c.label.includes('csrf') || c.selector.includes('csrf'))).toBe(false);
  });

  it('drops selectors containing { } < or backslash, and over-long ids', () => {
    const out = scanSimUiControls([
      '<button id="a{b">Bad brace</button>',
      '<button id="a}b">Bad brace 2</button>',
      '<input type="range" id="a<b">',
      '<input type="text" name="c\\d">',
      `<button id="${'x'.repeat(400)}">Too long</button>`,
      '<button id="ok">Fine</button>',
    ].join('\n'));
    expect(out).toEqual([{ selector: '#ok', kind: 'button', label: 'Fine' }]);
  });

  it('is robust to attribute order, single quotes, and unquoted values', () => {
    const out = scanSimUiControls(
      `<input id='q1' type='range'><input type=checkbox id=q2><button aria-label="Go" id="q3"></button>`,
    );
    const m = new Map(out.map(c => [c.selector, c]));
    expect(m.get('#q1')?.kind).toBe('slider');
    expect(m.get('#q2')?.kind).toBe('toggle');
    expect(m.get('#q3')?.label).toBe('Go');
  });

  it('a DUPLICATE id yields no control at all — ambiguity is dropped, not adjudicated', () => {
    // This test used to assert "first occurrence wins", which pinned the defect: `#dup` matches
    // BOTH elements, so the one row it kept was a selector that over-hides, and the second
    // control silently vanished. A selector that cannot be proven unique is not offered; the
    // runtime scanner addresses both elements via structural paths instead.
    const out = scanSimUiControls('<input type="range" id="dup"><input type="text" id="dup">');
    expect(out).toHaveLength(0);
  });

  it('an id that is not a clean CSS ident is dropped — querySelector could not use it', () => {
    // Legal HTML, unparseable raw CSS: a colon reads as a pseudo-class, a leading digit is not
    // an ident, a space is a descendant combinator. Escaping is not available (the /[{}<\\]/
    // filters at seven sites drop backslashes), so these fall to the runtime scanner.
    const out = scanSimUiControls(
      '<input type="range" id="odd:id.v2"><input type="range" id="123numeric">' +
      '<input type="range" id="has space"><input type="range" id="ok">',
    );
    expect(out.map((c) => c.selector)).toEqual(['#ok']);
  });

  it('a name shared by a group is never a selector — it names the group, not the control', () => {
    const out = scanSimUiControls(
      '<input type="radio" name="mode" value="a"><input type="radio" name="mode" value="b">' +
      '<input type="radio" name="solo" value="x">',
    );
    expect(out.map((c) => c.selector)).toEqual(['[name="solo"]']);
  });

  it('a duplicate id on a NON-control element still poisons the control selector', () => {
    // Ambiguity is a property of the document, not the control list: `#x` matching a <div> too
    // means hide-by-#x hides the div as well.
    const out = scanSimUiControls('<div id="x"></div><input type="range" id="x">');
    expect(out).toHaveLength(0);
  });

  it('caps at 100 controls', () => {
    const many = Array.from({ length: 150 }, (_, i) => `<button id="b${i}">B${i}</button>`).join('');
    expect(scanSimUiControls(many)).toHaveLength(SIM_UI_CONTROLS_MAX);
  });

  it('injected gate + inline bridge contribute nothing — scan is identical to the clean HTML', () => {
    const injected = injectInlineBridge(injectRafGate(FIXTURE_HTML), []);
    expect(injected).not.toBe(FIXTURE_HTML);   // sanity: injection actually happened
    expect(scanSimUiControls(injected)).toEqual(scanSimUiControls(FIXTURE_HTML));
  });

  it('ignores controls inside sim scripts, styles and comments', () => {
    const html = [
      '<script>const t = `<button id="phantom">x</button>`;</script>',
      '<style>#x{}</style>',
      '<!-- <input type="range" id="ghost"> -->',
      '<button id="real">Real</button>',
    ].join('\n');
    const out = scanSimUiControls(html);
    expect(out).toHaveLength(1);
    expect(out[0].selector).toBe('#real');
  });

  it('prettifies dashes/underscores/camelCase identifiers into words', () => {
    expect(prettifyIdentifier('playPauseBtn')).toBe('Play Pause Btn');
    expect(prettifyIdentifier('show-velocity_vectors')).toBe('Show Velocity Vectors');
  });

  it('derives wrapped-label text — <label>TEXT<input></label> AND text-after-control forms', () => {
    const out = scanSimUiControls([
      // Text before the control (the plan's canonical form).
      '<label>Wind speed: <input type="range" id="windSpeed"></label>',
      // Text AFTER the control — the flagship hand-rolled checkbox pattern
      // (<label class="checkbox-label"><input><span class=custom-checkbox/> Own wings</label>).
      '<label class="checkbox-label"><input type="checkbox" id="ownWings"><span class="custom-checkbox"></span> Own wings</label>',
      // A wrapped <select>: its <option> text must NOT leak into the label.
      '<label><select name="preset2"><option>Very long option text</option></select> Preset</label>',
    ].join('\n'));
    const m = new Map(out.map(c => [c.selector, c]));
    expect(m.get('#windSpeed')?.label).toBe('Wind speed');       // trailing ':' stripped
    expect(m.get('#windSpeed')?.kind).toBe('slider');
    expect(m.get('#ownWings')?.label).toBe('Own wings');
    expect(m.get('#ownWings')?.kind).toBe('toggle');
    expect(m.get('[name="preset2"]')?.label).toBe('Preset');
  });

  it('wrapped-label text loses to aria-label and label[for], but beats title/placeholder/name/id', () => {
    const out = scanSimUiControls([
      '<label>Wrapped A <input type="range" id="wa" aria-label="Aria wins"></label>',
      '<label for="wb">For wins</label>',
      '<label>Wrapped B <input type="range" id="wb"></label>',
      '<label>Wrapped C <input type="text" id="wc" title="Title loses" placeholder="Ph loses"></label>',
    ].join('\n'));
    const m = new Map(out.map(c => [c.selector, c]));
    expect(m.get('#wa')?.label).toBe('Aria wins');
    expect(m.get('#wb')?.label).toBe('For wins');
    expect(m.get('#wc')?.label).toBe('Wrapped C');
  });
});

// ── (b) Zod schema ────────────────────────────────────────────────────────────

const VALID_SELECTION: SimUiSelection = {
  controls: [
    { selector: '#a', kind: 'button', label: 'A' },
    { selector: '#b', kind: 'slider', label: 'B' },
  ],
  show: ['#a'],
  hide: ['#b'],
};

describe('SimUiSelectionSchema', () => {
  it('accepts a valid selection', () => {
    expect(SimUiSelectionSchema.safeParse(VALID_SELECTION).success).toBe(true);
  });

  it('rejects garbage shapes', () => {
    for (const bad of [null, 42, 'x', [], { controls: 'x', show: [], hide: [] }, { show: [], hide: [] }]) {
      expect(SimUiSelectionSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects oversized pieces (selectors > 300, labels > 200, arrays > 100)', () => {
    const longSel = '#' + 'x'.repeat(300);
    expect(SimUiSelectionSchema.safeParse({ ...VALID_SELECTION, hide: [longSel] }).success).toBe(false);
    expect(SimUiSelectionSchema.safeParse({
      ...VALID_SELECTION,
      controls: [{ selector: '#a', kind: 'button', label: 'x'.repeat(201) }],
    }).success).toBe(false);
    const manySelectors = Array.from({ length: 101 }, (_, i) => `#c${i}`);
    expect(SimUiSelectionSchema.safeParse({ ...VALID_SELECTION, hide: manySelectors }).success).toBe(false);
    expect(SimUiSelectionSchema.safeParse({
      controls: manySelectors.map(s => ({ selector: s, kind: 'button', label: 'x' })),
      show: [], hide: [],
    }).success).toBe(false);
  });

  it('rejects unknown kinds', () => {
    expect(SimUiSelectionSchema.safeParse({
      controls: [{ selector: '#a', kind: 'lever', label: 'A' }], show: [], hide: [],
    }).success).toBe(false);
  });

  it('rejects selectors containing { } < or backslash — in controls AND show/hide', () => {
    for (const bad of ['#a{b', '#a}b', '#a<b', '#a\\b', 'body{display:none}']) {
      expect(SimUiSelectionSchema.safeParse({ ...VALID_SELECTION, hide: [bad] }).success).toBe(false);
      expect(SimUiSelectionSchema.safeParse({ ...VALID_SELECTION, show: [bad] }).success).toBe(false);
      expect(SimUiSelectionSchema.safeParse({
        ...VALID_SELECTION,
        controls: [{ selector: bad, kind: 'button', label: 'X' }],
      }).success).toBe(false);
    }
  });

  it('allows the > child combinator (runtime structural paths)', () => {
    const structural = '#panel > div:nth-of-type(2) > button:nth-of-type(1)';
    expect(SimUiSelectionSchema.safeParse({
      controls: [{ selector: structural, kind: 'button', label: 'X' }],
      show: [structural],
      hide: ['body > canvas:nth-of-type(1)'],
    }).success).toBe(true);
  });

  it('accepts the optional hidden flag (gate v3 scan metadata) and rejects non-boolean values', () => {
    expect(SimUiSelectionSchema.safeParse({
      ...VALID_SELECTION,
      controls: [
        { selector: '#a', kind: 'button', label: 'A', hidden: true },
        { selector: '#b', kind: 'slider', label: 'B', hidden: false },
        { selector: '#c', kind: 'toggle', label: 'C' },               // absent stays fine
      ],
    }).success).toBe(true);
    expect(SimUiSelectionSchema.safeParse({
      ...VALID_SELECTION,
      controls: [{ selector: '#a', kind: 'button', label: 'A', hidden: 'yes' }],
    }).success).toBe(false);
  });
});

// ── (c) Normalization + canReuse equality matrix ──────────────────────────────

describe('simUiSelectionsEqual — canReuse selection matrix', () => {
  const sel = (show: string[], hide: string[]): SimUiSelection => ({
    controls: VALID_SELECTION.controls, show, hide,
  });

  it('both absent → equal (reuse allowed)', () => {
    expect(simUiSelectionsEqual(undefined, undefined)).toBe(true);
  });

  it('same selection → equal, regardless of show/hide order', () => {
    const a = sel(['#a', '#b'], ['#c', '#d']);
    const b = sel(['#b', '#a'], ['#d', '#c']);
    expect(simUiSelectionsEqual(a, b)).toBe(true);
  });

  it('same picks with drifted controls metadata → STILL equal (FE contract: show/hide only)', () => {
    // A rescan of the same sim can reorder controls, rename labels or reclassify kinds.
    // Identical picks must reuse — only the semantic show/hide sets count.
    const a: SimUiSelection = {
      controls: [
        { selector: '#a', kind: 'button', label: 'Run' },
        { selector: '#b', kind: 'slider', label: 'Speed' },
      ],
      show: ['#a'], hide: ['#b'],
    };
    const b: SimUiSelection = {
      controls: [
        { selector: '#b', kind: 'toggle', label: 'Renamed speed' },   // reordered + drifted
        { selector: '#a', kind: 'other',  label: 'Run (2)' },
        { selector: '#c', kind: 'input',  label: 'New in rescan' },   // extra metadata row
      ],
      show: ['#a'], hide: ['#b'],
    };
    expect(simUiSelectionsEqual(a, b)).toBe(true);
  });

  it('same picks with drifted hidden flags → STILL equal (hidden is scan metadata, never busts canReuse)', () => {
    // The same control can flip hidden between scans (menu open vs closed at scan time).
    const a: SimUiSelection = {
      controls: [
        { selector: '#a', kind: 'button', label: 'Run' },
        { selector: '#b', kind: 'slider', label: 'Speed', hidden: true },
      ],
      show: ['#a'], hide: ['#b'],
    };
    const b: SimUiSelection = {
      controls: [
        { selector: '#a', kind: 'button', label: 'Run', hidden: true },
        { selector: '#b', kind: 'slider', label: 'Speed' },
      ],
      show: ['#a'], hide: ['#b'],
    };
    expect(simUiSelectionsEqual(a, b)).toBe(true);
    expect(simUiSelectionsEqual(normalizeSimUiSelection(a), normalizeSimUiSelection(b))).toBe(true);
  });

  it('different selection → not equal (regenerate)', () => {
    expect(simUiSelectionsEqual(sel(['#a'], ['#b']), sel(['#b'], ['#a']))).toBe(false);
  });

  it('selection added (stored absent) → not equal', () => {
    expect(simUiSelectionsEqual(undefined, VALID_SELECTION)).toBe(false);
  });

  it('selection removed (incoming absent) → not equal', () => {
    expect(simUiSelectionsEqual(VALID_SELECTION, undefined)).toBe(false);
  });

  it('normalize sorts show/hide but keeps controls order (client owns coherence)', () => {
    const n = normalizeSimUiSelection({ ...VALID_SELECTION, show: ['#z', '#a'], hide: ['#m', '#b'] });
    expect(n.show).toEqual(['#a', '#z']);
    expect(n.hide).toEqual(['#b', '#m']);
    expect(n.controls.map(c => c.selector)).toEqual(['#a', '#b']);
    // Unknown selectors are NOT dropped.
    const withUnknown = normalizeSimUiSelection({ ...VALID_SELECTION, hide: ['#not-in-controls'] });
    expect(withUnknown.hide).toEqual(['#not-in-controls']);
  });

  it('normalize keeps hidden:true and canonicalizes false/absent to the key being ABSENT', () => {
    const n = normalizeSimUiSelection({
      controls: [
        { selector: '#a', kind: 'button', label: 'A', hidden: true },
        { selector: '#b', kind: 'slider', label: 'B', hidden: false },
        { selector: '#c', kind: 'toggle', label: 'C' },
      ],
      show: [], hide: [],
    });
    expect(n.controls[0].hidden).toBe(true);
    expect('hidden' in n.controls[1]).toBe(false);
    expect('hidden' in n.controls[2]).toBe(false);
  });

  it('readStoredUiControls round-trips the hidden flag', () => {
    const stored: SimUiSelection = {
      controls: [{ selector: '#adv', kind: 'slider', label: 'Wind', hidden: true }],
      show: [], hide: ['#adv'],
    };
    expect(readStoredUiControls(stored)?.controls[0].hidden).toBe(true);
  });

  it('readStoredUiControls tolerates malformed jsonb (→ undefined, i.e. absent)', () => {
    expect(readStoredUiControls(undefined)).toBeUndefined();
    expect(readStoredUiControls(null)).toBeUndefined();
    expect(readStoredUiControls({ hide: ['#a'] })).toBeUndefined();          // missing keys
    expect(readStoredUiControls('garbage')).toBeUndefined();
    expect(readStoredUiControls(VALID_SELECTION)).toEqual(normalizeSimUiSelection(VALID_SELECTION));
  });
});

// ── (d) Prompt block ──────────────────────────────────────────────────────────

describe('buildUiControlsPromptBlock', () => {
  it('is empty when there is no selection or nothing is shown/hidden', () => {
    expect(buildUiControlsPromptBlock(undefined)).toBe('');
    expect(buildUiControlsPromptBlock({ controls: VALID_SELECTION.controls, show: [], hide: [] })).toBe('');
  });

  it('lists ONLY the KEEP-VISIBLE controls; hidden controls are a token-cheap COUNT (lean block)', () => {
    const block = buildUiControlsPromptBlock(VALID_SELECTION);
    expect(block.startsWith('MINIMAL-UI CONTRACT (user-selected, authoritative):')).toBe(true);
    // Shown controls are itemized (label (kind) `selector`)…
    expect(block).toContain('KEEP VISIBLE');
    expect(block).toContain('- A (button) `#a`');
    // …hidden controls are NOT itemized (no selector dump) — only summarized as a count.
    expect(block).not.toContain('- B (slider) `#b`');
    expect(block).toContain('1 other scanned control');
    expect(block).toContain('params.hideSelectors');
    expect(block).toContain('never hide the KEEP-VISIBLE controls');
    expect(block).toContain('when simpleUi is off all controls stay untouched');
  });

  it('hide-only selection (None) emits a chrome-free block that names no selectors', () => {
    const block = buildUiControlsPromptBlock({
      controls: [{ selector: '#a', kind: 'button', label: 'A' }, { selector: '#b', kind: 'slider', label: 'B' }],
      show: [],
      hide: ['#a', '#b'],
    });
    expect(block.startsWith('MINIMAL-UI CONTRACT (user-selected, authoritative):')).toBe(true);
    expect(block).toContain('ALL 2 scanned UI control(s) are hidden');
    expect(block).not.toContain('KEEP VISIBLE');
    // No individual selectors are dumped into the prompt (token savings + the user's intent).
    expect(block).not.toContain('`#a`');
    expect(block).not.toContain('`#b`');
  });
});

// ── (e) Wrap templates — mechanical hideSelectors ─────────────────────────────

describe('wrap templates — __simHideUi mechanical hide', () => {
  const MAIN_BODY = 'return function cleanup() {};';
  const single = wrapBridgeMainBody(MAIN_BODY);
  const combined = wrapBridgeCombined(new Map([['sec-1', MAIN_BODY]]));

  for (const [name, tpl] of [['wrapBridgeMainBody', single], ['wrapBridgeCombined', combined]] as const) {
    describe(name, () => {
      it('applies hideSelectors via one style#__simHideUi only when simpleUi is on', () => {
        expect(tpl).toContain("document.getElementById('__simHideUi')");
        expect(tpl).toContain('params && params.simpleUi && Array.isArray(params.hideSelectors)');
        expect(tpl).toContain("'{display:none !important}'");
        expect(tpl).toContain("st.id = '__simHideUi';");
      });

      it('sanitizes selectors — rejects { } < and backslash, allows the > combinator', () => {
        expect(tpl).toContain('/[{}<\\\\]/.test(sel)');
        // '>' must NOT be in the forbidden class: runtime structural paths
        // ('#panel > button:nth-of-type(1)') rely on the child combinator.
        expect(tpl).not.toContain('/[{}<>\\\\]/.test(sel)');
      });

      it('refreshes the style on startScript and removes it on stopScript', () => {
        expect(tpl).toContain('applyHideUi(params);   // mechanical Minimal-UI hide — refreshed on every (re)start');
        const stopBody = tpl.slice(tpl.indexOf('function stopScript()'), tpl.indexOf('function startScript('));
        expect(stopBody).toContain('__simHideUi');
        expect(stopBody).toContain('.remove()');
      });

      it('keeps _lastSig semantics — hideSelectors participate via JSON.stringify(params)', () => {
        expect(tpl).toContain("JSON.stringify(params || {})");
        expect(tpl).toContain('sig === _lastSig) return;');
        // applyHideUi runs AFTER the identical-sig early return and after stopScript().
        const startBody = tpl.slice(tpl.indexOf('function startScript('), tpl.indexOf('window.SimAPI'));
        expect(startBody.indexOf('sig === _lastSig')).toBeLessThan(startBody.indexOf('applyHideUi(params)'));
        expect(startBody.indexOf('stopScript();')).toBeLessThan(startBody.indexOf('applyHideUi(params)'));
      });

      it('remains syntactically valid', () => {
        expect(() => new Function(tpl)).not.toThrow();
      });
    });
  }
});
