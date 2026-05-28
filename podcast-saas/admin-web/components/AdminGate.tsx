'use client';

import { useAdminAuth } from '../lib/firebase';
import { LoginPage } from './LoginPage';

function AccessDenied() {
  return (
    <div className="h-full flex items-center justify-center bg-background">
      <div className="text-center space-y-3 max-w-xs px-6">
        <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-destructive" aria-hidden>
            <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
        <h1 className="text-lg font-bold text-foreground">Access Denied</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Your account does not have admin privileges. Contact a super-admin to request access.
        </p>
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="h-full flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <p className="text-sm text-muted-foreground">Verifying access…</p>
      </div>
    </div>
  );
}

export function AdminGate({ children }: { children: React.ReactNode }) {
  const { loading, user, isAdmin } = useAdminAuth();
  // DEV BYPASS — skips the isAdmin check but still requires login for API tokens
  const bypass = process.env.NEXT_PUBLIC_ADMIN_BYPASS !== 'false';

  if (loading) return <LoadingScreen />;
  if (!user) return <LoginPage />;
  if (!bypass && isAdmin === null) return <LoadingScreen />;
  if (!bypass && isAdmin === false) return <AccessDenied />;

  return <>{children}</>;
}
