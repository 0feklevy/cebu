'use client';

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../lib/firebase';

export function UserProfileButton() {
  const { user, isAnonymous, signInWithGoogle, signOutUser } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!user || isAnonymous) {
    return (
      <button
        onClick={() => signInWithGoogle()}
        className="h-8 px-3 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors inline-flex items-center gap-1.5"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2 12c0-2.21 2.24-4 5-4s5 1.79 5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        Sign in
      </button>
    );
  }

  const initials = (user.displayName ?? user.email ?? '?')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-8 pl-1 pr-3 rounded-full border border-border hover:bg-muted transition-colors"
      >
        <div className="w-6 h-6 rounded-full bg-primary/15 text-primary text-[10px] font-bold flex items-center justify-center shrink-0">
          {initials}
        </div>
        <span className="text-sm text-foreground max-w-[120px] truncate hidden sm:block">
          {user.displayName ?? user.email}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className="text-muted-foreground">
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-56 rounded-xl border border-border bg-popover shadow-lg py-1.5">
          <div className="px-3 py-2 border-b border-border mb-1">
            <p className="text-sm font-medium text-foreground truncate">{user.displayName ?? 'User'}</p>
            <p className="text-xs text-muted-foreground truncate">{user.email}</p>
          </div>
          <button
            onClick={() => { setOpen(false); signOutUser(); }}
            className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors flex items-center gap-2"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
              <path d="M9 4.5L11.5 7 9 9.5M11.5 7H5M5 2H3a1 1 0 00-1 1v7a1 1 0 001 1h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
