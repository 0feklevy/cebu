'use client';

import { useEffect, useRef, useState } from 'react';
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
      pausedVideos.current.forEach((v) => { try { void v.play().catch(() => {}); } catch { /* noop */ } });
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
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [open, characterId, projectId]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="avatar-popup-backdrop" role="dialog" aria-modal="true">
      <div className="avatar-popup-panel">
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
              <p className="avatar-popup-name">Ask {meta.displayName}</p>
              {videoTitle && <p className="avatar-popup-sub">about “{videoTitle}”</p>}
            </div>
          </div>
          <button className="avatar-popup-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="avatar-popup-body">
          {error ? (
            <div className="avatar-popup-status">
              <p style={{ color: '#e87762', marginBottom: 16 }}>⚠ {error}</p>
              <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, maxWidth: 360, textAlign: 'center' }}>
                The avatar needs <code>ANAM_API_KEY</code> and a persona configured on the server.
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
