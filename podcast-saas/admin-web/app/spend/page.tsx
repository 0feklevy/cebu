'use client';

/**
 * Where the money went.
 *
 * Built after four ElevenLabs Auto Top-Up invoices fired in three and a half hours on 22 August
 * 2026 and nothing in this product could say what bought them. The page's job is not to look
 * authoritative — it is to be COMPARABLE to a vendor invoice, and to admit when it cannot be.
 *
 * Three deliberate choices follow from that:
 *
 *   • quantities are shown per unit and never summed together, because characters and images and
 *     minutes share a column and adding them yields a number that means nothing and looks like one
 *     that does;
 *   • the row count and the zero-priced count sit beside the total, because "$0.00" for a busy day
 *     is what a broken rate produces and is the one wrong answer nobody questions;
 *   • a truncated window says so, loudly, instead of presenting a partial sum as a total.
 */

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import { formatUsd, humaniseUnit, spendCaveat, toDateInput } from '../../lib/spendFormat';
import type { SpendSummaryResponse } from 'shared/src/generated/admin-v1';

const DEFAULT_DAYS = 31;

export default function SpendPage() {
  const [from, setFrom] = useState(() =>
    toDateInput(new Date(Date.now() - DEFAULT_DAYS * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(() => toDateInput(new Date()));
  const [data, setData] = useState<SpendSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    adminApi.getSpend(from, to)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const caveat = data ? spendCaveat(data) : null;

  return (
    <AdminShell>
      <h1 className="text-2xl font-bold mb-1">Spend</h1>
      <p className="text-sm text-gray-500 mb-6">
        What each provider was paid, and for how much of what. Compare against the vendor invoice —
        the quantities are the units an invoice itemises.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-6">
        <label className="text-sm">
          <span className="block text-gray-600 mb-1">From (UTC)</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                 className="border rounded px-2 py-1" />
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-1">To (UTC)</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                 className="border rounded px-2 py-1" />
        </label>
        <button onClick={load} disabled={loading}
                className="border rounded px-3 py-1 text-sm disabled:opacity-50">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          Could not load spend: {error}
        </p>
      )}

      {data && (
        <>
          {/* The caveat sits ABOVE the total on purpose: a warning printed underneath a big number
              is read after the number has already been believed. */}
          {caveat && (
            <p role="status" className="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded p-3">
              {caveat}
            </p>
          )}

          <section className="mb-8">
            <div className="text-4xl font-bold">{formatUsd(data.totalUsd)}</div>
            <div className="text-sm text-gray-500 mt-1">
              {data.rows.toLocaleString('en-US')} recorded calls
              {data.zeroCostRows > 0 && <> · {data.zeroCostRows.toLocaleString('en-US')} priced at zero</>}
            </div>
          </section>

          <section className="mb-8">
            <h2 className="font-semibold mb-2">By provider</h2>
            {data.providers.length === 0 ? (
              <p className="text-sm text-gray-500">Nothing recorded in this window.</p>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2">Provider</th>
                    <th className="py-2">Spend</th>
                    <th className="py-2">What was bought</th>
                  </tr>
                </thead>
                <tbody>
                  {data.providers.map((p) => (
                    <tr key={p.provider} className="border-b last:border-0 align-top">
                      <td className="py-2 font-medium">{p.provider}</td>
                      <td className="py-2">{formatUsd(p.usd)}</td>
                      <td className="py-2 text-gray-700">
                        {/* One line per unit. Never a combined figure — see the file header. */}
                        {p.quantities.map((q) => (
                          <div key={q.unit}>{humaniseUnit(q.quantity, q.unit)}</div>
                        ))}
                        {p.untypedRows > 0 && (
                          <div className="text-gray-500">
                            {p.untypedRows.toLocaleString('en-US')} LLM calls (counted in tokens)
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="mb-8">
            <h2 className="font-semibold mb-2">By task</h2>
            <p className="text-xs text-gray-500 mb-2">
              What the money was spent doing. A task climbing this list is the first sign of a loop.
            </p>
            <table className="w-full text-sm border-collapse">
              <tbody>
                {data.byTask.slice(0, 20).map((t) => (
                  <tr key={`${t.provider}:${t.task}`} className="border-b last:border-0">
                    <td className="py-1.5">{t.task}</td>
                    <td className="py-1.5 text-gray-500">{t.provider}</td>
                    <td className="py-1.5">{formatUsd(t.usd)}</td>
                    <td className="py-1.5 text-gray-500">{t.rows.toLocaleString('en-US')} calls</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="font-semibold mb-2">By day (UTC)</h2>
            <table className="w-full text-sm border-collapse">
              <tbody>
                {data.byDay.map((d) => (
                  <tr key={d.day} className="border-b last:border-0">
                    <td className="py-1.5">{d.day}</td>
                    <td className="py-1.5">{formatUsd(d.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </AdminShell>
  );
}
