'use client';

import { useState } from 'react';
import { useAdminAuth } from '../lib/firebase';

export function LoginPage() {
  const { signInWithGoogle, signInWithEmail } = useAdminAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await signInWithEmail(email, password);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-primary mb-4 shadow-lg shadow-primary/20">
            <svg width="22" height="16" viewBox="0 0 22 16" fill="none" aria-hidden>
              <ellipse cx="8.5" cy="8" rx="7" ry="7" fill="white" fillOpacity="0.9" />
              <ellipse cx="17.5" cy="8" rx="4" ry="4" fill="white" fillOpacity="0.5" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-foreground">Admin Portal</h1>
          <p className="text-sm text-muted-foreground mt-1">PodcastAI</p>
        </div>

        {/* Card */}
        <div className="bg-card rounded-2xl border border-border shadow-sm p-6 space-y-4">
          <button
            onClick={() => signInWithGoogle().catch((e) => setError(e.message))}
            className="w-full h-10 border border-border rounded-lg text-sm font-medium hover:bg-muted transition-colors flex items-center justify-center gap-2.5 text-foreground"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M15.68 8.18c0-.57-.05-1.12-.14-1.64H8v3.1h4.3a3.68 3.68 0 0 1-1.6 2.42v2h2.58c1.51-1.39 2.4-3.45 2.4-5.88z"
                fill="#4285F4"
              />
              <path
                d="M8 16c2.16 0 3.97-.72 5.3-1.94l-2.58-2a4.77 4.77 0 0 1-2.72.75c-2.1 0-3.87-1.41-4.5-3.32H.84v2.07A8 8 0 0 0 8 16z"
                fill="#34A853"
              />
              <path
                d="M3.5 9.49A4.8 4.8 0 0 1 3.25 8c0-.52.09-1.02.25-1.49V4.44H.84A8 8 0 0 0 0 8c0 1.3.31 2.52.84 3.56l2.66-2.07z"
                fill="#FBBC04"
              />
              <path
                d="M8 3.18c1.18 0 2.24.41 3.07 1.2l2.3-2.3C11.97.8 10.16 0 8 0A8 8 0 0 0 .84 4.44L3.5 6.51C4.13 4.6 5.9 3.18 8 3.18z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-card px-2.5 text-xs text-muted-foreground">or with email</span>
            </div>
          </div>

          <form onSubmit={handleEmail} className="space-y-3">
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/60"
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/60"
              required
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {loading && (
                <div className="w-3.5 h-3.5 rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground animate-spin" />
              )}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
