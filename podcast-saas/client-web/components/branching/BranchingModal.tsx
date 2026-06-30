'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, Plus, Trash2, GitBranch, AlertTriangle, Loader2,
  Film, ListTree, MapIcon, CheckCircle2,
} from 'lucide-react';
import { api } from '../../lib/api';
import { BranchGraphView } from './BranchGraphView';
import type {
  BranchGraph, BranchSequence, BranchChoicePoint, BranchEdge,
  BranchValidationIssue, BranchDestinationType, BranchAnalytics,
} from 'shared/src/generated/client-v1';

// Form-first "Split into branches" authoring (Phase 2). Field edits persist immediately
// through the branch API and patch the local graph; structural edits reload the full graph.

type DestChoice = { value: string; label: string };

function edgeSelectValue(e: BranchEdge): string {
  if (e.destination_type === 'sequence' && e.dest_sequence_id) return `seq:${e.dest_sequence_id}`;
  return e.destination_type; // back | restart | end | external_url | ...
}

export function BranchingModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [graph, setGraph] = useState<BranchGraph | null>(null);
  const [view, setView] = useState<'form' | 'map'>('form');
  const [analytics, setAnalytics] = useState<BranchAnalytics | null>(null);
  const [issues, setIssues] = useState<BranchValidationIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingCount, setSavingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const validationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    try {
      const [g, v] = await Promise.all([api.getBranching(projectId), api.validateBranching(projectId)]);
      setGraph(g);
      setIssues(v.issues);
      setError(null);
      api.getBranchAnalytics(projectId).then(setAnalytics).catch(() => setAnalytics(null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load branching');
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
  }, [reload]);

  const refreshValidation = useCallback(async () => {
    try {
      const v = await api.validateBranching(projectId);
      setIssues(v.issues);
    } catch {
      // Save errors are handled by run/quickSave; validation can retry on the next edit.
    }
  }, [projectId]);

  const scheduleValidation = useCallback(() => {
    if (validationTimerRef.current) clearTimeout(validationTimerRef.current);
    validationTimerRef.current = setTimeout(() => {
      validationTimerRef.current = null;
      void refreshValidation();
    }, 350);
  }, [refreshValidation]);

  useEffect(() => () => {
    if (validationTimerRef.current) clearTimeout(validationTimerRef.current);
  }, []);

  const updateGraph = useCallback((updater: (current: BranchGraph) => BranchGraph) => {
    setGraph((current) => current ? updater(current) : current);
  }, []);

  const replaceSequence = useCallback((seq: BranchSequence) => updateGraph((g) => ({
    ...g,
    sequences: g.sequences.map((s) => {
      if (s.id === seq.id) return seq;
      return seq.is_entry && s.is_entry ? { ...s, is_entry: false } : s;
    }),
  })), [updateGraph]);

  const replaceChoicePoint = useCallback((cp: BranchChoicePoint) => updateGraph((g) => ({
    ...g,
    choice_points: g.choice_points.map((item) => item.id === cp.id ? cp : item),
  })), [updateGraph]);

  const replaceEdge = useCallback((edge: BranchEdge) => updateGraph((g) => ({
    ...g,
    edges: g.edges.map((item) => item.id === edge.id ? edge : item),
  })), [updateGraph]);

  const replaceVideoAssignment = useCallback((assignment: { id: string; sequence_id: string | null; sequence_order: number | null }) => updateGraph((g) => ({
    ...g,
    videos: g.videos.map((v) => v.id === assignment.id ? { ...v, ...assignment } : v),
  })), [updateGraph]);

  // Wrap a mutation so it shows busy state, surfaces errors, and reloads after.
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const quickSave = useCallback(async <T,>(fn: () => Promise<T>, apply?: (result: T) => void) => {
    setSavingCount((count) => count + 1);
    try {
      const result = await fn();
      apply?.(result);
      setError(null);
      scheduleValidation();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
      await reload();
    } finally {
      setSavingCount((count) => Math.max(0, count - 1));
    }
  }, [reload, scheduleValidation]);

  const sequences = graph?.sequences ?? [];
  const videos = graph?.videos ?? [];
  const choicePointBySeq = new Map<string, BranchChoicePoint>();
  for (const cp of graph?.choice_points ?? []) if (!choicePointBySeq.has(cp.sequence_id)) choicePointBySeq.set(cp.sequence_id, cp);
  const edgesByCp = new Map<string, BranchEdge[]>();
  for (const e of graph?.edges ?? []) {
    if (!e.choice_point_id) continue;
    const list = edgesByCp.get(e.choice_point_id) ?? [];
    list.push(e);
    edgesByCp.set(e.choice_point_id, list);
  }

  const destChoicesFor = (currentSeqId: string): DestChoice[] => [
    ...sequences.filter((s) => s.id !== currentSeqId).map((s) => ({ value: `seq:${s.id}`, label: `Sequence: ${s.label}` })),
    { value: 'back', label: 'Back to previous decision' },
    { value: 'restart', label: 'Restart from the beginning' },
    { value: 'end', label: 'End the experience' },
    { value: 'external_url', label: 'External link...' },
  ];

  const applyEdgeDestination = (edge: BranchEdge, value: string) => {
    if (value.startsWith('seq:')) {
      return api.updateBranchEdge(projectId, edge.id, { destination_type: 'sequence', dest_sequence_id: value.slice(4), dest_url: null });
    }
    const destination_type = value as BranchDestinationType;
    return api.updateBranchEdge(projectId, edge.id, { destination_type, dest_sequence_id: null });
  };

  // Map: dragging from one sequence to another creates a choice edge (and a choice point if needed).
  const onGraphConnect = (sourceSeqId: string, targetSeqId: string) => run(async () => {
    let cp = choicePointBySeq.get(sourceSeqId);
    if (!cp) cp = await api.createChoicePoint(projectId, { sequence_id: sourceSeqId, behavior: 'continue', lead_in_sec: 10, timeout_sec: 8 });
    await api.createBranchEdge(projectId, { choice_point_id: cp.id, label: 'Choice', destination_type: 'sequence', dest_sequence_id: targetSeqId });
  });

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const totalChoices = graph?.edges.length ?? 0;
  const assignedClips = videos.filter((v) => v.sequence_id).length;

  return (
    <div className="fixed inset-0 z-[950] flex items-center justify-center bg-slate-950/55 p-[5dvh_5vw] backdrop-blur-md" onMouseDown={onClose}>
      <div
        className="surface-panel flex h-[90dvh] w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="branching-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="shell-bg flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3.5 max-[760px]:flex-col max-[760px]:items-stretch">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/12 text-cyan-600">
              <GitBranch size={18} strokeWidth={1.9} aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 id="branching-modal-title" className="truncate text-[15px] font-semibold shell-text">Follow user decisions</h2>
                {(busy || savingCount > 0) && <Loader2 size={14} className="animate-spin shell-muted" aria-hidden />}
              </div>
              <p className="mt-0.5 truncate text-[11px] shell-muted">
                {sequences.length} sequence{sequences.length === 1 ? '' : 's'} · {totalChoices} choice{totalChoices === 1 ? '' : 's'} · {assignedClips}/{videos.length} clips assigned
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 max-[760px]:justify-between">
            {sequences.length > 0 && (
              <div className="flex overflow-hidden rounded-lg border border-border bg-card/70 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setView('form')}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-semibold transition-colors max-[420px]:px-2 ${view === 'form' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
                >
                  <ListTree size={13} strokeWidth={2} aria-hidden /> Editor
                </button>
                <button
                  type="button"
                  onClick={() => setView('map')}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-semibold transition-colors max-[420px]:px-2 ${view === 'map' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
                >
                  <MapIcon size={13} strokeWidth={2} aria-hidden /> Map
                </button>
              </div>
            )}
            {sequences.length > 0 && (
              <button
                type="button"
                onClick={() => { if (confirm('Remove all branching and revert to a single linear video?')) run(() => api.clearBranching(projectId)); }}
                className="inline-flex h-8 items-center rounded-lg border border-border bg-card px-3 text-xs font-semibold text-red-600 transition-colors hover:bg-red-50 focus-ring max-[560px]:hidden"
              >
                Remove branching
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring">
              <X size={17} aria-hidden />
            </button>
          </div>
        </header>

        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={18} className="animate-spin" aria-hidden /> Loading branching...
          </div>
        ) : error ? (
          <div className="m-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        ) : sequences.length === 0 ? (
          <div className="flex flex-1 items-center justify-center bg-muted/20 p-8">
            <div className="w-full max-w-lg text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-cyan-500/12 text-cyan-600">
                <GitBranch size={25} strokeWidth={1.8} aria-hidden />
              </span>
              <h3 className="mt-4 text-lg font-semibold text-foreground">Create the first decision path</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Split the video into named sequences, assign clips, then add choices at the end of each sequence.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => api.createBranchSequence(projectId, { label: 'Sequence A', is_entry: true }))}
                className="mt-5 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 focus-ring"
              >
                <Plus size={16} aria-hidden /> Create sequence
              </button>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] max-[900px]:grid-cols-1">
            <aside className="flex min-h-0 flex-col border-r border-border bg-muted/25 max-[900px]:max-h-[190px] max-[900px]:border-b max-[900px]:border-r-0">
              <div className="grid grid-cols-3 gap-2 border-b border-border/70 p-3 max-[900px]:grid-cols-3">
                <div className="rounded-lg border border-border bg-card px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sequences</p>
                  <p className="mt-1 text-xl font-semibold text-foreground">{sequences.length}</p>
                </div>
                <div className="rounded-lg border border-border bg-card px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Choices</p>
                  <p className="mt-1 text-xl font-semibold text-foreground">{totalChoices}</p>
                </div>
                <div className="rounded-lg border border-border bg-card px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Clips</p>
                  <p className="mt-1 text-xl font-semibold text-foreground">{assignedClips}/{videos.length}</p>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-3 fine-scrollbar">
                <div className="mb-3 flex items-center gap-2">
                  {errors.length === 0 ? (
                    <CheckCircle2 size={15} className="text-emerald-600" aria-hidden />
                  ) : (
                    <AlertTriangle size={15} className="text-red-600" aria-hidden />
                  )}
                  <span className="text-xs font-semibold text-foreground">Graph status</span>
                </div>

                {analytics && analytics.sessions > 0 && (
                  <div className="mb-3 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                    {analytics.sessions} viewer{analytics.sessions === 1 ? '' : 's'} · {analytics.completes} completion{analytics.completes === 1 ? '' : 's'}
                  </div>
                )}

                {errors.length === 0 && warnings.length === 0 ? (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                    No issues. The branching graph is valid.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {errors.map((i, n) => (
                      <p key={`e${n}`} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">{i.message}</p>
                    ))}
                    {warnings.map((i, n) => (
                      <p key={`w${n}`} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">{i.message}</p>
                    ))}
                  </div>
                )}
              </div>
            </aside>

            {view === 'map' ? (
              <main className="min-h-0 overflow-hidden bg-background p-4">
                <BranchGraphView
                  graph={graph!}
                  onMoveNode={(seqId, x, y) => quickSave(() => api.updateBranchSequence(projectId, seqId, { graph_x: x, graph_y: y }), replaceSequence)}
                  onConnectSequences={onGraphConnect}
                  onSelectNode={() => setView('form')}
                />
              </main>
            ) : (
              <main className="grid min-h-0 grid-cols-[minmax(280px,360px)_minmax(0,1fr)] overflow-hidden bg-background max-[1100px]:grid-cols-1">
                <section className="flex min-h-0 flex-col border-r border-border bg-card/70 max-[1100px]:max-h-[260px] max-[1100px]:border-b max-[1100px]:border-r-0">
                  <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Film size={15} className="text-muted-foreground" aria-hidden />
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Clips to sequences</h3>
                    </div>
                    <span className="rounded-md bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground">{videos.length}</span>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 fine-scrollbar">
                    {videos.length === 0 && <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">This project has no main video clips yet.</p>}
                    {videos.map((v, idx) => (
                      <div key={v.id} className="rounded-lg border border-border bg-background px-3 py-2 shadow-sm-soft">
                        <div className="flex items-center gap-2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[11px] font-bold text-primary">{idx + 1}</span>
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={v.filename}>{v.filename}</span>
                        </div>
                        <div className="mt-2 grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                          <input
                            type="number"
                            defaultValue={v.sequence_order ?? 0}
                            min={0}
                            className="h-8 rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                            title="Order within sequence"
                            onBlur={(e) => {
                              const sequence_order = Number(e.target.value);
                              if (sequence_order === (v.sequence_order ?? 0)) return;
                              quickSave(
                                () => api.assignVideoToSequence(projectId, { video_file_id: v.id, sequence_id: v.sequence_id, sequence_order }),
                                replaceVideoAssignment,
                              );
                            }}
                          />
                          <select
                            value={v.sequence_id ?? ''}
                            className="h-8 min-w-0 rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                            onChange={(e) => {
                              const sequence_id = e.target.value || null;
                              if (sequence_id === (v.sequence_id ?? null)) return;
                              quickSave(
                                () => api.assignVideoToSequence(projectId, { video_file_id: v.id, sequence_id, sequence_order: v.sequence_order }),
                                replaceVideoAssignment,
                              );
                            }}
                          >
                            <option value="">Unassigned</option>
                            {sequences.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="flex min-h-0 flex-col overflow-hidden">
                  <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">Sequences and decisions</h3>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">Each sequence can end with a viewer decision.</p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => api.createBranchSequence(projectId, { label: `Sequence ${String.fromCharCode(65 + sequences.length)}` }))}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50 focus-ring"
                    >
                      <Plus size={14} aria-hidden /> Add sequence
                    </button>
                  </div>

                  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 fine-scrollbar">
                    {sequences.map((seq) => (
                      <SequenceCard
                        key={seq.id}
                        seq={seq}
                        cp={choicePointBySeq.get(seq.id) ?? null}
                        edges={(() => { const cp = choicePointBySeq.get(seq.id); return cp ? edgesByCp.get(cp.id) ?? [] : []; })()}
                        busy={busy}
                        edgeCounts={analytics?.edge_choice_counts ?? {}}
                        destChoices={destChoicesFor(seq.id)}
                        onRename={(label) => quickSave(() => api.updateBranchSequence(projectId, seq.id, { label }), replaceSequence)}
                        onSetEntry={() => quickSave(() => api.updateBranchSequence(projectId, seq.id, { is_entry: true }), replaceSequence)}
                        onDelete={() => run(() => api.deleteBranchSequence(projectId, seq.id))}
                        onAddChoicePoint={() => run(() => api.createChoicePoint(projectId, { sequence_id: seq.id, behavior: 'continue', lead_in_sec: 10, timeout_sec: 8 }))}
                        onUpdateChoicePoint={(patch) => { const cp = choicePointBySeq.get(seq.id); if (cp) return quickSave(() => api.updateChoicePoint(projectId, cp.id, patch), replaceChoicePoint); }}
                        onDeleteChoicePoint={() => { const cp = choicePointBySeq.get(seq.id); if (cp) return run(() => api.deleteChoicePoint(projectId, cp.id)); }}
                        onAddEdge={() => { const cp = choicePointBySeq.get(seq.id); if (!cp) return; const other = sequences.find((s) => s.id !== seq.id); return run(() => api.createBranchEdge(projectId, { choice_point_id: cp.id, label: 'Choice', destination_type: other ? 'sequence' : 'end', dest_sequence_id: other?.id ?? null })); }}
                        onUpdateEdge={(edge, patch) => quickSave(() => api.updateBranchEdge(projectId, edge.id, patch), replaceEdge)}
                        onSetEdgeDestination={(edge, value) => quickSave(() => applyEdgeDestination(edge, value), replaceEdge)}
                        onDeleteEdge={(edge) => run(() => api.deleteBranchEdge(projectId, edge.id))}
                        onSetDefaultEdge={(edgeId) => { const cp = choicePointBySeq.get(seq.id); if (cp) return quickSave(() => api.updateChoicePoint(projectId, cp.id, { default_edge_id: edgeId }), replaceChoicePoint); }}
                      />
                    ))}
                  </div>
                </section>
              </main>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SequenceCard({
  seq, cp, edges, busy, edgeCounts, destChoices,
  onRename, onSetEntry, onDelete,
  onAddChoicePoint, onUpdateChoicePoint, onDeleteChoicePoint,
  onAddEdge, onUpdateEdge, onSetEdgeDestination, onDeleteEdge, onSetDefaultEdge,
}: {
  seq: BranchSequence;
  cp: BranchChoicePoint | null;
  edges: BranchEdge[];
  busy: boolean;
  edgeCounts: Record<string, number>;
  destChoices: DestChoice[];
  onRename: (label: string) => void;
  onSetEntry: () => void;
  onDelete: () => void;
  onAddChoicePoint: () => void;
  onUpdateChoicePoint: (patch: Partial<{ lead_in_sec: number; timeout_sec: number | null; behavior: 'continue' | 'pause' | 'loop'; prompt: string | null; layout: string }>) => void;
  onDeleteChoicePoint: () => void;
  onAddEdge: () => void;
  onUpdateEdge: (edge: BranchEdge, patch: Partial<BranchEdge>) => void;
  onSetEdgeDestination: (edge: BranchEdge, value: string) => void;
  onDeleteEdge: (edge: BranchEdge) => void;
  onSetDefaultEdge: (edgeId: string) => void;
}) {
  return (
    <div className={`overflow-hidden rounded-xl border bg-card shadow-sm-soft ${seq.is_entry ? 'border-cyan-300 ring-1 ring-cyan-500/15' : 'border-border'}`}>
      <div className="flex items-center gap-3 border-b border-border/70 bg-muted/20 px-4 py-3">
        <label className={`inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-[11px] font-semibold transition-colors ${seq.is_entry ? 'border-cyan-200 bg-cyan-50 text-cyan-700' : 'border-border bg-card text-muted-foreground hover:bg-muted/50'}`} title="Starting sequence">
          <input type="radio" checked={seq.is_entry} onChange={onSetEntry} disabled={busy} className="accent-cyan-600" />
          Start
        </label>
        <input
          defaultValue={seq.label}
          className="h-9 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-sm font-semibold text-foreground transition-colors hover:border-border hover:bg-card focus:border-primary/40 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring/20"
          onBlur={(e) => { if (e.target.value !== seq.label) onRename(e.target.value); }}
        />
        <button type="button" onClick={onDelete} disabled={busy} aria-label="Delete sequence" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40">
          <Trash2 size={15} aria-hidden />
        </button>
      </div>

      <div className="p-4">
        {!cp ? (
          <button
            type="button"
            disabled={busy}
            onClick={onAddChoicePoint}
            className="flex min-h-16 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/25 px-4 text-sm font-semibold text-muted-foreground transition-colors hover:border-cyan-300 hover:bg-cyan-50/60 hover:text-cyan-700 disabled:opacity-50 focus-ring"
          >
            <Plus size={16} aria-hidden /> Add decision point
          </button>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-3 max-[1280px]:grid-cols-2 max-[620px]:grid-cols-1">
              <label className="grid gap-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Behavior</span>
                <select
                  value={cp.behavior}
                  className="h-9 rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                  onChange={(e) => onUpdateChoicePoint({ behavior: e.target.value as 'continue' | 'pause' | 'loop' })}
                >
                  <option value="continue">Keep playing</option>
                  <option value="pause">Pause &amp; wait</option>
                  <option value="loop">Loop clip until choice</option>
                </select>
              </label>
              <label className="grid gap-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Appears before end</span>
                <input type="number" min={1} defaultValue={cp.lead_in_sec} className="h-9 rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                  onBlur={(e) => {
                    const lead_in_sec = Number(e.target.value);
                    if (lead_in_sec !== cp.lead_in_sec) onUpdateChoicePoint({ lead_in_sec });
                  }} />
              </label>
              <label className="grid gap-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Timeout</span>
                <input type="number" min={0} defaultValue={cp.timeout_sec ?? ''} placeholder="None" className="h-9 rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                  onBlur={(e) => {
                    const timeout_sec = e.target.value === '' ? null : Number(e.target.value);
                    if (timeout_sec !== (cp.timeout_sec ?? null)) onUpdateChoicePoint({ timeout_sec });
                  }} />
              </label>
              <label className="grid gap-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Viewer style</span>
                <select value={cp.layout} className="h-9 rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                  onChange={(e) => onUpdateChoicePoint({ layout: e.target.value })}>
                  <option value="cards">Cards</option>
                  <option value="buttons">Buttons</option>
                  <option value="quiz">Quiz (A/B/C)</option>
                </select>
              </label>
            </div>

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-muted-foreground">Viewer prompt</span>
                <button type="button" onClick={onDeleteChoicePoint} disabled={busy} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40" aria-label="Remove decision point">
                  <Trash2 size={12} aria-hidden /> Remove decision
                </button>
              </div>
              <input
                defaultValue={cp.prompt ?? ''}
                placeholder="What should the viewer choose next?"
                className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                onBlur={(e) => {
                  const prompt = e.target.value || null;
                  if (prompt !== (cp.prompt ?? null)) onUpdateChoicePoint({ prompt });
                }}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Choices</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onAddEdge}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50 focus-ring"
                >
                  <Plus size={13} aria-hidden /> Add choice
                </button>
              </div>
              {edges.map((edge) => (
                <div key={edge.id} className="rounded-lg border border-border bg-muted/25 p-2">
                  <div className="grid grid-cols-[86px_minmax(130px,1fr)_minmax(170px,240px)_auto_auto] items-center gap-2 max-[900px]:grid-cols-1">
                    <label className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-[11px] font-semibold text-muted-foreground" title="Default on timeout">
                      <input type="radio" checked={cp.default_edge_id === edge.id} onChange={() => onSetDefaultEdge(edge.id)} className="accent-primary" />
                      default
                    </label>
                    <input
                      defaultValue={edge.label ?? ''}
                      placeholder="Choice label"
                      className="h-9 min-w-0 rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                      onBlur={(e) => { if ((e.target.value || null) !== edge.label) onUpdateEdge(edge, { label: e.target.value || null }); }}
                    />
                    <select
                      value={edgeSelectValue(edge)}
                      className="h-9 min-w-0 rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                      onChange={(e) => onSetEdgeDestination(edge, e.target.value)}
                    >
                      {destChoices.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                    {edgeCounts[edge.id] ? <span className="rounded-md bg-card px-2 py-1 text-[10px] font-semibold text-muted-foreground" title="Times chosen">{edgeCounts[edge.id]}x</span> : <span />}
                    <button type="button" onClick={() => onDeleteEdge(edge)} aria-label="Delete choice" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600">
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </div>
                  {edge.destination_type === 'external_url' && (
                    <input
                      defaultValue={edge.dest_url ?? ''}
                      placeholder="https://..."
                      className="mt-2 h-9 w-full rounded-lg border border-input bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20"
                      onBlur={(e) => {
                        const dest_url = e.target.value || null;
                        if (dest_url !== (edge.dest_url ?? null)) onUpdateEdge(edge, { dest_url });
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
