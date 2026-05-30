'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { AdminSettings } from 'shared/src/generated/admin-v1';

type Config = Pick<
  AdminSettings,
  | 'utility_model'
  | 'generation_model'
  | 'complex_model'
  | 'temperature'
  | 'max_tokens'
  | 'extended_thinking_enabled'
  | 'thinking_budget_tokens'
>;

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
          utility_model:              s.utility_model,
          generation_model:           s.generation_model,
          complex_model:              s.complex_model,
          temperature:                s.temperature,
          max_tokens:                 s.max_tokens,
          extended_thinking_enabled:  s.extended_thinking_enabled,
          thinking_budget_tokens:     s.thinking_budget_tokens,
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
            Model routing and generation settings
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

      <div className="max-w-2xl space-y-6">

        {/* Model Tiers */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Model Tiers
          </h2>
          <div className="rounded-lg border border-border bg-card p-5 space-y-5">
            <Field
              label="Utility Model"
              hint="Content moderation, video prompt enhancement — fast &amp; cheap"
            >
              <input
                type="text"
                value={form.utility_model}
                onChange={(e) => set('utility_model', e.target.value)}
                className="input font-mono"
                placeholder="claude-haiku-4-5"
              />
            </Field>

            <Field
              label="Generation Model"
              hint="Standard script generation tasks"
            >
              <input
                type="text"
                value={form.generation_model}
                onChange={(e) => set('generation_model', e.target.value)}
                className="input font-mono"
                placeholder="claude-sonnet-4-6"
              />
            </Field>

            <Field
              label="Complex Model"
              hint="Bridge plan generation, structural analysis — uses strongest model + optional extended thinking"
            >
              <input
                type="text"
                value={form.complex_model}
                onChange={(e) => set('complex_model', e.target.value)}
                className="input font-mono"
                placeholder="claude-sonnet-4-6"
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Supported: claude-haiku-4-5, claude-haiku-4-5-20251001, claude-sonnet-4-5, claude-sonnet-4-6, claude-opus-4-7, claude-opus-4-8
          </p>
        </section>

        {/* Extended Thinking */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Extended Thinking (Complex Tier)
          </h2>
          <div className="rounded-lg border border-border bg-card p-5 space-y-5">
            <Field
              label="Enable Thinking"
              hint="Claude reasons step-by-step before answering — higher quality for complex simulations"
            >
              <button
                type="button"
                onClick={() => set('extended_thinking_enabled', !form.extended_thinking_enabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  form.extended_thinking_enabled ? 'bg-primary' : 'bg-muted'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    form.extended_thinking_enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </Field>

            {form.extended_thinking_enabled && (
              <Field
                label="Thinking Budget"
                hint="Max tokens Claude can use for internal reasoning (1,000–32,000)"
              >
                <input
                  type="number"
                  min={1000}
                  max={32000}
                  step={1000}
                  value={form.thinking_budget_tokens}
                  onChange={(e) => set('thinking_budget_tokens', parseInt(e.target.value, 10))}
                  className="input"
                />
              </Field>
            )}
          </div>
        </section>

        {/* Generation Settings */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Generation Settings
          </h2>
          <div className="rounded-lg border border-border bg-card p-5 space-y-5">
            <Field label="Temperature" hint="0–1 · lower = more deterministic JSON output · forced to 1.0 when thinking is on">
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={form.temperature}
                onChange={(e) => set('temperature', parseFloat(e.target.value))}
                className="input"
                disabled={form.extended_thinking_enabled}
              />
            </Field>

            <Field label="Max Output Tokens" hint="Token budget for the model response">
              <input
                type="number"
                min={256}
                max={32768}
                step={256}
                value={form.max_tokens}
                onChange={(e) => set('max_tokens', parseInt(e.target.value, 10))}
                className="input"
              />
            </Field>
          </div>
        </section>
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
