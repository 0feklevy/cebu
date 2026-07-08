'use client';

import { useEffect, useState } from 'react';
import { Loader2, Mic, Volume2, VolumeX, X } from 'lucide-react';
import type { PodcastTurn } from 'shared/src/types/podcast';

/**
 * Inline inspector for the selected audio block. This used to be a floating portal
 * popover; keeping it in the document flow makes the transcript/editing area stable
 * below the timeline, where it has enough room to read and edit comfortably.
 */
export function ClipPopover({
  turn, gainDb, muted, revoicing,
  onClose, onRevoice, onGain, onToggleMute,
}: {
  turn: PodcastTurn;
  gainDb: number;
  muted: boolean;
  revoicing: boolean;
  onClose: () => void;
  onRevoice: (text: string) => void;
  onGain: (db: number) => void;
  onToggleMute: () => void;
}) {
  const [text, setText] = useState(turn.text);
  useEffect(() => { setText(turn.text); }, [turn.text, turn.id]);

  const dirty = text.trim() !== turn.text.trim();
  const speakerColor = turn.speaker === 'teacher' ? '#8b5cf6' : '#2563eb';

  return (
    <div data-podcast-shortcuts-ignore className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: speakerColor }} />
            {turn.speaker === 'teacher' ? 'Teacher line' : 'Learner line'}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">Edit the selected audio block, then re-voice only this line.</p>
        </div>
        <button
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring"
          title="Close line panel"
        >
          <X size={15} aria-hidden />
        </button>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-muted-foreground">Transcript text</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.max(4, Math.min(9, Math.ceil(text.length / 86)))}
            className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary focus-ring"
          />
        </label>

        <div className="flex flex-col justify-between gap-4 rounded-lg border border-border bg-muted/25 p-3">
          <div>
            <span className="mb-2 block text-xs font-semibold text-muted-foreground">Audio controls</span>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onRevoice(text)}
                disabled={revoicing || !text.trim()}
                className="gradient-action inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50 focus-ring"
              >
                {revoicing ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Mic size={13} strokeWidth={2} aria-hidden />}
                {dirty ? 'Save & re-voice' : 'Re-voice'}
              </button>
              <button onClick={onToggleMute} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted focus-ring">
                {muted ? <VolumeX size={13} aria-hidden /> : <Volume2 size={13} aria-hidden />}
                {muted ? 'Muted' : 'Mute'}
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
            <span className="w-9">Gain</span>
            <input type="range" min={-18} max={9} step={1} value={gainDb} onChange={(e) => onGain(Number(e.target.value))} className="flex-1" style={{ accentColor: 'hsl(var(--primary))' }} />
            <span className="w-8 tabular-nums text-right">{gainDb > 0 ? '+' : ''}{gainDb}dB</span>
          </label>
        </div>
      </div>
    </div>
  );
}
