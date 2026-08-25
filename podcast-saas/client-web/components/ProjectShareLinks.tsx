'use client';

/**
 * Every public address this project has, in one place.
 *
 * ── THE PROBLEM THIS SOLVES ───────────────────────────────────────────────────────────────────
 * A project can be reached at three different public URLs — the video at `/{slug}`, the podcast
 * at `/{slug}/audio`, the library mini-site at `/{slug}/library` — and until now they were
 * offered from three unrelated places, with the audio one offered from NOWHERE AT ALL. The owner's
 * words: "all the links are terribly confusing."
 *
 * So this is one surface listing them together. Not a new capability — a place to see what exists.
 *
 * ── WHY THE PODCAST ROW ALSO BUILDS ───────────────────────────────────────────────────────────
 * The audio edition is derived, not automatic, and the route that derives it had no caller: the
 * whole feature was reachable only by someone who knew the API existed. Putting the BUILD on the
 * same row as the LINK means the answer to "how do I export a podcast" is in the one place a
 * creator already looks for a link — instead of a separate screen they have to be told about.
 *
 * ── ONE STATUS SURFACE ────────────────────────────────────────────────────────────────────────
 * The build answers 202 and this polls `getAudioEdition` — the SAME endpoint the listener's page
 * reads. A creator watching a build and a listener opening the link can never see different
 * truths, which is the property the route was designed for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, Mic } from 'lucide-react';
import { api } from '@/lib/api';
import type { AudioEditionStatus, LibraryShareInfo } from 'shared/src/generated/client-v1';
import { failureMessage } from './failureSurface';

interface Props {
  projectId: string;
  /** The live permalink, e.g. https://flowvidco.com/my-lesson. Null when none is published. */
  permalinkUrl: string | null;
}

/** How often to re-ask while a build is running. Slow enough to be polite, fast enough to feel live. */
const POLL_MS = 4000;

function LinkRow({ label, url, hint, trailing }: {
  label: string; url: string | null; hint?: string; trailing?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* the URL is on screen and selectable — a failed copy is not a failed feature */ }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-foreground">{label}</div>
        {url ? (
          <div className="truncate text-[11px] text-muted-foreground" title={url}>{url}</div>
        ) : (
          <div className="text-[11px] text-muted-foreground">{hint}</div>
        )}
      </div>
      {trailing}
      {url && (
        <>
          <button
            onClick={copy}
            aria-label={`Copy ${label} link`}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-semibold hover:bg-muted focus-ring"
          >
            {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a
            href={url} target="_blank" rel="noreferrer"
            aria-label={`Open ${label}`}
            className="inline-flex h-7 items-center rounded-md border border-border px-2 hover:bg-muted focus-ring"
          >
            <ExternalLink size={11} aria-hidden />
          </a>
        </>
      )}
    </div>
  );
}

export function ProjectShareLinks({ projectId, permalinkUrl }: Props) {
  const [audio, setAudio] = useState<AudioEditionStatus | null>(null);
  const [library, setLibrary] = useState<LibraryShareInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAudio(await api.getAudioEdition(projectId));
    } catch {
      // A failed status read is not a failed page: the links above still work, and the podcast
      // row simply shows nothing rather than an error the creator cannot act on.
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Read ONCE, not polled: a library share is created by a person in another dialog, not derived
  // by a job, so there is no build to watch settle.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const info = await api.getLibraryShare(projectId);
        if (alive) setLibrary(info);
      } catch {
        // Same trade as the audio read: a failed status read hides one row, it does not
        // break the two that do not depend on it.
      }
    })();
    return () => { alive = false; };
  }, [projectId]);

  // Poll only WHILE a build is running, and stop the moment it settles — a timer that outlives
  // the work it watches is how a tab quietly keeps a server busy for an afternoon.
  useEffect(() => {
    const running = audio?.status === 'queued' || audio?.status === 'building';
    if (!running) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [audio?.status, refresh]);

  const build = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.buildAudioEdition(projectId);
      // Optimistic, so the row starts polling immediately rather than after the next tick.
      setAudio((prev) => ({ ...(prev ?? { error: null, audio_url: null, duration_ms: null, chapters: [] }), status: 'queued' }));
    } catch (e) {
      // A 409 here is a REFUSAL WITH A REASON — "no playable audio yet" — checked up front by the
      // server precisely so a creator is told, rather than watching a job fail two minutes later.
      setError(failureMessage(e as Error, 'Could not start the podcast build'));
    } finally {
      setBusy(false);
    }
  };

  if (!permalinkUrl) return null;

  const audioUrl = `${permalinkUrl.replace(/\/+$/, '')}/audio`;
  // NOT string-built. `cleanUrl` is the server's own `/{permalink}/library` form and is null
  // unless a LIVE share exists on a public project — so the 404 rule is enforced where the truth
  // lives rather than guessed here. `url` is the coded `{title}-{code}/library` fallback, which
  // works whenever a share exists at all.
  const libraryUrl = library?.cleanUrl ?? library?.url ?? null;
  const ready = audio?.status === 'ready';
  const running = audio?.status === 'queued' || audio?.status === 'building';

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60">
        Share this project
      </div>

      <LinkRow label="Video" url={permalinkUrl} />

      <LinkRow
        label="Podcast"
        // The link appears only when there is something behind it. Offering a URL that 404s is
        // worse than offering none: the creator shares it before opening it.
        url={ready ? audioUrl : null}
        hint={running
          ? 'Building — this takes a few minutes.'
          : audio?.status === 'failed'
            ? (audio.error ?? 'The last build failed.')
            : 'Listen-only version with chapters, lock-screen controls and questions.'}
        trailing={!ready && (
          <button
            onClick={build}
            disabled={busy || running}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-500/60 px-2 text-[11px] font-semibold text-amber-600 hover:bg-amber-500/10 disabled:opacity-50 focus-ring"
          >
            {running ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <Mic size={11} aria-hidden />}
            {running ? 'Building…' : audio?.status === 'failed' ? 'Try again' : 'Create podcast'}
          </button>
        )}
      />

      {libraryUrl && <LinkRow label="Library" url={libraryUrl} />}

      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
