'use client';

import type { ButtonHTMLAttributes } from 'react';

/**
 * The standard tutorial "?" button. Matches the Extended (Avatar) Library help button — a 32×32
 * rounded-square with a soft-gray fill and a bold "?" glyph — so every walkthrough trigger across
 * the app looks identical (replaces the assorted HelpCircle / ad-hoc "?" variants).
 */
export function TourButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label="Show tutorial"
      title="How this works"
      {...props}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-0 bg-muted text-[15px] font-bold leading-none text-muted-foreground transition-colors hover:bg-muted/80 focus-ring ${className}`}
    >
      ?
    </button>
  );
}
