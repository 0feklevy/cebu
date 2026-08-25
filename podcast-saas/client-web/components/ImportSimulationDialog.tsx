'use client';

/**
 * Import a simulation from another of the user's projects — the `+` without the re-upload.
 *
 * Two-step picker: project → simulation. The list is `api.listProjects()` — the projects this
 * account can already open — because that is exactly the set the server-side eligibility will
 * approve; a broader list here would only manufacture 404s. The server copies bucket-side, so
 * the "upload" completes in the time of a request, not of a transfer.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Project, Simulation } from 'shared/src/generated/client-v1';
import { failureMessage } from './failureSurface';

interface Props {
  /** The project being edited — imports land here, and it is excluded from the source list. */
  projectId: string;
  onImported: (sim: Simulation) => void;
  onClose: () => void;
}

export function ImportSimulationDialog({ projectId, onImported, onClose }: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sims, setSims] = useState<Simulation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // the sim id being imported
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listProjects()
      .then((list) => { if (!cancelled) setProjects(list.filter((p) => p.id !== projectId)); })
      .catch((e: Error) => { if (!cancelled) setLoadFailed(failureMessage(e, 'Could not load your projects')); });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    if (!sourceId) { setSims(null); return; }
    let cancelled = false;
    setSims(null);
    api.listSimulations(sourceId)
      .then((list) => { if (!cancelled) setSims(list.filter((s) => s.status === 'ready')); })
      .catch((e: Error) => { if (!cancelled) setError(failureMessage(e, 'Could not load that project\'s simulations')); });
    return () => { cancelled = true; };
  }, [sourceId]);

  const importSim = async (sim: Simulation) => {
    if (busy) return;
    setBusy(sim.id);
    setError(null);
    try {
      const imported = await api.importSimulation(projectId, sim.id);
      onImported(imported);
    } catch (e) {
      setError(failureMessage(e as Error, 'Could not import this simulation'));
      setBusy(null);
    }
  };

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Import simulation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => !busy && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[440px] max-h-[70vh] flex flex-col rounded-xl border border-border bg-card p-4 shadow-xl"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Import a simulation</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          From another of your projects — nothing is uploaded or stored twice.
        </p>

        {!sourceId ? (
          <div className="flex-1 overflow-y-auto">
            {loadFailed ? (
              <p role="alert" className="text-xs text-destructive">{loadFailed}</p>
            ) : projects === null ? (
              <p className="text-xs text-muted-foreground">Loading projects…</p>
            ) : projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">No other projects to import from.</p>
            ) : projects.map((p) => (
              <button
                key={p.id}
                onClick={() => { setSourceId(p.id); setError(null); }}
                className="mb-1 block w-full rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-muted"
              >
                {p.title || 'Untitled project'}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <button onClick={() => { setSourceId(null); setError(null); }} className="mb-2 text-xs text-muted-foreground hover:text-foreground">
              ← All projects
            </button>
            {sims === null ? (
              <p className="text-xs text-muted-foreground">Loading simulations…</p>
            ) : sims.length === 0 ? (
              <p className="text-xs text-muted-foreground">No ready simulations in that project.</p>
            ) : sims.map((s) => (
              <div key={s.id} className="mb-1 flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <span className="text-sm">{s.name}</span>
                <button
                  onClick={() => importSim(s)}
                  disabled={!!busy}
                  className="rounded-md bg-amber-500 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-400 disabled:opacity-50"
                >
                  {busy === s.id ? 'Importing…' : 'Import'}
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
