'use client';

import { useCallback, useEffect, useRef } from 'react';
import { getMemory, saveMemory, type Turn } from '../avatarApi';

interface AnamLike { addContext?: (s: string) => void; isStreaming?: () => boolean; }

function anonId(): string {
  if (typeof window === 'undefined') return 'server';
  let id = window.localStorage.getItem('avatar_anon_id');
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); window.localStorage.setItem('avatar_anon_id', id); }
  return id;
}

// Cross-session memory: loads stored context, injects it at session start, and
// records turns back to the server (debounced). Simplified port of
// darwin-avatar/client/src/hooks/useConversationMemory.ts.
export function useConversationMemory(characterId: string, projectId: string | undefined) {
  const sessionKey = `${anonId()}:${projectId ?? 'global'}:${characterId}`;
  const contextRef = useRef<string>('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMemory(sessionKey).then(({ turns, profile }) => {
      if (cancelled) return;
      const parts: string[] = [];
      if (profile && Object.keys(profile).length) {
        parts.push('What you remember about this person: ' + Object.entries(profile).map(([k, v]) => `${k}: ${v}`).join(', ') + '.');
      }
      if (turns?.length) {
        parts.push('Recent conversation:\n' + turns.slice(-6).map((t) => `${t.role === 'user' ? 'Visitor' : 'You'}: ${t.content}`).join('\n'));
      }
      contextRef.current = parts.join('\n\n');
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const inject = useCallback((client: AnamLike) => {
    if (!contextRef.current || !client.addContext) return;
    // addContext throws "not currently streaming" if the stream isn't active
    // (e.g. it ended/closed before this fired). Skip when not streaming and treat
    // injection as best-effort — it's optional memory context, never fatal.
    if (client.isStreaming && !client.isStreaming()) return;
    try {
      client.addContext(`[Memory — context from previous conversations: ${contextRef.current}]`);
    } catch {
      /* stream not ready / ended — ignore (memory injection is non-essential) */
    }
  }, []);

  const record = useCallback((messages: Array<{ role: string; content: string }>) => {
    const turns: Turn[] = messages
      .filter((m) => m.content && m.content.trim().length > 1)
      .map((m): Turn => ({ role: m.role === 'user' ? 'user' : 'persona', content: m.content }))
      .slice(-20);
    if (!turns.length) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveMemory(sessionKey, characterId, projectId, turns), 1500);
  }, [sessionKey, characterId, projectId]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  return { inject, record };
}
