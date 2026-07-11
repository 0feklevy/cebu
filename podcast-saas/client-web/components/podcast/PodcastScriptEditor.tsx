'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight, Check, ChevronDown, Eye, EyeOff, GripVertical, Loader2, Play, Plus, RefreshCw,
  Redo2, Sparkles, Trash2, Undo2, Wand2,
} from 'lucide-react';
import { api } from '../../lib/api';
import { ConfirmDialog } from '../ConfirmDialog';
import { PodcastButton } from './PodcastChrome';
import type {
  PodcastScript, PodcastScriptVersion, PodcastShow, PodcastEpisode,
} from 'shared/src/generated/client-v1';
import type { PodcastTurn } from 'shared/src/types/podcast';

const GENERATING = new Set(['drafting', 'reviewing', 'rewriting', 'compiling']);
// Two ends of the app's `gradient-action` (violet→indigo) so speaker coding reads as native.
const TEACHER = '#8b5cf6';
const LEARNER = '#6366f1';

/** Strip inline [tags] for the clean reading view. */
function stripTags(text: string): string {
  return text.replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

const STAGES: { key: string; label: string }[] = [
  { key: 'drafting', label: 'Writing' },
  { key: 'reviewing', label: 'Reviewing' },
  { key: 'rewriting', label: 'Polishing' },
  { key: 'compiling', label: 'Compiling' },
  { key: 'ready', label: 'Ready' },
];

function uid(): string {
  try { return crypto.randomUUID(); } catch { return `t${Date.now()}${Math.floor(Math.random() * 1e6)}`; }
}

export function PodcastScriptEditor({
  showId, episodeId, show, onEpisodeChange, onApproved,
}: {
  showId: string;
  episodeId: string;
  show: PodcastShow;
  onEpisodeChange?: (patch: Partial<PodcastEpisode>) => void;
  onApproved?: () => void;
}) {
  const [script, setScript] = useState<PodcastScript | null>(null);
  const [versions, setVersions] = useState<PodcastScriptVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [approving, setApproving] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [showDirections, setShowDirections] = useState(true);
  const [history, setHistory] = useState<PodcastTurn[][]>([]);
  const [future, setFuture] = useState<PodcastTurn[][]>([]);
  const editTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingPatches = useRef<Map<string, Partial<PodcastTurn>>>(new Map());
  const versionRef = useRef<number | undefined>(undefined);
  const turnsRef = useRef<PodcastTurn[]>([]);
  // Serialize all writes so a fork (approved→v+1) fully commits before the next write
  // reads the version — otherwise two in-flight edits double-fork and lose one another.
  const writeChain = useRef<Promise<void>>(Promise.resolve());

  const version = script?.version;
  const status = script?.status;
  const turns = script?.body_json?.turns ?? [];
  const isGenerating = status ? GENERATING.has(status) : false;

  const load = useCallback(async (v?: number) => {
    const res = await api.getPodcastScript(showId, episodeId, v);
    setScript(res.script);
    setVersions(res.versions);
    return res;
  }, [showId, episodeId]);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  // Keep the version fresh for the serialized write path (reads it at flush time, not
  // at the debounce-scheduling time — the fix for the stale-version double-fork).
  useEffect(() => { versionRef.current = version; }, [version]);
  const statusRef = useRef<string | undefined>(undefined);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { turnsRef.current = turns; });
  useEffect(() => () => { for (const t of editTimers.current.values()) clearTimeout(t); }, []);

  // ── Undo / redo (snapshots of the whole turns array) ───────────────────────
  const snapshot = useCallback(() => {
    setHistory((h) => [...h.slice(-49), turnsRef.current]);
    setFuture([]);
  }, []);

  // Poll while generating.
  useEffect(() => {
    if (!isGenerating) return;
    const iv = setInterval(() => { load(version).catch(() => {}); }, 2500);
    return () => clearInterval(iv);
  }, [isGenerating, version, load]);

  const generate = useCallback(async (withNotes?: string) => {
    setGenerating(true);
    try {
      const { version: v } = await api.generatePodcastScript(showId, episodeId, withNotes ? { notes: withNotes } : {});
      onEpisodeChange?.({ status: 'scripting' });
      await load(v);
      setShowNotes(false);
      setNotes('');
    } catch (err) {
      console.error('Generate failed', err);
      window.alert('Could not start generation — please try again.');
    } finally {
      setGenerating(false);
    }
  }, [showId, episodeId, load, onEpisodeChange]);

  // Replace local script from any edit response (may be a forked higher version).
  const applyScript = useCallback((s: PodcastScript) => {
    // Editing an approved script forks it server-side and moves the episode back to
    // 'script_ready' — mirror that on the page so the Audio tab stops being stale.
    if (statusRef.current === 'approved' && s.status !== 'approved') {
      onEpisodeChange?.({ status: 'script_ready' });
    }
    setScript(s);
    setVersions((prev) => (prev.some((x) => x.version === s.version) ? prev : [{ id: s.id, version: s.version, status: s.status, approved_at: s.approved_at, created_at: s.created_at }, ...prev]));
  }, [onEpisodeChange]);

  // Flush a turn's merged pending patch. Runs inside the serialized writeChain so the
  // version is read (versionRef) only after any prior fork has committed.
  const flushTurn = useCallback(async (turnId: string) => {
    const v = versionRef.current;
    const patch = pendingPatches.current.get(turnId);
    pendingPatches.current.delete(turnId);
    editTimers.current.delete(turnId);
    if (v == null || !patch) return;
    try {
      const { script: s } = await api.updatePodcastTurn(showId, episodeId, v, turnId, patch);
      applyScript(s);
      setEditError(null);
    } catch (err) {
      console.error('Turn save failed', err);
      setEditError('An edit didn’t save — reloading the latest version.');
      await load(versionRef.current).catch(() => {});
    }
  }, [showId, episodeId, applyScript, load]);

  const patchTurn = useCallback((turnId: string, patch: Partial<PodcastTurn>) => {
    // Snapshot for undo at the start of an edit burst for this turn (not per keystroke).
    if (!pendingPatches.current.has(turnId)) snapshot();
    // Optimistic local update.
    setScript((prev) => prev && prev.body_json ? { ...prev, body_json: { ...prev.body_json, turns: prev.body_json.turns.map((t) => t.id === turnId ? { ...t, ...patch } : t) } } : prev);
    if (versionRef.current == null) return;
    // Merge so a second field-change within the debounce window isn't dropped.
    pendingPatches.current.set(turnId, { ...(pendingPatches.current.get(turnId) ?? {}), ...patch });
    const existing = editTimers.current.get(turnId);
    if (existing) clearTimeout(existing);
    editTimers.current.set(turnId, setTimeout(() => {
      writeChain.current = writeChain.current.then(() => flushTurn(turnId));
    }, 600));
  }, [flushTurn, snapshot]);

  const replaceTurns = useCallback(async (next: PodcastTurn[]) => {
    setScript((prev) => prev && prev.body_json ? { ...prev, body_json: { ...prev.body_json, turns: next } } : prev);
    if (versionRef.current == null) return;
    const run = async () => {
      try {
        const { script: s } = await api.replacePodcastTurns(showId, episodeId, versionRef.current!, next);
        applyScript(s);
        setEditError(null);
      } catch (err) {
        console.error('Reorder/insert failed', err);
        setEditError('That change didn’t save — reloading the latest version.');
        await load(versionRef.current).catch(() => {});
      }
    };
    writeChain.current = writeChain.current.then(run);
    await writeChain.current;
  }, [showId, episodeId, applyScript, load]);

  // Reset undo history when the loaded version changes (undo shouldn't cross versions).
  useEffect(() => { setHistory([]); setFuture([]); }, [script?.id]);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      setFuture((f) => [...f, turnsRef.current]);
      void replaceTurns(h[h.length - 1]); // does not snapshot
      return h.slice(0, -1);
    });
  }, [replaceTurns]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      setHistory((h) => [...h, turnsRef.current]);
      void replaceTurns(f[f.length - 1]);
      return f.slice(0, -1);
    });
  }, [replaceTurns]);

  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Stop any preview playback when the editor unmounts (e.g. switching tabs).
  useEffect(() => () => { audioRef.current?.pause(); }, []);
  const preview = useCallback(async (turnId: string) => {
    const v = versionRef.current;
    if (v == null) return;
    setPreviewingId(turnId);
    try {
      const { url } = await api.previewPodcastTurn(showId, episodeId, v, turnId);
      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = url;
      await audioRef.current.play();
    } catch (err) {
      console.error('Preview failed', err);
      window.alert('Could not preview this line — check the ElevenLabs voices are set in show settings.');
    } finally {
      setPreviewingId(null);
    }
  }, [showId, episodeId]);

  const regen = useCallback(async (turnId: string) => {
    const hint = window.prompt('How should this line change? (optional — leave blank to just sharpen it)') ?? undefined;
    if (hint === undefined) return; // cancelled
    const v = versionRef.current;
    if (v == null) return;
    try {
      const { script: s } = await api.regeneratePodcastTurn(showId, episodeId, v, turnId, hint ? { hint } : {});
      applyScript(s);
    } catch (err) { console.error('Regen failed', err); window.alert('Could not regenerate this line.'); }
  }, [showId, episodeId, applyScript]);

  const insertAfter = (idx: number) => {
    snapshot();
    const next = [...turns];
    const speaker = turns[idx]?.speaker === 'teacher' ? 'learner' : 'teacher';
    next.splice(idx + 1, 0, { id: uid(), speaker, text: '', overlap: false, is_hook: false, beat: turns[idx]?.beat ?? '' });
    replaceTurns(next);
  };
  const deleteTurn = (idx: number) => { snapshot(); replaceTurns(turns.filter((_, i) => i !== idx)); };
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= turns.length) return;
    snapshot();
    const next = [...turns];
    [next[idx], next[j]] = [next[j], next[idx]];
    replaceTurns(next);
  };
  const mergeUp = (idx: number) => {
    if (idx === 0) return;
    snapshot();
    const next = [...turns];
    next[idx - 1] = { ...next[idx - 1], text: `${next[idx - 1].text} ${next[idx].text}`.trim() };
    next.splice(idx, 1);
    replaceTurns(next);
  };

  const approve = useCallback(async () => {
    if (version == null) return;
    setApproving(true);
    try {
      const { script: s } = await api.approvePodcastScript(showId, episodeId, version);
      applyScript(s);
      onEpisodeChange?.({ status: 'approved' });
      onApproved?.(); // jump to the Audio tab and auto-start the export
    } catch (err) {
      console.error('Approve failed', err);
      window.alert('Could not approve — the script may still be generating.');
    } finally { setApproving(false); }
  }, [showId, episodeId, version, applyScript, onEpisodeChange, onApproved]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) return <div className="h-40 rounded-xl bg-muted/40 animate-pulse" />;

  // No script yet — offer to generate.
  if (!script) {
    return (
      <div className="rounded-2xl border border-dashed border-border py-16 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles size={22} strokeWidth={1.9} aria-hidden />
        </div>
        <p className="mb-1 text-sm font-semibold text-foreground">No script yet</p>
        <p className="mb-5 text-sm text-muted-foreground">The writers&apos; room will turn your brief into a full two-host script.</p>
        <PodcastButton onClick={() => generate()} disabled={generating}>
          {generating ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Sparkles size={15} strokeWidth={2} aria-hidden />}
          Generate script
        </PodcastButton>
      </div>
    );
  }

  if (isGenerating) {
    const activeIdx = STAGES.findIndex((s) => s.key === status);
    return (
      <div className="rounded-2xl border py-14 text-center" style={{ borderColor: 'hsl(var(--border))' }}>
        <Loader2 size={26} className="mx-auto mb-4 animate-spin text-primary" aria-hidden />
        <p className="mb-1 text-sm font-semibold text-foreground">The writers&apos; room is working…</p>
        <p className="mb-6 text-sm text-muted-foreground">A story architect, a playwright, and three reviewers are shaping your episode. This can take a couple of minutes at full effort.</p>
        <div className="mx-auto flex max-w-md items-center justify-between px-6">
          {STAGES.map((s, i) => {
            const done = i < activeIdx;
            const active = i === activeIdx;
            return (
              <div key={s.key} className="flex flex-1 flex-col items-center gap-1.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold" style={{ background: done || active ? 'hsl(var(--primary))' : 'hsl(var(--muted))', color: done || active ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))' }}>
                  {done ? <Check size={13} strokeWidth={3} aria-hidden /> : active ? <Loader2 size={13} className="animate-spin" aria-hidden /> : i + 1}
                </div>
                <span className="text-[10px] font-medium" style={{ color: active ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}>{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="rounded-2xl border border-destructive/40 py-14 text-center">
        <p className="mb-1 text-sm font-semibold text-foreground">Generation failed</p>
        <p className="mb-5 text-sm text-muted-foreground">Something went wrong while writing the script. You can try again.</p>
        <PodcastButton onClick={() => generate()} disabled={generating}>
          <RefreshCw size={15} strokeWidth={2} aria-hidden /> Try again
        </PodcastButton>
      </div>
    );
  }

  const isApproved = status === 'approved';

  return (
    <div className="pb-24">
      {editError && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="flex-1">{editError}</span>
          <button onClick={() => setEditError(null)} className="text-xs font-medium underline">dismiss</button>
        </div>
      )}
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {versions.length > 1 && (
          <div className="relative">
            <select
              value={version}
              onChange={(e) => load(Number(e.target.value)).catch(() => setEditError('Could not load that version.'))}
              className="h-8 appearance-none rounded-lg border bg-background pl-3 pr-8 text-xs font-medium text-foreground focus-ring"
              style={{ borderColor: 'hsl(var(--border))' }}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.version}>v{v.version}{v.approved_at ? ' · approved' : ''}</option>
              ))}
            </select>
            <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          </div>
        )}
        <span className="text-xs text-muted-foreground">{turns.length} lines{isApproved ? ' · approved (edits create a new version)' : ''}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={undo}
            disabled={history.length === 0}
            title="Undo"
            className="flex h-8 w-8 items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:bg-muted focus-ring disabled:opacity-40"
            style={{ borderColor: 'hsl(var(--border))' }}
          >
            <Undo2 size={15} strokeWidth={2} aria-hidden />
          </button>
          <button
            onClick={redo}
            disabled={future.length === 0}
            title="Redo"
            className="flex h-8 w-8 items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:bg-muted focus-ring disabled:opacity-40"
            style={{ borderColor: 'hsl(var(--border))' }}
          >
            <Redo2 size={15} strokeWidth={2} aria-hidden />
          </button>
          <button
            onClick={() => setShowDirections((s) => !s)}
            aria-pressed={showDirections}
            title={showDirections ? 'Hide the [direction] tags for a clean read' : 'Show direction & tone tags'}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-ring ${showDirections ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}
          >
            {showDirections ? <Eye size={14} strokeWidth={2} aria-hidden /> : <EyeOff size={14} strokeWidth={2} aria-hidden />}
            Direction
          </button>
          <PodcastButton variant="outline" onClick={() => setShowNotes((s) => !s)}>
            <Wand2 size={15} strokeWidth={2} aria-hidden /> Regenerate
          </PodcastButton>
        </div>
      </div>

      {showNotes && (
        <div className="mb-4 rounded-xl border border-primary/30 p-3">
          <p className="mb-2 text-xs font-semibold text-foreground">Regenerate the whole script — you&apos;re the director</p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes: e.g. 'open with the bridge collapse story', 'make the learner more skeptical', 'lean harder on the postal-service analogy'."
            className="mb-2 min-h-[60px] w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm text-foreground focus-ring"
            style={{ borderColor: 'hsl(var(--border))' }}
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowNotes(false)} className="h-8 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-muted focus-ring">Cancel</button>
            <PodcastButton onClick={() => setConfirmRegen(true)} disabled={generating}>Regenerate</PodcastButton>
          </div>
        </div>
      )}

      {/* Turns */}
      <div className="space-y-2">
        {turns.map((turn, idx) => (
          <TurnCard
            key={turn.id}
            turn={turn}
            teacherName={show.teacher_name}
            learnerName={show.learner_name}
            showDirections={showDirections}
            onPatch={(p) => patchTurn(turn.id, p)}
            onSwap={() => patchTurn(turn.id, { speaker: turn.speaker === 'teacher' ? 'learner' : 'teacher' })}
            onRegen={() => regen(turn.id)}
            onPreview={() => preview(turn.id)}
            previewing={previewingId === turn.id}
            onInsert={() => insertAfter(idx)}
            onDelete={() => deleteTurn(idx)}
            onUp={() => move(idx, -1)}
            onDown={() => move(idx, 1)}
            onMergeUp={idx > 0 ? () => mergeUp(idx) : undefined}
          />
        ))}
      </div>

      {/* Approve bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {isApproved ? 'Approved. Editing forks a new version.' : 'Review the lines, edit anything, then approve to unlock audio export.'}
          </p>
          <PodcastButton onClick={approve} disabled={approving || isApproved}>
            {approving ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Check size={15} strokeWidth={2.5} aria-hidden />}
            {isApproved ? 'Approved' : 'Approve script'}
          </PodcastButton>
        </div>
      </div>

      {confirmRegen && (
        <ConfirmDialog
          title="Regenerate the whole script?"
          description="This writes a brand-new version from your brief and notes. Your current version stays in the version list."
          confirmLabel="Regenerate"
          busy={generating}
          onConfirm={() => { setConfirmRegen(false); generate(notes.trim() || undefined); }}
          onCancel={() => setConfirmRegen(false)}
        />
      )}
    </div>
  );
}

function TurnCard({
  turn, teacherName, learnerName, showDirections, onPatch, onSwap, onRegen, onPreview, previewing, onInsert, onDelete, onUp, onDown, onMergeUp,
}: {
  turn: PodcastTurn;
  teacherName: string;
  learnerName: string;
  showDirections: boolean;
  onPatch: (p: Partial<PodcastTurn>) => void;
  onSwap: () => void;
  onRegen: () => void;
  onPreview: () => void;
  previewing: boolean;
  onInsert: () => void;
  onDelete: () => void;
  onUp: () => void;
  onDown: () => void;
  onMergeUp?: () => void;
}) {
  const isTeacher = turn.speaker === 'teacher';
  const color = isTeacher ? TEACHER : LEARNER;
  const name = isTeacher ? teacherName : learnerName;
  const clean = !showDirections ? stripTags(turn.text) : turn.text;

  return (
    <div className="group relative rounded-xl border transition-colors" style={{ borderColor: 'hsl(var(--border))', borderLeft: `3px solid ${color}` }}>
      <div className="flex gap-3 p-3">
        {/* Speaker */}
        <button onClick={onSwap} title="Swap speaker" className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 focus-ring" style={{ background: `${color}14`, color }}>
          <span className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold" style={{ background: color, color: '#fff' }}>{name.charAt(0).toUpperCase()}</span>
          <ArrowLeftRight size={12} strokeWidth={2} aria-hidden className="opacity-0 transition-opacity group-hover:opacity-70" />
        </button>

        {/* Body — just the line. Direction ON shows inline [tags]; OFF strips them. */}
        <div className="min-w-0 flex-1 self-center">
          {showDirections ? (
            <textarea
              value={turn.text}
              dir="auto"
              onChange={(e) => onPatch({ text: e.target.value })}
              rows={Math.max(1, Math.ceil(turn.text.length / 70))}
              className="w-full resize-none rounded-lg border-transparent bg-transparent text-sm text-foreground outline-none focus:border-transparent"
              placeholder="Empty line…"
            />
          ) : (
            // Clean reading view — inline [direction] tags stripped out.
            <p dir="auto" className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {clean || <span className="text-muted-foreground">Empty line…</span>}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-col items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button onClick={onPreview} disabled={previewing} title="Preview this line (approximate)" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-ring disabled:opacity-50" style={{ color }}>
            {previewing ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Play size={13} strokeWidth={2} aria-hidden />}
          </button>
          <button onClick={onRegen} title="Regenerate this line with AI" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-ring" style={{ color }}>
            <RefreshCw size={13} strokeWidth={2} aria-hidden />
          </button>
          <button onClick={onInsert} title="Add a line below" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-ring">
            <Plus size={13} strokeWidth={2} aria-hidden />
          </button>
          <button onClick={onDelete} title="Delete line" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-ring">
            <Trash2 size={13} strokeWidth={2} aria-hidden />
          </button>
        </div>
      </div>

      {/* Reorder / merge handles */}
      <div className="absolute -left-6 top-1/2 hidden -translate-y-1/2 flex-col opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 lg:flex">
        <button onClick={onUp} title="Move up" className="text-muted-foreground hover:text-foreground focus-ring"><ChevronDown size={13} className="rotate-180" aria-hidden /></button>
        <GripVertical size={13} className="text-muted-foreground/40" aria-hidden />
        <button onClick={onDown} title="Move down" className="text-muted-foreground hover:text-foreground focus-ring"><ChevronDown size={13} aria-hidden /></button>
      </div>
      {onMergeUp && (
        <button onClick={onMergeUp} title="Merge into the line above" className="absolute right-11 top-2 hidden text-[10px] font-medium text-muted-foreground hover:text-foreground group-hover:block group-focus-within:block focus-ring">merge ↑</button>
      )}
    </div>
  );
}
