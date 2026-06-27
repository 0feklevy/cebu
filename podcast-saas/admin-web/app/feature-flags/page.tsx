'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { AdminSettings } from 'shared/src/generated/admin-v1';

type Controls = Pick<AdminSettings, 'maintenance_mode' | 'maintenance_message' | 'anonymous_user_limit'>;

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
      </div>
    </AdminShell>
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
