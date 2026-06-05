'use client';

import { useEffect, useState } from 'react';
import { Lock, Unlock, Loader2, Check } from 'lucide-react';
import { api } from '../lib/api';
import type { ContentType } from 'shared/src/generated/client-v1';

interface Props {
  contentType: ContentType;
  contentId: string;
  /** Compact inline card (default) — set false for a borderless variant. */
  bordered?: boolean;
  onChanged?: (accessType: 'free' | 'paid', priceCents: number | null) => void;
}

/**
 * Lock a video/playlist behind a one-time price. Self-fetches the current pricing
 * and the billing-enabled flag; renders nothing if Stripe isn't configured.
 */
export function LockPriceControl({ contentType, contentId, bordered = true, onChanged }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [paid, setPaid] = useState(false);
  const [dollars, setDollars] = useState('1.99');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [status, access] = await Promise.all([
          api.getBillingStatus(),
          api.getContentAccess(contentType, contentId).catch(() => null),
        ]);
        if (cancelled) return;
        setEnabled(status.enabled);
        if (access) {
          setPaid(access.accessType === 'paid');
          if (access.priceCents) setDollars((access.priceCents / 100).toFixed(2));
        }
      } catch { if (!cancelled) setEnabled(false); }
    })();
    return () => { cancelled = true; };
  }, [contentType, contentId]);

  if (enabled === null || enabled === false) return null;

  const save = async (nextPaid: boolean) => {
    setSaving(true); setSaved(false);
    try {
      const priceCents = nextPaid ? Math.round(parseFloat(dollars || '0') * 100) : null;
      const res = await api.setContentPricing(contentType, contentId, {
        access_type: nextPaid ? 'paid' : 'free',
        price_cents: priceCents,
      });
      setPaid(res.access_type === 'paid');
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
      onChanged?.(res.access_type, res.price_cents);
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  };

  return (
    <div className={bordered ? 'rounded-lg border border-border bg-card p-3' : ''}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {paid ? <Lock size={15} className="text-amber-500" /> : <Unlock size={15} className="text-muted-foreground" />}
          <div>
            <p className="text-sm font-medium text-foreground">{paid ? 'Locked — pay to watch' : 'Free to watch'}</p>
            <p className="text-[11px] text-muted-foreground">
              {paid ? 'Viewers unlock with a one-time payment.' : 'Lock this to charge viewers a one-time price.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => save(!paid)}
          disabled={saving}
          className="relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50"
          style={{ background: paid ? '#f59e0b' : 'hsl(var(--border))' }}
          title={paid ? 'Make free' : 'Lock'}
        >
          <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all" style={{ left: paid ? 18 : 2 }} />
        </button>
      </div>

      {paid && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" min="0.50" step="0.50" value={dollars}
              onChange={(e) => setDollars(e.target.value)}
              className="h-9 w-full rounded-lg border border-input bg-white pl-6 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25"
            />
          </div>
          <button
            type="button"
            onClick={() => save(true)}
            disabled={saving || parseFloat(dollars || '0') < 0.5}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <Check size={13} /> : null}
            {saved ? 'Saved' : 'Set price'}
          </button>
        </div>
      )}
    </div>
  );
}
