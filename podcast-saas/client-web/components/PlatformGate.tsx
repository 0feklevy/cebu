'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { PlatformSettings } from 'shared';

interface PlatformContextValue {
  settings: PlatformSettings | null;
}

const PlatformContext = createContext<PlatformContextValue>({ settings: null });

export function usePlatform(): PlatformContextValue {
  return useContext(PlatformContext);
}

export function PlatformGate({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
    fetch(`${apiUrl}/api/v1/platform/settings`)
      .then((r) => r.json())
      .then((s: PlatformSettings) => {
        setSettings(s);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (settings?.maintenance_mode) {
    return (
      <div className="h-full flex items-center justify-center bg-background px-6">
        <div className="max-w-sm text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-muted-foreground" aria-hidden>
              <path d="M10 2v8M10 14v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-foreground">Under Maintenance</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {settings.maintenance_message ?? 'We are performing scheduled maintenance. Please check back soon.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PlatformContext.Provider value={{ settings }}>
      {children}
    </PlatformContext.Provider>
  );
}
