'use client';

import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { getByokStatus, saveMyAnamKey } from './avatarApi';

// The signed-in user's own Anam API key (BYOK). Shown in Home → Settings → AI.
// When the admin enables BYOK, each video the user owns uses this key for its
// Ask-the-Avatar sessions; otherwise the shared server key is used.
export function AnamKeyField() {
  const [status, setStatus] = useState<{ byokEnabled: boolean; hasKey: boolean }>({ byokEnabled: false, hasKey: false });
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => { getByokStatus().then(setStatus).catch(() => {}); }, []);

  const save = async (clear = false) => {
    setSaving(true); setMsg('');
    try {
      const r = await saveMyAnamKey(clear ? '' : value);
      setStatus((s) => ({ ...s, hasKey: r.hasKey }));
      setValue('');
      setMsg(r.hasKey ? '✓ Saved' : '✓ Cleared');
      setTimeout(() => setMsg(''), 2500);
    } catch (e) { setMsg((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 shadow-sm-soft">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <KeyRound size={15} strokeWidth={1.8} aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Ask-the-Avatar (Anam)</h3>
          <p className="text-xs text-muted-foreground">
            {status.byokEnabled
              ? (status.hasKey ? 'Your key is set — your videos use it.' : 'Bring-your-own-key is enabled — add your Anam key below.')
              : 'Currently using the shared server key for everyone. You can still pre-set your own key here.'}
          </p>
        </div>
        {status.hasKey && <span className="ml-auto shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-600">Key set</span>}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={status.hasKey ? '•••••••••• (enter a new key to replace)' : 'Paste your Anam API key'}
          className="min-w-[200px] flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-ring"
        />
        <button onClick={() => save(false)} disabled={saving || !value.trim()} className="rounded-lg gradient-action px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
          {saving ? 'Saving…' : 'Save key'}
        </button>
        {status.hasKey && (
          <button onClick={() => save(true)} disabled={saving} className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground">
            Remove
          </button>
        )}
        {msg && <span className="text-xs font-medium text-emerald-600">{msg}</span>}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">Get a key at lab.anam.ai → Settings → API Keys. Stored encrypted; never shown again.</p>
    </div>
  );
}
