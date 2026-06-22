'use client';

/**
 * LessonPlayer — the interactive player island for a public /c/ lesson page.
 * Composes the EXISTING renderer (HLSPlayerShell + Ask-the-Avatar); it does not
 * re-implement video/simulation playback. Unlike SharedViewerPage it receives a
 * pre-fetched, public PlayerConfig (no share token, no polling) from the SSR view
 * model, so the server-rendered text around it is the source of truth for SEO.
 */
import { useState } from 'react';
import type { PlayerConfig } from './types';
import { HLSPlayerShell } from './HLSPlayerShell';
import { AskAvatarButton } from '../avatar/AskAvatarButton';
import { AvatarPopup } from '../avatar/AvatarPopup';

export function LessonPlayer({ config }: { config: PlayerConfig }) {
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [captionMenuOpen, setCaptionMenuOpen] = useState(false);
  const cfg = config as PlayerConfig & { id?: string; project_id?: string; title?: string | null };

  if (!config.segments?.length) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black">
        <p className="px-4 text-center text-sm text-white/50">This lesson’s video is not available yet.</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <HLSPlayerShell
        config={config}
        onCaptionMenuOpenChange={setCaptionMenuOpen}
        bottomRightOverlay={!captionMenuOpen ? <AskAvatarButton onClick={() => setAvatarOpen(true)} label="Ask!" /> : null}
      />
      <AvatarPopup
        open={avatarOpen}
        onClose={() => setAvatarOpen(false)}
        projectId={cfg.project_id ?? cfg.id}
        videoTitle={cfg.title ?? null}
      />
    </div>
  );
}
