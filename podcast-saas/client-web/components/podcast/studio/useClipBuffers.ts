'use client';

import { useEffect, useRef, useState } from 'react';
import type { PodcastStudioClip } from 'shared';
import type { LoadedClip } from './mixEngine';

/**
 * Fetch + decode every clip's WAV into an AudioBuffer, bounded concurrency, with a
 * shared AudioContext for decoding. The timeline stays fully interactive from the
 * (server-precomputed) peaks while audio decodes in the background — playback just
 * skips clips whose buffer isn't ready yet.
 */
export function useClipBuffers(clips: PodcastStudioClip[]): {
  buffers: Map<string, LoadedClip>;
  readyCount: number;
  total: number;
} {
  const [buffers, setBuffers] = useState<Map<string, LoadedClip>>(new Map());
  const [readyCount, setReadyCount] = useState(0);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!ctxRef.current) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctx();
    }
    const ctx = ctxRef.current;
    const have = buffers; // decode only clips we don't already have
    const todo = clips.filter((c) => !have.has(c.id));
    if (todo.length === 0) return;

    let active = 0;
    let i = 0;
    const next = () => {
      if (cancelled) return;
      while (active < 6 && i < todo.length) {
        const clip = todo[i++];
        active++;
        fetch(clip.url)
          .then((r) => r.arrayBuffer())
          .then((buf) => new Promise<AudioBuffer>((res, rej) => ctx.decodeAudioData(buf, res, rej)))
          .then((audio) => {
            if (cancelled) return;
            setBuffers((prev) => {
              const m = new Map(prev);
              m.set(clip.id, { id: clip.id, buffer: audio, durationMs: clip.duration_ms });
              return m;
            });
            setReadyCount((n) => n + 1);
          })
          .catch(() => { /* leave un-decoded; peaks still render */ })
          .finally(() => { active--; next(); });
      }
    };
    next();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  useEffect(() => () => { void ctxRef.current?.close(); ctxRef.current = null; }, []);

  return { buffers, readyCount, total: clips.length };
}
