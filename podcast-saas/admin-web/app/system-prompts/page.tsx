'use client';

import { useEffect, useState, useCallback } from 'react';
import { adminApi } from '../../lib/api';
import { AdminShell } from '../../components/AdminShell';
import type { SystemPrompt } from 'shared/src/generated/admin-v1';

export default function SystemPromptsPage() {
  const [prompts, setPrompts] = useState<SystemPrompt[]>([]);
  const [selected, setSelected] = useState<SystemPrompt | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .listSystemPrompts()
      .then((p) => {
        setPrompts(p);
        if (p.length > 0) {
          setSelected(p[0]);
          setDraft(p[0].content);
        }
      })
      .catch((e) => setError(e.message));
  }, []);

  const select = useCallback((p: SystemPrompt) => {
    setSelected(p);
    setDraft(p.content);
    setSaved(false);
    setError(null);
  }, []);

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await adminApi.updateSystemPrompt(selected.key, draft);
      setPrompts((prev) => prev.map((p) => (p.key === updated.key ? updated : p)));
      setSelected(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (selected) setDraft(selected.content);
  };

  return (
    <AdminShell>
      <h1 className="text-2xl font-bold mb-6">System Prompts</h1>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-destructive/20 text-destructive text-sm">{error}</div>
      )}

      <div className="flex gap-6 h-[calc(100vh-12rem)]">
        {/* Prompt list */}
        <div className="w-56 shrink-0 rounded-lg border border-border bg-card overflow-auto">
          {prompts.map((p) => (
            <button
              key={p.key}
              onClick={() => select(p)}
              className={`w-full text-left px-4 py-3 border-b border-border last:border-0 text-sm transition-colors ${
                selected?.key === p.key
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              }`}
            >
              <div className="font-medium truncate">{p.key}</div>
              {p.is_customized && (
                <div className="text-xs text-primary mt-0.5">customized</div>
              )}
            </button>
          ))}
        </div>

        {/* Editor pane */}
        {selected ? (
          <div className="flex-1 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-sm text-foreground">{selected.key}</span>
                {selected.is_customized && (
                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                    customized
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={reset}
                  className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent/50 transition-colors"
                >
                  Reset
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-60"
                >
                  {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
                </button>
              </div>
            </div>

            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="flex-1 w-full rounded-lg border border-input bg-card px-4 py-3 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              spellCheck={false}
            />

            <div className="text-xs text-muted-foreground">
              {draft.length} chars · last updated{' '}
              {new Date(selected.updated_at).toLocaleString()}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Select a prompt to edit
          </div>
        )}
      </div>
    </AdminShell>
  );
}
