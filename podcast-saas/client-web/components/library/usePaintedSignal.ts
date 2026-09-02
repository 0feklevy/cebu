'use client';

/**
 * True once the simulation in `frameRef` has posted SIM_PAINTED — the rAF gate's first real frame
 * — or, failing that, `fallbackMs` after the document loaded (night run 2026-09-03 §6).
 *
 * Listens on `window` and accepts only messages whose source is THIS frame's window: the library
 * page can hold exactly one live simulation, but the check is what makes that a fact rather than
 * an assumption.
 */
import { useEffect, useState, type MutableRefObject } from 'react';

export const SIM_PAINTED_TYPE = 'SIM_PAINTED';

export function usePaintedSignal(
  frameRef: MutableRefObject<HTMLIFrameElement | null>,
  loaded: boolean,
  fallbackMs = 2500,
): boolean {
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    if (painted) return;
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const type = (e.data as { type?: unknown } | null)?.type;
      if (type === SIM_PAINTED_TYPE) setPainted(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameRef, painted]);

  useEffect(() => {
    if (!loaded || painted) return;
    const t = window.setTimeout(() => setPainted(true), fallbackMs);
    return () => window.clearTimeout(t);
  }, [loaded, painted, fallbackMs]);

  return painted;
}
