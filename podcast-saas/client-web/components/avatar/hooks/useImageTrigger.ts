'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeImage } from '../avatarApi';

// Ported from darwin-avatar/client/src/hooks/useImageTrigger.ts (projectId added).
export function useImageTrigger(characterId: string, projectId: string | undefined, isVisualShowing: () => boolean) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [altText, setAltText] = useState('');
  const [caption, setCaption] = useState('');
  const [imageType, setImageType] = useState<'realistic' | 'diagram'>('realistic');
  const [visible, setVisible] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTriggerAt = useRef(0);
  const genIdRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  const scheduleImageClear = useCallback(() => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => { setImageUrl(null); setAltText(''); setCaption(''); }, 400);
  }, []);

  const dismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
    scheduleImageClear();
  }, [scheduleImageClear]);

  const reset = useCallback(() => {
    genIdRef.current++;
    inFlightRef.current = false;
    lastTriggerAt.current = 0;
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
    scheduleImageClear();
  }, [scheduleImageClear]);

  const trigger = useCallback(async (userMessage: string, context?: string): Promise<void> => {
    if (!userMessage) return;
    if (inFlightRef.current) return;
    const now = Date.now();
    if (now - lastTriggerAt.current < 5_000) return;
    lastTriggerAt.current = now;

    inFlightRef.current = true;
    const genId = genIdRef.current;
    try {
      const result = await analyzeImage(userMessage, characterId, context, projectId);
      if (genId !== genIdRef.current) return;
      if (result.shouldGenerate && result.imageUrl) {
        if (isVisualShowing()) return;
        setImageUrl(result.imageUrl);
        setAltText(result.altText);
        setCaption(result.caption ?? '');
        setImageType(result.imageType ?? 'realistic');
        setVisible(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => { setVisible(false); scheduleImageClear(); }, 12_000);
      }
    } catch {
      /* silent */
    } finally {
      inFlightRef.current = false;
    }
  }, [characterId, projectId, scheduleImageClear, isVisualShowing]);

  const setDirectImage = useCallback((url: string, type: 'realistic' | 'diagram', cap: string) => {
    if (isVisualShowing()) return;
    setImageUrl(url);
    setAltText(cap.split('.')[0] ?? '');
    setCaption(cap);
    setImageType(type);
    setVisible(true);
    lastTriggerAt.current = Date.now();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { setVisible(false); scheduleImageClear(); }, 12_000);
  }, [isVisualShowing, scheduleImageClear]);

  return { imageUrl, altText, caption, imageType, visible, trigger, reset, dismiss, setDirectImage };
}
