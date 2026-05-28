'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { AdminSettings } from 'shared/src/generated/admin-v1';

type Config = Pick<
  AdminSettings,
  | 'default_provider'
  | 'temperature'
  | 'max_tokens'
  | 'extended_thinking_enabled'
  | 'thinking_budget_tokens'
  | 'utility_model'
  | 'generation_model'
  | 'complex_model'
  | 'complex_min_corpus_tokens'
  | 'complex_min_retries'
  | 'tts_provider'
  | 'elevenlabs_model'
  | 'default_voice_id_a'
  | 'default_voice_id_b'
>;

const PROVIDER_OPTIONS = ['claude', 'openai', 'gemini'] as const;

export default function LlmConfigPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [form, setForm] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .getLlmConfig()
      .then((s) => {
        const c: Config = {
          default_provider: s.default_provider,
          temperature: s.temperature,
          max_tokens: s.max_tokens,
          extended_thinking_enabled: s.extended_thinking_enabled,
          thinking_budget_tokens: s.thinking_budget_tokens,
          utility_model: s.utility_model,
          generation_model: s.generation_model,
          complex_model: s.complex_model,
          complex_min_corpus_tokens: s.complex_min_corpus_tokens,
          complex_min_retries: s.complex_min_retries,
          tts_provider: s.tts_provider ?? 'elevenlabs',
          elevenlabs_model: s.elevenlabs_model ?? 'eleven_turbo_v2_5',
          default_voice_id_a: s.default_voice_id_a ?? '',
          default_voice_id_b: s.default_voice_id_b ?? '',
        };
        setConfig(c);
        setForm(c);
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
      setConfig(form);
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
        <h1 className="text-2xl font-bold">LLM Config</h1>
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

      <div className="max-w-2xl space-y-8">
        <Section title="Provider & Defaults">
          <Field label="Default Provider">
            <select
              value={form.default_provider}
              onChange={(e) => set('default_provider', e.target.value as Config['default_provider'])}
              className="input"
            >
              {PROVIDER_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Temperature" hint="0–2">
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              onChange={(e) => set('temperature', parseFloat(e.target.value))}
              className="input"
            />
          </Field>

          <Field label="Max Output Tokens" hint="256–32768">
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
        </Section>

        <Section title="Extended Thinking (Claude)">
          <Field label="Enable Extended Thinking">
            <Toggle
              checked={form.extended_thinking_enabled}
              onChange={(v) => set('extended_thinking_enabled', v)}
            />
          </Field>

          <Field label="Thinking Budget Tokens">
            <input
              type="number"
              min={1000}
              step={1000}
              value={form.thinking_budget_tokens}
              onChange={(e) => set('thinking_budget_tokens', parseInt(e.target.value, 10))}
              className="input"
              disabled={!form.extended_thinking_enabled}
            />
          </Field>
        </Section>

        <Section title="Model Tiers">
          <Field label="Utility Model" hint="Moderation, rewrite">
            <input
              type="text"
              value={form.utility_model}
              onChange={(e) => set('utility_model', e.target.value)}
              className="input font-mono"
            />
          </Field>

          <Field label="Generation Model" hint="Pass 1 draft">
            <input
              type="text"
              value={form.generation_model}
              onChange={(e) => set('generation_model', e.target.value)}
              className="input font-mono"
            />
          </Field>

          <Field label="Complex Model" hint="Pass 0 structural analysis">
            <input
              type="text"
              value={form.complex_model}
              onChange={(e) => set('complex_model', e.target.value)}
              className="input font-mono"
            />
          </Field>
        </Section>

        <Section title="Complex Tier Routing">
          <Field label="Min Corpus Tokens for Complex" hint="Below this uses generation model">
            <input
              type="number"
              min={0}
              step={1000}
              value={form.complex_min_corpus_tokens}
              onChange={(e) => set('complex_min_corpus_tokens', parseInt(e.target.value, 10))}
              className="input"
            />
          </Field>

          <Field label="Min Retries Before Escalation">
            <input
              type="number"
              min={0}
              max={5}
              value={form.complex_min_retries}
              onChange={(e) => set('complex_min_retries', parseInt(e.target.value, 10))}
              className="input"
            />
          </Field>
        </Section>

        <Section title="Voice Synthesis (TTS)">
          <Field label="TTS Provider" hint="elevenlabs or gemini">
            <select
              value={form.tts_provider}
              onChange={(e) => set('tts_provider', e.target.value as Config['tts_provider'])}
              className="input"
            >
              <option value="elevenlabs">ElevenLabs</option>
              <option value="gemini">Gemini</option>
            </select>
          </Field>

          <Field label="ElevenLabs Model" hint="eleven_turbo_v2_5 (fast/cheap) · eleven_multilingual_v2 (quality)">
            <select
              value={form.elevenlabs_model}
              onChange={(e) => set('elevenlabs_model', e.target.value)}
              className="input font-mono"
              disabled={form.tts_provider !== 'elevenlabs'}
            >
              <option value="eleven_turbo_v2_5">eleven_turbo_v2_5 — fast, cheap, recommended for MVP</option>
              <option value="eleven_multilingual_v2">eleven_multilingual_v2 — higher quality, multilingual</option>
              <option value="eleven_v3">eleven_v3 — latest, best expressiveness</option>
            </select>
          </Field>

          <Field label="Host A Voice ID" hint="ElevenLabs voice ID — leave blank to use default (George)">
            <input
              type="text"
              value={form.default_voice_id_a ?? ''}
              onChange={(e) => set('default_voice_id_a', e.target.value || null)}
              placeholder="JBFqnCBsd6RMkjVDRZzb"
              className="input font-mono"
              disabled={form.tts_provider !== 'elevenlabs'}
            />
          </Field>

          <Field label="Host B Voice ID" hint="ElevenLabs voice ID — leave blank to use default (Nicole)">
            <input
              type="text"
              value={form.default_voice_id_b ?? ''}
              onChange={(e) => set('default_voice_id_b', e.target.value || null)}
              placeholder="pNInz6obpgDQGcFmaJgB"
              className="input font-mono"
              disabled={form.tts_provider !== 'elevenlabs'}
            />
          </Field>
        </Section>
      </div>
    </AdminShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">{title}</h2>
      <div className="rounded-lg border border-border bg-card p-4 space-y-4">{children}</div>
    </div>
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
    <div className="flex items-center gap-4">
      <div className="w-56 shrink-0">
        <div className="text-sm text-foreground">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        checked ? 'bg-primary' : 'bg-muted'
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
