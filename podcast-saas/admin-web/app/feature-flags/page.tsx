'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { AdminSettings } from 'shared/src/generated/admin-v1';

type Controls = Pick<
  AdminSettings,
  | 'maintenance_mode'
  | 'maintenance_message'
  | 'anonymous_user_limit'
  | 'generation_limit_enabled'
  | 'generation_daily_limit'
  // Simulation runtime. These are the kill switches an incident actually needs, and until now the
  // admin PATCH accepted them while nothing rendered them — so reaching one meant a direct DB
  // write against production. A switch that cannot be thrown is not a rollback plan.
  | 'sim_pool_mode'
  | 'sim_scheduler_mode'
  | 'sim_adaptive_quality'
  | 'sim_boundary_sentinel'
  | 'sim_transition_coordinator'
  | 'rum_sample_rate'
>;

export default function ControlsPage() {
  const [form, setForm] = useState<Controls | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .getSettings()
      .then((s) =>
        setForm({
          maintenance_mode: s.maintenance_mode,
          maintenance_message: s.maintenance_message,
          anonymous_user_limit: s.anonymous_user_limit,
          generation_limit_enabled: s.generation_limit_enabled,
          generation_daily_limit: s.generation_daily_limit,
          sim_pool_mode: s.sim_pool_mode,
          sim_scheduler_mode: s.sim_scheduler_mode,
          sim_adaptive_quality: s.sim_adaptive_quality,
          sim_boundary_sentinel: s.sim_boundary_sentinel,
          sim_transition_coordinator: s.sim_transition_coordinator,
          rum_sample_rate: s.rum_sample_rate,
        }),
      )
      .catch((e) => setError(e.message));
  }, []);

  const set = <K extends keyof Controls>(key: K, value: Controls[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      await adminApi.updateSettings(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!form) {
    return (
      <AdminShell>
        <div className="animate-pulse text-muted-foreground">Loading…</div>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Controls</h1>
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 bg-primary text-primary-foreground text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
        >
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Changes'}
        </button>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-destructive/20 text-destructive text-sm">{error}</div>
      )}

      <div className="max-w-2xl space-y-6">
        <FlagCard
          title="Maintenance Mode"
          description="Show a maintenance screen to all users on the client app."
          enabled={form.maintenance_mode}
          onToggle={(v) => set('maintenance_mode', v)}
          danger
        >
          {form.maintenance_mode && (
            <div className="mt-3">
              <label className="text-xs text-muted-foreground mb-1 block">
                Message shown to users (optional)
              </label>
              <input
                type="text"
                value={form.maintenance_message ?? ''}
                onChange={(e) => set('maintenance_message', e.target.value || null)}
                placeholder="e.g. We'll be back shortly."
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
        </FlagCard>

        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Anonymous User Limit</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Max projects an anonymous user can create. Set to 0 to disable anonymous access.
              </div>
            </div>
            <input
              type="number"
              min={0}
              max={100}
              value={form.anonymous_user_limit}
              onChange={(e) => set('anonymous_user_limit', parseInt(e.target.value, 10))}
              className="w-20 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <FlagCard
          title="Per-User Generation Limit"
          description="Cap how many AI generations each user can run per day. Off = unlimited."
          enabled={form.generation_limit_enabled}
          onToggle={(v) => set('generation_limit_enabled', v)}
        >
          {form.generation_limit_enabled ? (
            <div className="mt-3 flex items-center justify-between">
              <label className="text-xs text-muted-foreground">Max generations per user / day</label>
              <input
                type="number"
                min={1}
                max={10000}
                value={form.generation_daily_limit}
                onChange={(e) => set('generation_daily_limit', parseInt(e.target.value, 10) || 1)}
                className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground">Currently unlimited.</div>
          )}
        </FlagCard>

        <div className="pt-2">
          <h2 className="text-sm font-semibold text-foreground">Simulation runtime</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Kill switches for the viewer&apos;s simulation pipeline. Each takes effect on the next page load;
            none requires a deploy.
          </p>
        </div>

        <ChoiceCard
          title="Resident simulation pool"
          description="How many simulation documents may stay resident. Single keeps exactly one alive — the safe setting if simulations are leaking memory or crashing tabs."
          value={form.sim_pool_mode}
          options={[
            { value: 'single', label: 'Single (safe)' },
            { value: 'adaptive', label: 'Adaptive' },
          ]}
          onChange={(v) => set('sim_pool_mode', v as Controls['sim_pool_mode'])}
        />

        <ChoiceCard
          title="Predictive scheduler"
          description="Prepares an upcoming section's simulation before the playhead reaches it. Off falls back to preparing on arrival."
          value={form.sim_scheduler_mode}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'predictive', label: 'Predictive' },
          ]}
          onChange={(v) => set('sim_scheduler_mode', v as Controls['sim_scheduler_mode'])}
        />

        <FlagCard
          title="Frame-valid transition coordinator"
          description="Holds the video→simulation handoff until the simulation has actually submitted a frame, instead of revealing on a timer. Off restores the previous handoff exactly."
          enabled={form.sim_transition_coordinator}
          onToggle={(v) => set('sim_transition_coordinator', v)}
        />

        <FlagCard
          title="Adaptive quality"
          description="Lets a simulation lower its own render quality when it cannot hold frame rate."
          enabled={form.sim_adaptive_quality}
          onToggle={(v) => set('sim_adaptive_quality', v)}
        />

        <FlagCard
          title="Boundary sentinel"
          description="Watches the section boundary with requestVideoFrameCallback so a handoff cannot be missed between animation frames."
          enabled={form.sim_boundary_sentinel}
          onToggle={(v) => set('sim_boundary_sentinel', v)}
        />

        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <div className="flex-1 pr-4">
              <div className="text-sm font-medium">Simulation telemetry sample rate</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Fraction of viewer sessions that report simulation timings. Set to 0 to stop ingestion entirely.
              </div>
            </div>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={form.rum_sample_rate}
              onChange={(e) => {
                // An empty or non-numeric field must not send NaN — the PATCH would 400 and the
                // operator would lose every other unsaved change on this page with it.
                const n = parseFloat(e.target.value);
                set('rum_sample_rate', Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
              }}
              className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      </div>
    </AdminShell>
  );
}

function ChoiceCard({
  title,
  description,
  value,
  options,
  onChange,
}: {
  title: string;
  description: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="flex-1 pr-4">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
        </div>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={title}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function FlagCard({
  title,
  description,
  enabled,
  onToggle,
  danger,
  children,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  danger?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border bg-card p-5 transition-colors ${
        enabled && danger ? 'border-destructive/50' : 'border-border'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 pr-4">
          <div className={`text-sm font-medium ${enabled && danger ? 'text-destructive' : 'text-foreground'}`}>
            {title}
            {enabled && danger && <span className="ml-2 text-xs">[ACTIVE]</span>}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
        </div>
        <Toggle checked={enabled} onChange={onToggle} danger={danger && enabled} />
      </div>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  danger,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? (danger ? 'bg-destructive' : 'bg-primary') : 'bg-muted'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
