'use client';

import { Suspense, useEffect, useState } from 'react';
import type { Route } from 'next';
import { useSearchParams, useRouter } from 'next/navigation';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import type { ContentType } from 'shared/src/generated/client-v1';

/**
 * Stripe Checkout return page. After paying, Stripe redirects here; we poll the
 * access endpoint (the webhook grants the purchase server-side) and then bounce
 * the viewer back to the content, now unlocked.
 */
function UnlockInner() {
  const params = useSearchParams();
  const router = useRouter();
  const type = (params.get('type') as ContentType) ?? 'project';
  const id = params.get('id') ?? '';
  const sessionId = params.get('session_id') ?? '';
  const canceled = params.get('canceled') === '1';

  const [state, setState] = useState<'checking' | 'unlocked' | 'failed'>(canceled ? 'failed' : 'checking');

  useEffect(() => {
    if (canceled || !id) return;
    let tries = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const viewerUrl = (type === 'playlist' ? `/playlists/${id}/view` : `/projects/${id}/view`) as Route;

    // Actively reconcile the session first — grants access immediately if the payment is settled,
    // so the viewer isn't stranded when the Stripe webhook is delayed or missed. Idempotent.
    const reconcileOnce = sessionId
      ? api.reconcileCheckout(sessionId).catch(() => undefined)
      : Promise.resolve(undefined);

    const poll = async () => {
      if (cancelled) return;
      try {
        const access = await api.getContentAccess(type, id);
        if (access.hasAccess) {
          setState('unlocked');
          setTimeout(() => router.replace(viewerUrl), 900);
          return;
        }
      } catch { /* ignore */ }
      if (++tries > 15) { setState('failed'); return; }
      timer = setTimeout(poll, 1000);
    };
    reconcileOnce.then(poll);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [type, id, sessionId, canceled, router]);

  const viewerUrl = (type === 'playlist' ? `/playlists/${id}/view` : `/projects/${id}/view`) as Route;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-black px-6 text-center">
      {state === 'checking' && (
        <>
          <Loader2 size={40} className="animate-spin text-white/70" />
          <p className="text-sm text-white/60">Confirming your payment and unlocking…</p>
        </>
      )}
      {state === 'unlocked' && (
        <>
          <CheckCircle2 size={48} className="text-emerald-400" />
          <p className="text-base font-semibold text-white">Unlocked! Taking you to the video…</p>
        </>
      )}
      {state === 'failed' && (
        <>
          <XCircle size={44} className="text-red-400" />
          <p className="text-sm text-white/70">{canceled ? 'Checkout was canceled.' : 'We couldn’t confirm the payment yet.'}</p>
          <a href={viewerUrl} className="mt-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}>
            Back to the video
          </a>
        </>
      )}
    </div>
  );
}

export default function UnlockPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-black" />}>
      <UnlockInner />
    </Suspense>
  );
}
