'use client';

import { useEffect } from 'react';

interface Props {
  imageUrl: string;
  altText: string;
  caption: string;
  imageType: 'realistic' | 'diagram';
  visible: boolean;
  onDismiss: () => void;
}

// Full-bleed Ken-Burns image overlay shown above the avatar while it speaks.
export function AvatarImageOverlay({ imageUrl, altText, caption, visible, onDismiss }: Props) {
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onDismiss]);

  return (
    <div
      className={`avatar-image-overlay${visible ? ' avatar-image-overlay--visible' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <div className="avatar-image-overlay__frame">
        <img src={imageUrl} alt={altText} className="avatar-image-overlay__img" />
        <button className="avatar-image-overlay__close" onClick={onDismiss} aria-label="Close">✕</button>
        {caption && <div className="avatar-image-overlay__caption">{caption}</div>}
      </div>
    </div>
  );
}
