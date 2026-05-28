'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAdminAuth } from '../lib/firebase';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/system-prompts', label: 'System Prompts' },
  { href: '/llm-config', label: 'LLM Config' },
  { href: '/api-keys', label: 'API Keys' },
  { href: '/feature-flags', label: 'Feature Flags' },
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
          <svg width="13" height="9" viewBox="0 0 13 9" fill="none" aria-hidden>
            <ellipse cx="5" cy="4.5" rx="4" ry="4" fill="white" fillOpacity="0.9" />
            <ellipse cx="10.5" cy="4.5" rx="2.25" ry="2.25" fill="white" fillOpacity="0.5" />
          </svg>
        </div>
        <div>
          <p className="text-xs font-semibold text-foreground leading-none">PodcastAI</p>
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
