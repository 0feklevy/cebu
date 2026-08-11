'use client';

/**
 * The Duplicate-project flow, once, for both places that offer it (`HomeHero` tiles and the
 * `HomeSidebar` list).
 *
 * WHY A HOOK AND NOT TWO COPIES
 * The flow is not a single call: it is POST → poll → navigate, with three failure shapes (refused
 * up front, failed mid-copy, network). Both surfaces need all of it, and the two project lists in
 * this app are already independent React state that drift from each other on delete — adding a
 * second, hand-written copy of a polling state machine is how they would drift here too.
 *
 * The poll interval matches the b-roll panel's (3s). Nothing streams: the backend exposes a plain
 * status row, exactly like every other long-running job in this product.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { ProjectDuplicationStatus } from 'shared/src/generated/client-v1';

const POLL_MS = 3000;

/**
 * How many CONSECUTIVE failed status reads end the run.
 *
 * The old comment was right about the premise and wrong about the conclusion: a single failed poll
 * really is not a failed duplication — the copy runs server-side and the next tick picks it up — but
 * "only a terminal row ends the loop" turns any PERMANENT read failure into a loop that never ends.
 * Delete the source project while a copy runs and the GET is 404 for the rest of the session; let
 * the token expire and it is 401 for the rest of the session. Either way `state.status` stays
 * `copying`, `busy` stays true, and the tile reads "Copying…" behind a disabled button forever.
 *
 * Five is ~15 s of unbroken failure, which is far longer than any transient this poll actually sees
 * and short enough that the user is told while they are still looking at the tile. The counter is
 * reset by ANY successful read, so a flaky connection that answers one tick in three never trips it.
 *
 * WHAT IT DOES NOT CLAIM. Losing contact with the status row is not the same as the copy having
 * failed — the server may well finish it — so the message says exactly that, and the run is left in
 * `failed` (the state whose control is enabled again) rather than pretending to know the outcome.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/** Stated to the user when the poll gives up. Deliberately not "the duplication failed". */
export const POLL_LOST_CONTACT_MESSAGE =
  'Lost contact with the copy — it may still be running. Refresh to check.';

export interface DuplicationState {
  /** Null when nothing is in flight. */
  status: ProjectDuplicationStatus | null;
  /** 0–1, or null while the object count is still unknown. */
  progress: number | null;
  error: string | null;
  /** Set once the copy exists and is safe to open. */
  targetProjectId: string | null;
}

const IDLE: DuplicationState = { status: null, progress: null, error: null, targetProjectId: null };

export interface UseProjectDuplication extends DuplicationState {
  /** True from the click until the copy is ready or has failed. */
  busy: boolean;
  start: () => Promise<void>;
  /** Clear a finished or failed run so the control returns to its resting state. */
  reset: () => void;
}

export function useProjectDuplication(
  projectId: string,
  onReady?: (targetProjectId: string) => void,
): UseProjectDuplication {
  const [state, setState] = useState<DuplicationState>(IDLE);
  // STATE, not a ref: the polling effect has to start when the POST returns an id, and an effect
  // cannot depend on a ref. Keying it on `status` alone deadlocks — the server's first answer is
  // also `queued`, so the status never changes and the effect never re-runs to notice the id.
  const [duplicationId, setDuplicationId] = useState<string | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // Guards a setState after unmount when a poll resolves late.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const start = useCallback(async () => {
    if (duplicationId) return;
    setState({ status: 'queued', progress: null, error: null, targetProjectId: null });
    try {
      const started = await api.duplicateProject(projectId);
      if (!aliveRef.current) return;
      setDuplicationId(started.duplication_id);
      setState((s) => ({ ...s, status: started.status }));
    } catch (err) {
      if (!aliveRef.current) return;
      setDuplicationId(null);
      setState({
        status: 'failed',
        progress: null,
        // The API client throws the server's `message`, which for the two refusals a user can
        // actually act on (over the size limit, project gone) is written for them.
        error: err instanceof Error ? err.message : 'Could not start the duplication.',
        targetProjectId: null,
      });
    }
  }, [projectId, duplicationId]);

  useEffect(() => {
    if (!duplicationId) return;
    if (state.status !== 'queued' && state.status !== 'copying' && state.status !== 'committing') return;

    let cancelled = false;
    // Consecutive, not cumulative: a run that survives an hour of intermittent failures is healthy,
    // and a run that cannot read the row five times in a row is not going to.
    let consecutiveFailures = 0;
    const tick = async (): Promise<void> => {
      try {
        const row = await api.getProjectDuplication(projectId, duplicationId);
        if (cancelled || !aliveRef.current) return;
        consecutiveFailures = 0;
        const progress = row.objects_total > 0 ? row.objects_copied / row.objects_total : null;
        if (row.status === 'ready') {
          setDuplicationId(null);
          setState({ status: 'ready', progress: 1, error: null, targetProjectId: row.target_project_id });
          // A ready row with no target means the copy was made and has since been deleted (the
          // column is ON DELETE SET NULL). Terminal either way — the loop must not spin on it.
          if (row.target_project_id) onReadyRef.current?.(row.target_project_id);
          return;
        }
        if (row.status === 'failed') {
          setDuplicationId(null);
          setState({ status: 'failed', progress, error: row.error ?? 'Duplication failed.', targetProjectId: null });
          return;
        }
        setState((s) => ({ ...s, status: row.status, progress }));
      } catch {
        // A single failed poll is not a failed duplication — the copy runs server-side and the
        // next tick will pick it up. A RUN of them is a different statement: nothing this client
        // can do will learn the outcome, so the loop stops and says so rather than spinning with a
        // disabled control for the rest of the session.
        if (cancelled || !aliveRef.current) return;
        consecutiveFailures += 1;
        if (consecutiveFailures < MAX_CONSECUTIVE_POLL_FAILURES) return;
        // Clearing the id is what actually ends the loop: this effect is keyed on it, and its
        // cleanup clears the interval.
        setDuplicationId(null);
        setState((s) => ({ ...s, status: 'failed', error: POLL_LOST_CONTACT_MESSAGE }));
      }
    };
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    void tick();
    return () => { cancelled = true; clearInterval(timer); };
  }, [projectId, duplicationId, state.status]);

  const reset = useCallback(() => {
    setDuplicationId(null);
    setState(IDLE);
  }, []);

  return {
    ...state,
    busy: state.status === 'queued' || state.status === 'copying' || state.status === 'committing',
    start,
    reset,
  };
}

/** The label a Duplicate control shows for a given state. One wording, both surfaces. */
export function duplicationLabel(state: DuplicationState): string {
  switch (state.status) {
    case 'queued':     return 'Preparing…';
    case 'copying':    return state.progress !== null ? `Copying ${Math.round(state.progress * 100)}%` : 'Copying…';
    case 'committing': return 'Finishing…';
    case 'ready':      return 'Copy ready';
    case 'failed':     return 'Copy failed';
    default:           return 'Duplicate project';
  }
}
