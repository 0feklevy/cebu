'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminShell } from '../../components/AdminShell';
import {
  getAvatarConfig, setAvatarByok, getAvatarStats, getAvatarGallery, deleteAvatarVisual, getAvatarConversations,
  type AvatarConfig, type AvatarStats, type AvatarGalleryItem, type AvatarSession,
} from '../../lib/avatarAdminApi';

type Tab = 'gallery' | 'conversations';

export default function AvatarAdminPage() {
  const [config, setConfig] = useState<AvatarConfig | null>(null);
  const [stats, setStats] = useState<AvatarStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('gallery');

  // gallery state
  const [items, setItems] = useState<AvatarGalleryItem[]>([]);
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({});
  const [type, setType] = useState('');
  const [scope, setScope] = useState('');
  const [q, setQ] = useState('');
  const [galleryLoading, setGalleryLoading] = useState(false);

  // conversations state
  const [sessions, setSessions] = useState<AvatarSession[]>([]);

  useEffect(() => {
    Promise.all([getAvatarConfig(), getAvatarStats()])
      .then(([c, s]) => { setConfig(c); setStats(s); })
      .catch((e) => setError((e as Error).message));
  }, []);

  const loadGallery = useCallback(async () => {
    setGalleryLoading(true);
    try {
      const res = await getAvatarGallery({ type: type || undefined, scope: scope || undefined, q: q || undefined });
      setItems(res.items);
      setTypeCounts(res.typeCounts);
    } catch (e) { setError((e as Error).message); } finally { setGalleryLoading(false); }
  }, [type, scope, q]);

  useEffect(() => { if (tab === 'gallery') loadGallery(); }, [tab, loadGallery]);
  useEffect(() => { if (tab === 'conversations') getAvatarConversations().then((r) => setSessions(r.sessions)).catch((e) => setError((e as Error).message)); }, [tab]);

  const del = async (id: string) => {
    if (!confirm('Delete this visual?')) return;
    await deleteAvatarVisual(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  return (
    <AdminShell>
      <h1 className="text-2xl font-bold mb-1">Avatar</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Ask-the-Avatar — live conversation + the visual Library (basic &amp; extended), ported from darwin-avatar.
      </p>

      {error && <div className="mb-4 px-4 py-3 rounded-lg bg-destructive/20 text-destructive text-sm">{error}</div>}

      {/* Configuration */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Configuration</h2>
        <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
          <ConfigCard label="Anam configured" ok={config?.anam_configured} />
          <ConfigCard label="ANAM_API_KEY" ok={config?.anam_api_key} />
          <ConfigCard label="OpenAI key" ok={config?.openai} />
          <ConfigCard label="Einstein persona" ok={config?.persona_einstein} />
          <ConfigCard label="Darwin persona" ok={config?.persona_darwin} />
          <ConfigCard label="Default" text={config?.default_character ?? '—'} />
        </div>
        {/* BYOK toggle */}
        <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-card p-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Bring-your-own Anam key (BYOK)</p>
            <p className="text-xs text-muted-foreground">
              {config?.byok_enabled
                ? 'ON — each video uses its owner&apos;s Anam key (set in their Home → Settings → AI). Falls back to the shared key if unset.'
                : 'OFF — everyone uses the shared server ANAM_API_KEY.'}
            </p>
          </div>
          <button
            onClick={async () => {
              if (!config) return;
              try { const r = await setAvatarByok(!config.byok_enabled); setConfig({ ...config, byok_enabled: r.byok_enabled }); }
              catch (e) { setError((e as Error).message); }
            }}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${config?.byok_enabled ? 'bg-primary' : 'bg-muted'}`}
            aria-pressed={config?.byok_enabled}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${config?.byok_enabled ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </div>
      </section>

      {/* Stats */}
      {stats && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Library &amp; usage</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Metric label="Total visuals" value={stats.total_visuals} />
            <Metric label="Basic" value={stats.by_scope.basic ?? 0} />
            <Metric label="Extended" value={stats.by_scope.extended ?? 0} />
            <Metric label="Conversation turns" value={stats.conversation_turns} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(stats.by_type).map(([k, v]) => (
              <span key={k} className="px-2.5 py-1 rounded-full bg-muted text-muted-foreground">{k}: <b className="text-foreground">{v}</b></span>
            ))}
            {Object.entries(stats.by_source).map(([k, v]) => (
              <span key={k} className="px-2.5 py-1 rounded-full bg-primary/10 text-primary">{k}: <b>{v}</b></span>
            ))}
          </div>
        </section>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-4 border-b border-border">
        {(['gallery', 'conversations'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t === 'gallery' ? 'Library / Gallery' : 'Conversations'}
          </button>
        ))}
      </div>

      {tab === 'gallery' ? (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm">
              <option value="">All scopes</option><option value="basic">Basic</option><option value="extended">Extended</option>
            </select>
            <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm">
              <option value="">All types</option>
              {['image', 'simulation', 'chart', 'diagram', 'equation'].map((t) => (
                <option key={t} value={t}>{t}{typeCounts[t] ? ` (${typeCounts[t]})` : ''}</option>
              ))}
            </select>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadGallery(); }}
              placeholder="Search captions…" className="flex-1 min-w-[180px] rounded-lg border border-border bg-card px-3 py-1.5 text-sm" />
            <button onClick={loadGallery} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">Search</button>
          </div>

          {galleryLoading ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No visuals found.</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {items.map((item) => <GalleryCard key={item.id} item={item} onDelete={() => del(item.id)} />)}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-4">
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No conversations recorded yet.</p>
          ) : sessions.map((s) => (
            <div key={s.session_key} className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{s.character_id}</span>
                <span className="font-mono">{s.session_key}</span>
              </div>
              <div className="space-y-1.5">
                {s.turns.map((t, i) => (
                  <p key={i} className="text-sm">
                    <span className={t.role === 'user' ? 'text-primary font-medium' : 'text-muted-foreground font-medium'}>{t.role === 'user' ? 'Visitor' : 'Avatar'}: </span>
                    {t.content}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </AdminShell>
  );
}

function ConfigCard({ label, ok, text }: { label: string; ok?: boolean; text?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[11px] text-muted-foreground mb-1">{label}</div>
      {text !== undefined
        ? <div className="text-sm font-semibold">{text}</div>
        : <div className={`text-sm font-semibold ${ok ? 'text-primary' : 'text-destructive'}`}>{ok ? '✓ Yes' : '✗ No'}</div>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-xl font-bold">{value.toLocaleString()}</div>
    </div>
  );
}

function GalleryCard({ item, onDelete }: { item: AvatarGalleryItem; onDelete: () => void }) {
  const spec = item.visual_spec as Record<string, unknown> | null;
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="relative aspect-[16/10] bg-muted flex items-center justify-center overflow-hidden">
        <span className="absolute top-1.5 left-1.5 z-10 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-black/60 text-white">{item.scope}</span>
        <span className="absolute top-1.5 right-1.5 z-10 text-[9px] font-bold px-1.5 py-0.5 rounded bg-black/50 text-white">{item.visual_type}</span>
        {item.visual_type === 'image' && item.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.image_url} alt={item.alt_text ?? ''} className="w-full h-full object-cover" />
        ) : item.visual_type === 'simulation' && item.sim_entry_url ? (
          <iframe src={item.sim_entry_url} title="sim" sandbox="allow-scripts allow-same-origin" className="w-full h-full border-0" />
        ) : item.visual_type === 'diagram' && typeof spec?.html === 'string' ? (
          <iframe srcDoc={spec.html as string} title="diagram" sandbox="allow-scripts" className="w-full h-full border-0" />
        ) : (
          <span className="text-3xl">{item.visual_type === 'equation' ? '∑' : item.visual_type === 'chart' ? '📊' : '🖼️'}</span>
        )}
      </div>
      <div className="p-2.5">
        <p className="text-xs text-foreground/80 line-clamp-2 mb-1.5">{item.caption || item.alt_text || '(no caption)'}</p>
        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span className="truncate">{item.project_title ?? 'Global'} · used {item.use_count}×</span>
          <button onClick={onDelete} className="shrink-0 text-destructive hover:underline">Delete</button>
        </div>
      </div>
    </div>
  );
}
