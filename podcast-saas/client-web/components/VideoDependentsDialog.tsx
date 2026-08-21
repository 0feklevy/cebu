'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { VideoDeleteBlocked, VideoDeleteChoice } from 'shared/src/generated/client-v1';

/**
 * "THIS VIDEO IS HOLDING UP OTHER CLIPS. WHAT SHOULD HAPPEN TO THEM?" (D-01b.)
 *
 * WHY THIS IS NOT A ConfirmDialog. That component asks a yes/no question, and this one is not
 * yes/no: an author deleting a video that other rows are placed against has TWO different things
 * they might mean, and the whole ruling is that the system must not pick for them. A two-button
 * dialog would force one of the answers to become the default, which is exactly the silent
 * behaviour being removed.
 *
 * AND THERE IS NO THIRD BUTTON. "Move them to the next clip" is a guess about intent that would be
 * indistinguishable, afterwards, from a placement the author made — so it is not offered here, and
 * the server would not accept it either.
 *
 * The list is the point of the dialog, not decoration. "2 sections depend on this" tells an author
 * nothing they can act on; each row names the clip, says which second it plays at, and says which
 * of the two things it loses — its POSITION (anchored here) or its MEDIA (this video IS the clip).
 * The second kind cannot be kept by any answer, and says so rather than being quietly dropped.
 *
 * Styling is token-only (`hsl(var(--…))`) — asserted by videoDeleteDependents.test.tsx — because a
 * dialog that is unreadable in dark mode is a dialog whose answer is a coin flip.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  /** The refusal, verbatim from the server. */
  blocked: VideoDeleteBlocked;
  /** The video's name, for the title — the server answers about ids, an author thinks in names. */
  filename?: string | null;
  onChoose: (choice: VideoDeleteChoice) => void;
  onCancel: () => void;
  busy?: boolean;
}

const secLabel = (sec: number): string => {
  const whole = Math.max(0, Math.floor(sec));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

export function VideoDependentsDialog({ blocked, filename, onChoose, onCancel, busy = false }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();

  // Focus containment, same contract as ConfirmDialog: `aria-modal` promises focus is inside, and
  // without this the promise is a lie at the moment an author is deciding about permanent deletion.
  useEffect(() => {
    if (!mounted) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    // Opens on Cancel — the answer that changes nothing.
    (cancelRef.current ?? dialogRef.current)?.focus();
    return () => { restoreTo?.focus?.(); };
  }, [mounted]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCancel(); return; }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) { e.preventDefault(); root.focus(); return; }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (!root.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); return; }
      if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  if (!mounted) return null;

  const removedRegardless = new Set(blocked.removed_regardless);
  const keepable = blocked.dependents.filter(
    (d) => d.kind === 'anchor' && !removedRegardless.has(d.sectionId),
  ).length;

  return createPortal(
    <>
      <div
        onClick={busy ? undefined : onCancel}
        style={{
          position: 'fixed', inset: 0, zIndex: 9000,
          backgroundColor: 'hsl(var(--foreground) / 0.45)',
          backdropFilter: 'blur(6px)',
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        style={{
          position: 'fixed', zIndex: 9001, top: '50%', left: '50%',
          transform: 'translate(-50%,-50%)',
          width: 'min(460px, calc(100vw - 32px))',
          maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
          backgroundColor: 'hsl(var(--card))',
          color: 'hsl(var(--card-foreground))',
          border: '1px solid hsl(var(--border))',
          borderRadius: 10,
          padding: '22px 22px 18px',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div>
          <p id={titleId} style={{ fontSize: 15, fontWeight: 700, margin: 0, marginBottom: 6, color: 'hsl(var(--foreground))' }}>
            {filename ? `“${filename}” is holding up other clips` : 'This video is holding up other clips'}
          </p>
          <p id={descId} style={{ fontSize: 13, margin: 0, lineHeight: 1.5, color: 'hsl(var(--muted-foreground))' }}>
            Deleting it changes where these sit, and that is your call — nothing will be moved for you.
          </p>
        </div>

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {blocked.dependents.map((d) => (
            <li
              key={`${d.sectionId ?? 'unknown'}-${d.kind}`}
              style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10,
                padding: '8px 10px', borderRadius: 8,
                backgroundColor: 'hsl(var(--muted))',
                fontSize: 12.5,
              }}
            >
              <span style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                {d.label ?? 'Untitled section'}
                <span style={{ fontWeight: 400, color: 'hsl(var(--muted-foreground))' }}>
                  {` · ${secLabel(d.absoluteSec)}`}
                </span>
              </span>
              <span style={{ color: 'hsl(var(--muted-foreground))', whiteSpace: 'nowrap' }}>
                {d.kind === 'anchor' ? 'loses its position' : 'is this video'}
              </span>
            </li>
          ))}
        </ul>

        {removedRegardless.size > 0 && (
          <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5, color: 'hsl(var(--muted-foreground))' }}>
            {removedRegardless.size === 1 ? 'One section is' : `${removedRegardless.size} sections are`}
            {' made of this video and will be removed whichever you choose.'}
          </p>
        )}

        {blocked.generations_in_flight > 0 && (
          <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5, color: 'hsl(var(--muted-foreground))' }}>
            {blocked.generations_in_flight === 1
              ? 'One b-roll generation is still rendering for this spot.'
              : `${blocked.generations_in_flight} b-roll generations are still rendering for this spot.`}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
          <button
            type="button"
            className="focus-ring"
            onClick={() => onChoose('detach')}
            disabled={busy}
            style={{
              height: 38, borderRadius: 9,
              border: '1.5px solid hsl(var(--border))',
              backgroundColor: 'hsl(var(--card))',
              color: 'hsl(var(--foreground))',
              fontSize: 13, fontWeight: 600,
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            {keepable === 1
              ? 'Keep 1 clip where it plays now'
              : `Keep ${keepable} clips where they play now`}
          </button>
          <button
            type="button"
            className="focus-ring"
            onClick={() => onChoose('delete')}
            disabled={busy}
            style={{
              height: 38, borderRadius: 9, border: 'none',
              backgroundColor: 'hsl(var(--destructive))',
              color: 'hsl(var(--destructive-foreground))',
              fontSize: 13, fontWeight: 600,
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1,
            }}
          >
            Delete them with the video
          </button>
          <button
            ref={cancelRef}
            type="button"
            className="focus-ring"
            onClick={onCancel}
            disabled={busy}
            style={{
              height: 34, borderRadius: 9, border: 'none',
              backgroundColor: 'transparent',
              color: 'hsl(var(--muted-foreground))',
              fontSize: 13, fontWeight: 600,
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
        </div>

        <p style={{ fontSize: 11.5, margin: 0, lineHeight: 1.5, color: 'hsl(var(--muted-foreground))' }}>
          Kept clips stay at the second they play at today and are flagged for you to re-place —
          they are never moved onto another video for you.
        </p>
      </div>
    </>,
    document.body,
  );
}
