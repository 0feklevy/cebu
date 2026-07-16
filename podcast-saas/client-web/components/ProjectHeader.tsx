'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ArrowLeft, Check, Copy, ExternalLink, Eye, Globe, Link2, Loader2, Lock, Share2, Unlink2, X } from 'lucide-react';
import { TourButton } from './TourButton';
import { api, createShareToken, revokeShareToken } from '../lib/api';
import { PermalinkEditor } from './PermalinkEditor';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
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

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

export function ProjectHeader({ projectId }: Props) {
  const { loading: authLoading } = useAuth();
  const [project,       setProject]       = useState<Project | null>(null);
  const [hasMainVideo,  setHasMainVideo]   = useState(false);
  const [shareToken,    setShareToken]     = useState<string | null>(null);
  const [shareLoading,  setShareLoading]   = useState(false);
  const [shareCopied,   setShareCopied]    = useState(false);
  const [shareOpen,     setShareOpen]      = useState(false);
  const [shareError,    setShareError]     = useState<string | null>(null);
  const [shareTab,      setShareTab]       = useState<'public' | 'private'>('public');
  const popRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Load project info and existing share token
  useEffect(() => {
    if (authLoading) return;
    api.getProject(projectId).then(setProject).catch(() => null);
    // Preview/Share are gated on whether an actual main clip exists in the timeline (not on
    // project.status, which stays 'draft' even after a clip is uploaded).
    api.listVideos(projectId).then(vs => setHasMainVideo(vs.some(v => !v.is_broll))).catch(() => {});

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
  // Only disable Preview/Share when the timeline has no main clip (fresh project). Once any main
  // video exists they're enabled — regardless of project.status, which lingers at 'draft'.
  const noVideos = !hasMainVideo;
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
        data-tour="preview"
        href={noVideos ? undefined : `/projects/${projectId}/view`}
        target="_blank"
        rel="noopener noreferrer"
        aria-disabled={noVideos}
        tabIndex={noVideos ? -1 : undefined}
        onClick={(e) => { if (noVideos) e.preventDefault(); }}
        title={noVideos ? 'Add a video first to preview' : undefined}
        className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium shell-muted transition-colors focus-ring sm:px-3 ${noVideos ? 'cursor-not-allowed opacity-50' : 'shell-hover hover:text-[hsl(var(--shell-foreground))]'}`}
        style={{ borderColor: 'hsl(var(--shell-border))' }}
      >
        <Eye size={13} strokeWidth={1.8} aria-hidden />
        <span className="hidden min-[390px]:inline">Preview</span>
      </a>

      <TourButton
        onClick={() => window.dispatchEvent(new Event('editor:start-tour'))}
        title="Editor walkthrough"
        aria-label="Editor walkthrough"
      />

      <ProjectSettingsPanel
        projectId={projectId}
        project={project}
        onProjectChange={p => setProject(p)}
      />

      <div className="relative shrink-0" ref={popRef}>
        <button
          onClick={handleShare}
          disabled={shareLoading || noVideos}
          title={noVideos ? 'Add a video first to share' : undefined}
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
            <div className="flex items-start justify-between gap-3 border-b border-border bg-card px-4 py-3">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Link2 size={14} strokeWidth={1.9} aria-hidden />
                  </span>
                  <p className="text-sm font-semibold text-foreground">Share this video</p>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Choose how you want to share.
                </p>
              </div>
              <button
                onClick={() => setShareOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring"
                title="Close"
              >
                <span className="sr-only">Close share sheet</span>
                <X size={15} strokeWidth={1.8} aria-hidden />
              </button>
            </div>

            <div className="space-y-3 px-4 py-4">
              {/* One link concept per tab: the public permalink OR the secret token link. */}
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Share options">
                <button
                  role="tab"
                  aria-selected={shareTab === 'public'}
                  onClick={() => setShareTab('public')}
                  className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition-colors focus-ring ${shareTab === 'public' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <Globe size={12} strokeWidth={1.9} aria-hidden />
                  Public page
                </button>
                <button
                  role="tab"
                  aria-selected={shareTab === 'private'}
                  onClick={() => setShareTab('private')}
                  className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition-colors focus-ring ${shareTab === 'private' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <Lock size={12} strokeWidth={1.9} aria-hidden />
                  Private link
                </button>
              </div>

              {shareTab === 'private' ? (
                <>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    A secret link — anyone who has it can watch, even while the video stays private. It&apos;s not listed anywhere.
                  </p>
                  <div className="rounded-xl border border-border bg-background p-1.5 shadow-sm-soft">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
                        <Check size={14} strokeWidth={2} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={shareUrl}>
                        {shareUrl}
                      </span>
                      <button
                        onClick={handleCopy}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring"
                        title={shareCopied ? 'Copied' : 'Copy link'}
                        aria-label={shareCopied ? 'Copied' : 'Copy share link'}
                      >
                        {shareCopied ? <Check size={15} strokeWidth={2.2} aria-hidden /> : <Copy size={15} strokeWidth={1.9} aria-hidden />}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                    <a
                      href={shareUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring"
                    >
                      <ExternalLink size={14} strokeWidth={1.8} aria-hidden />
                      Open viewer
                    </a>
                    <button
                      onClick={handleRevoke}
                      disabled={shareLoading}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100 disabled:opacity-40 focus-ring"
                    >
                      {shareLoading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Unlink2 size={14} strokeWidth={1.8} aria-hidden />}
                      Revoke link
                    </button>
                  </div>

                  <p className="text-[11px] leading-5 text-muted-foreground">
                    Revoking disables the private link immediately. You can create a new one later.
                  </p>
                </>
              ) : (
                <PermalinkEditor
                  contentType="project"
                  contentId={projectId}
                  hideTitle
                  visibility={project?.visibility ?? 'private'}
                  onMakePublic={async () => {
                    await api.setProjectVisibility(projectId, 'public');
                    setProject(prev => (prev ? { ...prev, visibility: 'public' } : prev));
                  }}
                />
              )}
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
