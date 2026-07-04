'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Globe, Loader2, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { PermalinkInfo } from 'shared/src/generated/client-v1';

/**
 * WordPress-style permalink editor (migration 043). The creator picks the URL
 * path of the PUBLIC link — {PUBLIC_SITE_URL}/{slug} — while the random
 * /v/:token and /pl/:token links stay as the private share links.
 *
 * Projects: the permalink goes live only while visibility === 'public'
 * (pass `visibility` + `onMakePublic`). Playlists: having a slug IS what
 * makes the playlist public.
 */
interface Props {
  contentType: 'project' | 'playlist';
  contentId: string;
  visibility?: 'private' | 'unlisted' | 'public';
  onMakePublic?: () => Promise<void>;
}

type CheckState = { state: 'idle' | 'checking' | 'ok' | 'bad'; message?: string };

export function PermalinkEditor({ contentType, contentId, visibility, onMakePublic }: Props) {
  const [info, setInfo]     = useState<PermalinkInfo | null>(null);
  const [input, setInput]   = useState('');
  const [check, setCheck]   = useState<CheckState>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [makingPublic, setMakingPublic] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = contentType === 'project'
      ? api.getProjectPermalink(contentId)
      : api.getPlaylistPermalink(contentId);
    load.then((i) => {
      if (cancelled) return;
      setInfo(i);
      setInput(i.slug ?? i.suggestedSlug ?? '');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [contentType, contentId]);

  // Debounced availability check while typing (skipped when unchanged from the saved slug).
  useEffect(() => {
    if (!info) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const value = input.trim();
    if (!value || value === info.slug) { setCheck({ state: 'idle' }); return; }
    setCheck({ state: 'checking' });
    debounceRef.current = setTimeout(() => {
      api.checkPermalinkAvailability(value, { type: contentType, id: contentId })
        .then((r) => setCheck(r.available
          ? { state: 'ok', message: r.slug && r.slug !== value ? `Will be saved as “${r.slug}”` : 'Available' }
          : { state: 'bad', message: r.message ?? 'Not available' }))
        .catch(() => setCheck({ state: 'idle' }));
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [input, info, contentType, contentId]);

  if (!info) return null;

  const savedSlug   = info.slug ?? null;
  const dirty       = input.trim() !== (savedSlug ?? '');
  const displayBase = info.baseUrl.replace(/^https?:\/\//, '');
  const isProject   = contentType === 'project';
  const needsPublic = isProject && visibility !== 'public';

  const applyResult = (res: PermalinkInfo) => {
    setInfo((prev) => (prev ? { ...prev, ...res, suggestedSlug: prev.suggestedSlug } : res));
    setInput(res.slug ?? '');
    setCheck({ state: 'idle' });
  };

  const save = async (slug: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const res = isProject
        ? await api.setProjectPermalink(contentId, slug)
        : await api.setPlaylistPermalink(contentId, slug);
      applyResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!info.permalinkUrl) return;
    try {
      await navigator.clipboard.writeText(info.permalinkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const handleMakePublic = async () => {
    if (!onMakePublic) return;
    setMakingPublic(true);
    try { await onMakePublic(); } catch { /* parent surfaces errors */ }
    finally { setMakingPublic(false); }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Globe size={12} strokeWidth={1.9} className="text-muted-foreground/70" aria-hidden />
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60">Permalink</p>
        {savedSlug && !needsPublic && (
          <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600">Live</span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {isProject
          ? 'Your public URL — pick a memorable address for this video.'
          : 'Your public URL — setting one makes this playlist viewable by anyone at that address.'}
      </p>

      <div className="flex items-center rounded-xl border border-border bg-background px-2.5 py-2 shadow-sm-soft">
        <span className="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground" title={`${info.baseUrl}/`}>
          {displayBase}/
        </span>
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && dirty && check.state !== 'bad' && !saving) save(input.trim() || null); }}
          placeholder="my-video"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Permalink URL slug"
          className="min-w-0 flex-1 bg-transparent text-xs font-medium text-foreground outline-none placeholder:text-muted-foreground/50"
        />
      </div>

      {check.state === 'checking' && <p className="text-[11px] text-muted-foreground">Checking availability…</p>}
      {check.state === 'ok'  && <p className="text-[11px] text-emerald-600">{check.message}</p>}
      {check.state === 'bad' && <p className="text-[11px] text-red-500">{check.message}</p>}
      {error && <p className="text-[11px] text-red-500">{error}</p>}

      <div className="flex gap-2">
        {dirty ? (
          <>
            <button
              onClick={() => save(input.trim() || null)}
              disabled={saving || check.state === 'bad' || check.state === 'checking' || (!input.trim() && !savedSlug)}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-50 focus-ring"
              style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
            >
              {saving ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Check size={12} strokeWidth={2.1} aria-hidden />}
              {input.trim() ? 'Save permalink' : 'Remove permalink'}
            </button>
            <button
              onClick={() => { setInput(savedSlug ?? ''); setError(null); setCheck({ state: 'idle' }); }}
              disabled={saving}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-40 focus-ring"
            >
              Cancel
            </button>
          </>
        ) : savedSlug && info.permalinkUrl ? (
          <>
            <button
              onClick={handleCopy}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring"
            >
              {copied ? <Check size={12} strokeWidth={2.2} aria-hidden /> : <Copy size={12} strokeWidth={1.9} aria-hidden />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <a
              href={info.permalinkUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring"
            >
              <ExternalLink size={12} strokeWidth={1.9} aria-hidden />
              Open
            </a>
            <button
              onClick={() => save(null)}
              disabled={saving}
              title="Remove permalink"
              aria-label="Remove permalink"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 bg-red-50 text-red-600 transition-colors hover:bg-red-100 disabled:opacity-40 focus-ring"
            >
              {saving ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Trash2 size={12} strokeWidth={1.8} aria-hidden />}
            </button>
          </>
        ) : null}
      </div>

      {needsPublic && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-amber-700">
            {savedSlug
              ? 'This video isn’t public yet — the permalink goes live once visibility is Public.'
              : 'This video isn’t public yet — permalinks only work for Public videos.'}
          </p>
          {onMakePublic && (
            <button
              onClick={handleMakePublic}
              disabled={makingPublic}
              className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg bg-amber-600 px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50 focus-ring"
            >
              {makingPublic && <Loader2 size={11} className="animate-spin" aria-hidden />}
              Make public
            </button>
          )}
        </div>
      )}
    </div>
  );
}
