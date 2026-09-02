'use client';

/**
 * The viewer's keys, on the `?` key — the one help surface the viewer never had (night run
 * 2026-09-03 §5). Space and the arrows have worked "like YouTube" for a long time and were listed
 * nowhere; a viewer who did not already know could not find out.
 */
import { useEffect, useState } from 'react';
import { VIEWER_SHORTCUTS } from '@/lib/tours/steps';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === '?') { e.preventDefault(); setOpen((v) => !v); return; }
      if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={() => setOpen(false)}
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/60"
    >
      <div onClick={(e) => e.stopPropagation()} className="min-w-[260px] rounded-xl bg-neutral-900 p-5 text-white shadow-2xl">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/70">Keyboard shortcuts</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {VIEWER_SHORTCUTS.map((s) => (
            <div key={s.keys} className="contents">
              <dt className="whitespace-nowrap rounded bg-white/10 px-2 py-0.5 text-center font-mono text-xs">{s.keys}</dt>
              <dd className="text-white/85">{s.does}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
