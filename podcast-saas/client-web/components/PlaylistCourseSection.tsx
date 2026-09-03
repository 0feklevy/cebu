'use client';

/**
 * The one course section in the playlist editor (owner ruling 2026-09-03: "Playlist → Publish as
 * course", deliberately narrow). State line, the public address once published, the readiness
 * reasons when it cannot publish, and three buttons: Publish as course / Update / Unpublish.
 */
import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import type { PlaylistCourseState } from 'shared/src/generated/client-v1';

interface Props {
  playlistId: string;
  /** The playlist's current item count, from the editor — a course needs at least one. */
  itemCount: number;
}

export function PlaylistCourseSection({ playlistId, itemCount }: Props) {
  const [state, setState] = useState<PlaylistCourseState | null>(null);
  const [busy, setBusy] = useState<'publish' | 'update' | 'unpublish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The address: prefilled with the course's slug once it exists; empty means "from the title".
  const [slug, setSlug] = useState('');
  const [slugCheck, setSlugCheck] = useState<{ available: boolean; normalized: string } | null>(null);

  const load = useCallback(() => {
    api.getPlaylistCourse(playlistId).then((s) => { setState(s); if (s.course) setSlug(s.course.slug); }).catch(() => setState(null));
  }, [playlistId]);
  useEffect(() => { load(); }, [load]);

  // Availability, a moment after typing stops; the current course's own slug is always available.
  useEffect(() => {
    const wanted = slug.trim();
    if (!wanted || wanted === state?.course?.slug) { setSlugCheck(null); return; }
    const t = window.setTimeout(() => {
      api.courseSlugAvailable(wanted, state?.course?.id).then(setSlugCheck).catch(() => setSlugCheck(null));
    }, 400);
    return () => window.clearTimeout(t);
  }, [slug, state?.course?.id, state?.course?.slug]);

  const run = useCallback(async (kind: 'publish' | 'update' | 'unpublish') => {
    setBusy(kind);
    setError(null);
    try {
      const next = kind === 'unpublish'
        ? await api.unpublishPlaylistCourse(playlistId)
        : await api.publishPlaylistCourse(playlistId, { publish: kind === 'publish' || state?.course?.publish_state === 'published', slug: slug.trim() || null });
      setState(next);
      if (next.course) setSlug(next.course.slug);
    } catch (e) {
      setError((e as Error).message || 'Could not update the course.');
    } finally {
      setBusy(null);
    }
  }, [playlistId, slug, state?.course?.publish_state]);

  const course = state?.course ?? null;
  const published = course?.publish_state === 'published';
  const publicUrl = course && typeof window !== 'undefined' ? `${window.location.origin}${course.public_path}` : null;
  const thin = state?.readiness && !state.readiness.ready ? state.readiness.thinLessons : [];

  return (
    <section className="border-b border-border px-4 py-4 space-y-2" aria-label="Course">
      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60">Course</p>
      <p className="text-xs text-muted-foreground">
        {!course
          ? 'Publish this playlist as a course: its videos become the lessons, in this order, at one public address.'
          : published
            ? `Published as a course with ${course.lesson_count} lesson${course.lesson_count === 1 ? '' : 's'}.`
            : `A course draft exists (${course.lesson_count} lesson${course.lesson_count === 1 ? '' : 's'}), not published.`}
      </p>
      {publicUrl && published && (
        <div className="flex items-center gap-2">
          <a href={publicUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-primary hover:underline">
            <ExternalLink size={12} aria-hidden />
            <span className="truncate">{publicUrl}</span>
          </a>
          <button
            type="button"
            onClick={() => { void navigator.clipboard?.writeText(publicUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
            aria-label="Copy course address"
            className="rounded-md border border-border p-1 text-muted-foreground hover:text-foreground focus-ring"
          >
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <label htmlFor={`course-slug-${playlistId}`} className="shrink-0 text-[11px] text-muted-foreground">/c/</label>
        <input
          id={`course-slug-${playlistId}`}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="from the title"
          aria-label="Course address"
          className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-card px-2 text-xs text-foreground outline-none focus:border-primary/45 focus:ring-2 focus:ring-ring/20"
        />
        {slugCheck && (
          <span role="status" className={`shrink-0 text-[11px] ${slugCheck.available ? 'text-emerald-600' : 'text-red-600'}`}>
            {slugCheck.available ? `available as ${slugCheck.normalized}` : slugCheck.normalized ? `${slugCheck.normalized} is taken` : 'not a valid address'}
          </span>
        )}
      </div>
      {thin.length > 0 && (
        <ul className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700" aria-label="Why it cannot publish yet">
          {thin.slice(0, 5).map((t) => <li key={t.lessonSlug}>{t.lessonSlug}: {t.reason}</li>)}
          {thin.length > 5 && <li>… and {thin.length - 5} more</li>}
        </ul>
      )}
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {!published ? (
          <button
            type="button"
            onClick={() => void run('publish')}
            disabled={busy !== null || itemCount === 0}
            title={itemCount === 0 ? 'Add a video first' : undefined}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:brightness-110 focus-ring disabled:opacity-40"
          >
            {busy === 'publish' ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <BookOpen size={12} aria-hidden />}
            Publish as course
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void run('update')}
              disabled={busy !== null}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-ring disabled:opacity-40"
            >
              {busy === 'update' ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}
              Update course
            </button>
            <button
              type="button"
              onClick={() => void run('unpublish')}
              disabled={busy !== null}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100 focus-ring disabled:opacity-40"
            >
              {busy === 'unpublish' ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}
              Unpublish
            </button>
          </>
        )}
      </div>
    </section>
  );
}
