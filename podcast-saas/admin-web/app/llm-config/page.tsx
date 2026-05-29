'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { AdminSettings } from 'shared/src/generated/admin-v1';

type Config = Pick<AdminSettings, 'utility_model' | 'temperature' | 'max_tokens'>;

export default function AiConfigPage() {
  const [form, setForm] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .getLlmConfig()
      .then((s) => {
        setForm({
          utility_model: s.utility_model,
          temperature: s.temperature,
          max_tokens: s.max_tokens,
        });
      })
      .catch((e) => setError(e.message));
  }, []);

  const set = <K extends keyof Config>(key: K, value: Config[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      await adminApi.updateLlmConfig(form);
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
        <div>
          <h1 className="text-2xl font-bold">AI Config</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Settings for AI bridge function extraction (SimulationService)
          </p>
        </div>
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

      <div className="max-w-2xl">
        <div className="rounded-lg border border-border bg-card p-5 space-y-5">
          <Field
            label="Extraction Model"
            hint="Claude model used to extract bridge functions from simulation JS"
          >
            <input
              type="text"
              value={form.utility_model}
              onChange={(e) => set('utility_model', e.target.value)}
              className="input font-mono"
              placeholder="claude-haiku-4-5"
            />
          </Field>

          <Field label="Temperature" hint="0–1 · lower = more deterministic JSON output">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={form.temperature}
              onChange={(e) => set('temperature', parseFloat(e.target.value))}
              className="input"
            />
          </Field>

          <Field label="Max Output Tokens" hint="Budget for the JSON extraction response">
            <input
              type="number"
              min={256}
              max={8192}
              step={256}
              value={form.max_tokens}
              onChange={(e) => set('max_tokens', parseInt(e.target.value, 10))}
              className="input"
            />
          </Field>
        </div>
      </div>
    </AdminShell>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="w-56 shrink-0 pt-2">
        <div className="text-sm text-foreground">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}
