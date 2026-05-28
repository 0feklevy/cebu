'use client';

import { AdminNav } from './AdminNav';

export function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex overflow-hidden bg-background">
      <AdminNav />
      <main className="flex-1 overflow-y-auto bg-muted/20">
        <div className="max-w-5xl mx-auto px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
