'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PodcastStudioResponse } from 'shared';
import type { PodcastEpisode } from 'shared/src/generated/client-v1';
import type { PodcastTurn } from 'shared/src/types/podcast';
import { api } from '../../../lib/api';
import { AudioStudio } from './AudioStudio';

const SCRIPT_READY = new Set(['approved', 'rendering', 'ready', 'script_ready']);

/** Loads the studio payload + the latest script's turns, then hands off to the editor. */
export function PodcastStudioTab({ showId, episodeId, episode }: { showId: string; episodeId: string; episode: PodcastEpisode }) {
  const [studio, setStudio] = useState<PodcastStudioResponse | null>(null);
  const [turns, setTurns] = useState<PodcastTurn[]>([]);
  const [loading, setLoading] = useState(true);
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqRef.current;
    const [s, scriptRes] = await Promise.all([
      api.getPodcastStudio(showId, episodeId),
      api.getPodcastScript(showId, episodeId).catch(() => null),
    ]);
    if (id !== reqRef.current) return;
    setStudio(s);
    setTurns(scriptRes?.script?.body_json?.turns ?? []);
  }, [showId, episodeId]);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  if (loading) return <div className="h-64 rounded-xl bg-muted/40 animate-pulse" />;

  if (!SCRIPT_READY.has(episode.status)) {
    return (
      <div className="rounded-2xl border border-dashed border-border py-16 text-center">
        <p className="mb-1 text-sm font-semibold text-foreground">Approve the script first</p>
        <p className="text-sm text-muted-foreground">Head to the Script tab, review the lines, and approve — then you can build and edit the audio.</p>
      </div>
    );
  }

  if (!studio) return <div className="h-64 rounded-xl bg-muted/40 animate-pulse" />;

  return (
    <AudioStudio
      showId={showId}
      episodeId={episodeId}
      initial={studio}
      turns={turns}
      onReloadScript={() => { load().catch(() => {}); }}
    />
  );
}
