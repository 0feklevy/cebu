'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Link2, Loader2, Trash2, X } from 'lucide-react';
import { createLibraryShare, revokeLibraryShare, NOT_SHARED } from '@/lib/libraryShareClient';
import type { LibraryShareState } from 'shared/src/types/library-view';

/**
 * The owner's control panel for the library link. Modelled on `components/PermalinkEditor.tsx`,
 * which is the house pattern for exactly this UI.
 *
 * Two pieces of copy here are load-bearing rather than decorative, and both state a limit honestly
 * instead of implying a guarantee that does not exist:
 *
 *   1. "Anyone who already saved a file keeps it." Revocation stamps the row and purges the page
 *      within seconds, but it CANNOT recall the material URLs themselves: under the production
 *      storage adapter a public object URL is permanent and unauthenticated, and `/sim-public/*` is
 *      unauthenticated by design — the unguessable key IS the capability. That is a pre-existing
 *      platform property that every `/v/{token}` share already hands out, but this link publishes
 *      more keys at once, so the dialog says so.
 *   2. "The link keeps its current wording even if you rename the video." The slug is frozen at
 *      mint so links already sent keep working.
 *
 * Every outcome lands in an inline status strip. Never `alert()`. Revoke sits behind an inline
 * Yes/No confirm — the `ExtendedLibraryModal` delete pattern — because it is destructive and
 * irreversible for anyone holding the link.
 */

interface Props {
  projectId: string;
  title: string | null;
  state: LibraryShareState;
  onState: (next: LibraryShareState) => void;
  onClose: () => void;
}

type Status = { tone: 'ok' | 'error'; message: string } | null;

export function LibraryShareDialog({ projectId, title, state, onState, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shareUrl = state.cleanUrl ?? state.url;

  const mint = async () => {
    setBusy(true);
    setStatus(null);
    try {
      onState(await createLibraryShare(projectId));
      setStatus({ tone: 'ok', message: 'Link created.' });
    } catch (err) {
      setStatus({ tone: 'error', message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await revokeLibraryShare(projectId);
      onState(NOT_SHARED);
      setConfirmingRevoke(false);
      setStatus({ tone: 'ok', message: 'Link switched off. The page is no longer reachable.' });
    } catch (err) {
      setStatus({ tone: 'error', message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setStatus({ tone: 'error', message: 'Could not copy — select the link and copy it manually.' });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="library-share-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 text-card-foreground shadow-card">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="library-share-dialog-title" className="text-sm font-semibold text-foreground">
              Share this library
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              One link to every simulation, image, video and sound in{' '}
              {title ? <span className="font-medium text-foreground">{title}</span> : 'this project'}.
              It does not share the video itself.
            </p>
          </div>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            aria-label="Close share dialog"
            title="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-ring"
          >
            <X size={14} strokeWidth={1.9} aria-hidden />
          </button>
        </div>

        {shareUrl ? (
          <>
            <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-2.5 py-2 shadow-sm-soft">
              <Link2 size={13} strokeWidth={1.9} className="shrink-0 text-muted-foreground/70" aria-hidden />
              <input
                readOnly
                value={shareUrl}
                aria-label="Library link"
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none"
              />
              <button
                type="button"
                onClick={copy}
                aria-label="Copy library link"
                title="Copy"
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-border bg-card px-2 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-ring"
              >
                {copied
                  ? <Check size={12} strokeWidth={2.1} aria-hidden />
                  : <Copy size={12} strokeWidth={1.9} aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <ul className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <li>Anyone with this link can view the materials — no account needed.</li>
              <li>The link keeps its current wording even if you rename the video, so links you have already sent keep working.</li>
              <li>Switching it off stops the page within seconds, but anyone who already saved a file keeps it.</li>
            </ul>

            <div className="mt-4 flex items-center justify-end gap-2 border-t border-border/60 pt-3">
              {confirmingRevoke ? (
                <>
                  <span className="mr-auto text-[11px] font-medium text-foreground">Switch this link off?</span>
                  <button
                    type="button"
                    onClick={() => setConfirmingRevoke(false)}
                    className="inline-flex h-8 items-center rounded-lg border border-border bg-card px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-ring"
                  >
                    No
                  </button>
                  <button
                    type="button"
                    onClick={revoke}
                    disabled={busy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 text-[11px] font-semibold text-destructive transition-colors hover:bg-destructive/20 focus-ring disabled:opacity-60"
                  >
                    {busy && <Loader2 size={12} strokeWidth={2.1} className="animate-spin" aria-hidden />}
                    Yes, switch it off
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingRevoke(true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-ring"
                >
                  <Trash2 size={12} strokeWidth={1.9} aria-hidden />
                  Switch off
                </button>
              )}
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={mint}
            disabled={busy}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-ring disabled:opacity-60"
          >
            {busy && <Loader2 size={13} strokeWidth={2.1} className="animate-spin" aria-hidden />}
            Create the link
          </button>
        )}

        {status && (
          <p
            role="status"
            className={`mt-3 rounded-md px-2.5 py-1.5 text-[11px] font-medium ${
              status.tone === 'error' ? 'bg-destructive/15 text-destructive' : 'bg-primary/10 text-foreground'
            }`}
          >
            {status.message}
          </p>
        )}
      </div>
    </div>
  );
}
