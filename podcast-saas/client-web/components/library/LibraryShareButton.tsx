'use client';

import { useEffect, useState } from 'react';
import { Share2 } from 'lucide-react';
import { getLibraryShare, NOT_SHARED } from '@/lib/libraryShareClient';
import { LibraryShareDialog } from './LibraryShareDialog';
import type { LibraryShareState } from 'shared/src/types/library-view';

/**
 * The share control, sitting immediately to the LEFT of the editor's "Extended" button.
 *
 * ITS ACCESSIBLE NAME IS MANDATORY, NOT POLISH. Its entire visible content is an `aria-hidden`
 * icon, which is the exact failure `client-web/__tests__/a11yOperableControls.test.tsx` exists to
 * catch (ui-ux-003): such a button reaches the accessibility tree as an anonymous "button". The
 * `aria-label` is what makes it operable, and a test resolves this control by that name.
 *
 * It READS state on mount and never mutates on first click — pressing it opens the dialog, and
 * minting is a deliberate act inside it. Chrome matches Extended exactly (`h-8 rounded-lg border
 * border-border bg-card`) so the pair reads as one group; a live link tints it with the primary
 * token rather than a hardcoded colour.
 */
export function LibraryShareButton({ projectId, title }: { projectId: string; title: string | null }) {
  const [state, setState] = useState<LibraryShareState>(NOT_SHARED);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getLibraryShare(projectId).then((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; };
  }, [projectId]);

  const live = Boolean(state.url);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Share this library"
        title={live ? 'Shared — manage the library link' : 'Share this library'}
        className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[10px] font-semibold transition-colors focus-ring ${
          live
            ? 'border-primary/40 bg-primary/10 text-foreground hover:bg-primary/15'
            : 'border-border bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground'
        }`}
      >
        <Share2 size={12} strokeWidth={1.9} aria-hidden />
      </button>

      {open && (
        <LibraryShareDialog
          projectId={projectId}
          title={title}
          state={state}
          onState={setState}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
