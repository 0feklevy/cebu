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
        className="h-8 px-3 rounded-lg border border-border bg-card text-sm font-medium text-foreground shadow-sm hover:bg-muted transition-colors inline-flex items-center gap-1.5 focus-ring"
      >
        <LogIn size={14} strokeWidth={1.8} aria-hidden />
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
        className="flex h-8 items-center gap-2 rounded-full border border-border bg-card pl-1 pr-2 text-foreground shadow-sm transition-colors hover:bg-muted focus-ring"
        title={user.displayName || user.email || 'Account'}
      >
        <div className="w-6 h-6 rounded-full text-white text-[10px] font-bold flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}>
          {initials}
        </div>
        {showLabel && <span className="hidden max-w-[120px] truncate text-sm text-foreground sm:block">
          {user.displayName ?? user.email}
        </span>}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className="text-muted-foreground">
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-[1000] w-64 rounded-lg border border-border bg-popover shadow-dropdown py-1.5">
          <div className="px-3 py-2 border-b border-border mb-1">
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
