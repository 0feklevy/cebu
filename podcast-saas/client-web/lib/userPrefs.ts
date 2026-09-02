/**
 * The local (per-browser) preferences the settings dialog writes — read here by the things that
 * act on them. Until now `guidedTutorial` was written and read by nothing, so turning it off did
 * nothing (night run 2026-09-03 §5).
 */
export const LOCAL_PREFS_KEY = 'podcast-saas-user-preferences';

export interface LocalUserPrefs {
  /** Auto-run the editor walkthrough the first time this browser opens a project. */
  guidedTutorial: boolean;
}

const DEFAULTS: LocalUserPrefs = { guidedTutorial: true };

export function readLocalUserPrefs(): LocalUserPrefs {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<LocalUserPrefs>;
    return { ...DEFAULTS, guidedTutorial: parsed.guidedTutorial !== false };
  } catch {
    return DEFAULTS;
  }
}
