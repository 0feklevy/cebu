'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface TourStep {
  /** CSS selector for the element to highlight (e.g. '[data-tour="library"]'). */
  selector: string;
  title: string;
  content: string;
}

interface Props {
  steps: TourStep[];
  open: boolean;
  onClose: () => void;
}

/**
 * Lightweight, dependency-free product walkthrough (fiji-style coachmarks). Dims the page,
 * spotlights one target at a time via a box-shadow cut-out, and shows a themed tooltip with
 * Back / Next / Skip. Uses theme tokens (bg-card/foreground/border) so it works in dark mode.
 * Steps whose target isn't on the page are skipped automatically.
 */
export function GuidedTour({ steps, open, onClose }: Props) {
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[idx];

  useEffect(() => { if (open) setIdx(0); }, [open]);

  // Measure the current target (and keep it in sync on scroll/resize).
  useLayoutEffect(() => {
    if (!open || !step) return;
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(step.selector) as HTMLElement | null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    const el = document.querySelector(step.selector) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    measure();
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    const settle = setTimeout(measure, 320); // re-measure after the scrollIntoView settles
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [open, step, idx]);

  // Auto-skip a step whose target doesn't exist (e.g. a panel that's collapsed on this screen).
  useEffect(() => {
    if (!open || !step) return;
    if (document.querySelector(step.selector)) return;
    const t = setTimeout(() => {
      if (idx < steps.length - 1) setIdx((i) => i + 1);
      else onClose();
    }, 400);
    return () => clearTimeout(t);
  }, [open, step, idx, steps.length, onClose]);

  if (open && !step) { onClose(); return null; }
  if (!open || !step || typeof document === 'undefined') return null;

  const PAD = 8;
  const hole = rect && rect.width > 0
    ? { left: rect.left - PAD, top: rect.top - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD }
    : null;

  // Place the tooltip below the target, or above if there's more room up top; clamp to viewport.
  const vw = window.innerWidth, vh = window.innerHeight;
  const TW = Math.min(320, vw - 24);
  const below = hole ? hole.top + hole.height + 12 : vh / 2;
  const placeAbove = hole ? (hole.top + hole.height + 200 > vh && hole.top > 220) : false;
  const tipTop = hole
    ? (placeAbove ? Math.max(12, hole.top - 12) : below)
    : Math.max(24, vh / 2 - 80);
  const tipLeft = hole
    ? Math.min(Math.max(12, hole.left + hole.width / 2 - TW / 2), vw - TW - 12)
    : vw / 2 - TW / 2;

  const isLast = idx === steps.length - 1;

  return createPortal(
    <div className="fixed inset-0 z-[1000]" role="dialog" aria-modal="true" aria-label="Guided walkthrough">
      {/* Spotlight: the highlighted box casts a huge shadow that dims everything else. */}
      {hole ? (
        <div
          className="pointer-events-none absolute rounded-lg ring-2 ring-primary transition-all duration-200"
          style={{ left: hole.left, top: hole.top, width: hole.width, height: hole.height, boxShadow: '0 0 0 9999px rgba(0,0,0,0.62)' }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/60" />
      )}

      {/* Click-catcher to dismiss on backdrop click (outside the tooltip). */}
      <div className="absolute inset-0" onClick={onClose} />

      <div
        className="absolute w-[320px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl"
        style={{ top: tipTop, left: tipLeft, transform: placeAbove ? 'translateY(-100%)' : undefined }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-foreground">{step.title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{step.content}</p>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[10px] font-medium text-muted-foreground">{idx + 1} / {steps.length}</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Skip
            </button>
            {idx > 0 && (
              <button
                type="button"
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
                className="rounded-md px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted/60"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => (isLast ? onClose() : setIdx((i) => i + 1))}
              className="rounded-md bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90"
            >
              {isLast ? 'Got it!' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
