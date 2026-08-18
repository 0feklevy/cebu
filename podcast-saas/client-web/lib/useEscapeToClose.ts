'use client';

import { useEffect } from 'react';

/**
 * Escape closes the overlay — the app's established dismissal idiom, in one place.
 *
 * Every Radix-backed dialog in client-web (CreateProjectDialog, UserSettingsDialog,
 * HowItWorksDialog, PlaylistEditorDialog) gets this for free, and the hand-rolled ones
 * (ConfirmDialog, ProjectSettingsPanel) each re-implement it. The podcast-studio overlays were
 * built as `createPortal` + backdrop pairs and simply never got it, so click-outside dismissed
 * them and Escape did nothing — an inconsistency a user only discovers by pressing Escape and
 * watching nothing happen.
 *
 * @param onClose  invoked on Escape.
 * @param enabled  pass `false` to suspend dismissal (e.g. while an export is running, matching
 *                 what the backdrop's own `!busy && onClose()` guard already does). Escape must
 *                 not become a second, unguarded way to abandon work in flight.
 */
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, enabled]);
}
