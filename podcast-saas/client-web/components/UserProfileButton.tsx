'use client';

import { useState, useRef, useEffect } from 'react';
import { LogIn, LogOut, Settings, User } from 'lucide-react';
import { useAuth } from '../lib/firebase';
import { UserSettingsDialog } from './UserSettingsDialog';

interface Props {
  showLabel?: boolean;
}

export function UserProfileButton({ showLabel = false }: Props) {
  const { user, isAnonymous, signInWithGoogle, signOutUser } = useAuth();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      <>
      <button
        onClick={() => signInWithGoogle()}
        className={`${showLabel ? 'h-10 w-full justify-center px-3' : 'h-8 px-3'} inline-flex items-center gap-1.5 rounded-lg border border-border bg-card text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted focus-ring`}
      >
        <LogIn size={showLabel ? 16 : 14} strokeWidth={1.8} aria-hidden />
        Sign in
      </button>
      <UserSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </>
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
        className={`${showLabel ? 'h-10 w-full rounded-lg pl-1.5 pr-3' : 'h-8 rounded-full pl-1 pr-2'} flex items-center gap-2 border border-border bg-card text-foreground shadow-sm transition-colors hover:bg-muted focus-ring`}
        title={user.displayName || user.email || 'Account'}
      >
        <div className={`${showLabel ? 'h-7 w-7 text-xs' : 'h-6 w-6 text-[10px]'} flex shrink-0 items-center justify-center rounded-full font-bold text-white`} style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}>
          {initials}
        </div>
        {showLabel && <span className="block min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground">
          {user.displayName ?? user.email}
        </span>}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className="text-muted-foreground">
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="floating-panel absolute right-0 top-11 z-[1000] w-[min(18rem,calc(100dvw-24px))] overflow-hidden rounded-xl py-1.5">
          <div className="mb-1 border-b border-border bg-muted/45 px-3 py-3">
            <p className="text-sm font-medium text-foreground truncate">{user.displayName ?? 'User'}</p>
            <p className="text-xs text-muted-foreground truncate">{user.email}</p>
          </div>
          <button
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
            className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors flex items-center gap-2"
          >
            <Settings size={14} strokeWidth={1.8} aria-hidden />
            Settings
          </button>
          <button
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
            className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors flex items-center gap-2"
          >
            <User size={14} strokeWidth={1.8} aria-hidden />
            Account profile
          </button>
          <div className="my-1 border-t border-border" />
          <button
            onClick={() => { setOpen(false); signOutUser(); }}
            className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors flex items-center gap-2"
          >
            <LogOut size={14} strokeWidth={1.8} aria-hidden />
            Sign out
          </button>
        </div>
      )}
      <UserSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
