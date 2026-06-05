'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ArrowLeft, Check, Copy, ExternalLink, Eye, Link2, Loader2, Share2, Unlink2, X } from 'lucide-react';
import { api, createShareToken, revokeShareToken } from '../lib/api';
import { ProjectLockButton } from './ProjectLockButton';
import { useAuth } from '../lib/firebase';
import type { Project } from 'shared/src/generated/client-v1';

const STATUS_STYLES: Record<string, string> = {
  draft:      'bg-muted text-muted-foreground',
  has_videos: 'bg-blue-500/10 text-blue-600',
  ready:      'bg-emerald-500/10 text-emerald-600',
  failed:     'bg-destructive/10 text-destructive',
};

const STATUS_LABELS: Record<string, string> = {
  draft:      'Draft',
  has_videos: 'Has videos',
  ready:      'Ready',
  failed:     'Failed',
};

interface Props {
  projectId: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

export function ProjectHeader({ projectId }: Props) {
  const { loading: authLoading } = useAuth();
  const [project,       setProject]       = useState<Project | null>(null);
  const [shareToken,    setShareToken]     = useState<string | null>(null);
  const [shareLoading,  setShareLoading]   = useState(false);
  const [shareCopied,   setShareCopied]    = useState(false);
  const [shareOpen,     setShareOpen]      = useState(false);
  const [shareError,    setShareError]     = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Load project info and existing share token
  useEffect(() => {
    if (authLoading) return;
    api.getProject(projectId).then(setProject).catch(() => null);

    // Check for an existing share token
    import('../lib/firebase').then(({ auth: fa }) => {
      fa.currentUser?.getIdToken().then(token => {
        fetch(`${API_URL}/api/v1/projects/${projectId}/share`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }).then(async r => {
          if (r.ok) {
            const d = await r.json() as { shareToken?: string | null };
            if (d.shareToken) setShareToken(d.shareToken);
          }
        }).catch(() => {});
      });
    });
  }, [projectId, authLoading]);

  // Close popover on outside click
  useEffect(() => {
    if (!shareOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popRef.current &&
        !popRef.current.contains(target) &&
        sheetRef.current &&
        !sheetRef.current.contains(target)
      ) {
        setShareOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [shareOpen]);

  useEffect(() => {
    if (!shareOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShareOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [shareOpen]);

  const statusStyle = project ? (STATUS_STYLES[project.status] ?? 'bg-muted text-muted-foreground') : '';
  const statusLabel = project ? (STATUS_LABELS[project.status] ?? project.status) : '';
  const rawTitle    = project?.title ?? project?.topic ?? '';
  const title       = rawTitle.length > 60 ? rawTitle.slice(0, 60) + '…' : rawTitle;
  const shareUrl    = shareToken && typeof window !== 'undefined' ? `${window.location.origin}/v/${shareToken}` : null;
  const canPortal   = typeof document !== 'undefined';

  const handleShare = async () => {
    setShareError(null);
    if (!shareToken) {
      setShareLoading(true);
      try {
        const { shareToken: tok } = await createShareToken(projectId);
        setShareToken(tok);
        setShareOpen(true);
      } catch (e) {
        setShareError((e as Error).message);
      } finally {
        setShareLoading(false);
      }
    } else {
      setShareOpen(v => !v);
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const handleRevoke = async () => {
    setShareLoading(true);
    try {
      await revokeShareToken(projectId);
      setShareToken(null);
      setShareOpen(false);
    } catch (e) {
      setShareError((e as Error).message);
    } finally {
      setShareLoading(false);
    }
  };

  return (
    <header className="relative z-[90] shrink-0 min-h-12 border-b shell-bg flex flex-wrap items-center px-3 py-2 gap-2 shadow-dropdown sm:h-12 sm:flex-nowrap sm:px-4 sm:py-0">
      <Link
        href="/"
        className="flex items-center gap-1.5 rounded-md text-sm shell-muted transition-colors shrink-0 focus-ring hover:text-[hsl(var(--shell-foreground))]"
      >
        <ArrowLeft size={15} strokeWidth={1.8} aria-hidden />
        Home
      </Link>

      <div className="hidden w-px h-4 shrink-0 sm:block" style={{ backgroundColor: 'hsl(var(--shell-border))' }} />

      <div className="order-3 flex w-full items-center gap-2 min-w-0 sm:order-none sm:w-auto sm:flex-1">
        {title && <span className="text-sm font-medium shell-text truncate">{title}</span>}
        {statusLabel && (
          <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusStyle}`}>
            {statusLabel}
          </span>
        )}
      </div>

      <a
        href={`/projects/${projectId}/view`}
        target="_blank"
        rel="noopener noreferrer"
        className="hidden h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium shell-muted transition-colors shell-hover hover:text-[hsl(var(--shell-foreground))] focus-ring sm:inline-flex"
        style={{ borderColor: 'hsl(var(--shell-border))' }}
      >
        <Eye size={13} strokeWidth={1.8} aria-hidden />
        Preview
      </a>

      <ProjectLockButton projectId={projectId} />

      <div className="relative shrink-0" ref={popRef}>
        <button
          onClick={handleShare}
          disabled={shareLoading}
          className={shareToken
            ? 'flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white shadow-sm transition-all disabled:opacity-60 focus-ring'
            : 'flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold shell-muted transition-colors shell-hover disabled:opacity-60 focus-ring hover:text-[hsl(var(--shell-foreground))]'
          }
          style={shareToken ? { background: 'linear-gradient(135deg,#a855f7,#6366f1)', color: '#fff' } : { borderColor: 'hsl(var(--shell-border))' }}
        >
          {shareLoading ? (
            <Loader2 size={13} className="animate-spin" aria-hidden />
          ) : (
            <Share2 size={13} strokeWidth={1.8} aria-hidden />
          )}
          {shareToken ? 'Share' : 'Create link'}
        </button>

        {shareOpen && shareToken && shareUrl && canPortal && createPortal(
          <div
            ref={sheetRef}
            className="floating-panel fixed right-3 top-[58px] z-[10000] w-[min(400px,calc(100vw-24px))] overflow-hidden rounded-xl sm:right-4"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border bg-muted px-4 py-3">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
                    <Link2 size={14} strokeWidth={1.9} aria-hidden />
                  </span>
                  <p className="text-sm font-semibold text-foreground">Public watch link</p>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Anyone with the link can watch the current final video.
                </p>
              </div>
              <button
                onClick={() => setShareOpen(false)}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring"
                title="Close"
              >
                <span className="sr-only">Close share sheet</span>
                <X size={15} strokeWidth={1.8} aria-hidden />
              </button>
            </div>

            <div className="space-y-3 px-4 py-4">
              <div className="rounded-lg border border-border bg-background p-2 shadow-sm-soft">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-500/14 text-emerald-500">
                    <Check size={14} strokeWidth={2} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                    {shareUrl}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleCopy}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold text-white shadow-sm transition-all hover:opacity-90 active:scale-[0.98] focus-ring"
                  style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
                >
                  {shareCopied ? <Check size={14} strokeWidth={2} aria-hidden /> : <Copy size={14} strokeWidth={1.8} aria-hidden />}
                  {shareCopied ? 'Copied' : 'Copy link'}
                </button>

                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring"
                >
                  <ExternalLink size={14} strokeWidth={1.8} aria-hidden />
                  Open viewer
                </a>
              </div>

              <div className="flex items-center justify-between border-t border-border pt-3">
                <button
                  onClick={handleRevoke}
                  disabled={shareLoading}
                  className="flex items-center gap-1.5 rounded-md text-[11px] font-medium text-red-500 transition-colors hover:text-red-600 disabled:opacity-40 focus-ring"
                >
                  <Unlink2 size={13} strokeWidth={1.8} aria-hidden />
                  Revoke link
                </button>
                <span className="text-[10px] text-muted-foreground">Revokes immediately</span>
              </div>
            </div>

            {shareError && (
              <p className="border-t border-border px-4 py-2 text-[11px] text-red-500">{shareError}</p>
            )}
          </div>,
          document.body,
        )}
      </div>

    </header>
  );
}
