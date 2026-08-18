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
  /**
   * A FRESH IMAGE IS SECONDS, AND THE VIEWER USED TO BE SHOWN NOTHING FOR ALL OF THEM.
   *
   * On a library miss `/image/analyze` runs a gpt-4.1-mini classify, then a gpt-image-1 render,
   * then a storage upload — strictly sequential, all before the response is written. No client
   * change makes that instant. What the client controls is whether those seconds look like a
   * product that is working or one that is broken, and until now they looked like the second:
   * the conversation carried on and the screen stayed empty until the image simply appeared, or
   * simply did not.
   *
   * VisualPanel has rendered a shimmering "Generating image…" state for `image_loading` since it
   * was ported (VisualPanel.tsx, .avatar-image-shimmer in avatar.css) and NOTHING EVER SET IT —
   * the only two references to `image_loading` in the whole client were the type declaration and
   * that renderer. This is the state that reaches it.
   */
  const [pending, setPending] = useState(false);
  const [pendingCaption, setPendingCaption] = useState('');

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

  const clearPending = useCallback(() => { setPending(false); setPendingCaption(''); }, []);

  const dismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    clearPending();
    setVisible(false);
    scheduleImageClear();
  }, [scheduleImageClear, clearPending]);

  const reset = useCallback(() => {
    genIdRef.current++;
    inFlightRef.current = false;
    lastTriggerAt.current = 0;
    if (timerRef.current) clearTimeout(timerRef.current);
    clearPending();
    setVisible(false);
    scheduleImageClear();
  }, [scheduleImageClear, clearPending]);

  const trigger = useCallback(async (userMessage: string, context?: string, hintCaption?: string): Promise<void> => {
    if (!userMessage) return;
    if (inFlightRef.current) return;
    const now = Date.now();
    if (now - lastTriggerAt.current < 5_000) return;
    lastTriggerAt.current = now;

    inFlightRef.current = true;
    const genId = genIdRef.current;
    // Announced BEFORE the await, because the whole point is the interval the await covers.
    // Not announced when a visual is already on screen: the panel is one slot, and a placeholder
    // that displaces a finished visual is a downgrade, not progress.
    if (!isVisualShowing()) { setPending(true); setPendingCaption(hintCaption ?? ''); }
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
      // Unconditional: a placeholder left standing after a call that returned nothing — or that
      // failed, or that was superseded — is worse than the empty screen it replaced, because it
      // promises something that is never coming.
      if (genId === genIdRef.current) clearPending();
    }
  }, [characterId, projectId, scheduleImageClear, isVisualShowing, clearPending]);

  const setDirectImage = useCallback((url: string, type: 'realistic' | 'diagram', cap: string) => {
    if (isVisualShowing()) return;
    clearPending();
    setImageUrl(url);
    setAltText(cap.split('.')[0] ?? '');
    setCaption(cap);
    setImageType(type);
    setVisible(true);
    lastTriggerAt.current = Date.now();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { setVisible(false); scheduleImageClear(); }, 12_000);
  }, [isVisualShowing, scheduleImageClear, clearPending]);

  return { imageUrl, altText, caption, imageType, visible, pending, pendingCaption, trigger, reset, dismiss, dismissPending: clearPending, setDirectImage };
}
