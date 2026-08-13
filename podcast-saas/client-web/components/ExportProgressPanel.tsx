'use client';

/**
 * The compact popover that reports one linear-video export, anchored under the header's
 * "Export video" button.
 *
 * The rules this surface exists to enforce:
 *
 * 1. DEGRADED QUALITY IS CONSENTED TO, NEVER ASSUMED. When the server answers 409 `degraded_only`,
 *    the panel asks — states plainly that simulations will appear as still images, lists the
 *    substitutions, and re-POSTs with `allow_degraded` only on an explicit "Export anyway".
 *    Declining sends nothing.
 * 2. WARNINGS ARE PART OF THE RESULT. The plan's warnings are honest degradations — a simulation
 *    rendered as its poster still, an omitted layer. They are listed verbatim whenever present,
 *    including on success; a bare "ready" would be a lie of omission.
 * 3. A DEGRADED SUCCESS IS NOT A PLAIN SUCCESS. A ready export with `quality_state: 'degraded'`
 *    carries a "Completed with substitutions" label beside its download.
 * 4. FAILURES ARE THE SERVER'S WORDS. The backend stores a classified reason; it is shown verbatim
 *    and never decorated. Whether retrying can help is part of that classification — "you can try
 *    again" appears in the message only when it is true — so this panel appends NO retry advice of
 *    its own. A branching-project refusal retried is the same refusal.
 * 5. CANCELLED IS NEUTRAL. The user asked for it: it is rendered as a plain statement, with no
 *    error styling and no advice.
 * 6. LOST CONTACT IS NOT FAILURE. The hook's give-up message says the export may still be running;
 *    this panel shows it as-is rather than dressing it up as an outcome it does not know.
 */

import { Download, Loader2, X } from 'lucide-react';
import { exportPhaseLabel, type UseProjectExport } from '../lib/useProjectExport';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The single source of truth — owned by the header so the run survives this panel closing. */
  flow: UseProjectExport;
}

export function ExportProgressPanel({ open, onClose, flow }: Props) {
  const {
    status, progressPct, warnings, error, downloadUrl, qualityState,
    busy, cancelRequested, degradedConsent,
  } = flow;

  if (!open || (status === null && !degradedConsent)) return null;

  return (
    <div
      role="dialog"
      aria-label="Export video progress"
      className="floating-panel absolute right-0 top-[calc(100%+8px)] z-[10000] w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-xl"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
        <p className="text-sm font-semibold text-foreground">Export video</p>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring"
          title="Close"
        >
          <span className="sr-only">Close export panel</span>
          <X size={15} strokeWidth={1.8} aria-hidden />
        </button>
      </div>

      {degradedConsent ? (
        /* The server can complete this export only with substitutions. Ask; do not assume. */
        <div className="space-y-3 px-4 py-4">
          <p className="text-xs font-medium leading-relaxed text-foreground">
            Simulations in this project will appear as still images in the exported video.
          </p>
          {degradedConsent.warnings.length > 0 && (
            <ul
              aria-label="Export warnings"
              className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2"
            >
              {degradedConsent.warnings.map((w, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                  {w}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => flow.declineDegraded()}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring"
            >
              Cancel
            </button>
            <button
              onClick={() => void flow.confirmDegraded()}
              className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-ring"
            >
              Export anyway
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 px-4 py-4">
          <div role="status" className="text-xs text-foreground">
            {status === 'failed' ? (
              <p className="whitespace-pre-wrap leading-relaxed text-red-500">{error}</p>
            ) : status === 'cancelled' ? (
              /* Neutral by design: the user asked for this. No error colour, no advice. */
              <p className="font-medium">Export cancelled</p>
            ) : status === 'ready' ? (
              <p className="font-medium">Your video is ready.</p>
            ) : (
              <p className="flex items-center gap-1.5 font-medium">
                <Loader2 size={12} className="animate-spin" aria-hidden />
                {exportPhaseLabel(status)}
              </p>
            )}
          </div>

          {busy && (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPct ?? undefined}
              aria-label="Export progress"
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${progressPct ?? 4}%` }}
              />
            </div>
          )}

          {/* A cancel that could not even be requested — the run itself is still in flight. */}
          {error && status !== 'failed' && (
            <p className="text-[11px] leading-relaxed text-red-500">{error}</p>
          )}

          {warnings.length > 0 && (
            <ul
              aria-label="Export warnings"
              className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2"
            >
              {warnings.map((w, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                  {w}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {busy && (
              <button
                onClick={() => void flow.cancel()}
                disabled={cancelRequested}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50 focus-ring"
              >
                {cancelRequested ? 'Cancelling…' : 'Cancel export'}
              </button>
            )}

            {/* A degraded success is labelled AT the download, where the decision to use it is made. */}
            {status === 'ready' && qualityState === 'degraded' && (
              <span className="mr-auto inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                Completed with substitutions
              </span>
            )}
            {status === 'ready' && downloadUrl && (
              <a
                href={downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-ring"
              >
                <Download size={13} strokeWidth={1.9} aria-hidden />
                Download video
              </a>
            )}
            {status === 'ready' && (
              <button
                onClick={() => { flow.reset(); onClose(); }}
                className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring"
              >
                Done
              </button>
            )}

            {(status === 'failed' || status === 'cancelled') && (
              <button
                onClick={() => { flow.reset(); onClose(); }}
                className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
