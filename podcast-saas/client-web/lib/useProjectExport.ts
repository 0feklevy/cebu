'use client';

/**
 * The linear-video-export flow: POST → poll → download, as one hook.
 *
 * This is `useProjectDuplication`'s discipline applied to the export job (read that file's header
 * for the full reasoning — every rule here is inherited from it deliberately):
 *
 * - 3 s poll against a plain status row; nothing streams.
 * - A bound on CONSECUTIVE failed reads, because a permanent read failure (project deleted, token
 *   expired) would otherwise leave "Rendering…" behind a disabled control forever.
 * - When the poll gives up it says it LOST CONTACT — it does not claim the export failed, because
 *   the server may well finish it.
 * - Terminal rows end the loop by clearing the export id, which is what the polling effect is
 *   keyed on.
 *
 * Contract points the duplication flow does not have:
 *
 * - DEGRADED-QUALITY CONSENT. The server may answer the POST with 409 `degraded_only`: it can
 *   complete the export, but only with substitutions (simulations as still images). That is a
 *   QUESTION, not a failure — the hook parks it in `degradedConsent` and does nothing until the
 *   user answers. `confirmDegraded()` re-POSTs with `allow_degraded: true`; `declineDegraded()`
 *   POSTs nothing. Consent is never assumed: this hook must not auto-retry with the flag.
 * - `cancel()` — an encode is worth interrupting. Cancel is a REQUEST: the runner honours it
 *   between phases, so the row stays in flight until the server confirms with the terminal
 *   `cancelled` status — which is neutral: not an error, not a success.
 * - `warnings` — the plan's honest record of what the export deliberately left out (poster
 *   stand-ins for simulations, omitted layers). They are part of the state because the user must
 *   see them, not a bare success.
 * - `qualityState` — a `ready` export that substituted content is `degraded`, and the UI must say
 *   so next to the download rather than presenting a plain success.
 * - Failures are the server's words, VERBATIM. The backend classifies every failure and writes a
 *   message for the user; whether retrying can help is part of that message ("you can try again"
 *   appears only when it is true). This client never appends retry advice of its own — decorating
 *   a branching-project refusal with "try again" would be telling the user to walk into the same
 *   wall twice.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isDegradedOnlyRefusal, startProjectExport } from './api';
import type { ProjectExport, ProjectExportStatus } from 'shared/src/generated/client-v1';

const POLL_MS = 3000;

/**
 * `[export]` debug logging — development only. `NODE_ENV` is statically replaced by the bundler, so
 * production builds compile these to no-ops and ship a clean console; local debugging keeps the
 * full POST/poll/outcome trail.
 */
const dbg = process.env.NODE_ENV !== 'production'
  ? { info: console.info.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) }
  : { info: (..._a: unknown[]) => {}, warn: (..._a: unknown[]) => {}, error: (..._a: unknown[]) => {} };

/**
 * How many CONSECUTIVE failed status reads end the run. Five is ~15 s of unbroken failure — longer
 * than any transient this poll actually sees, short enough that the user is told while they are
 * still looking at the panel. Any successful read resets the counter.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/** Stated when the poll gives up. Deliberately not "the export failed" — we do not know that. */
export const EXPORT_POLL_LOST_CONTACT_MESSAGE =
  'Lost contact with the export — it may still be running. Refresh to check.';

const IN_FLIGHT: ReadonlySet<ProjectExportStatus> =
  new Set(['queued', 'planning', 'capturing', 'assembling', 'uploading']);

export interface ProjectExportState {
  /** Null when nothing is in flight and nothing finished. */
  status: ProjectExportStatus | null;
  /** 0–100, or null while the plan has not sized the work (`objects_total` still 0). */
  progressPct: number | null;
  /** The plan's honest degradations, verbatim from the server. Never hidden behind a bare success. */
  warnings: string[];
  /** The server's classified message on failure (or a start/cancel refusal), verbatim. */
  error: string | null;
  /**
   * Presigned download URL, set only once the export is ready. Short-lived and minted per poll —
   * read from state and used, never persisted anywhere.
   */
  downloadUrl: string | null;
  /** On `ready`: whether the export substituted content. Null while not ready. */
  qualityState: 'full' | 'degraded' | null;
}

const IDLE: ProjectExportState = {
  status: null, progressPct: null, warnings: [], error: null, downloadUrl: null, qualityState: null,
};

export interface UseProjectExport extends ProjectExportState {
  /** True from start() until the export reaches a terminal state. */
  busy: boolean;
  /** True once cancel has been requested; the run is still in flight until the server confirms. */
  cancelRequested: boolean;
  /**
   * Set when the server refused the plain POST with 409 `degraded_only`. The flow is paused on a
   * question; nothing runs until `confirmDegraded()` or `declineDegraded()` answers it.
   */
  degradedConsent: { warnings: string[] } | null;
  start: () => Promise<void>;
  /** The explicit yes: re-POST with `allow_degraded: true`. Only valid while consent is pending. */
  confirmDegraded: () => Promise<void>;
  /** The explicit no: clears the question. POSTs nothing. */
  declineDegraded: () => void;
  cancel: () => Promise<void>;
  /** Clear a finished or failed run so the control returns to its resting state. */
  reset: () => void;
}

export function useProjectExport(projectId: string): UseProjectExport {
  const [state, setState] = useState<ProjectExportState>(IDLE);
  // STATE, not a ref: the polling effect must start when the POST returns an id, and keying on
  // `status` alone deadlocks — the server's first answer can be the same status we already hold.
  const [exportId, setExportId] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [degradedConsent, setDegradedConsent] = useState<{ warnings: string[] } | null>(null);
  // Guards a setState after unmount when a poll resolves late.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  /** The one POST path. `allowDegraded` is only ever true after the user's explicit yes. */
  const begin = useCallback(async (allowDegraded: boolean) => {
    setCancelRequested(false);
    setDegradedConsent(null);
    setState({ ...IDLE, status: 'queued' });
    dbg.info('[export] POST /export', { projectId, allowDegraded });
    try {
      const started = allowDegraded
        ? await startProjectExport(projectId, { allowDegraded: true })
        : await startProjectExport(projectId);
      if (!aliveRef.current) return;
      dbg.info('[export] started', started);
      // `already_running` joins are indistinguishable from a fresh start on purpose: either way
      // the id names the run to poll, and the next tick reports its real progress.
      setExportId(started.export_id);
      setState((s) => ({ ...s, status: started.status }));
    } catch (err) {
      if (!aliveRef.current) return;
      setExportId(null);
      // 409 degraded_only is a QUESTION, not an outcome. Park it and wait for the user; the
      // re-POST with `allow_degraded` happens only through confirmDegraded(). (When the refusal
      // arrives even WITH consent, fall through to failure — looping the dialog would spin.)
      if (!allowDegraded && isDegradedOnlyRefusal(err)) {
        dbg.info('[export] server asks degraded-quality consent', { warnings: err.warnings?.length ?? 0 });
        setState(IDLE);
        setDegradedConsent({ warnings: err.warnings ?? [] });
        return;
      }
      dbg.error('[export] start failed:', err);
      setState({
        ...IDLE,
        status: 'failed',
        // The API client throws the server's `message` — for the refusals a user can act on
        // (branching project, project gone) it is written for them. Shown verbatim.
        error: err instanceof Error ? err.message : 'Could not start the export.',
      });
    }
  }, [projectId]);

  const start = useCallback(async () => {
    if (exportId) return;
    await begin(false);
  }, [exportId, begin]);

  const confirmDegraded = useCallback(async () => {
    // No pending question means nothing was consented to — this must never turn into a plain
    // start with the flag set.
    if (!degradedConsent || exportId) return;
    await begin(true);
  }, [degradedConsent, exportId, begin]);

  const declineDegraded = useCallback(() => {
    setDegradedConsent(null);
  }, []);

  const cancel = useCallback(async () => {
    if (!exportId) return;
    setCancelRequested(true);
    dbg.info('[export] cancel requested', { exportId });
    try {
      await api.cancelProjectExport(projectId, exportId);
      // Nothing else: the runner honours the request between phases and the poll reports the
      // terminal row it produces.
    } catch (err) {
      if (!aliveRef.current) return;
      dbg.error('[export] cancel failed:', err);
      setCancelRequested(false);
      setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Could not cancel the export.',
      }));
    }
  }, [projectId, exportId]);

  useEffect(() => {
    if (!exportId) return;
    if (state.status === null || !IN_FLIGHT.has(state.status)) return;

    let cancelled = false;
    // Consecutive, not cumulative: a run that survives an hour of intermittent failures is healthy;
    // a run that cannot read the row five times in a row is not going to.
    let consecutiveFailures = 0;
    // Log poll results only when something changed — a 3 s heartbeat would drown the console.
    let lastLoggedSnapshot = '';
    const tick = async (): Promise<void> => {
      try {
        const row: ProjectExport = await api.getProjectExport(projectId, exportId);
        if (cancelled || !aliveRef.current) return;
        consecutiveFailures = 0;
        const snapshot = `${row.status} ${row.objects_done}/${row.objects_total}`;
        if (snapshot !== lastLoggedSnapshot) {
          lastLoggedSnapshot = snapshot;
          dbg.info('[export] poll:', snapshot, row.error ? `error: ${row.error}` : '');
        }
        const progressPct = row.objects_total > 0
          ? Math.round((row.objects_done / row.objects_total) * 100)
          : null;
        const warnings = row.warnings ?? [];
        // A join can attach to a run someone else already asked to stop; reflect that honestly.
        if (row.cancel_requested) setCancelRequested(true);
        if (row.status === 'ready') {
          dbg.info('[export] ready', {
            qualityState: row.quality_state, warnings: warnings.length, hasDownloadUrl: !!row.download_url,
          });
          setExportId(null);
          setState({
            status: 'ready', progressPct: 100, warnings,
            error: null, downloadUrl: row.download_url ?? null,
            qualityState: row.quality_state === 'degraded' ? 'degraded' : 'full',
          });
          return;
        }
        if (row.status === 'cancelled') {
          // Terminal and NEUTRAL: the user asked for this. Not an error, not a success.
          setExportId(null);
          setState({
            status: 'cancelled', progressPct, warnings,
            error: null, downloadUrl: null, qualityState: null,
          });
          return;
        }
        if (row.status === 'failed') {
          dbg.error('[export] failed:', row.error ?? 'no error message stored');
          setExportId(null);
          setState({
            status: 'failed', progressPct, warnings,
            // The backend stores a real classified reason. Verbatim — never rewritten, and never
            // decorated with retry advice the classification did not include.
            error: row.error ?? 'Export failed.',
            downloadUrl: null, qualityState: null,
          });
          return;
        }
        setState((s) => ({ ...s, status: row.status, progressPct, warnings }));
      } catch (err) {
        // A single failed poll is not a failed export — the job runs server-side and the next tick
        // picks it up. A RUN of them means this client will never learn the outcome, so the loop
        // stops and says so rather than spinning behind a disabled control forever.
        if (cancelled || !aliveRef.current) return;
        consecutiveFailures += 1;
        dbg.warn(
          `[export] poll failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}):`,
          err instanceof Error ? err.message : err,
        );
        if (consecutiveFailures < MAX_CONSECUTIVE_POLL_FAILURES) return;
        // Clearing the id is what actually ends the loop: this effect is keyed on it.
        dbg.error('[export] lost contact — giving up polling; the export may still be running server-side');
        setExportId(null);
        setState((s) => ({ ...s, status: 'failed', error: EXPORT_POLL_LOST_CONTACT_MESSAGE }));
      }
    };
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    void tick();
    return () => { cancelled = true; clearInterval(timer); };
  }, [projectId, exportId, state.status]);

  const reset = useCallback(() => {
    setExportId(null);
    setCancelRequested(false);
    setDegradedConsent(null);
    setState(IDLE);
  }, []);

  return {
    ...state,
    busy: state.status !== null && IN_FLIGHT.has(state.status),
    cancelRequested,
    degradedConsent,
    start,
    confirmDegraded,
    declineDegraded,
    cancel,
    reset,
  };
}

/** Human text for each phase. One wording, wherever the flow is surfaced. */
export function exportPhaseLabel(status: ProjectExportStatus | null): string {
  switch (status) {
    case 'queued':     return 'Starting…';
    case 'planning':   return 'Planning…';
    case 'capturing':  return 'Rendering sections…';
    case 'assembling': return 'Assembling video…';
    case 'uploading':  return 'Uploading…';
    case 'ready':      return 'Export ready';
    case 'cancelled':  return 'Export cancelled';
    case 'failed':     return 'Export failed';
    default:           return 'Export video';
  }
}
