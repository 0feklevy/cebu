'use client';

import { Sparkles } from 'lucide-react';

interface Props {
  onClick: () => void;
  variant?: 'floating' | 'pill' | 'icon';
  label?: string;
  className?: string;
  title?: string;
}

// The "Ask!" button. Floating overlay on the player, a pill in lists, or a small icon.
export function AskAvatarButton({ onClick, variant = 'floating', label = 'Ask!', className = '', title = 'Ask the avatar about this video' }: Props) {
  const handle = (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); onClick(); };

  if (variant === 'icon') {
    return (
      <button type="button" onClick={handle} title={title} aria-label={title} className={`avatar-ask-icon ${className}`}>
        <Sparkles size={14} />
      </button>
    );
  }
  if (variant === 'pill') {
    return (
      <button type="button" onClick={handle} title={title} aria-label={title} className={`avatar-ask-pill ${className}`}>
        <Sparkles size={13} /> {label}
      </button>
    );
  }
  return (
    <button type="button" onClick={handle} title={title} aria-label={title} className={`avatar-ask-floating ${className}`}>
      <Sparkles size={16} /> {label}
    </button>
  );
}
