/**
 * Loading a saved bridge onto a section: WHICH of the two paths does this load take?
 *
 * ── THE TWO PATHS, AND WHY THERE HAVE TO BE TWO ───────────────────────────────────────────────
 * A preset carries a RECIPE (prompt, toggles, minimal-UI selection — pure intent and data) and
 * usually an ARTIFACT (the generated script body — code that binds BY NAME to one simulation's
 * DOM ids, label texts and window.* API). The artifact pasted onto content it was not written
 * for finds nothing and no-ops SILENTLY: a dead section in production with no error anywhere,
 * which is the exact failure mode SimBridgeContract.ts was built to prevent for sim replacement.
 *
 * So the load is judged, not assumed:
 *
 *   ARTIFACT — every anchor the body binds to exists in the target's sources. Instant apply,
 *              zero LLM, zero seconds. The headline the feature was asked for.
 *   RECIPE   — anything less. The prompt + toggles + selection drive a fresh generation against
 *              the target's own manifest. Slower, costs one LLM call — and still skips ALL the
 *              authoring work, which is the actual value being saved.
 *
 * The judgement is pure so every branch is provable without storage, a database, or an LLM.
 *
 * ── WHY "SAME CONTENT" IS NOT SHORT-CIRCUITED TO ARTIFACT ─────────────────────────────────────
 * Matching source hashes make artifact-compatibility LIKELY, not proven — and the verification
 * against the target's actual sources costs a string scan. A shortcut that skips the scan buys
 * nothing measurable and creates the one hole through which a silently-dead section can ship.
 * Hash equality is therefore reported as context (`sameContent`), never used as the decision.
 */

import type { BridgeContract, ContractAnchor } from './SimBridgeContract.js';

export interface PresetForLoad {
  /** Null for a recipe-only preset — one saved from a section that never generated a script. */
  mainBody: string | null;
  /** Precomputed at save time. Null tolerated: an old row degrades to recipe, never crashes. */
  contract: BridgeContract | null;
  sourceBridgeHash: string | null;
  sourceHash: string | null;
}

export interface TargetForLoad {
  /**
   * The target simulation's bridge hash, when known. Used ONLY to choose between two cosmetic
   * sentences — never to decide the path, which is always the contract verification.
   */
  bridgeHash: string | null;
  /** Result of verifyContract(preset.contract, targetSources); null when it could not run. */
  verification: { missing: ContractAnchor[]; checked: number } | null;
}

export type LoadPath =
  | {
      path: 'artifact';
      /** True when hashes also match — pure context for the UI ("same simulation content"). */
      sameContent: boolean;
    }
  | {
      path: 'recipe';
      why: 'no-artifact' | 'no-contract' | 'verification-unavailable' | 'anchors-missing';
      /** The anchors that failed, so the UI can say WHAT the preset needed and did not find. */
      missing: ContractAnchor[];
    };

export function judgeBridgeLoad(preset: PresetForLoad, target: TargetForLoad): LoadPath {
  // A preset without a body has nothing to paste. Not a failure — minimal-UI-only setups never
  // had a script, and their whole value is the selection.
  if (!preset.mainBody) return { path: 'recipe', why: 'no-artifact', missing: [] };

  // A body with no contract cannot be judged, and an unjudged paste is exactly the silent no-op
  // this module exists to prevent. Regenerating is the conservative reading.
  if (!preset.contract) return { path: 'recipe', why: 'no-contract', missing: [] };

  // The verification could not run — the target's sources were unreadable, the active revision
  // missing, whatever. "Could not check" must never resolve to "assume it fits".
  if (!target.verification) return { path: 'recipe', why: 'verification-unavailable', missing: [] };

  if (target.verification.missing.length > 0) {
    return { path: 'recipe', why: 'anchors-missing', missing: target.verification.missing };
  }

  // Bridge hash only. A first draft also compared `preset.sourceHash === target.sourceHash` — and
  // that clause could never fire: there is no per-SIMULATION source hash anywhere. `sourceHash` is
  // computed from a package's files at generation time and stored on a SECTION's sim_meta, so the
  // target side is unobtainable here without re-reading and re-hashing every source file. Since
  // `sameContent` only chooses between two cosmetic sentences, that would be a lot of I/O to
  // change a word. The unreachable comparison is gone rather than left looking functional.
  const sameContent = preset.sourceBridgeHash != null && preset.sourceBridgeHash === target.bridgeHash;

  return { path: 'artifact', sameContent };
}

/**
 * The sentence shown beside the Load button — decided here so the wording and the decision cannot
 * drift apart, and so no raw selector ever needs to be composed ad hoc in the UI.
 */
export function describeLoadPath(v: LoadPath): string {
  if (v.path === 'artifact') {
    return v.sameContent
      ? 'This preset was saved from this exact simulation — it will apply instantly.'
      : 'Everything this preset needs exists here — it will apply instantly.';
  }
  switch (v.why) {
    case 'no-artifact':
      return 'This preset carries settings only; they will apply and the script will be generated fresh.';
    case 'no-contract':
    case 'verification-unavailable':
      return 'Compatibility could not be checked, so the script will be regenerated from the saved settings.';
    case 'anchors-missing': {
      const shown = v.missing.slice(0, 3).map((m) => m.token).join(', ');
      const more = v.missing.length > 3 ? ` and ${v.missing.length - 3} more` : '';
      return `This simulation does not have ${shown}${more} — the script will be regenerated from the saved settings.`;
    }
  }
}
