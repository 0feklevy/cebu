'use client';

/**
 * Import simulations from your other projects — a gallery, not a two-step list.
 *
 * ── WHAT CHANGED, AND WHY ─────────────────────────────────────────────────────────────────────
 *
 * The previous version was a 440px modal with two nested text lists: click a project name, then
 * read simulation names and press Import on one of them. It asked the author to recognise a
 * simulation from a string like "sim-3" and to remember which project it was in — for content
 * that is inherently visual and that they may have made months ago.
 *
 * This version mirrors the Extended Library gallery (`avatar/ExtendedLibraryModal.tsx`) and reuses
 * its stylesheet rather than inventing a second look: one full-screen surface, a live preview per
 * card, search across name AND project, project pills to narrow by source, a full-screen preview
 * for a proper look, and multi-select so bringing in four simulations is one trip.
 *
 * ── WHY THE PREVIEWS ARE SAFE AND CHEAP ───────────────────────────────────────────────────────
 *
 * `listSimulations` already returns `entry_file` as a full public URL (the controller rewrites the
 * stored key on the way out), so a preview needs no new endpoint. Each frame goes through
 * `SimSurface`, which is what applies origin rebase — a raw stored URL is blocked by the frame-src
 * CSP and renders blank — and keeps an unrevealed frame `inert`/`aria-hidden`. Frames mount only
 * when scrolled into view and unmount when they leave: with several projects' worth of cards, a
 * grid of eagerly-mounted simulations would run dozens of animation loops at once.
 *
 * Previews are PASSIVE. `interactive={false}`, no runtime, no lifecycle — this surface displays
 * packages, it never drives them.
 *
 * ── WHY IMPORTS RUN ONE AT A TIME ─────────────────────────────────────────────────────────────
 *
 * Each import is a server-side bucket copy plus a row. Firing N in parallel would multiply the
 * storage work and make a partial failure hard to describe. Sequential lets the dialog report
 * exactly which ones landed and leave the rest selected, so a retry is one click and does not
 * re-import what already succeeded.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Maximize2, CheckCircle2, AlertTriangle, ArrowDownUp } from 'lucide-react';
import { api } from '@/lib/api';
import type { Project, Simulation } from 'shared/src/generated/client-v1';
import { failureMessage } from './failureSurface';
import { SimSurface } from '../lib/sim/SimSurface';
import './avatar/avatar.css';
import './importSimulation.css';

/**
 * Previews here are passive, so nothing needs a handle on the element — but SimSurface's
 * `frameRef` is required (it is the runtime's attach point on surfaces that DO have a lifecycle).
 * Module-level so SimSurface's memo() stays effective across re-renders.
 */
const NOOP_FRAME_REF = () => {};

interface Props {
  /** The project being edited — imports land here, and it is excluded from the source list. */
  projectId: string;
  onImported: (sims: Simulation[]) => void;
  onClose: () => void;
}

/** A simulation plus the project it came from — the pair every card and every filter needs. */
interface Candidate {
  sim: Simulation;
  projectId: string;
  projectTitle: string;
}

type SortBy = 'newest' | 'name' | 'project';

export function ImportSimulationDialog({ projectId, onImported, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [q, setQ] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');     // '' = all projects
  const [sortBy, setSortBy] = useState<SortBy>('newest');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Load every eligible simulation across the author's other projects ───────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const projects = await api.listProjects();
        const others = projects.filter((p: Project) => p.id !== projectId);
        if (cancelled) return;
        // Per-project, and a project whose simulations cannot be listed is SKIPPED rather than
        // failing the whole dialog: one unreadable project must not hide every other project's
        // work. `settled`, not `all`, is what makes that true.
        const results = await Promise.allSettled(
          others.map(async (p) => {
            const sims = await api.listSimulations(p.id);
            return sims
              .filter((s) => s.status === 'ready')
              .map((sim): Candidate => ({ sim, projectId: p.id, projectTitle: p.title || 'Untitled project' }));
          }),
        );
        if (cancelled) return;
        setCandidates(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
      } catch (e) {
        if (!cancelled) setLoadFailed(failureMessage(e as Error, 'Could not load your projects'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  /** Source projects that actually contributed a simulation — never an empty category. */
  const sources = useMemo(() => {
    const counts = new Map<string, { title: string; n: number }>();
    for (const c of candidates) {
      const prev = counts.get(c.projectId);
      counts.set(c.projectId, { title: c.projectTitle, n: (prev?.n ?? 0) + 1 });
    }
    return [...counts.entries()].sort((a, b) => a[1].title.localeCompare(b[1].title));
  }, [candidates]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = candidates.filter((c) => {
      if (sourceFilter && c.projectId !== sourceFilter) return false;
      if (!needle) return true;
      // Name AND project title: an author searching "physics" may be reaching for either.
      return `${c.sim.name} ${c.projectTitle}`.toLowerCase().includes(needle);
    });
    return rows.sort((a, b) => {
      if (sortBy === 'name') return a.sim.name.localeCompare(b.sim.name);
      if (sortBy === 'project') return a.projectTitle.localeCompare(b.projectTitle) || a.sim.name.localeCompare(b.sim.name);
      return (b.sim.created_at ?? '').localeCompare(a.sim.created_at ?? '');
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

    for (const id of ids) {
      try {
        imported.push(await api.importSimulation(projectId, id));
        stillSelected.delete(id);
        setProgress({ done: imported.length, total: ids.length });
      } catch (e) {
        // Stop at the first failure, but KEEP what already landed. Continuing would pile up
        // errors from what is usually one cause; discarding would re-import on retry.
        setError(failureMessage(e as Error, 'Could not import this simulation'));
        break;
      }
    }

    setSelected(stillSelected);
    setImporting(false);
    setProgress(null);
    if (imported.length > 0) onImported(imported);
    // Close only on a CLEAN sweep. If anything failed, the dialog stays open with the survivors
    // still selected and the error visible — closing would strand a retry the author can no
    // longer reach, and would report success for a partial result.
    if (stillSelected.size === 0) onClose();
  }, [importing, selected, projectId, onImported, onClose]);

  // Escape closes — but never mid-import, when closing would strand a partial result.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !importing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [importing, onClose]);

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Import simulations"
      className="avatar-gallery"
      onClick={() => !importing && onClose()}
    >
      <div className="avatar-gallery__panel" onClick={(e) => e.stopPropagation()}>
        <div className="avatar-gallery__header">
          <div>
            <h2 className="avatar-gallery__title">Import a simulation</h2>
            <p className="avatar-gallery__hint">
              From your other projects — the server copies it bucket-side, so nothing is uploaded
              or stored twice.
            </p>
          </div>
          <span className="avatar-gallery__count">
            {selected.size > 0 ? `${selected.size} selected` : `${visible.length} available`}
          </span>
          <button
            className="avatar-gallery__close" onClick={onClose} disabled={importing}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="avatar-gallery-filters">
          <div className="avatar-g-search">
            <Search size={15} className="avatar-g-search__icon" />
            <input
              className="avatar-g-search__input" type="search" placeholder="Search simulations…"
              value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            />
          </div>
          <div className="avatar-g-tabs">
            <button
              className={`avatar-g-tab${sourceFilter === '' ? ' avatar-g-tab--active' : ''}`}
              onClick={() => setSourceFilter('')}
            >
              {candidates.length > 0 && <span className="avatar-g-tab__count" style={{ background: '#6366f1' }}>{candidates.length}</span>}
              All projects
            </button>
            {sources.map(([id, { title, n }]) => (
              <button
                key={id}
                className={`avatar-g-tab${sourceFilter === id ? ' avatar-g-tab--active' : ''}`}
                onClick={() => setSourceFilter(id)}
                title={title}
              >
                <span className="avatar-g-tab__count" style={{ background: '#8a94a6' }}>{n}</span>
                {title}
              </button>
            ))}
          </div>
          <div className="avatar-g-sort">
            <ArrowDownUp size={13} style={{ color: '#888', flexShrink: 0 }} />
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} aria-label="Sort by">
              <option value="newest">Newest</option>
              <option value="name">Name</option>
              <option value="project">Project</option>
            </select>
          </div>
        </div>

        <div className="avatar-gallery__body">
          {loadFailed ? (
            <div className="avatar-g-empty" role="alert">{loadFailed}</div>
          ) : loading ? (
            <div className="avatar-g-empty"><span className="avatar-spinner" /></div>
          ) : candidates.length === 0 ? (
            <div className="avatar-g-empty">No ready simulations in your other projects yet.</div>
          ) : visible.length === 0 ? (
            <div className="avatar-g-empty">Nothing matches “{q}”.</div>
          ) : (
            <div className="avatar-g-grid">
              {visible.map((c) => (
                <ImportCard
                  key={c.sim.id}
                  candidate={c}
                  selected={selected.has(c.sim.id)}
                  disabled={importing}
                  onToggle={() => toggle(c.sim.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="import-sim__footer">
          {error && (
            <span role="alert" className="import-sim__error">
              <AlertTriangle size={13} /> {error}
            </span>
          )}
          {progress && (
            <span className="import-sim__progress">
              <CheckCircle2 size={13} /> Imported {progress.done} of {progress.total}…
            </span>
          )}
          <button className="avatar-g-create" onClick={onClose} disabled={importing}>Cancel</button>
          <button
            className="import-sim__go"
            onClick={runImport}
            disabled={importing || selected.size === 0}
          >
            {importing
              ? 'Importing…'
              : selected.size === 0 ? 'Select simulations'
                : `Import ${selected.size}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

function ImportCard({ candidate, selected, disabled, onToggle }: {
  candidate: Candidate; selected: boolean; disabled: boolean; onToggle: () => void;
}) {
  const { sim, projectTitle } = candidate;
  const [fs, setFs] = useState(false);
  const date = sim.created_at ? new Date(sim.created_at).toLocaleDateString() : '';

  return (
    <div className={`avatar-gc import-sim-card${selected ? ' import-sim-card--on' : ''}`}>
      <div className="avatar-gc__accent" style={{ background: selected ? '#6366f1' : '#e2e6ec' }} />
      <div style={{ position: 'relative' }}>
        <LazySimPreview src={sim.entry_file} />
        <button
          className="avatar-gc__fs" onClick={() => setFs(true)}
          title="Full screen preview" aria-label={`Preview ${sim.name} full screen`}
        >
          <Maximize2 size={13} />
        </button>
      </div>
      {/*
        The whole body is the toggle. A <label>-wrapped checkbox keeps the real control in the
        accessibility tree and keyboard-reachable, while the large target is what a grid of visual
        cards actually wants — clicking a card should select it, not hunt for a 14px box.
      */}
      <label className="avatar-gc__body import-sim-card__pick">
        <input
          type="checkbox" checked={selected} disabled={disabled} onChange={onToggle}
          className="import-sim-card__box"
        />
        <span className="import-sim-card__text">
          <span className="import-sim-card__name">{sim.name}</span>
          <span className="avatar-gc__meta">
            <span className="avatar-gc__badge" style={{ background: 'rgba(99,102,241,0.15)', color: '#6366f1' }}>
              {projectTitle}
            </span>
            {date && <span className="avatar-gc__date">{date}</span>}
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

/**
 * Lazy preview — mounts only when scrolled into view, unmounts when it leaves.
 *
 * With several projects' worth of cards this is a real performance property, not a nicety: every
 * mounted frame is a live document running its own animation loop.
 */
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

  // A remount is a fresh document, so it has to re-earn its reveal — otherwise the card flashes an
  // unpainted white frame at full opacity on the way back into view.
  useEffect(() => { if (!mounted) setLoaded(false); }, [mounted]);

  if (!src) return <div className="avatar-gc__preview avatar-gc__preview--sim"><span>▶ Interactive</span></div>;

  return (
    <div ref={ref} className="avatar-gc__preview">
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

/** The proper look: one simulation, the whole screen, and interactive — the point of previewing. */
function FullScreenPreview({ sim, projectTitle, onClose }: {
  sim: Simulation; projectTitle: string; onClose: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    // Capture phase: the gallery behind this also listens for Escape, and the top-most surface is
    // the one that should answer it.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      role="dialog" aria-modal="true" aria-label={`${sim.name} preview`}
      className="import-sim-fs" onClick={onClose}
    >
      <div className="import-sim-fs__bar" onClick={(e) => e.stopPropagation()}>
        <span className="import-sim-fs__name">{sim.name}</span>
        <span className="import-sim-fs__project">{projectTitle}</span>
        <button className="avatar-gallery__close" onClick={onClose} aria-label="Close preview">
          <X size={16} />
        </button>
      </div>
      <div className="import-sim-fs__stage" onClick={(e) => e.stopPropagation()}>
        {/*
          Interactive here, unlike the card: a full-screen preview exists so the author can try the
          simulation before importing it. Still no runtime — it drives nothing in this app.
        */}
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
