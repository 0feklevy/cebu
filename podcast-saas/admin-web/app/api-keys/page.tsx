'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { ApiKeyStatus } from 'shared/src/generated/admin-v1';

type Provider = 'claude' | 'openai' | 'gemini' | 'elevenlabs';

const PROVIDERS: { id: Provider; label: string; placeholder: string; description: string }[] = [
  { id: 'elevenlabs', label: 'ElevenLabs', placeholder: 'sk_…', description: 'Voice synthesis (TTS)' },
  { id: 'claude', label: 'Anthropic (Claude)', placeholder: 'sk-ant-…', description: 'Script generation' },
  { id: 'gemini', label: 'Google (Gemini)', placeholder: 'AIza…', description: 'Script generation / TTS fallback' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…', description: 'Script generation fallback' },
];

interface KeyEntry {
  status: ApiKeyStatus | null;
  draft: string;
  testing: boolean;
  testResult: { valid: boolean; model?: string; error?: string } | null;
  saving: boolean;
  deleting: boolean;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<Record<Provider, KeyEntry>>({
    elevenlabs: { status: null, draft: '', testing: false, testResult: null, saving: false, deleting: false },
    claude: { status: null, draft: '', testing: false, testResult: null, saving: false, deleting: false },
    openai: { status: null, draft: '', testing: false, testResult: null, saving: false, deleting: false },
    gemini: { status: null, draft: '', testing: false, testResult: null, saving: false, deleting: false },
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .listApiKeys()
      .then((statuses) => {
        setKeys((prev) => {
          const next = { ...prev };
          for (const s of statuses) {
            next[s.provider] = { ...next[s.provider], status: s };
          }
          return next;
        });
      })
      .catch((e) => setError(e.message));
  }, []);

  const update = (provider: Provider, patch: Partial<KeyEntry>) =>
    setKeys((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }));

  const testKey = async (provider: Provider) => {
    const draft = keys[provider].draft.trim();
    if (!draft) return;
    update(provider, { testing: true, testResult: null });
    try {
      const result = await adminApi.testApiKey(provider, draft);
      update(provider, { testResult: result });
    } catch (e) {
      update(provider, { testResult: { valid: false, error: (e as Error).message } });
    } finally {
      update(provider, { testing: false });
    }
  };

  const saveKey = async (provider: Provider) => {
    const draft = keys[provider].draft.trim();
    if (!draft) return;
    update(provider, { saving: true });
    setError(null);
    try {
      await adminApi.setApiKey(provider, draft);
      const statuses = await adminApi.listApiKeys();
      const s = statuses.find((x) => x.provider === provider) ?? null;
      update(provider, { status: s, draft: '', testResult: null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      update(provider, { saving: false });
    }
  };

  const deleteKey = async (provider: Provider) => {
    if (!confirm(`Remove the ${provider} API key? This cannot be undone.`)) return;
    update(provider, { deleting: true });
    try {
      await adminApi.deleteApiKey(provider);
      update(provider, { status: { provider, set: false, last_updated: null }, deleting: false });
    } catch (e) {
      setError((e as Error).message);
      update(provider, { deleting: false });
    }
  };

  return (
    <AdminShell>
      <h1 className="text-2xl font-bold mb-6">API Keys</h1>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-destructive/20 text-destructive text-sm">{error}</div>
      )}

      <div className="max-w-2xl space-y-6">
        {PROVIDERS.map(({ id, label, placeholder, description }) => {
          const entry = keys[id];
          return (
            <div key={id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="text-sm font-semibold">{label}</div>
                  <div className="text-xs text-muted-foreground">{description}</div>
                  {entry.status?.set ? (
                    <div className="text-xs text-primary mt-0.5">
                      Key set
                      {entry.status.last_updated &&
                        ` · updated ${new Date(entry.status.last_updated).toLocaleDateString()}`}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground mt-0.5">No key configured</div>
                  )}
                </div>

                {entry.status?.set && (
                  <button
                    onClick={() => deleteKey(id)}
                    disabled={entry.deleting}
                    className="text-xs px-2 py-1 text-destructive border border-destructive/40 rounded hover:bg-destructive/10 transition-colors disabled:opacity-60"
                  >
                    {entry.deleting ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </div>

              <div className="space-y-2">
                <input
                  type="password"
                  value={entry.draft}
                  onChange={(e) => update(id, { draft: e.target.value, testResult: null })}
                  placeholder={placeholder}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  autoComplete="off"
                />

                {entry.testResult && (
                  <div
                    className={`text-xs px-3 py-2 rounded-md ${
                      entry.testResult.valid
                        ? 'bg-primary/10 text-primary'
                        : 'bg-destructive/10 text-destructive'
                    }`}
                  >
                    {entry.testResult.valid
                      ? `Valid · ${(entry.testResult as any).tier ?? entry.testResult.model ?? 'connected'}`
                      : `Invalid · ${entry.testResult.error}`}
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => testKey(id)}
                    disabled={!entry.draft.trim() || entry.testing}
                    className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent/50 transition-colors disabled:opacity-40"
                  >
                    {entry.testing ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    onClick={() => saveKey(id)}
                    disabled={!entry.draft.trim() || entry.saving}
                    className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-40"
                  >
                    {entry.saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AdminShell>
  );
}
