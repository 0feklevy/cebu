/**
 * The POLICY ALGEBRA (audit P1.2) — the one module that decides whether a presentation change can
 * be applied to a LIVE section or must re-run its body.
 *
 * WHY THIS FILE IS WORTH ITS LENGTH
 * Everything downstream of `simPolicy.ts` is a consequence of the partition it declares. The v3
 * child, the generated v2 bridge and `SimRuntimeClient` each restate a piece of it in their own
 * dialect — a bridge template written as strings, a runtime emitted as bytes, a TypeScript class —
 * and none of them can compare notes at compile time. So the properties pinned here are the ones
 * the other three suites assume and cannot themselves prove:
 *
 *   • which fields are policy and which are structural, TOTALLY over `SimPresentationConfig`;
 *   • that `hideSelectors` compares as a SET, so a re-ordered selection is not a change;
 *   • that `null` and `[]` stay distinguishable through `mergePolicy` and `paramsForPolicy`,
 *     because the section editor's toggle and its picker rely on exactly that difference;
 *   • that `policyDelta`'s structural verdict agrees with `canonicalizeConfig` — a disagreement
 *     means re-activating for a difference the identity model says does not exist, which is the
 *     precise defect P1.2 removes.
 *
 * WHAT THESE TESTS DO NOT PROVE
 * Nothing here runs a simulation. "A toggle does not reset the physics" is a property of the child
 * runtime and the bridge, and it is proven in those suites by observing that a section body was not
 * re-executed. This file proves only that the DECISION handed to them is the right one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  CONFIG_FIELD_IS_POLICY,
  POLICY_CONFIG_FIELDS,
  SIM_POLICY_KINDS,
  STRUCTURAL_CONFIG_FIELDS,
  automationPolicyOf,
  effectiveConfig,
  isSimPolicyKind,
  mergePolicy,
  normalizeHideSelectors,
  paramsForPolicy,
  policyDelta,
  sameAutomationPolicy,
  sameSectionPolicy,
  sameUiPolicy,
  sectionPolicyOf,
  uiPolicyOf,
  withAutomationPolicy,
  withSectionPolicy,
  withUiPolicy,
  type SimSectionPolicy,
  type SimUiPolicy,
} from '../simPolicy.js';
import {
  DEFAULT_PRESENTATION_CONFIG,
  canonicalizeConfig,
  computeConfigHash,
  type SimPresentationConfig,
} from '../simIdentity.js';

const base = (over: Partial<SimPresentationConfig> = {}): SimPresentationConfig => ({
  ...DEFAULT_PRESENTATION_CONFIG,
  ...over,
});

const policy = (over: Partial<SimSectionPolicy> = {}): SimSectionPolicy => ({
  simpleUi: false,
  hideSelectors: null,
  autoScript: true,
  ...over,
});

// ══ 1. THE PARTITION IS TOTAL ════════════════════════════════════════════════════════════════
//
// The map is `satisfies Record<keyof SimPresentationConfig, boolean>`, so a field added to the
// config and NOT to the map is already a compile error. The other direction — and the one a
// `satisfies` cannot catch — is a field added to the config, added to the map, and then quietly
// left out of `POLICY_CONFIG_FIELDS` or mis-classified. These read the interface from source so
// the guard is about the TYPE, not about a value someone remembered to keep in step.

/** The property names declared on `interface SimPresentationConfig`, read from the source file. */
function declaredConfigFields(): string[] {
  const path = new URL('../simIdentity.ts', import.meta.url);
  const sf = ts.createSourceFile(
    'simIdentity.ts',
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === 'SimPresentationConfig') {
      for (const m of n.members) {
        if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name)) out.push(m.name.text);
      }
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return out;
}

describe('the policy/structural partition covers SimPresentationConfig exactly', () => {
  it('reads the interface from source at all — a failed parse would make the guard vacuous', () => {
    // Without this, a rename of the interface (or a parse that silently returns nothing) would turn
    // the next test into `[] vs []`, which passes forever.
    const declared = declaredConfigFields();
    expect(declared.length, 'SimPresentationConfig was not found in simIdentity.ts').toBeGreaterThan(4);
    expect(declared).toContain('simpleUi');
    expect(declared).toContain('quality');
  });

  it('CONFIG_FIELD_IS_POLICY has an entry for every declared field, and invents none', () => {
    // THIS IS THE GUARD THE FINDING ASKS FOR. Add `showLegend: boolean` to the config and this
    // fails until someone decides whether hiding a legend is chrome (policy) or a rebuild
    // (structural) — which is a decision, not a detail, and the failure is where it gets made.
    expect(Object.keys(CONFIG_FIELD_IS_POLICY).sort()).toEqual([...declaredConfigFields()].sort());
  });

  it('POLICY_CONFIG_FIELDS and STRUCTURAL_CONFIG_FIELDS partition the same set, with no overlap', () => {
    const policyFields = Object.entries(CONFIG_FIELD_IS_POLICY).filter(([, v]) => v).map(([k]) => k);
    expect([...POLICY_CONFIG_FIELDS].sort()).toEqual(policyFields.sort());
    expect([...STRUCTURAL_CONFIG_FIELDS].sort()).toEqual(['aspect', 'initialState', 'quality', 'transparent']);
    const overlap = [...POLICY_CONFIG_FIELDS].filter((k) => (STRUCTURAL_CONFIG_FIELDS as string[]).includes(k));
    expect(overlap, 'a field cannot be both hot-swappable and a rebuild').toEqual([]);
    expect(POLICY_CONFIG_FIELDS.length + STRUCTURAL_CONFIG_FIELDS.length)
      .toBe(Object.keys(CONFIG_FIELD_IS_POLICY).length);
  });

  it('classifies the three chrome/automation fields as policy and nothing else', () => {
    // Stated as literals rather than derived, so a mis-flip (`quality: true`) fails HERE with a
    // readable diff instead of somewhere downstream as a section that refuses to rebuild.
    expect(CONFIG_FIELD_IS_POLICY).toEqual({
      simpleUi: true, hideSelectors: true, autoScript: true,
      quality: false, aspect: false, initialState: false, transparent: false,
    });
  });

  it('the kind union is the two families the protocol carries, and rejects anything else', () => {
    expect([...SIM_POLICY_KINDS]).toEqual(['ui', 'automation']);
    for (const k of SIM_POLICY_KINDS) expect(isSimPolicyKind(k)).toBe(true);
    for (const junk of ['UI', 'both', '', null, undefined, 0, {}]) expect(isSimPolicyKind(junk)).toBe(false);
  });
});

// ══ 2. hideSelectors IS A SET ════════════════════════════════════════════════════════════════

describe('normalizeHideSelectors — set semantics, the same rule canonicalizeConfig uses', () => {
  it('dedupes and sorts, so order and repetition are not information', () => {
    expect(normalizeHideSelectors(['.b', '.a', '.b'])).toEqual(['.a', '.b']);
    expect(normalizeHideSelectors(['.a', '.b'])).toEqual(normalizeHideSelectors(['.b', '.a']));
  });

  it('collapses null, undefined and [] to the same empty set', () => {
    expect(normalizeHideSelectors(null)).toEqual([]);
    expect(normalizeHideSelectors(undefined)).toEqual([]);
    expect(normalizeHideSelectors([])).toEqual([]);
  });

  it('never mutates or aliases its input — the caller keeps its own ordering', () => {
    const input = ['.z', '.a'];
    const out = normalizeHideSelectors(input);
    expect(input, 'the live policy object was sorted underneath its owner').toEqual(['.z', '.a']);
    expect(out).not.toBe(input);
  });

  it('agrees with canonicalizeConfig, which is what makes a re-order cost nothing downstream', () => {
    // If these two ever disagreed, a re-ordered selection would be "no change" to the policy path
    // and a DIFFERENT configHash to the identity model — i.e. a live section whose stored poster
    // key no longer describes it.
    const a = base({ simpleUi: true, hideSelectors: ['.b', '.a', '.a'] });
    const b = base({ simpleUi: true, hideSelectors: ['.a', '.b'] });
    expect(canonicalizeConfig(a)).toBe(canonicalizeConfig(b));
    expect(sameUiPolicy(uiPolicyOf(a), uiPolicyOf(b))).toBe(true);
  });
});

describe('sameUiPolicy — null vs [] vs re-ordered', () => {
  const ui = (simpleUi: boolean, hideSelectors: string[] | null): SimUiPolicy => ({ simpleUi, hideSelectors });

  it('treats null and [] as the SAME live policy — both mean "no mechanical hide set"', () => {
    // They differ only on the RESTART path, where the body sees the value. For deciding whether to
    // send a message they must not: a toggle that flipped null→[] would otherwise re-post forever.
    expect(sameUiPolicy(ui(true, null), ui(true, []))).toBe(true);
    expect(sameUiPolicy(ui(false, []), ui(false, null))).toBe(true);
  });

  it('a re-ordered selection is NOT a change', () => {
    expect(sameUiPolicy(ui(true, ['.a', '.b']), ui(true, ['.b', '.a']))).toBe(true);
    expect(sameUiPolicy(ui(true, ['.a', '.a', '.b']), ui(true, ['.b', '.a']))).toBe(true);
  });

  it('a different membership IS a change, in either direction', () => {
    expect(sameUiPolicy(ui(true, ['.a']), ui(true, ['.a', '.b']))).toBe(false);
    expect(sameUiPolicy(ui(true, ['.a', '.b']), ui(true, ['.a']))).toBe(false);
    expect(sameUiPolicy(ui(true, ['.a']), ui(true, ['.b']))).toBe(false);
    expect(sameUiPolicy(ui(true, []), ui(true, ['.a']))).toBe(false);
    expect(sameUiPolicy(ui(true, null), ui(true, ['.a']))).toBe(false);
  });

  it('simpleUi alone distinguishes two otherwise identical policies', () => {
    // The headline toggle. If this returned true the Minimal-UI checkbox would do nothing at all.
    expect(sameUiPolicy(ui(true, ['.a']), ui(false, ['.a']))).toBe(false);
  });

  it('sameAutomationPolicy and sameSectionPolicy compose from the two halves', () => {
    expect(sameAutomationPolicy({ autoScript: true }, { autoScript: true })).toBe(true);
    expect(sameAutomationPolicy({ autoScript: true }, { autoScript: false })).toBe(false);
    expect(sameSectionPolicy(policy(), policy())).toBe(true);
    expect(sameSectionPolicy(policy(), policy({ autoScript: false }))).toBe(false);
    expect(sameSectionPolicy(policy(), policy({ simpleUi: true }))).toBe(false);
    // …and the set rule survives composition, which is where a hand-rolled `===` would break.
    expect(sameSectionPolicy(policy({ hideSelectors: ['.a', '.b'] }), policy({ hideSelectors: ['.b', '.a'] })))
      .toBe(true);
  });
});

// ══ 3. READING AND APPLYING ══════════════════════════════════════════════════════════════════

describe('reading a policy out of a config, and writing one back', () => {
  it('uiPolicyOf / automationPolicyOf / sectionPolicyOf read exactly their own fields', () => {
    const c = base({ simpleUi: true, hideSelectors: ['.a'], autoScript: false, quality: 'low' });
    expect(uiPolicyOf(c)).toEqual({ simpleUi: true, hideSelectors: ['.a'] });
    expect(automationPolicyOf(c)).toEqual({ autoScript: false });
    expect(sectionPolicyOf(c)).toEqual({ simpleUi: true, hideSelectors: ['.a'], autoScript: false });
  });

  it('withSectionPolicy changes ONLY the policy fields — every structural field survives', () => {
    const prepared = base({
      quality: 'low', aspect: 'portrait', transparent: true, initialState: { t: 3 },
      simpleUi: false, hideSelectors: [], autoScript: true,
    });
    const next = withSectionPolicy(prepared, policy({ simpleUi: true, hideSelectors: ['.x'], autoScript: false }));
    expect(next.quality).toBe('low');
    expect(next.aspect).toBe('portrait');
    expect(next.transparent).toBe(true);
    expect(next.initialState).toEqual({ t: 3 });
    expect(next.simpleUi).toBe(true);
    expect(next.hideSelectors).toEqual(['.x']);
    expect(next.autoScript).toBe(false);
    expect(next, 'the prepared config must not be mutated in place').not.toBe(prepared);
    expect(prepared.simpleUi).toBe(false);
  });

  it('withUiPolicy lands `null` as [] — SimPresentationConfig has no null hide set', () => {
    // The narrowing is deliberate and it is where the null/[] distinction STOPS. Anything reading a
    // config (the hash, the mechanical style applier) sees one representation of "nothing hidden".
    const c = withUiPolicy(base({ hideSelectors: ['.a'] }), { simpleUi: true, hideSelectors: null });
    expect(c.hideSelectors).toEqual([]);
    expect(withAutomationPolicy(base(), { autoScript: false }).autoScript).toBe(false);
  });

  it('effectiveConfig overlays the applied policy, and is the identity when none was applied', () => {
    const prepared = base({ simpleUi: false, hideSelectors: [], autoScript: true, quality: 'balanced' });
    expect(effectiveConfig(prepared, null)).toBe(prepared);   // no copy when nothing was applied

    const applied = policy({ simpleUi: true, hideSelectors: ['.controls'], autoScript: false });
    const live = effectiveConfig(prepared, applied);
    expect(live).toEqual({ ...prepared, simpleUi: true, hideSelectors: ['.controls'], autoScript: false });

    // The reason the function exists: the activation's own configHash still describes the PREPARE,
    // and anything visual must hash the effective config instead or it will re-use a poster taken
    // of a section that had its controls showing.
    expect(computeConfigHash(live)).not.toBe(computeConfigHash(prepared));
    expect(computeConfigHash(live)).toBe(computeConfigHash(
      base({ simpleUi: true, hideSelectors: ['.controls'], autoScript: false, quality: 'balanced' }),
    ));
  });
});

// ══ 4. mergePolicy — a PATCH, and the deliberate null ════════════════════════════════════════

describe('mergePolicy — an omitted field is untouched, an explicit null is a value', () => {
  const live = policy({ simpleUi: true, hideSelectors: ['.a', '.b'], autoScript: false });

  it('an empty patch is the identity', () => {
    expect(mergePolicy(live, {})).toEqual(live);
  });

  it('an omitted hideSelectors keeps the live selection — a toggle must not clear the picker', () => {
    expect(mergePolicy(live, { simpleUi: false }).hideSelectors).toEqual(['.a', '.b']);
  });

  it('REGRESSION: an EXPLICIT null replaces the live selection and is never swallowed', () => {
    // The `'hideSelectors' in patch` branch. Written as `patch.hideSelectors ?? base.hideSelectors`
    // — the obvious form — a deliberate `null` reads as "absent" and the previous selection
    // survives. The section editor's toggle path sends exactly this null, so the bug would be:
    // clear every hide, watch the old hides stay on screen, and get no error anywhere.
    const merged = mergePolicy(live, { hideSelectors: null });
    expect(merged.hideSelectors, 'a deliberate null was swallowed by a ?? default').toBeNull();
    expect(merged.simpleUi, 'the untouched fields must still come from the base').toBe(true);
    expect(merged.autoScript).toBe(false);
  });

  it('an explicit [] is also carried, and is NOT the same patch as null', () => {
    // `[]` is the picker's "the user re-checked everything" instruction; `null` is the toggle's
    // "there is no mechanical set". They agree on screen and disagree on the restart path.
    expect(mergePolicy(live, { hideSelectors: [] }).hideSelectors).toEqual([]);
    expect(mergePolicy(live, { hideSelectors: [] }).hideSelectors).not.toBeNull();
  });

  it('false is carried for the two booleans — `??` is correct there and `||` would not be', () => {
    expect(mergePolicy(policy({ simpleUi: true }), { simpleUi: false }).simpleUi).toBe(false);
    expect(mergePolicy(policy({ autoScript: true }), { autoScript: false }).autoScript).toBe(false);
  });

  it('an explicit `undefined` reads as ABSENT for every field, including hideSelectors', () => {
    // `{ hideSelectors: undefined }` is what a spread of an optional field produces. `in` is true
    // for it, so the null branch is taken and it lands as null — the same answer as an explicit
    // null, which is the honest reading: the caller named the field and supplied no set.
    expect(mergePolicy(live, { simpleUi: undefined }).simpleUi).toBe(true);
    expect(mergePolicy(live, { hideSelectors: undefined }).hideSelectors).toBeNull();
  });

  it('returns a fresh object — the live policy is never edited through its patch', () => {
    const merged = mergePolicy(live, { simpleUi: false });
    expect(merged).not.toBe(live);
    expect(live.simpleUi).toBe(true);
  });
});

// ══ 5. paramsForPolicy — what a RESTART must carry ═══════════════════════════════════════════

describe('paramsForPolicy — the fallback restart reproduces the policy exactly', () => {
  it('OMITS hideSelectors entirely when there is no mechanical set', () => {
    const params = paramsForPolicy(policy({ simpleUi: true, hideSelectors: null, autoScript: false }));
    // `hasOwnProperty`, not `toBeUndefined`: an own property set to undefined SURVIVES structured
    // clone as a present-and-empty key, which is the shape a body's `'hideSelectors' in params`
    // check would read as "the caller supplied a set". Absent has to be genuinely absent.
    expect(Object.prototype.hasOwnProperty.call(params, 'hideSelectors')).toBe(false);
    expect(params).toEqual({ simpleUi: true, autoScript: false });
  });

  it('SENDS an empty array when the set is empty — that is a different instruction', () => {
    // `[]` means "the user re-checked every control": the body's own generated hide logic must be
    // told to hide nothing, not left to decide for itself.
    const params = paramsForPolicy(policy({ simpleUi: true, hideSelectors: [] }));
    expect(Object.prototype.hasOwnProperty.call(params, 'hideSelectors')).toBe(true);
    expect(params.hideSelectors).toEqual([]);
  });

  it('carries the selection verbatim, and is total over the two booleans', () => {
    expect(paramsForPolicy(policy({ simpleUi: true, hideSelectors: ['.a', '.b'], autoScript: true })))
      .toEqual({ simpleUi: true, autoScript: true, hideSelectors: ['.a', '.b'] });
    expect(paramsForPolicy(policy({ simpleUi: false, autoScript: false })))
      .toEqual({ simpleUi: false, autoScript: false });
  });

  it('round-trips: a restart carrying these params reproduces the same UI policy', () => {
    for (const hideSelectors of [null, [], ['.a'], ['.b', '.a']]) {
      const p = policy({ simpleUi: true, hideSelectors, autoScript: false });
      const params = paramsForPolicy(p);
      const reconstructed: SimSectionPolicy = {
        simpleUi: params.simpleUi,
        hideSelectors: params.hideSelectors ?? null,
        autoScript: params.autoScript,
      };
      expect(sameSectionPolicy(reconstructed, p), `lost the policy for ${JSON.stringify(hideSelectors)}`).toBe(true);
    }
  });
});

// ══ 6. policyDelta — the whole decision, one call ════════════════════════════════════════════

describe('policyDelta — which of the three axes actually moved', () => {
  const from = base({ simpleUi: false, hideSelectors: [], autoScript: true, quality: 'high' });

  it('IDENTICAL configs move nothing — the caller sends no message at all', () => {
    expect(policyDelta(from, base({ ...from }))).toEqual({
      ui: false, automation: false, structural: false, structuralFields: [],
    });
  });

  it('UI-ONLY: simpleUi, or the hide set, and nothing else', () => {
    expect(policyDelta(from, base({ ...from, simpleUi: true }))).toEqual({
      ui: true, automation: false, structural: false, structuralFields: [],
    });
    expect(policyDelta(from, base({ ...from, hideSelectors: ['.controls'] }))).toEqual({
      ui: true, automation: false, structural: false, structuralFields: [],
    });
  });

  it('AUTOMATION-ONLY: the Auto Script toggle', () => {
    expect(policyDelta(from, base({ ...from, autoScript: false }))).toEqual({
      ui: false, automation: true, structural: false, structuralFields: [],
    });
  });

  it('STRUCTURAL-ONLY: each of the four, named individually', () => {
    // Named individually so a caller can REPORT why it had to re-activate. "Something structural
    // changed" is the report that sends an engineer to read a diff.
    const cases: [Partial<SimPresentationConfig>, string][] = [
      [{ quality: 'low' }, 'quality'],
      [{ aspect: 'portrait' }, 'aspect'],
      [{ initialState: { t: 1 } }, 'initialState'],
      [{ transparent: true }, 'transparent'],
    ];
    for (const [over, field] of cases) {
      const d = policyDelta(from, base({ ...from, ...over }));
      expect(d.structuralFields, `${field} was not reported`).toEqual([field]);
      expect(d.structural).toBe(true);
      expect(d.ui).toBe(false);
      expect(d.automation).toBe(false);
    }
  });

  it('MIXED: every axis at once, with all four structural fields listed', () => {
    const d = policyDelta(from, base({
      simpleUi: true, hideSelectors: ['.a'], autoScript: false,
      quality: 'low', aspect: 'native', initialState: { t: 1 }, transparent: true,
    }));
    expect(d.ui).toBe(true);
    expect(d.automation).toBe(true);
    expect(d.structural).toBe(true);
    expect([...d.structuralFields].sort()).toEqual(['aspect', 'initialState', 'quality', 'transparent']);
  });

  it('is SYMMETRIC — reversing the arguments reports the same movement', () => {
    const to = base({ ...from, simpleUi: true, quality: 'low' });
    expect(policyDelta(to, from)).toEqual(policyDelta(from, to));
  });

  it('a re-ordered hide set is NOT a change on any axis', () => {
    const a = base({ simpleUi: true, hideSelectors: ['.a', '.b'] });
    const b = base({ simpleUi: true, hideSelectors: ['.b', '.a', '.a'] });
    expect(policyDelta(a, b)).toEqual({ ui: false, automation: false, structural: false, structuralFields: [] });
  });

  it('the structural verdict AGREES with canonicalizeConfig — never a rebuild for a non-difference', () => {
    // THE PROPERTY THAT MAKES THE VERDICT MEAN ANYTHING. `structural: true` costs a full
    // re-activation: the body re-runs and the solver restarts from the pinned initial state. Paying
    // that for two configs the identity model already calls the same picture is the exact defect
    // P1.2 exists to remove, arriving through the code that was supposed to remove it.
    //
    // The pairs below are all hash-identical and were all reported structural by a JSON.stringify
    // comparison of the raw field values.
    const pairs: [SimPresentationConfig, SimPresentationConfig, string][] = [
      [base({ transparent: undefined }), base({ transparent: false }), 'undefined vs false transparent'],
      [base({ initialState: undefined }), base({ initialState: null }), 'undefined vs null initialState'],
      [base({ initialState: { a: 1, b: 2 } }), base({ initialState: { b: 2, a: 1 } }), 're-ordered initialState keys'],
    ];
    for (const [a, b, label] of pairs) {
      expect(computeConfigHash(a), `${label}: the premise is wrong, these hash differently`)
        .toBe(computeConfigHash(b));
      expect(policyDelta(a, b).structuralFields, `${label}: re-activated for a non-difference`).toEqual([]);
    }
  });

  it('…and still reports a REAL structural difference the canonical form does see', () => {
    // The guard above must not have been bought by making everything look equal.
    expect(policyDelta(base({ initialState: { a: 1 } }), base({ initialState: { a: 2 } })).structuralFields)
      .toEqual(['initialState']);
    expect(policyDelta(base({ transparent: true }), base({ transparent: false })).structuralFields)
      .toEqual(['transparent']);
  });

  it('`structural` is exactly "structuralFields is non-empty", never an independent flag', () => {
    const samples: Partial<SimPresentationConfig>[] = [
      {}, { simpleUi: true }, { quality: 'low' }, { aspect: 'native', autoScript: false },
      { initialState: { t: 1 }, transparent: true },
    ];
    for (const over of samples) {
      const d = policyDelta(from, base({ ...from, ...over }));
      expect(d.structural).toBe(d.structuralFields.length > 0);
    }
  });

  it('a delta with no structural movement is fully deliverable as policy messages', () => {
    // The closing of the loop: when `structural` is false, applying the two policy families to the
    // OLD config must reproduce the new one exactly — otherwise the live section would drift from
    // what the caller believes is on screen.
    const to = base({ ...from, simpleUi: true, hideSelectors: ['.a'], autoScript: false });
    const d = policyDelta(from, to);
    expect(d.structural).toBe(false);
    expect(withSectionPolicy(from, sectionPolicyOf(to))).toEqual(to);
  });
});
