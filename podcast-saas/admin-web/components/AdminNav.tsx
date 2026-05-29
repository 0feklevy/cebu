'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAdminAuth } from '../lib/firebase';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/llm-config', label: 'AI Config' },
  { href: '/api-keys', label: 'API Keys' },
  { href: '/feature-flags', label: 'Controls' },
  { href: '/users', label: 'Users' },
];

export function AdminNav() {
  const pathname = usePathname();
  const { signOutUser } = useAdminAuth();

  return (
    <nav className="w-52 h-full flex flex-col shrink-0 border-r border-border bg-card">
      {/* Logo */}
      <div className="h-14 px-5 border-b border-border flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shadow-sm shrink-0">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <rect x="1" y="4" width="8" height="6" rx="1" fill="white" fillOpacity="0.9" />
            <polygon points="9,4 13,7 9,10" fill="white" fillOpacity="0.5" />
          </svg>
        </div>
        <div>
          <p className="text-xs font-semibold text-foreground leading-none">VideoAI</p>
          <p className="text-[10px] text-muted-foreground leading-none mt-0.5">Admin</p>
        </div>
      </div>

      {/* Links */}
      <div className="flex-1 overflow-y-auto py-3 px-2">
        {NAV.map(({ href, label }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center px-3 py-2 rounded-lg text-sm transition-colors mb-0.5 ${
                active
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              {label}
            </Link>
          );
        })}
      </div>

      {/* Sign out */}
      <div className="px-2 py-3 border-t border-border">
        <button
          onClick={() => signOutUser()}
          className="w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors text-left"
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}
