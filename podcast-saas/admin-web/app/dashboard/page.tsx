'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { AdminSettings, PipelineStats, UsageRollup } from 'shared/src/generated/admin-v1';

export default function DashboardPage() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [usage, setUsage] = useState<UsageRollup | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([adminApi.getSettings(), adminApi.getPipelineStats(), adminApi.getUsageRollup()])
      .then(([s, p, u]) => {
        setSettings(s);
        setStats(p);
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

      {/* System status */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <StatusCard
          label="Maintenance Mode"
          value={settings ? (settings.maintenance_mode ? 'ON' : 'OFF') : '—'}
          bad={settings?.maintenance_mode}
        />
        <StatusCard
          label="Anonymous User Limit"
          value={settings ? String(settings.anonymous_user_limit) : '—'}
        />
      </div>

      {stats && (
        <>
          {/* Projects */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Projects</h2>
            <div className="grid grid-cols-2 gap-4">
              <MetricCard label="Total Projects" value={stats.projects.total.toLocaleString()} />
              <MetricCard label="Created (Last 30 Days)" value={stats.projects.recent_30d.toLocaleString()} />
            </div>
          </section>

          {/* Video pipeline */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Video Pipeline
            </h2>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground mb-3">
                {stats.videos.total.toLocaleString()} videos total
              </div>
              <HlsStatusBar counts={stats.videos.by_hls_status} total={stats.videos.total} />
              <div className="grid grid-cols-4 gap-3 mt-4">
                <HlsBadge label="Pending" count={stats.videos.by_hls_status.pending} color="muted" />
                <HlsBadge label="Processing" count={stats.videos.by_hls_status.processing} color="amber" />
                <HlsBadge label="Ready" count={stats.videos.by_hls_status.ready} color="green" />
                <HlsBadge label="Failed" count={stats.videos.by_hls_status.failed} color="red" />
              </div>
            </div>
          </section>

          {/* Simulations */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Simulations
            </h2>
            <div className="grid grid-cols-3 gap-4">
              <MetricCard label="Total" value={stats.simulations.total.toLocaleString()} />
              <MetricCard
                label="Ready"
                value={stats.simulations.by_status.ready.toLocaleString()}
                good={stats.simulations.by_status.ready > 0}
              />
              <MetricCard
                label="Failed"
                value={stats.simulations.by_status.failed.toLocaleString()}
                bad={stats.simulations.by_status.failed > 0}
              />
            </div>
          </section>

          {/* AI extraction (last 30 days) */}
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              AI Extraction (Last 30 Days)
            </h2>
            <div className="grid grid-cols-4 gap-4">
              <MetricCard label="Extractions Run" value={stats.ai_extraction.count.toLocaleString()} />
              <MetricCard label="Input Tokens" value={stats.ai_extraction.total_input_tokens.toLocaleString()} />
              <MetricCard label="Output Tokens" value={stats.ai_extraction.total_output_tokens.toLocaleString()} />
              <MetricCard
                label="Total Cost"
                value={`$${(stats.ai_extraction.total_cost_cents / 100).toFixed(2)}`}
              />
            </div>
          </section>
        </>
      )}

      {/* Full AI usage breakdown */}
      {usage && usage.total_input_tokens > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            All AI Usage (Last 30 Days)
          </h2>
          <div className="grid grid-cols-2 gap-6">
            <BreakdownTable
              title="By Model"
              rows={Object.entries(usage.by_model).map(([k, v]) => ({
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
        </section>
      )}
    </AdminShell>
  );
}

function StatusCard({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`text-lg font-semibold ${bad ? 'text-destructive' : 'text-foreground'}`}>{value}</div>
    </div>
  );
}

function MetricCard({ label, value, bad, good }: { label: string; value: string; bad?: boolean; good?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`text-xl font-bold ${bad ? 'text-destructive' : good ? 'text-primary' : ''}`}>{value}</div>
    </div>
  );
}

function HlsStatusBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  if (total === 0) return null;
  const segments = [
    { key: 'ready', color: 'bg-primary' },
    { key: 'processing', color: 'bg-amber-500' },
    { key: 'pending', color: 'bg-muted' },
    { key: 'failed', color: 'bg-destructive' },
  ];
  return (
    <div className="flex rounded-full overflow-hidden h-2 gap-px">
      {segments.map(({ key, color }) => {
        const pct = total > 0 ? (counts[key] / total) * 100 : 0;
        if (pct === 0) return null;
        return <div key={key} className={`${color} h-full`} style={{ width: `${pct}%` }} />;
      })}
    </div>
  );
}

function HlsBadge({ label, count, color }: { label: string; count: number; color: string }) {
  const colorMap: Record<string, string> = {
    muted: 'text-muted-foreground',
    amber: 'text-amber-500',
    green: 'text-primary',
    red: 'text-destructive',
  };
  return (
    <div className="text-center">
      <div className={`text-lg font-bold ${colorMap[color]}`}>{count}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
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
            {rows.some((r) => r.cost !== undefined) && <th className="text-right pb-2">Cost</th>}
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
