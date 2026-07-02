'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { startAvatarSession, type AvatarDisplay } from './avatarApi';
import { characterMeta, DEFAULT_CHARACTER_ID } from './characters';
import { AvatarConversation } from './AvatarConversation';
import './avatar.css';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  videoTitle?: string | null;
  characterId?: string;
}

// Full-screen popup shown above the video. Pauses every other <video> on the page
// while open (and resumes them on close), then runs the live avatar conversation.
export function AvatarPopup({ open, onClose, projectId, videoTitle, characterId = DEFAULT_CHARACTER_ID }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolvedCharacter, setResolvedCharacter] = useState(characterId);
  const [avatarDisplay, setAvatarDisplay] = useState<AvatarDisplay | undefined>();
  const pausedVideos = useRef<HTMLVideoElement[]>([]);
  const meta = characterMeta(resolvedCharacter, avatarDisplay);

  // Pause/resume other videos on the page.
  useEffect(() => {
    if (!open) return;
    const videos = Array.from(document.querySelectorAll('video')).filter((v) => v.id !== 'anam-avatar-video') as HTMLVideoElement[];
    pausedVideos.current = videos.filter((v) => !v.paused);
    pausedVideos.current.forEach((v) => { try { v.pause(); } catch { /* noop */ } });
    return () => {
      // Only resume videos we paused that are still paused at close-time. If another
      // effect resumed/started a video while the popup was open, re-check v.paused so
      // we don't spuriously replay it.
      pausedVideos.current.forEach((v) => {
        if (!v.paused) return;
        try { void v.play().catch(() => {}); } catch { /* noop */ }
      });
      pausedVideos.current = [];
    };
  }, [open]);

  // Fetch a session token when opened.
  useEffect(() => {
    if (!open) { setToken(null); setError(null); setAvatarDisplay(undefined); return; }
    let cancelled = false;
    setError(null);
    setToken(null);
    setResolvedCharacter(characterId);
    setAvatarDisplay(undefined);
    // Pass projectId so the server applies the video's saved persona config and
    // lets it choose the character; omit character_id so the config wins.
    startAvatarSession(undefined, projectId)
      .then((data) => {
        if (!cancelled) {
          setToken(data.sessionToken);
          setResolvedCharacter(data.characterId ?? characterId);
          setAvatarDisplay(data.avatarDisplay ?? (data.voiceSensitivity != null ? { voiceSensitivity: data.voiceSensitivity } : undefined));
        }
      })
      .catch((e) => {
        // Keep the real error in the console for operators; show viewers a friendly,
        // generic message (no server internals / env-var names). (ui-ux-205)
        console.error('[AvatarPopup] failed to start avatar session:', e);
        if (!cancelled) setError("The avatar couldn't start right now. Please try again in a moment.");
      });
    return () => { cancelled = true; };
  }, [open, characterId, projectId]);

  const panelRef = useRef<HTMLDivElement>(null);

  // Focus management + trap: move focus into the dialog on open, keep Tab inside it,
  // close on Escape, and restore focus to the trigger on close (a11y, review ui-ux-001).
  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab' && panelRef.current) {
        const f = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (f.length === 0) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      prevActive?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="avatar-popup-backdrop" role="dialog" aria-modal="true" aria-labelledby="avatar-popup-title">
      <div className="avatar-popup-panel" ref={panelRef} tabIndex={-1}>
        <div className="avatar-popup-header">
          <div className="avatar-popup-title">
            {meta.portrait ? (
              <img
                src={meta.portrait}
                alt=""
                className="avatar-popup-avatar"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            ) : (
              <span className="avatar-popup-emoji">{meta.emoji}</span>
            )}
            <div>
              <p className="avatar-popup-name" id="avatar-popup-title">Ask {meta.displayName}</p>
              {videoTitle && <p className="avatar-popup-sub">about “{videoTitle}”</p>}
            </div>
          </div>
          <button className="avatar-popup-x" onClick={onClose} aria-label="Close">
            <X size={17} strokeWidth={1.9} aria-hidden />
          </button>
        </div>

        <div className="avatar-popup-body">
          {error ? (
            <div className="avatar-popup-status">
              <p style={{ color: '#e87762', marginBottom: 16 }}>⚠ {error}</p>
              <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, maxWidth: 360, textAlign: 'center' }}>
                This video&apos;s avatar isn&apos;t available at the moment.
              </p>
              <button className="avatar-btn avatar-btn--secondary" style={{ marginTop: 18 }} onClick={onClose}>Close</button>
            </div>
          ) : !token ? (
            <div className="avatar-popup-status">
              <span className="avatar-spinner" />
              <p style={{ color: 'rgba(255,255,255,0.6)', marginTop: 14 }}>{meta.startingLabel}</p>
            </div>
          ) : (
            <AvatarConversation characterId={resolvedCharacter} projectId={projectId} sessionToken={token} display={avatarDisplay} onLeave={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}
