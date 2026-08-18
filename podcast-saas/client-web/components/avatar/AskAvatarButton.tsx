'use client';

import { Sparkles } from 'lucide-react';
import { preloadAnamSdk } from './anamSdk';

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
  // The Anam SDK is a lazy chunk (see anamSdk.ts for the measurement). Warm it on the
  // first sign of intent so the split costs click-to-first-frame nothing. This fetches
  // a static asset only — it starts no session and mints nothing billable, which is the
  // whole reason hover is a safe trigger for it and not for /avatar/start.
  const warm = { onMouseEnter: preloadAnamSdk, onFocus: preloadAnamSdk, onTouchStart: preloadAnamSdk };

  if (variant === 'icon') {
    return (
      <button type="button" onClick={handle} {...warm} title={title} aria-label={title} className={`avatar-ask-icon ${className}`}>
        <Sparkles size={14} />
      </button>
    );
  }
  if (variant === 'pill') {
    return (
      <button type="button" onClick={handle} {...warm} title={title} aria-label={title} className={`avatar-ask-pill ${className}`}>
        <Sparkles size={13} /> {label}
      </button>
    );
  }
  return (
    <button type="button" onClick={handle} {...warm} title={title} aria-label={title} className={`avatar-ask-floating ${className}`}>
      <Sparkles size={16} /> {label}
    </button>
  );
}
