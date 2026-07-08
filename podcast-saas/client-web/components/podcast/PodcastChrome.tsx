'use client';

import { ArrowLeft, Mic } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Product accent for Podcast Studio. Matches the app's indigo `--primary` family so
 * the product blends into the rest of client-web. Kept as a concrete hex (not
 * `hsl(var(--primary))`) so the existing `${PODCAST_ACCENT}18`-style alpha
 * concatenations across the podcast components keep composing. Prefer the Tailwind
 * `primary` token classes (text-primary, bg-primary/10, border-primary/30) in new code.
 */
export const PODCAST_ACCENT = '#6366f1';

/**
 * Shared top bar + page frame for all Podcast Studio pages. Mirrors the app's
 * inner-page header idiom (see ProjectHeader): sticky shell-bg bar, a back-to-home
 * affordance, and a breadcrumb that climbs Show → Episode.
 */
export function PodcastChrome({
  crumbs,
  actions,
  children,
}: {
  crumbs: { label: string; href?: string }[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-40 flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 shell-bg shadow-sm sm:h-12 sm:flex-nowrap sm:px-4 sm:py-0">
        <a
          href="/"
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium shell-muted transition-colors hover:text-[hsl(var(--shell-foreground))] focus-ring"
          style={{ textDecoration: 'none' }}
          title="Back to workspace"
        >
          <ArrowLeft size={15} strokeWidth={2} aria-hidden />
          Home
        </a>
        <span className="shell-muted">/</span>
        <span className="flex items-center gap-1.5 text-sm font-semibold text-primary">
          <Mic size={15} strokeWidth={2} aria-hidden />
          Podcasts
        </span>
        {crumbs.map((c) => (
          <span key={c.label} className="flex min-w-0 items-center gap-2">
            <span className="shell-muted">/</span>
            {c.href ? (
              <a href={c.href} className="truncate rounded-md px-1 py-1 text-sm font-medium shell-muted transition-colors hover:text-[hsl(var(--shell-foreground))] focus-ring" style={{ textDecoration: 'none' }}>
                {c.label}
              </a>
            ) : (
              <span className="truncate text-sm font-semibold shell-text">{c.label}</span>
            )}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

/**
 * Primary/secondary button for the product. `solid` reuses the app's `gradient-action`
 * (violet→indigo) CTA treatment so it's identical to the rest of client-web; `outline`
 * is the app's standard primary-tinted ghost button.
 */
export function PodcastButton({
  children,
  onClick,
  disabled,
  type = 'button',
  variant = 'solid',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  variant?: 'solid' | 'outline';
  title?: string;
}) {
  const base =
    'inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-semibold transition-all focus-ring disabled:opacity-50 disabled:pointer-events-none active:translate-y-px';
  const cls =
    variant === 'solid'
      ? `${base} gradient-action shadow-sm hover:brightness-110`
      : `${base} border border-primary/40 bg-transparent text-primary hover:bg-primary/10`;
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={cls}>
      {children}
    </button>
  );
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
