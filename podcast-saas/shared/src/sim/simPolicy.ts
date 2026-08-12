/**
 * Section POLICY — the part of a presentation configuration that can change WITHOUT re-preparing
 * the section.
 *
 * WHY THIS MODULE EXISTS (audit P1.2)
 * `SimPresentationConfig` conflates two very different kinds of field:
 *
 *   • STRUCTURAL — quality, aspect, initialState, transparent. Changing one of these changes what
 *     the body must build, so it genuinely needs a new activation: the body re-runs, the solver
 *     restarts from the pinned initial state, and that is the correct behaviour.
 *   • POLICY — simpleUi, hideSelectors, autoScript. These change CHROME and AUTOMATION. Nothing
 *     about the simulation's scientific state depends on them, and yet, because `configHash` is
 *     computed over the whole config and `configHash` is one axis of activation identity, flipping
 *     "Minimal UI" was BY CONSTRUCTION a new activation — which released the scope, ran the body's
 *     cleanup and re-ran the body. Toggling a checkbox reset the physics.
 *
 * This module is the one place that says which fields are which, so the parent, the v3 child and
 * the v2 bridge cannot drift about it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not change `canonicalizeConfig` or `computeConfigHash`. Repartitioning the hash would
 * re-key every stored poster and every canary verdict, and the activation identity's `configHash`
 * has a defensible meaning as it stands: *the config this activation was PREPARED with*. What the
 * policy path adds is the honest statement that the live presentation may have drifted from it —
 * see `effectiveConfig` below, which is what anything visual (a poster key) must hash instead of
 * assuming the activation's own hash still describes the picture.
 *
 * `hideSelectors: null` IS NOT `hideSelectors: []`
 * Both mean "no mechanical hide set", and to the mechanical style applier they are identical. They
 * differ on the RESTART path, which is the only path where the section BODY sees the value:
 * omitting the key leaves the body's own generated hide logic to decide, while `[]` tells it the
 * caller has an empty selection. The section editor relies on exactly that difference (its picker
 * sends `[]` to mean "the user re-checked everything"; its toggle omits the key when no selection
 * exists), so the distinction is carried through here rather than normalised away.
 */

import { canonicalizeConfig, type SimPresentationConfig } from './simIdentity.js';

// ─── Kinds ────────────────────────────────────────────────────────────────────────────────────

/** The policy families a package can negotiate independently. */
export type SimPolicyKind = 'ui' | 'automation';

export const SIM_POLICY_KINDS: readonly SimPolicyKind[] = ['ui', 'automation'];

export function isSimPolicyKind(v: unknown): v is SimPolicyKind {
  return v === 'ui' || v === 'automation';
}

// ─── Shapes ───────────────────────────────────────────────────────────────────────────────────

export interface SimUiPolicy {
  simpleUi: boolean;
  /** The MECHANICAL hide set. `null` = none; see the header on why that is not `[]`. */
  hideSelectors: string[] | null;
}

export interface SimAutomationPolicy {
  autoScript: boolean;
}

export interface SimSectionPolicy extends SimUiPolicy, SimAutomationPolicy {}

/** The `params` object a v2 `startScript` carries. Structural, so `shared` needs no client import. */
export interface SimPolicyParams {
  simpleUi: boolean;
  autoScript: boolean;
  hideSelectors?: string[];
}

// ─── Field partition ──────────────────────────────────────────────────────────────────────────

/**
 * Kept as DATA, not as an `if` chain, so `policyDelta` and its tests read the same list. A field
 * added to `SimPresentationConfig` and forgotten here is caught by `STRUCTURAL_CONFIG_FIELDS`
 * below, which is a total map over the config type.
 */
export const POLICY_CONFIG_FIELDS = ['simpleUi', 'hideSelectors', 'autoScript'] as const;

/**
 * The complement, as a TOTAL record over `SimPresentationConfig` — adding a field to the config
 * without deciding which side of the line it falls on is a compile error here.
 */
export const CONFIG_FIELD_IS_POLICY = {
  simpleUi: true,
  hideSelectors: true,
  autoScript: true,
  quality: false,
  aspect: false,
  initialState: false,
  transparent: false,
} satisfies Record<keyof SimPresentationConfig, boolean>;

export const STRUCTURAL_CONFIG_FIELDS = (
  Object.keys(CONFIG_FIELD_IS_POLICY) as (keyof SimPresentationConfig)[]
).filter((k) => !CONFIG_FIELD_IS_POLICY[k]);

// ─── Reading a policy out of a config ─────────────────────────────────────────────────────────

export function uiPolicyOf(config: SimPresentationConfig): SimUiPolicy {
  return { simpleUi: config.simpleUi, hideSelectors: config.hideSelectors };
}

export function automationPolicyOf(config: SimPresentationConfig): SimAutomationPolicy {
  return { autoScript: config.autoScript };
}

export function sectionPolicyOf(config: SimPresentationConfig): SimSectionPolicy {
  return { simpleUi: config.simpleUi, hideSelectors: config.hideSelectors, autoScript: config.autoScript };
}

// ─── Comparison ───────────────────────────────────────────────────────────────────────────────

/**
 * `hideSelectors` is semantically a SET — the same reasoning `canonicalizeConfig` uses. Comparing
 * it as a sequence would make a re-ordered selection look like a change, and every "change"
 * re-posts a policy message the package then has to decide is a no-op.
 */
export function normalizeHideSelectors(selectors: string[] | null | undefined): string[] {
  if (!selectors) return [];
  return [...new Set(selectors)].sort();
}

export function sameUiPolicy(a: SimUiPolicy, b: SimUiPolicy): boolean {
  if (a.simpleUi !== b.simpleUi) return false;
  const x = normalizeHideSelectors(a.hideSelectors);
  const y = normalizeHideSelectors(b.hideSelectors);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

export function sameAutomationPolicy(a: SimAutomationPolicy, b: SimAutomationPolicy): boolean {
  return a.autoScript === b.autoScript;
}

export function sameSectionPolicy(a: SimSectionPolicy, b: SimSectionPolicy): boolean {
  return sameUiPolicy(a, b) && sameAutomationPolicy(a, b);
}

// ─── Applying a policy ────────────────────────────────────────────────────────────────────────

export function withUiPolicy(config: SimPresentationConfig, policy: SimUiPolicy): SimPresentationConfig {
  return { ...config, simpleUi: policy.simpleUi, hideSelectors: policy.hideSelectors ?? [] };
}

export function withAutomationPolicy(
  config: SimPresentationConfig,
  policy: SimAutomationPolicy,
): SimPresentationConfig {
  return { ...config, autoScript: policy.autoScript };
}

export function withSectionPolicy(
  config: SimPresentationConfig,
  policy: SimSectionPolicy,
): SimPresentationConfig {
  return withAutomationPolicy(withUiPolicy(config, policy), policy);
}

/**
 * The EFFECTIVE config of a live activation: what it was prepared with, overlaid with every policy
 * applied since. Anything that describes what is ON SCREEN (a poster key, a visual-equivalence
 * check) must hash THIS, not the activation's own `configHash`, which describes the prepare only.
 */
export function effectiveConfig(
  prepared: SimPresentationConfig,
  applied: SimSectionPolicy | null,
): SimPresentationConfig {
  return applied ? withSectionPolicy(prepared, applied) : prepared;
}

export function mergePolicy(base: SimSectionPolicy, patch: Partial<SimSectionPolicy>): SimSectionPolicy {
  return {
    simpleUi: patch.simpleUi ?? base.simpleUi,
    // `??` would swallow a deliberate `null`, which is a real value here ("no mechanical set"),
    // so presence is tested rather than truthiness.
    hideSelectors: 'hideSelectors' in patch ? (patch.hideSelectors ?? null) : base.hideSelectors,
    autoScript: patch.autoScript ?? base.autoScript,
  };
}

/** The `params` a restart must carry to reproduce this policy exactly. */
export function paramsForPolicy(policy: SimSectionPolicy): SimPolicyParams {
  return {
    simpleUi: policy.simpleUi,
    autoScript: policy.autoScript,
    // Omitted, never `[]`, when there is no mechanical set — see the header.
    ...(policy.hideSelectors ? { hideSelectors: policy.hideSelectors } : {}),
  };
}

// ─── Deciding whether a change needs a new activation ─────────────────────────────────────────

export interface SimPolicyDelta {
  /** The UI policy differs — deliverable as SET_UI_POLICY. */
  ui: boolean;
  /** The automation policy differs — deliverable as SET_AUTOMATION_POLICY. */
  automation: boolean;
  /**
   * A field OUTSIDE the policy partition differs. A new activation is the only correct answer:
   * the body must be re-run for it, and re-running the body is what a policy message exists to
   * avoid — so this flag is the honest boundary of what P1.2 can save.
   */
  structural: boolean;
  /** Which structural fields differ, so a caller can report WHY it had to re-activate. */
  structuralFields: (keyof SimPresentationConfig)[];
}

/**
 * Whether adopting `to`'s value for ONE structural field changes what `from` describes.
 *
 * Asked through `canonicalizeConfig` rather than by comparing the raw values, because the raw
 * values carry distinctions the identity model deliberately does not: `transparent: undefined` and
 * `transparent: false` are the same picture, and so is an `initialState` whose keys were written in
 * a different order. A comparison that saw those as differences would answer `structural: true` for
 * two configs with the SAME `configHash` — i.e. re-run the body, and reset the solver, for a change
 * the rest of the system says did not happen. That is the exact defect P1.2 removes, arriving
 * through the module that exists to remove it.
 *
 * (A config `canonicalizeConfig` refuses — a non-finite number in `initialState` — throws here as
 * it would anywhere else. Such a config has no `configHash`, so it can never be an activation.)
 */
function adoptingChangesConfig(
  from: SimPresentationConfig,
  to: SimPresentationConfig,
  field: keyof SimPresentationConfig,
): boolean {
  // The cast is the computed-key spread: TypeScript widens `{ ...from, [field]: to[field] }` to a
  // union of the field types. Every value comes from a real config, so the shape is exact.
  const swapped = { ...from, [field]: to[field] } as SimPresentationConfig;
  return canonicalizeConfig(swapped) !== canonicalizeConfig(from);
}

export function policyDelta(from: SimPresentationConfig, to: SimPresentationConfig): SimPolicyDelta {
  const structuralFields = STRUCTURAL_CONFIG_FIELDS.filter((k) => adoptingChangesConfig(from, to, k));
  return {
    ui: !sameUiPolicy(uiPolicyOf(from), uiPolicyOf(to)),
    automation: !sameAutomationPolicy(automationPolicyOf(from), automationPolicyOf(to)),
    structural: structuralFields.length > 0,
    structuralFields,
  };
}

// ─── Outcomes ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a policy request actually did. Deliberately NOT a boolean: "the toggle was applied" and
 * "the toggle was applied by restarting the section, which reset the solver" are the two outcomes
 * this whole finding is about telling apart, and a boolean cannot.
 */
export type SimPolicyOutcome =
  /** Nothing is running; there is no activation to police. */
  | 'no-activation'
  /** The live policy already matches — no message sent, nothing touched. */
  | 'unchanged'
  /** Delivered as policy message(s). The section kept running; no cleanup, no re-run. */
  | 'policy'
  /** The package could not take it as policy, so the section was re-activated. Reported, never silent. */
  | 'reactivated';

/**
 * Why a package refused a policy. Every one of these ends in a full re-activation, and every one
 * is reported — a fallback that cannot say why it happened is indistinguishable from a bug.
 */
export type SimPolicyRefusal =
  /** The package's bridge predates the policy protocol (old published package). */
  | 'unsupported'
  /** Automation is being turned ON for a body that was STARTED with it off — nothing to resume. */
  | 'never-started'
  /** Handles were registered but cannot be recreated, so resume would silently do nothing. */
  | 'unrestorable'
  /** The section changed underneath the request. */
  | 'stale-activation';
