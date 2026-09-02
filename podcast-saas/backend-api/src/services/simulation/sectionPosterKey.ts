/**
 * ONE place that says what a section's poster identity is (night run 2026-09-03 §6).
 *
 * The player looks a poster up by an identity built from the section row; the export plan builds
 * the same identity to capture under; and now the editor's browser-side capture stores under it.
 * Three callers, one function — a poster filed under any other key is a picture the player will
 * never ask for, and there is deliberately no cross-identity fallback (posterIdentity.ts).
 */
import {
  DEFAULT_PRESENTATION_CONFIG, computeConfigHash, variantKeyFor, type SimAspectProfile,
} from 'shared/sim/simIdentity';
import type { PosterKey } from 'shared/sim/posterIdentity';

/** The Minimal-UI hide list a section stores in `sim_meta.uiControls.hide`, cleaned, or undefined. */
export function uiHideFromMeta(simMeta: unknown): string[] | undefined {
  const hide = (simMeta as { uiControls?: { hide?: unknown } } | null | undefined)?.uiControls?.hide;
  if (!Array.isArray(hide)) return undefined;
  const clean = hide.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return clean.length > 0 ? clean : undefined;
}

export interface PosterSectionRow {
  id: string;
  simulation_url: string | null;
  sim_script?: string | null;
  simple_ui?: boolean | null;
  auto_script?: boolean | null;
  sim_meta?: unknown;
}

/** The aspect profile a project's posters are captured and looked up under. */
export function posterAspectFor(orientation: 'landscape' | 'portrait'): SimAspectProfile {
  return orientation === 'portrait' ? 'portrait' : 'wide';
}

/**
 * The identity for one section at one package revision. `quality` is 'high' — what the player
 * builds its own config from — and the aspect is the project's frame.
 */
export function posterKeyForSection(
  section: PosterSectionRow,
  packageRevision: string,
  aspect: SimAspectProfile,
): PosterKey {
  const configHash = computeConfigHash({
    ...DEFAULT_PRESENTATION_CONFIG,
    simpleUi:      section.simple_ui  ?? false,
    hideSelectors: uiHideFromMeta(section.sim_meta) ?? [],
    autoScript:    section.auto_script ?? true,
    // Quality and aspect are hashed here AND named as key axes below — the same configuration is
    // legitimately captured at several sizes and quality profiles (posterIdentity.ts).
    quality: 'high',
    aspect,
  });
  return {
    packageRevision,
    // The SECTION's dispatch key — the same value the runtime puts on the wire as `variantKey`.
    variantKey: variantKeyFor(section as Parameters<typeof variantKeyFor>[0]),
    configHash,
    aspectProfile: aspect,
    qualityProfile: 'high',
  };
}
