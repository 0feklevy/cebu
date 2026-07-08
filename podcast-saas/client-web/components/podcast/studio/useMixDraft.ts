'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';
import { layoutMix, type MixTimeline } from 'shared';

type LaneOf = (turnId: string) => 'teacher' | 'learner';
type DurOf = (clipId: string) => number;

function normalizeTimeline(tl: MixTimeline, laneOf: LaneOf): MixTimeline {
  return {
    ...tl,
    layout: 'lanes',
    clips: tl.clips.map((clip) => ({
      ...clip,
      role: 'speech',
      lane: laneOf(clip.turnId),
      gapBeforeMs: Math.max(0, Math.round(clip.gapBeforeMs)),
      trimStartMs: Math.round(clip.trimStartMs),
      trimEndMs: Math.round(clip.trimEndMs),
    })),
  };
}

function migrateTimelineToLanes(tl: MixTimeline, laneOf: LaneOf, durOf: DurOf): MixTimeline {
  const clean = normalizeTimeline(tl, laneOf);
  if (tl.layout === 'lanes') return clean;

  const legacy = { ...clean, layout: undefined };
  const { placements } = layoutMix(legacy, durOf);
  const cursorByLane = new Map<string, number>();
  const clips = clean.clips.map((clip, index) => {
    const lane = laneOf(clip.turnId);
    const p = placements[index];
    const cursor = cursorByLane.get(lane) ?? 0;
    const gapBeforeMs = Math.max(0, Math.round((p?.startMs ?? cursor) - cursor));
    if (p) cursorByLane.set(lane, p.startMs + (p.outMs - p.inMs));
    return { ...clip, lane, gapBeforeMs };
  });
  return { ...clean, layout: 'lanes', clips };
}

/**
 * The editable mix draft: current timeline + optimistic `rev`, in-session undo/redo
 * (whole-timeline snapshots), and debounced autosave serialized through a write
 * chain (mirrors PodcastScriptEditor). A 409 means another tab moved the draft →
 * reload via onConflict.
 */
export function useMixDraft(opts: {
  showId: string;
  episodeId: string;
  initial: MixTimeline;
  initialRev: number;
  laneOf: LaneOf;
  durOf: DurOf;
  onError?: (msg: string) => void;
}) {
  const { showId, episodeId, initial, initialRev, laneOf, durOf, onError } = opts;
  const [timeline, setTimeline] = useState<MixTimeline>(() => migrateTimelineToLanes(initial, laneOf, durOf));
  const [history, setHistory] = useState<MixTimeline[]>([]);
  const [future, setFuture] = useState<MixTimeline[]>([]);
  const [saving, setSaving] = useState(false);

  const tlRef = useRef(timeline);
  const revRef = useRef(initialRev);
  const needsInitialSaveRef = useRef(JSON.stringify(initial) !== JSON.stringify(migrateTimelineToLanes(initial, laneOf, durOf)));
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { tlRef.current = timeline; }, [timeline]);

  // Re-seed when a fresh draft is loaded (generate/restore/version change).
  const reseed = useCallback((tl: MixTimeline, rev: number) => {
    const clean = migrateTimelineToLanes(tl, laneOf, durOf);
    setTimeline(clean); tlRef.current = clean; revRef.current = rev;
    setHistory([]); setFuture([]);
  }, [durOf, laneOf]);

  const flush = useCallback(async () => {
    const tl = normalizeTimeline(tlRef.current, laneOf);
    tlRef.current = tl;
    setTimeline(tl);
    try {
      setSaving(true);
      const { rev } = await api.savePodcastMixTimeline(showId, episodeId, tl, revRef.current);
      revRef.current = rev;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save the edit.';
      onError?.(msg);
    } finally {
      setSaving(false);
    }
  }, [showId, episodeId, laneOf, onError]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { writeChain.current = writeChain.current.then(flush); }, 800);
  }, [flush]);

  useEffect(() => {
    if (!needsInitialSaveRef.current) return;
    needsInitialSaveRef.current = false;
    scheduleSave();
  }, [scheduleSave]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  /** Apply a new timeline. `snapshot` (default true) pushes the current onto undo. */
  const apply = useCallback((next: MixTimeline, snapshot = true) => {
    const clean = normalizeTimeline(next, laneOf);
    if (snapshot) { setHistory((h) => [...h.slice(-49), tlRef.current]); setFuture([]); }
    setTimeline(clean);
    tlRef.current = clean;
    scheduleSave();
  }, [laneOf, scheduleSave]);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      setFuture((f) => [...f, tlRef.current]);
      const prev = normalizeTimeline(h[h.length - 1], laneOf);
      setTimeline(prev); tlRef.current = prev; scheduleSave();
      return h.slice(0, -1);
    });
  }, [laneOf, scheduleSave]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      setHistory((h) => [...h, tlRef.current]);
      const next = normalizeTimeline(f[f.length - 1], laneOf);
      setTimeline(next); tlRef.current = next; scheduleSave();
      return f.slice(0, -1);
    });
  }, [laneOf, scheduleSave]);

  return {
    timeline, apply, undo, redo, reseed, saving,
    canUndo: history.length > 0,
    canRedo: future.length > 0,
    getRev: () => revRef.current,
  };
}
