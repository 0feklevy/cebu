/**
 * Save a bridge, then decide whether it can be pasted somewhere else — through the REAL modules.
 *
 * ── THE GAP THIS CLOSES ───────────────────────────────────────────────────────────────────────
 * `bridgePresetDecision.test.ts` proves the judgement given a contract and a verification result.
 * It hands both in as literals. So the three steps that PRODUCE those inputs have never been run
 * together:
 *
 *     a real bridge.js  →  parseSectionEntries  →  extractBridgeContract  →  verifyContract
 *
 * Every one of those is a parser or a scanner over text, and text parsers fail on real input in
 * ways no hand-written literal reproduces: a body extracted with its wrapper still attached, a
 * contract that harvests the WRAPPER's identifiers instead of the demo's, a verification that
 * matches a substring of an unrelated word. Any of those turns "apply instantly" into a section
 * that silently does nothing — the exact failure the whole design exists to prevent.
 *
 * So this file starts from bridge.js text in the shipped grammar and ends at a verdict.
 */
import { describe, it, expect } from 'vitest';
import { parseSectionEntries } from '../SimulationService.js';
import { extractBridgeContract, verifyContract, buildSources } from '../SimBridgeContract.js';
import { judgeBridgeLoad, describeLoadPath } from '../bridgePresetDecision.js';

const SECTION = 'sec-11111111';

/** A bridge.js in the grammar `buildSectionEntry` emits, holding one realistic demo body. */
const BRIDGE_JS = `
window.__SECTIONS__ = {
    /* @@SIM_BRIDGE:${SECTION}@@ */
    '${SECTION}': function (params) {
      var btn = document.getElementById('pluck-btn');
      var panel = document.querySelector('.controls .slider-container');
      window.__murmuration.pluck(1);
      btn.addEventListener('click', function () { window.__murmuration.pluck(2); });
      return function cleanup() { panel = null; };
    },
    /* @@/SIM_BRIDGE:${SECTION}@@ */
};
`;

/** A simulation that provides everything the demo binds to. */
const MATCHING_SIM = {
  files: new Map([
    ['index.html', Buffer.from(`<div class="controls"><div class="slider-container"></div>
      <button id="pluck-btn">Pluck</button></div><script src="app.js"></script>`)],
    ['app.js', Buffer.from(`window.__murmuration = { pluck: function (n) { return n; } };`)],
  ]),
  entryRelPath: 'index.html',
};

/** A different simulation — same shape of product, none of the same names. */
const FOREIGN_SIM = {
  files: new Map([
    ['index.html', Buffer.from(`<div class="panel"><input id="temperature"></div><script src="ising.js"></script>`)],
    ['ising.js', Buffer.from(`window.__ising = { flip: function () {} };`)],
  ]),
  entryRelPath: 'index.html',
};

const preset = () => {
  const mainBody = parseSectionEntries(BRIDGE_JS).get(SECTION) ?? null;
  return {
    mainBody,
    contract: mainBody ? extractBridgeContract(mainBody) : null,
    sourceBridgeHash: 'bh-source',
    sourceHash: null,
  };
};

describe('extracting the body from a real bridge.js', () => {
  it('finds the section and returns the BARE body, without its wrapper', () => {
    // A body saved with `'sec-…': function (params) {` still attached would be re-wrapped on
    // apply and produce a syntactically broken bridge — one that fails at load, silently, in
    // production.
    const body = parseSectionEntries(BRIDGE_JS).get(SECTION);
    expect(body).toBeTruthy();
    expect(body).toContain('__murmuration.pluck');
    expect(body, 'the dispatch key rode along with the body').not.toContain(`'${SECTION}':`);
    expect(body, 'the function wrapper rode along with the body').not.toMatch(/^function\s*\(params\)/);
  });

  it('returns null for a section the bridge does not carry', () => {
    expect(parseSectionEntries(BRIDGE_JS).get('sec-does-not-exist')).toBeUndefined();
  });
});

describe('the contract harvested from that body', () => {
  it('captures what the demo actually binds to', () => {
    const c = extractBridgeContract(preset().mainBody!);
    const all = JSON.stringify(c);
    expect(all).toContain('pluck-btn');
    expect(all).toContain('__murmuration');
  });

  it('does NOT harvest the wrapper\'s own vocabulary', () => {
    // `params` and `cleanup` belong to the harness, exist in every body, and would verify against
    // any simulation at all — a contract containing them is weaker than it looks.
    const c = extractBridgeContract(preset().mainBody!);
    const ids = [...c.ids, ...c.classes, ...c.globals, ...c.members];
    expect(ids).not.toContain('params');
    expect(ids).not.toContain('cleanup');
  });
});

describe('the verdict, end to end', () => {
  it('APPLIES INSTANTLY when the target provides every anchor', () => {
    const p = preset();
    const verification = verifyContract(p.contract!, buildSources(MATCHING_SIM));
    const v = judgeBridgeLoad(p, { bridgeHash: 'bh-target', verification });

    expect(verification.missing, `unmet: ${JSON.stringify(verification.missing)}`).toEqual([]);
    expect(v.path).toBe('artifact');
    expect(describeLoadPath(v)).toMatch(/instantly/);
  });

  it('REGENERATES against a foreign simulation — and names what is missing', () => {
    // The failure this design exists for: pasted onto the Ising model, the boids demo would find
    // nothing and no-op silently. Here it is refused, with the anchors listed.
    const p = preset();
    const verification = verifyContract(p.contract!, buildSources(FOREIGN_SIM));
    const v = judgeBridgeLoad(p, { bridgeHash: 'bh-other', verification });

    expect(verification.missing.length).toBeGreaterThan(0);
    expect(v.path).toBe('recipe');
    const sentence = describeLoadPath(v);
    expect(sentence).not.toMatch(/instantly/);
    expect(sentence).toMatch(/#pluck-btn|__murmuration|does not have/);
  });

  it('a target missing only ONE anchor is still refused', () => {
    // Partial is not compatible: a demo that finds its button and not its API half-runs, which is
    // worse than not running — it looks alive and does the wrong thing.
    const nearly = {
      files: new Map([
        ['index.html', Buffer.from(`<div class="controls"><div class="slider-container"></div>
          <button id="pluck-btn">Pluck</button></div>`)],
        // No app.js: the DOM matches, `window.__murmuration` does not exist.
      ]),
      entryRelPath: 'index.html',
    };
    const p = preset();
    const verification = verifyContract(p.contract!, buildSources(nearly));
    expect(verification.missing.length).toBeGreaterThan(0);
    expect(judgeBridgeLoad(p, { bridgeHash: null, verification }).path).toBe('recipe');
  });

  it('a recipe-only preset never reaches the artifact path, whatever the target offers', () => {
    const v = judgeBridgeLoad(
      { mainBody: null, contract: null, sourceBridgeHash: null, sourceHash: null },
      { bridgeHash: 'bh', verification: { missing: [], checked: 0 } },
    );
    expect(v).toMatchObject({ path: 'recipe', why: 'no-artifact' });
  });
});
