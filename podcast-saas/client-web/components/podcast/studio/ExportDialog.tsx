'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Loader2, X } from 'lucide-react';
import { PodcastButton } from '../PodcastChrome';

const FORMATS: { key: 'mp4' | 'mp3' | 'wav'; label: string; note: string }[] = [
  { key: 'mp4', label: 'MP4', note: 'Single-channel video-container audio — best for uploads.' },
  { key: 'mp3', label: 'MP3', note: 'Compact, universal.' },
  { key: 'wav', label: 'WAV', note: 'Lossless master.' },
];

export function ExportDialog({ onClose, onExport }: { onClose: () => void; onExport: (fmt: 'mp4' | 'mp3' | 'wav') => Promise<void> }) {
  const [fmt, setFmt] = useState<'mp4' | 'mp3' | 'wav'>('mp4');
  const [busy, setBusy] = useState(false);
  return createPortal(
    <div className="fixed inset-0 z-[850] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div className="relative z-10 w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-modal">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">Export the mix</h2>
          <button onClick={() => !busy && onClose()} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-ring"><X size={17} aria-hidden /></button>
        </div>
        <div className="mb-4 space-y-2">
          {FORMATS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFmt(f.key)}
              className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-ring"
              style={fmt === f.key ? { borderColor: 'hsl(var(--primary))', background: 'hsl(var(--primary)/0.08)' } : { borderColor: 'hsl(var(--border))' }}
            >
              <span className="text-sm font-semibold text-foreground">{f.label}</span>
              <span className="flex-1 text-xs text-muted-foreground">{f.note}</span>
              <span className="h-3.5 w-3.5 rounded-full border" style={{ borderColor: fmt === f.key ? 'hsl(var(--primary))' : 'hsl(var(--border))', background: fmt === f.key ? 'hsl(var(--primary))' : 'transparent' }} />
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={() => !busy && onClose()} className="h-9 rounded-lg px-3.5 text-sm font-medium text-muted-foreground hover:bg-muted focus-ring">Cancel</button>
          <PodcastButton onClick={async () => { setBusy(true); try { await onExport(fmt); } finally { setBusy(false); } }} disabled={busy}>
            {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Download size={15} strokeWidth={2} aria-hidden />}
            Export {fmt.toUpperCase()}
          </PodcastButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
