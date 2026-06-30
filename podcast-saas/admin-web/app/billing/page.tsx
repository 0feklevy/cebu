'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { AdminBillingOverview, AdminBillingTransaction } from 'shared/src/generated/admin-v1';

function money(cents: number, currency = 'usd') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

const STATUS_STYLE: Record<string, string> = {
  succeeded: 'bg-emerald-500/10 text-emerald-600',
  pending:   'bg-amber-500/10 text-amber-600',
  failed:    'bg-red-500/10 text-red-600',
  refunded:  'bg-slate-500/10 text-slate-600',
};

export default function BillingPage() {
  const [overview, setOverview] = useState<AdminBillingOverview | null>(null);
  const [txs, setTxs] = useState<AdminBillingTransaction[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi.getBillingOverview().then(setOverview).catch((e) => setError(e.message));
    // Surface transaction-load failures instead of silently rendering "no transactions" (frontend-013).
    adminApi.getBillingTransactions().then(setTxs).catch((e) => setError(e.message));
  }, []);

  return (
    <AdminShell>
      <h1 className="mb-5 text-xl font-semibold text-foreground">Billing</h1>
      {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

      {!overview ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !overview.enabled ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <p className="text-sm font-medium text-foreground">Payments are not configured</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Set <code className="rounded bg-muted px-1">STRIPE_SECRET_KEY</code> and{' '}
            <code className="rounded bg-muted px-1">STRIPE_WEBHOOK_SECRET</code> to enable pay-to-unlock.
          </p>
        </div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Gross volume', value: money(overview.totalVolumeCents) },
              { label: `Platform fees (${overview.platformFeePercent}%)`, value: money(overview.totalPlatformFeesCents) },
              { label: 'Sales', value: String(overview.totalTransactions) },
              { label: 'Pending', value: String(overview.pendingTransactions) },
              { label: 'Creators', value: String(overview.activeCreators) },
              { label: 'Buyers', value: String(overview.activeBuyers) },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-border bg-card p-4 shadow-sm-soft">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="mt-1.5 text-2xl font-semibold text-foreground">{s.value}</p>
              </div>
            ))}
          </div>

          {/* Transactions table */}
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Recent transactions</h2>
            </div>
            {txs.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">No transactions yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-4 py-2 font-medium">Date</th>
                      <th className="px-4 py-2 font-medium">Content</th>
                      <th className="px-4 py-2 font-medium">Buyer</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 text-right font-medium">Amount</th>
                      <th className="px-4 py-2 text-right font-medium">Payout</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txs.map((t) => (
                      <tr key={t.id} className="border-b border-border/60 last:border-0">
                        <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{new Date(t.created_at).toLocaleDateString()}</td>
                        <td className="max-w-[220px] truncate px-4 py-2 text-foreground">{t.description ?? `${t.content_type}`}</td>
                        <td className="max-w-[180px] truncate px-4 py-2 text-muted-foreground">{t.payer_email ?? '—'}</td>
                        <td className="px-4 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[t.status] ?? 'bg-muted text-muted-foreground'}`}>{t.status}</span>
                        </td>
                        <td className="px-4 py-2 text-right font-medium text-foreground">{money(t.amount_cents, t.currency)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{money(t.creator_payout_cents, t.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </AdminShell>
  );
}
