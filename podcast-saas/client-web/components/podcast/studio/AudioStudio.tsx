'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, History, Loader2, Pause, Pin, Play, Redo2, Save, Scissors, Undo2 } from 'lucide-react';
import { layoutMix, type MixTimeline, type PodcastStudioResponse, type PodcastStudioClip } from 'shared';
import type { PodcastTurn } from 'shared/src/types/podcast';
import { api } from '../../../lib/api';
import { PodcastButton } from '../PodcastChrome';
import { TimelineSurface } from './TimelineSurface';
import { ClipPopover } from './ClipPopover';
import { ExportDialog } from './ExportDialog';
import { VersionsDrawer } from './VersionsDrawer';
import { useMixDraft } from './useMixDraft';
import { useClipBuffers } from './useClipBuffers';
import { useMixWaveform } from './useMixWaveform';
import { MixPlayer } from './mixEngine';
import { setClipField, splitBlock } from './interactions';
import { renderDownloadUrl } from './renderUrl';

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function AudioStudio({ showId, episodeId, initial, turns, onReloadScript }: {
  showId: string;
  episodeId: string;
  initial: PodcastStudioResponse;
  turns: PodcastTurn[];
  onReloadScript: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const shortcutsActiveRef = useRef(false);
  const [data, setData] = useState(initial);
  const [clips, setClips] = useState<PodcastStudioClip[]>(initial.clips);
  const [err, setErr] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [razor, setRazor] = useState(false);
  const [sticky, setSticky] = useState(false);
  const [pop, setPop] = useState<{ index: number } | null>(null);
  const [revoicing, setRevoicing] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [exportJob, setExportJob] = useState<{ renderId: string; format: 'mp4' | 'mp3' | 'wav'; status: 'rendering' | 'ready' | 'failed'; url: string | null; error: string | null } | null>(null);
  const [staleTurnIds, setStaleTurnIds] = useState<Set<string>>(new Set());
  const clipsById = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);
  const turnsById = useMemo(() => new Map(turns.map((t) => [t.id, t])), [turns]);
  const durMap = useMemo(() => new Map(clips.map((c) => [c.id, c.duration_ms])), [clips]);
  const laneOf = useCallback((turnId: string): 'teacher' | 'learner' => turnsById.get(turnId)?.speaker ?? 'learner', [turnsById]);
  const durOf = useCallback((clipId: string): number => durMap.get(clipId) ?? 0, [durMap]);

  const draft = useMixDraft({
    showId, episodeId,
    initial: (data.mix?.timeline as MixTimeline) ?? { version: 1, clips: [] },
    initialRev: data.mix?.rev ?? 0,
    laneOf,
    durOf,
    onError: setErr,
  });
  const timeline = draft.timeline;

  const { placements, totalMs } = useMemo(() => layoutMix(timeline, durOf, laneOf), [timeline, durOf, laneOf]);

  const { buffers, readyCount, total } = useClipBuffers(clips);
  const mixPeaks = useMixWaveform(timeline, buffers, totalMs, laneOf);

  // Compute per-turn staleness (current text vs the take's text_hash).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stale = new Set<string>();
      const latestClipByTurn = new Map<string, PodcastStudioClip>();
      for (const c of clips) if (!latestClipByTurn.has(c.turn_id)) latestClipByTurn.set(c.turn_id, c);
      for (const t of turns) {
        const usedClipId = timeline.clips.find((mc) => mc.turnId === t.id)?.clipId;
        const clip = clips.find((c) => c.id === usedClipId);
        if (!clip) continue;
        const h = await sha256(`${t.speaker}|${t.text}`);
        if (h !== clip.text_hash) stale.add(t.id);
      }
      if (!cancelled) setStaleTurnIds(stale);
    })();
    return () => { cancelled = true; };
  }, [clips, turns, timeline]);

  // ── Player ──────────────────────────────────────────────────────────────────
  const timelineRef = useRef(timeline);
  const buffersRef = useRef(buffers);
  const durMapRef = useRef(durMap);
  const laneOfRef = useRef(laneOf);
  useEffect(() => { timelineRef.current = timeline; }, [timeline]);
  useEffect(() => { buffersRef.current = buffers; }, [buffers]);
  useEffect(() => { durMapRef.current = durMap; }, [durMap]);
  useEffect(() => { laneOfRef.current = laneOf; }, [laneOf]);
  const playerRef = useRef<MixPlayer | null>(null);
  useEffect(() => {
    playerRef.current = new MixPlayer(
      () => timelineRef.current,
      (id) => durMapRef.current.get(id) ?? 0,
      (turnId) => laneOfRef.current(turnId),
      (id) => buffersRef.current.get(id)?.buffer,
      (pos, isPlaying) => { setPlayhead(pos); setPlaying(isPlaying); },
    );
    return () => { playerRef.current?.dispose(); playerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.playing) p.pause();
    else void p.play(playhead >= totalMs - 5 ? 0 : playhead);
  }, [playhead, totalMs]);

  // ── Generation polling ──────────────────────────────────────────────────────
  const generating = data.mix?.status === 'generating';
  useEffect(() => {
    if (!generating) return;
    const iv = setInterval(async () => {
      try {
        const fresh = await api.getPodcastStudio(showId, episodeId);
        setData(fresh);
        setClips(fresh.clips);
        if (fresh.mix?.status === 'ready' && fresh.mix.timeline) draft.reseed(fresh.mix.timeline as MixTimeline, fresh.mix.rev);
      } catch { /* keep polling */ }
    }, 2500);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generating, showId, episodeId]);

  const scriptChanged = data.latest_script_hash != null && data.mix?.script_hash != null && data.latest_script_hash !== data.mix.script_hash;

  const rebuild = useCallback(async () => {
    try {
      await api.generatePodcastStudio(showId, episodeId);
      const fresh = await api.getPodcastStudio(showId, episodeId);
      setData(fresh); setClips(fresh.clips);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not rebuild the audio.'); }
  }, [showId, episodeId]);

  // ── Block mutations ───────────────────────────────────────────────────────────
  const apply = draft.apply;
  const setField = useCallback((index: number, patch: Parameters<typeof setClipField>[2]) => apply(setClipField(timeline, index, patch)), [apply, timeline]);

  const revoice = useCallback(async (index: number, text: string) => {
    const mc = timeline.clips[index];
    setRevoicing(true);
    try {
      if (text.trim() !== turnsById.get(mc.turnId)?.text.trim()) {
        // Persist the text change to the script first (forks if approved).
        const v = data.latest_script_version;
        if (v != null) await api.updatePodcastTurn(showId, episodeId, v, mc.turnId, { text: text.trim() });
        onReloadScript();
      }
      const { clip } = await api.revoicePodcastTurnClip(showId, episodeId, mc.turnId);
      setClips((prev) => [clip, ...prev.filter((c) => c.id !== clip.id)]);
      // Swap every part of this turn onto the new take; collapse to one part, reset trims.
      const first = timeline.clips.find((c) => c.turnId === mc.turnId);
      const next: MixTimeline = {
        ...timeline,
        clips: timeline.clips
          .filter((c) => !(c.turnId === mc.turnId && c.partIndex > 0))
          .map((c) => c.turnId === mc.turnId ? { ...c, clipId: clip.id, partIndex: 0, trimStartMs: 0, trimEndMs: 0, gapBeforeMs: first?.gapBeforeMs ?? c.gapBeforeMs } : c),
      };
      apply(next);
      setPop(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not re-voice this line.');
    } finally { setRevoicing(false); }
  }, [timeline, turnsById, data.latest_script_version, showId, episodeId, apply, onReloadScript]);

  const doExport = useCallback(async (fmt: 'mp4' | 'mp3' | 'wav') => {
    const { render_id } = await api.exportPodcastMix(showId, episodeId, fmt);
    setExportJob({ renderId: render_id, format: fmt, status: 'rendering', url: null, error: null });
    setShowExport(false);
  }, [showId, episodeId]);

  // ── Export polling ────────────────────────────────────────────────────────────
  // A mix export is an async ffmpeg/ElevenLabs job. Poll the render-status endpoint
  // until it's ready/failed, then surface a real download link (and refresh the
  // Versions drawer so its export row gets a working download too). Stops on unmount.
  useEffect(() => {
    if (!exportJob || exportJob.status !== 'rendering') return;
    let cancelled = false;
    const { renderId } = exportJob;
    const iv = setInterval(async () => {
      try {
        const render = await api.getPodcastRender(showId, episodeId, renderId);
        if (cancelled) return;
        if (render.status === 'ready') {
          const url = renderDownloadUrl(render);
          setExportJob((j) => (j && j.renderId === renderId ? { ...j, status: 'ready', url } : j));
          try {
            const fresh = await api.getPodcastStudio(showId, episodeId);
            if (!cancelled) setData((d) => ({ ...d, snapshots: fresh.snapshots }));
          } catch { /* the download link above is enough on its own */ }
        } else if (render.status === 'failed') {
          setExportJob((j) => (j && j.renderId === renderId ? { ...j, status: 'failed', error: render.error ?? 'The export failed. Try again.' } : j));
        }
      } catch { /* keep polling */ }
    }, 2500);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportJob?.renderId, exportJob?.status, showId, episodeId]);

  const saveVersion = useCallback(async () => {
    const name = window.prompt('Name this version', `Edit · ${new Date().toLocaleString()}`);
    if (!name) return;
    try {
      const { snapshot } = await api.createPodcastMixSnapshot(showId, episodeId, name);
      setData((d) => ({ ...d, snapshots: [snapshot, ...d.snapshots] }));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save the version.'); }
  }, [showId, episodeId]);

  const restore = useCallback(async (id: string) => {
    try {
      const { rev, timeline: tl } = await api.restorePodcastMixSnapshot(showId, episodeId, id);
      draft.reseed(tl as MixTimeline, rev);
      setShowVersions(false);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not restore that version.'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showId, episodeId]);

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root || !root.contains(e.target as Node)) shortcutsActiveRef.current = false;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (!shortcutsActiveRef.current || isEditableTarget(el)) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? draft.redo() : draft.undo(); }
      else if (e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey) setRazor((r) => !r);
      else if (e.key.toLowerCase() === 'm' && selected != null) setField(selected, { muted: !timeline.clips[selected].muted });
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selected != null) setField(selected, { muted: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, draft, selected, timeline, setField]);

  // ── Render ───────────────────────────────────────────────────────────────────
  if (generating) {
    const prog = data.mix?.progress as { done?: number; total?: number } | null;
    return (
      <div className="rounded-xl border border-border py-14 text-center">
        <Loader2 size={26} className="mx-auto mb-3 animate-spin text-primary" aria-hidden />
        <p className="mb-1 text-sm font-semibold text-foreground">Building the studio audio…</p>
        <p className="text-sm text-muted-foreground">{prog?.total ? `${prog.done ?? 0} / ${prog.total} clips` : 'Synthesizing every line into its own editable block.'}</p>
      </div>
    );
  }

  if (!data.mix || data.mix.status !== 'ready' || timeline.clips.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-primary/30 py-14 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Scissors size={22} strokeWidth={1.9} aria-hidden /></div>
        <p className="mb-1 text-sm font-semibold text-foreground">{data.mix?.status === 'failed' ? 'Build failed' : 'Open the editor'}</p>
        <p className="mb-5 text-sm text-muted-foreground">Generate one editable block per line, then arrange, trim, and re-voice on a Premiere-style timeline.</p>
        <PodcastButton onClick={rebuild}><Scissors size={15} strokeWidth={2} aria-hidden /> {data.mix?.status === 'failed' ? 'Try again' : 'Build studio audio'}</PodcastButton>
      </div>
    );
  }

  const activeIndex = pop?.index ?? selected;
  const activeClip = activeIndex != null ? timeline.clips[activeIndex] : undefined;
  const popTurn = activeClip ? turnsById.get(activeClip.turnId) : undefined;

  return (
    <div
      ref={rootRef}
      className="space-y-4"
      onPointerDownCapture={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-podcast-shortcuts-ignore]')) {
          shortcutsActiveRef.current = false;
          return;
        }
        shortcutsActiveRef.current = Boolean(target.closest('[data-podcast-timeline-shortcuts]'));
      }}
    >
      {err && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="flex-1">{err}</span>
          <button onClick={() => setErr(null)} className="text-xs font-medium underline">dismiss</button>
        </div>
      )}
      {scriptChanged && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle size={16} strokeWidth={2} aria-hidden />
          <span className="flex-1">The script changed. Re-voice the flagged lines, or rebuild the audio to match.</span>
          <button onClick={rebuild} className="rounded-md border border-amber-500/40 px-2 py-1 text-xs font-semibold">Rebuild</button>
        </div>
      )}
      {exportJob && exportJob.status === 'rendering' && (
        <div className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2.5 text-sm text-primary">
          <Loader2 size={16} className="animate-spin" aria-hidden />
          <span className="flex-1">Exporting {exportJob.format.toUpperCase()}… this can take a minute. You can keep editing.</span>
        </div>
      )}
      {exportJob && exportJob.status === 'ready' && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
          <Download size={16} strokeWidth={2} aria-hidden />
          <span className="flex-1">Your {exportJob.format.toUpperCase()} export is ready.</span>
          {exportJob.url && (
            <a href={exportJob.url} download className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs font-semibold hover:bg-emerald-500/10 focus-ring">Download</a>
          )}
          <button onClick={() => setExportJob(null)} className="text-xs font-medium underline">dismiss</button>
        </div>
      )}
      {exportJob && exportJob.status === 'failed' && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <AlertTriangle size={16} strokeWidth={2} aria-hidden />
          <span className="flex-1">{exportJob.error ?? 'The export failed.'}</span>
          <button onClick={() => { setExportJob(null); setShowExport(true); }} className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-semibold">Try again</button>
          <button onClick={() => setExportJob(null)} className="text-xs font-medium underline">dismiss</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div data-podcast-timeline-shortcuts className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-3">
          <button onClick={togglePlay} className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-all hover:brightness-110 focus-ring" title="Play / pause (Space)">
            {playing ? <Pause size={17} aria-hidden /> : <Play size={17} aria-hidden />}
          </button>
          <div className="mr-1">
            <div className="w-28 tabular-nums text-sm font-semibold text-foreground">{fmtMs(playhead)} / {fmtMs(totalMs)}</div>
            <div className="text-[11px] text-muted-foreground">{readyCount < total ? `Decoding ${readyCount}/${total}` : `${timeline.clips.length} audio blocks`}</div>
          </div>
          <span className="mx-1 hidden h-6 w-px bg-border sm:block" />
          <IconBtn title="Undo (⌘Z)" onClick={draft.undo} disabled={!draft.canUndo}><Undo2 size={15} aria-hidden /></IconBtn>
          <IconBtn title="Redo (⇧⌘Z)" onClick={draft.redo} disabled={!draft.canRedo}><Redo2 size={15} aria-hidden /></IconBtn>
          <button onClick={() => setRazor((r) => !r)} title="Cut tool (C)" className="flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors focus-ring" style={razor ? { borderColor: 'hsl(var(--primary))', color: 'hsl(var(--primary))', background: 'hsl(var(--primary)/0.1)' } : { borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
            <Scissors size={14} aria-hidden /> Split
          </button>
          <button onClick={() => setSticky((s) => !s)} title="Sticky ripple edit" className="flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors focus-ring" style={sticky ? { borderColor: 'hsl(var(--primary))', color: 'hsl(var(--primary))', background: 'hsl(var(--primary)/0.1)' } : { borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}>
            <Pin size={14} aria-hidden /> Sticky
          </button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {draft.saving && <span className="px-1 text-[11px] text-muted-foreground">saving…</span>}
            <IconBtn title="Versions" onClick={() => setShowVersions(true)}><History size={15} aria-hidden /></IconBtn>
            <button onClick={saveVersion} className="flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted focus-ring"><Save size={14} aria-hidden /> Save version</button>
            <PodcastButton onClick={() => setShowExport(true)} disabled={exportJob?.status === 'rendering'}>
              {exportJob?.status === 'rendering'
                ? <><Loader2 size={15} className="animate-spin" aria-hidden /> Exporting…</>
                : <><Download size={15} strokeWidth={2} aria-hidden /> Export</>}
            </PodcastButton>
          </div>
        </div>

        <div className="space-y-3 p-3">
          {activeIndex != null && popTurn && (
            <ClipPopover
              turn={popTurn}
              gainDb={timeline.clips[activeIndex]?.gainDb ?? 0}
              muted={timeline.clips[activeIndex]?.muted ?? false}
              revoicing={revoicing}
              onClose={() => { setPop(null); setSelected(null); }}
              onRevoice={(text) => revoice(activeIndex, text)}
              onGain={(db) => setField(activeIndex, { gainDb: db })}
              onToggleMute={() => setField(activeIndex, { muted: !timeline.clips[activeIndex].muted })}
            />
          )}

          <div data-podcast-timeline-shortcuts>
            <TimelineSurface
              timeline={timeline}
              placements={placements}
              totalMs={totalMs}
              clipsById={clipsById}
              turnsById={turnsById}
              staleTurnIds={staleTurnIds}
              mixPeaks={mixPeaks}
              durMap={durMap}
              playheadMs={playhead}
              playing={playing}
              selectedIndex={selected}
              razor={razor}
              sticky={sticky}
              laneOf={laneOf}
              onSelect={(index) => { setSelected(index); if (index != null) setPop({ index }); }}
              onSeek={(ms) => playerRef.current?.seek(ms)}
              onApply={apply}
              onSplitAt={(index, srcMs) => { apply(splitBlock(timeline, index, srcMs, durMap)); setRazor(false); setPop({ index }); }}
              onOpenPopover={(index) => setPop({ index })}
            />
          </div>
        </div>
      </div>

      <p className="px-1 text-[11px] text-muted-foreground">Sticky off keeps later blocks fixed · Sticky on moves everything after the edited block · <kbd>C</kbd> then hover and click to cut · <kbd>Space</kbd> play/pause · <kbd>⌘Z</kbd> undo · <kbd>⇧⌘Z</kbd> redo</p>

      {showExport && <ExportDialog onClose={() => setShowExport(false)} onExport={doExport} />}
      {showVersions && <VersionsDrawer showId={showId} episodeId={episodeId} snapshots={data.snapshots} onClose={() => setShowVersions(false)} onRestore={restore} />}
    </div>
  );
}

function IconBtn({ children, onClick, disabled, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title: string }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40 focus-ring">
      {children}
    </button>
  );
}

function isEditableTarget(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.closest('[data-podcast-shortcuts-ignore]')) return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"]'));
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
