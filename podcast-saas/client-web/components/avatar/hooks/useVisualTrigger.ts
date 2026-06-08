'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { analyzeVisual, type VisualResult } from '../avatarApi';

export type VisualTriggerResult =
  | { handled: true; reason: 'shown' | 'intent_locked_no_match' | 'generation_started' }
  | { handled: false; reason: 'fallback_image_allowed' };

function quickDetectRequestedType(msg: string): string | null {
  if (/\b(simulation|simulate)\b/i.test(msg)) return 'simulation';
  if (/\b(chart|graph|plot)\b/i.test(msg)) return 'chart';
  if (/\b(equation|formula|the\s+math)\b/i.test(msg)) return 'equation';
  if (/\b(diagram|flowchart)\b/i.test(msg)) return 'diagram';
  return null;
}

const DISMISS_DELAY_SIMULATION = 30_000;
const DISMISS_DELAY_DEFAULT = 14_000;
const SHOWN_THROTTLE_MS = 8_000;

// Ported from darwin-avatar/client/src/hooks/useVisualTrigger.ts (projectId added).
export function useVisualTrigger(
  characterId: string,
  projectId: string | undefined,
  onImageReady?: (url: string, type: 'realistic' | 'diagram', caption: string) => void,
) {
  const [visual, setVisual] = useState<VisualResult | null>(null);
  const [visible, setVisible] = useState(false);

  const genIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastShownAt = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  const clearAutoDismiss = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const scheduleClear = useCallback(() => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => setVisual(null), 400);
  }, []);

  const dismiss = useCallback(() => {
    clearAutoDismiss();
    setVisible(false);
    scheduleClear();
  }, [clearAutoDismiss, scheduleClear]);

  const reset = useCallback(() => {
    genIdRef.current++;
    inFlightRef.current = false;
    lastShownAt.current = 0;
    clearAutoDismiss();
    setVisible(false);
    scheduleClear();
  }, [clearAutoDismiss, scheduleClear]);

  const scheduleAutoDismiss = useCallback((v: VisualResult) => {
    clearAutoDismiss();
    const delay = v.type === 'simulation' ? DISMISS_DELAY_SIMULATION : DISMISS_DELAY_DEFAULT;
    timerRef.current = setTimeout(dismiss, delay);
  }, [clearAutoDismiss, dismiss]);

  const trigger = useCallback(async (message: string, context?: string): Promise<VisualTriggerResult> => {
    const localRequestedType = quickDetectRequestedType(message);

    const now = Date.now();
    if (now - lastShownAt.current < SHOWN_THROTTLE_MS) return { handled: true, reason: 'shown' };
    if (inFlightRef.current) return { handled: true, reason: 'shown' };

    inFlightRef.current = true;
    const genId = genIdRef.current;
    if (clearTimerRef.current) { clearTimeout(clearTimerRef.current); clearTimerRef.current = null; }

    let result: VisualResult;
    try {
      result = await analyzeVisual(message, characterId, context, projectId) as VisualResult;
    } catch {
      inFlightRef.current = false;
      if (localRequestedType && localRequestedType !== 'image') return { handled: true, reason: 'intent_locked_no_match' };
      return { handled: false, reason: 'fallback_image_allowed' };
    } finally {
      inFlightRef.current = false;
    }

    const staleGens = genIdRef.current - genId;
    const maxStale = result.type === 'simulation' ? 2 : 1;
    if (staleGens > maxStale) return { handled: true, reason: 'shown' };

    const requestedType = (result as { _intentRequestedType?: string | null })._intentRequestedType ?? localRequestedType ?? null;
    const explicitNonImage = requestedType && requestedType !== 'image';

    if (result.type === 'none' || result.type === 'image') {
      if (explicitNonImage) return { handled: true, reason: 'intent_locked_no_match' };
      return { handled: false, reason: 'fallback_image_allowed' };
    }

    if (explicitNonImage && result.type !== requestedType) return { handled: true, reason: 'intent_locked_no_match' };

    if (result.type === 'image_ready') {
      const r = result as { imageUrl: string; imageType: 'realistic' | 'diagram'; caption: string };
      lastShownAt.current = Date.now();
      onImageReady?.(r.imageUrl, r.imageType ?? 'realistic', r.caption ?? '');
      return { handled: true, reason: 'shown' };
    }

    lastShownAt.current = Date.now();
    setVisual(result);
    setVisible(true);
    scheduleAutoDismiss(result);
    return { handled: true, reason: 'shown' };
  }, [characterId, projectId, scheduleAutoDismiss, onImageReady]);

  return { visual, visible, trigger, reset, dismiss };
}
