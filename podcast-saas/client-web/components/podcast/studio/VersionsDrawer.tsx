'use client';

import { createPortal } from 'react-dom';
import { Check, Download, History, RotateCcw, X } from 'lucide-react';
import { timeAgo } from '../PodcastChrome';
import type { PodcastMixSnapshotInfo } from 'shared';

const KIND_LABEL: Record<string, string> = { manual: 'Saved', export: 'Export', pre_rebuild: 'Before rebuild' };

export function VersionsDrawer({ snapshots, onClose, onRestore }: {
  snapshots: PodcastMixSnapshotInfo[];
  onClose: () => void;
  onRestore: (id: string) => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[840] flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex h-full w-full max-w-sm flex-col border-l border-border bg-card shadow-modal">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><History size={16} aria-hidden /> Versions</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-ring"><X size={17} aria-hidden /></button>
        </div>
        <div className="fine-scrollbar flex-1 overflow-y-auto p-3">
          {snapshots.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">No saved versions yet. Save one, or every export freezes a version here.</p>
          ) : (
            <div className="space-y-1.5">
              {snapshots.map((s) => (
                <div key={s.id} className="group flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{KIND_LABEL[s.kind] ?? s.kind}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{s.name}</span>
                    <span className="block text-[11px] text-muted-foreground">{timeAgo(s.created_at)}{s.script_version != null ? ` · script v${s.script_version}` : ''}</span>
                  </span>
                  {s.kind === 'export' && s.render_id && <Download size={13} className="text-muted-foreground" aria-hidden />}
                  <button onClick={() => onRestore(s.id)} title="Restore into the editor" className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary opacity-0 transition-opacity hover:bg-primary/10 group-hover:opacity-100 focus-ring">
                    <RotateCcw size={12} aria-hidden /> Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
