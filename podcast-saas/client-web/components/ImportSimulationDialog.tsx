'use client';

/**
 * Import simulations from your other projects — the whole screen, stills first (night run
 * 2026-09-03 §6).
 *
 * ── WHAT CHANGED, AND WHY ─────────────────────────────────────────────────────────────────────
 *
 * The previous gallery borrowed the Extended Library's 1120×760 panel: on a large monitor a small
 * dimmed window over the editor, with 210px cards each running a LIVE simulation — eight to
 * twelve animation loops at postage-stamp size, none of them readable. Now the gallery is the
 * screen, tiles are ≥300px 16:9 stills of each simulation's poster, and a simulation only runs
 * when the author asks to see it move (hover / "Play") or opens it full screen.
 *
 * ── ONE REQUEST, NOT ONE PER PROJECT ──────────────────────────────────────────────────────────
 *
 * `listImportableSimulations` answers with every ready simulation across the author's editable
 * projects, each with its project title and poster — the server already knows which projects
 * are editable, so the client no longer lists projects and fans out N requests that all had to
 * finish before anything rendered.
 *
 * ── IMPORTS RUN A FEW AT A TIME ───────────────────────────────────────────────────────────────
 *
 * Three at once: each import is a bucket-side copy plus a row, and a modest bound keeps a large
 * selection from hammering storage while still being far from one-at-a-time. On a failure the
 * survivors stay selected and the dialog stays open, so a retry is one click and never re-imports
 * what already landed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Maximize2, CheckCircle2, AlertTriangle, ArrowDownUp, Play } from 'lucide-react';
import { api } from '@/lib/api';
import type { ImportableSimulation, Simulation } from 'shared/src/generated/client-v1';
import { failureMessage } from './failureSurface';
import { SimSurface } from '../lib/sim/SimSurface';
import './importSimulation.css';

const NOOP_FRAME_REF = () => {};
const IMPORT_CONCURRENCY = 3;

interface Props {
  /** The project being edited — imports land here, and it is excluded from the source list. */
  projectId: string;
  onImported: (sims: Simulation[]) => void;
  onClose: () => void;
}

type SortBy = 'newest' | 'name' | 'project';

/** Run `tasks` with at most `limit` in flight; results in order; the first rejection wins. */
export async function runWithLimit<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < tasks.length && failed === null) {
      const i = next++;
      try { results[i] = await tasks[i](); }
      catch (e) { if (failed === null) failed = e ?? new Error('import failed'); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  if (failed !== null) throw failed;
  return results;
}

export function ImportSimulationDialog({ projectId, onImported, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ImportableSimulation[]>([]);
  const [q, setQ] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');     // '' = all projects
  const [sortBy, setSortBy] = useState<SortBy>('newest');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sims = await api.listImportableSimulations(projectId);
        if (!cancelled) setCandidates(sims.filter((s) => s.status === 'ready'));
      } catch (e) {
        if (!cancelled) setLoadFailed(failureMessage(e as Error, 'Could not load your simulations'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  /** Source projects that actually contributed a simulation — never an empty pill. */
  const sources = useMemo(() => {
    const counts = new Map<string, { title: string; n: number }>();
    for (const c of candidates) {
      const prev = counts.get(c.project_id);
      counts.set(c.project_id, { title: c.project_title || 'Untitled project', n: (prev?.n ?? 0) + 1 });
    }
    return [...counts.entries()].sort((a, b) => a[1].title.localeCompare(b[1].title));
  }, [candidates]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = candidates.filter((c) => {
      if (sourceFilter && c.project_id !== sourceFilter) return false;
      if (!needle) return true;
      return `${c.name} ${c.project_title}`.toLowerCase().includes(needle);
    });
    return rows.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'project') return a.project_title.localeCompare(b.project_title) || a.name.localeCompare(b.name);
      return (b.created_at ?? '').localeCompare(a.created_at ?? '');
    });
  }, [candidates, q, sourceFilter, sortBy]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const runImport = useCallback(async () => {
    if (importing || selected.size === 0) return;
    setImporting(true);
    setError(null);
    const ids = [...selected];
    setProgress({ done: 0, total: ids.length });
    const imported: Simulation[] = [];
    const stillSelected = new Set(ids);

    try {
      await runWithLimit(ids.map((id) => async () => {
        const sim = await api.importSimulation(projectId, id);
        imported.push(sim);
        stillSelected.delete(id);
        setProgress({ done: imported.length, total: ids.length });
      }), IMPORT_CONCURRENCY);
    } catch (e) {
      // Stop on the first failure, keep what landed. The survivors stay selected for one-click retry.
      setError(failureMessage(e as Error, 'Could not import this simulation'));
    }

    setSelected(stillSelected);
    setImporting(false);
    setProgress(null);
    if (imported.length > 0) onImported(imported);
    // Close only on a CLEAN sweep — closing on a partial result would report success for work
    // that did not happen and strand the retry.
    if (stillSelected.size === 0) onClose();
  }, [importing, selected, projectId, onImported, onClose]);

  const [canPortal, setCanPortal] = useState(false);
  useEffect(() => { setCanPortal(true); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !importing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [importing, onClose]);

  // The gallery IS the screen: portaled to <body> so no ancestor's stacking context or transform
  // can trap a fixed surface inside the editor rail (v0.3.0 shipped it trapped there).
  if (!canPortal) return null;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Import simulations" className="import-sim">
      <div className="import-sim__header">
        <div>
          <h2 className="import-sim__title">Import a simulation</h2>
          <p className="import-sim__hint">From your other projects — copied bucket-side, nothing uploaded or stored twice.</p>
        </div>
        <span className="import-sim__count" aria-live="polite">
          {selected.size > 0 ? `${selected.size} selected` : `${visible.length} available`}
        </span>
        <button className="import-sim__close" onClick={onClose} disabled={importing} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="import-sim__filters">
        <label className="import-sim__search">
          <Search size={15} />
          <input
            type="search" placeholder="Search simulations…" aria-label="Search simulations"
            value={q} onChange={(e) => setQ(e.target.value)} autoFocus
          />
        </label>
        <div className="import-sim__pills" role="group" aria-label="Source project">
          <button
            type="button"
            className={`import-sim__pill${sourceFilter === '' ? ' import-sim__pill--on' : ''}`}
            onClick={() => setSourceFilter('')}
          >
            <span>All projects</span>{candidates.length > 0 && <b>{candidates.length}</b>}
          </button>
          {sources.map(([id, { title, n }]) => (
            <button
              key={id}
              type="button"
              className={`import-sim__pill${sourceFilter === id ? ' import-sim__pill--on' : ''}`}
              onClick={() => setSourceFilter(id)}
              title={title}
            >
              <span>{title}</span><b>{n}</b>
            </button>
          ))}
        </div>
        <label className="import-sim__sort">
          <ArrowDownUp size={13} />
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} aria-label="Sort by">
            <option value="newest">Newest</option>
            <option value="name">Name</option>
            <option value="project">Project</option>
          </select>
        </label>
      </div>

      <div className="import-sim__body">
        {loadFailed ? (
          <div className="import-sim__empty" role="alert">{loadFailed}</div>
        ) : loading ? (
          <div className="import-sim__empty"><span className="avatar-spinner" /></div>
        ) : candidates.length === 0 ? (
          <div className="import-sim__empty">No ready simulations in your other projects yet.</div>
        ) : visible.length === 0 ? (
          <div className="import-sim__empty">Nothing matches “{q}”.</div>
        ) : (
          <div className="import-sim__grid">
            {visible.map((c) => (
              <ImportCard
                key={c.id}
                sim={c}
                selected={selected.has(c.id)}
                disabled={importing}
                onToggle={() => toggle(c.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="import-sim__footer">
        {error && (
          <span role="alert" className="import-sim__error"><AlertTriangle size={13} /> {error}</span>
        )}
        {progress && (
          <span className="import-sim__progress"><CheckCircle2 size={13} /> Imported {progress.done} of {progress.total}…</span>
        )}
        <button className="import-sim__cancel" onClick={onClose} disabled={importing}>Cancel</button>
        <button className="import-sim__go" onClick={runImport} disabled={importing || selected.size === 0}>
          {importing ? 'Importing…' : selected.size === 0 ? 'Select simulations' : `Import ${selected.size}`}
        </button>
      </div>
    </div>,
    document.body
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

function ImportCard({ sim, selected, disabled, onToggle }: {
  sim: ImportableSimulation; selected: boolean; disabled: boolean; onToggle: () => void;
}) {
  const [fs, setFs] = useState(false);
  const [live, setLive] = useState(false);
  const date = sim.created_at ? new Date(sim.created_at).toLocaleDateString() : '';
  const projectTitle = sim.project_title || 'Untitled project';

  return (
    <div className={`import-sim-card${selected ? ' import-sim-card--on' : ''}`} data-sim-id={sim.id}>
      <div className="import-sim-card__preview">
        {live || !sim.poster_url ? (
          <LazySimPreview src={sim.entry_file} />
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sim.poster_url} alt="" className="import-sim-card__still" loading="lazy" decoding="async" />
            <button
              type="button" className="import-sim-card__play" onClick={() => setLive(true)}
              aria-label={`Play ${sim.name} preview`}
            >
              <span><Play size={13} /> Play</span>
            </button>
          </>
        )}
        <button
          type="button" className="import-sim-card__fs" onClick={() => setFs(true)}
          title="Full screen preview" aria-label={`Preview ${sim.name} full screen`}
        >
          <Maximize2 size={13} />
        </button>
      </div>
      <label className="import-sim-card__pick">
        <input type="checkbox" checked={selected} disabled={disabled} onChange={onToggle} className="import-sim-card__box" />
        <span className="import-sim-card__text">
          <span className="import-sim-card__name">{sim.name}</span>
          <span className="import-sim-card__meta">
            <span className="import-sim-card__project">{projectTitle}</span>
            {date && <span>{date}</span>}
          </span>
        </span>
      </label>
      {fs && createPortal(
        <FullScreenPreview sim={sim} projectTitle={projectTitle} onClose={() => setFs(false)} />,
        document.body,
      )}
    </div>
  );
}

/** A live, passive preview — mounted only while in view, and only when there is no still to show. */
function LazySimPreview({ src }: { src?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => setMounted(e.isIntersecting), { rootMargin: '120px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  useEffect(() => { if (!mounted) setLoaded(false); }, [mounted]);

  if (!src) return <div ref={ref} className="import-sim-card__placeholder">▶ Interactive</div>;
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0 }}>
      {mounted && (
        <SimSurface
          src={src}
          visible={loaded}
          onLoad={() => setLoaded(true)}
          frameRef={NOOP_FRAME_REF}
          title="preview"
          interactive={false}
          sandbox="allow-scripts allow-same-origin"
          style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: '#fff' }}
        />
      )}
    </div>
  );
}

/** The proper look: one simulation, the whole screen, interactive. */
function FullScreenPreview({ sim, projectTitle, onClose }: {
  sim: ImportableSimulation; projectTitle: string; onClose: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label={`${sim.name} preview`} className="import-sim-fs" onClick={onClose}>
      <div className="import-sim-fs__bar" onClick={(e) => e.stopPropagation()}>
        <span className="import-sim-fs__name">{sim.name}</span>
        <span className="import-sim-fs__project">{projectTitle}</span>
        <button className="import-sim__close" onClick={onClose} aria-label="Close preview"><X size={16} /></button>
      </div>
      <div className="import-sim-fs__stage" onClick={(e) => e.stopPropagation()}>
        <SimSurface
          src={sim.entry_file}
          visible={loaded}
          onLoad={() => setLoaded(true)}
          frameRef={NOOP_FRAME_REF}
          title={`${sim.name} preview`}
          interactive
          sandbox="allow-scripts allow-same-origin"
          allow="fullscreen"
          style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: '#fff' }}
        />
      </div>
    </div>
  );
}
