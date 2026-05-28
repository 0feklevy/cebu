'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { AdminSettings, UsageRollup } from 'shared/src/generated/admin-v1';

export default function DashboardPage() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [usage, setUsage] = useState<UsageRollup | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([adminApi.getSettings(), adminApi.getUsageRollup()])
      .then(([s, u]) => {
        setSettings(s);
        setUsage(u);
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <AdminShell>
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-destructive/20 text-destructive text-sm">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-8">
        <StatusCard
          label="Generation"
          value={settings ? (settings.generation_paused ? 'Paused' : 'Active') : '—'}
          bad={settings?.generation_paused}
        />
        <StatusCard
          label="Maintenance Mode"
          value={settings ? (settings.maintenance_mode ? 'ON' : 'OFF') : '—'}
          bad={settings?.maintenance_mode}
        />
        <StatusCard
          label="Anonymous User Limit"
          value={settings ? String(settings.anonymous_user_limit) : '—'}
        />
        <StatusCard
          label="Default Provider"
          value={settings?.default_provider ?? '—'}
        />
      </div>

      {usage && (
        <div className="space-y-6">
          <h2 className="text-lg font-semibold">Usage (Last 30 Days)</h2>
          <div className="grid grid-cols-3 gap-4">
            <MetricCard label="Total Input Tokens" value={usage.total_input_tokens.toLocaleString()} />
            <MetricCard label="Total Output Tokens" value={usage.total_output_tokens.toLocaleString()} />
            <MetricCard
              label="Total Cost"
              value={`$${(usage.total_cost_cents / 100).toFixed(2)}`}
            />
          </div>

          <div className="grid grid-cols-2 gap-6">
            <BreakdownTable
              title="By Provider"
              rows={Object.entries(usage.by_provider).map(([k, v]) => ({
                key: k,
                input: v.input,
                output: v.output,
                cost: v.cost_cents,
              }))}
            />
            <BreakdownTable
              title="By Task"
              rows={Object.entries(usage.by_task).map(([k, v]) => ({
                key: k,
                input: v.input,
                output: v.output,
              }))}
            />
          </div>
        </div>
      )}
    </AdminShell>
  );
}

function StatusCard({
  label,
  value,
  bad,
}: {
  label: string;
  value: string;
  bad?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`text-lg font-semibold ${bad ? 'text-destructive' : 'text-foreground'}`}>{value}</div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; input: number; output: number; cost?: number }[];
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground border-b border-border">
            <th className="text-left pb-2">Key</th>
            <th className="text-right pb-2">Input</th>
            <th className="text-right pb-2">Output</th>
            {rows.some((r) => r.cost !== undefined) && (
              <th className="text-right pb-2">Cost</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="py-1.5 font-mono">{r.key}</td>
              <td className="text-right py-1.5">{r.input.toLocaleString()}</td>
              <td className="text-right py-1.5">{r.output.toLocaleString()}</td>
              {r.cost !== undefined && (
                <td className="text-right py-1.5">${(r.cost / 100).toFixed(2)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
