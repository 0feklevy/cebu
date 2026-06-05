'use client';

import { useState } from 'react';
import { Lock, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/firebase';
import type { ContentType } from 'shared/src/generated/client-v1';

interface Props {
  contentType: ContentType;
  contentId: string;
  title: string | null;
  priceCents: number | null;
  currency: string;
}

export function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

/**
 * Full-screen paywall shown by the viewer when content is locked. Redirects to
 * Stripe Checkout; after payment Stripe returns to /unlock which bounces back to
 * the viewer (now unlocked).
 */
export function PaywallOverlay({ contentType, contentId, title, priceCents, currency }: Props) {
  const { user, isAnonymous, signInWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const price = priceCents != null ? formatPrice(priceCents, currency) : '—';
  const needsSignIn = !user || isAnonymous;

  const handleUnlock = async () => {
    setError(null);
    setBusy(true);
    try {
      if (needsSignIn) {
        await signInWithGoogle();
      }
      const { url } = await api.createCheckout(contentType, contentId);
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message ?? 'Something went wrong');
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full w-full items-start justify-center overflow-y-auto bg-black px-4 py-8 sm:items-center sm:px-6">
      <div
        className="w-full max-w-sm rounded-xl border p-5 text-center sm:p-7"
        style={{ background: 'rgba(20,20,24,0.92)', borderColor: 'rgba(255,255,255,0.1)' }}
      >
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full" style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}>
          <Lock size={24} strokeWidth={2} className="text-white" aria-hidden />
        </div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">
          {contentType === 'playlist' ? 'Locked playlist' : 'Locked video'}
        </p>
        <h1 className="mt-1.5 text-xl font-bold text-white">{title?.trim() || 'Premium content'}</h1>
        <p className="mt-2 text-sm text-white/55">
          Unlock to watch — a one-time purchase, yours forever.
        </p>

        <div className="my-5 text-3xl font-extrabold text-white sm:text-4xl">{price}</div>

        <button
          onClick={handleUnlock}
          disabled={busy || priceCents == null}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-bold text-white shadow-lg transition-all hover:brightness-110 disabled:opacity-50 sm:text-base"
          style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
        >
          {busy ? <Loader2 size={18} className="animate-spin" /> : <Lock size={16} strokeWidth={2.2} />}
          {needsSignIn ? `Sign in & unlock for ${price}` : `Unlock for ${price}`}
        </button>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <p className="mt-4 text-[11px] text-white/35">
          Secure payment via Stripe. {needsSignIn && 'Sign-in keeps your purchase linked to you.'}
        </p>
      </div>
    </div>
  );
}
