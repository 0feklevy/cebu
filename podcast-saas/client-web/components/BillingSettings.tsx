'use client';

import { useEffect, useState } from 'react';
import { CreditCard, ExternalLink, Loader2, Play, ListVideo } from 'lucide-react';
import { api } from '../lib/api';
import type { Purchase, CreatorEarnings } from 'shared/src/generated/client-v1';

function money(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

export function BillingSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const status = await api.getBillingStatus();
        setEnabled(status.enabled);
        if (!status.enabled) return;
        const [p, e] = await Promise.all([
          api.listPurchases().catch(() => []),
          api.getCreatorEarnings().catch(() => null),
        ]);
        setPurchases(p);
        setEarnings(e);
      } catch { setEnabled(false); }
    })();
  }, []);

  const openPortal = async () => {
    setPortalBusy(true);
    try {
      const { url } = await api.openBillingPortal(`${window.location.origin}`);
      window.location.href = url;
    } catch { setPortalBusy(false); }
  };

  if (enabled === null) {
    return <div className="flex justify-center py-10"><Loader2 className="animate-spin text-muted-foreground" /></div>;
  }
  if (!enabled) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Payments are not enabled on this workspace.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Payment methods */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-foreground">Payment</h3>
        <button
          onClick={openPortal}
          disabled={portalBusy}
          className="inline-flex min-h-9 max-w-full flex-wrap items-center justify-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 focus-ring"
        >
          {portalBusy ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} />}
          Manage payment methods
          <ExternalLink size={13} className="text-muted-foreground" />
        </button>
        <p className="mt-1.5 text-[11px] text-muted-foreground">Opens Stripe’s secure portal to manage cards and receipts.</p>
      </section>

      {/* Purchases */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-foreground">Your purchases</h3>
        {purchases.length === 0 ? (
          <p className="text-xs text-muted-foreground">No purchases yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {purchases.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="flex min-w-0 items-center gap-2">
                  {p.content_type === 'playlist' ? <ListVideo size={14} className="text-primary" /> : <Play size={14} className="text-primary" />}
                  <span className="truncate text-sm text-foreground">{p.title ?? 'Untitled'}</span>
                </span>
                <span className="shrink-0 text-xs font-medium text-muted-foreground">{money(p.amount_cents, p.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Earnings */}
      {earnings && earnings.salesCount > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-foreground">Your earnings</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-3 text-center">
              <p className="text-lg font-bold text-foreground">{earnings.salesCount}</p>
              <p className="text-[10px] text-muted-foreground">Sales</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-3 text-center">
              <p className="text-lg font-bold text-foreground">{money(earnings.totalGrossCents, earnings.currency)}</p>
              <p className="text-[10px] text-muted-foreground">Gross</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-3 text-center">
              <p className="text-lg font-bold text-emerald-600">{money(earnings.totalNetCents, earnings.currency)}</p>
              <p className="text-[10px] text-muted-foreground">Your payout</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
