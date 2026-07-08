'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Link2, Loader2, Mic, Music4, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/firebase';
import { PodcastChrome, PodcastButton } from './PodcastChrome';
import { PodcastScriptEditor } from './PodcastScriptEditor';
import { PodcastStudioTab } from './studio/PodcastStudioTab';
import type { PodcastEpisode, PodcastEpisodeWithSources, PodcastShow, PodcastSource } from 'shared/src/generated/client-v1';

type Tab = 'brief' | 'script' | 'audio';

const fieldCls =
  'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary focus-ring';

const SRC_STATUS: Record<string, { label: string; color: string }> = {
  pending:    { label: 'Pending',    color: '#94a3b8' },
  processing: { label: 'Extracting…', color: '#f59e0b' },
  ready:      { label: 'Ready',      color: '#10b981' },
  failed:     { label: 'Failed',     color: '#ef4444' },
};

export function PodcastEpisodePage({ showId, episodeId }: { showId: string; episodeId: string }) {
  const { loading: authLoading } = useAuth();
  const [show, setShow] = useState<PodcastShow | null>(null);
  const [episode, setEpisode] = useState<PodcastEpisodeWithSources | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>('brief');
  // Lazily mount Script/Audio on first visit, then keep them mounted (hidden when
  // inactive) so switching tabs doesn't discard editor/render state or refetch.
  const [visited, setVisited] = useState<{ script: boolean; audio: boolean }>({ script: false, audio: false });
  useEffect(() => {
    if (tab === 'script' || tab === 'audio') setVisited((v) => (v[tab] ? v : { ...v, [tab]: true }));
  }, [tab]);

  // Brief form
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [autoLength, setAutoLength] = useState(true);   // target_minutes === 0 → auto
  const [minutes, setMinutes] = useState(8);
  const [savedFlash, setSavedFlash] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sources
  const [urlInput, setUrlInput] = useState('');
  const [addingUrl, setAddingUrl] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    Promise.all([api.getPodcastShow(showId), api.getPodcastEpisode(showId, episodeId)])
      .then(([s, ep]) => {
        if (cancelled) return;
        setShow(s);
        setEpisode(ep);
        setTitle(ep.title ?? '');
        setBrief(ep.brief ?? '');
        setAutoLength((ep.target_minutes ?? 0) === 0);
        setMinutes(ep.target_minutes && ep.target_minutes > 0 ? ep.target_minutes : 8);
      })
      .catch(() => { if (!cancelled) setNotFound(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authLoading, showId, episodeId]);

  const persist = useCallback(
    async (patch: { title?: string; brief?: string; target_minutes?: number }) => {
      try {
        const updated = await api.updatePodcastEpisode(showId, episodeId, patch);
        setEpisode((prev) => (prev ? { ...prev, ...updated } : prev));
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
      } catch (err) {
        console.error('Save brief failed', err);
      }
    },
    [showId, episodeId],
  );

  const scheduleSave = useCallback((patch: { title?: string; brief?: string; target_minutes?: number }) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(patch), 700);
  }, [persist]);

  // Poll while any source is still extracting.
  const pendingKey = (episode?.sources ?? []).filter((s) => s.status === 'processing' || s.status === 'pending').map((s) => s.id).join(',');
  useEffect(() => {
    if (!pendingKey) return;
    const tick = async () => {
      try {
        const rows = await api.listPodcastSources(showId, episodeId);
        setEpisode((prev) => (prev ? { ...prev, sources: rows } : prev));
      } catch { /* ignore */ }
    };
    const iv = setInterval(tick, 2500);
    return () => clearInterval(iv);
  }, [pendingKey, showId, episodeId]);

  const addUrl = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;
    setAddingUrl(true);
    try {
      const src = await api.createPodcastSource(showId, episodeId, { kind: 'url', source_url: url });
      setEpisode((prev) => (prev ? { ...prev, sources: [...prev.sources, src] } : prev));
      setUrlInput('');
    } catch (err) {
      console.error('Add url failed', err);
      window.alert('Could not add that link.');
    } finally {
      setAddingUrl(false);
    }
  }, [urlInput, showId, episodeId]);

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const src = await api.uploadPodcastSource(showId, episodeId, file);
      setEpisode((prev) => (prev ? { ...prev, sources: [...prev.sources, src] } : prev));
    } catch (err) {
      console.error('Upload failed', err);
      window.alert('Could not upload that file.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [showId, episodeId]);

  const deleteSource = useCallback(async (src: PodcastSource) => {
    setEpisode((prev) => (prev ? { ...prev, sources: prev.sources.filter((s) => s.id !== src.id) } : prev));
    try {
      await api.deletePodcastSource(showId, episodeId, src.id);
    } catch (err) {
      console.error('Delete source failed', err);
    }
  }, [showId, episodeId]);

  const [starting, setStarting] = useState(false);
  const startGeneration = useCallback(async () => {
    setStarting(true);
    try {
      await api.generatePodcastScript(showId, episodeId, {});
      setEpisode((prev) => (prev ? { ...prev, status: 'scripting' } : prev));
      setTab('script');
    } catch (err) {
      console.error('Generate failed', err);
      window.alert('Could not start the writers’ room — please try again.');
    } finally {
      setStarting(false);
    }
  }, [showId, episodeId]);

  const onEpisodeChange = useCallback((patch: Partial<PodcastEpisode>) => {
    setEpisode((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  if (notFound) {
    return (
      <PodcastChrome crumbs={[{ label: 'Not found' }]}>
        <p className="text-sm text-muted-foreground">This episode doesn&apos;t exist or you don&apos;t have access to it.</p>
      </PodcastChrome>
    );
  }

  const crumbs = [
    { label: show?.title?.trim() || 'Show', href: `/podcasts/${showId}` },
    { label: episode?.title?.trim() || `Episode ${episode?.episode_number ?? ''}` },
  ];

  const tabs = (
    <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
      {(['brief', 'script', 'audio'] as Tab[]).map((t) => {
        const active = tab === t;
        const label = t === 'brief' ? 'Brief' : t === 'script' ? 'Script' : 'Audio';
        const Icon = t === 'brief' ? FileText : t === 'script' ? Sparkles : Music4;
        return (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors focus-ring ${active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Icon size={14} strokeWidth={2} aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <PodcastChrome crumbs={crumbs} actions={tabs}>
      <div>
        {loading || authLoading || !episode ? (
          <div className="space-y-3"><div className="h-40 rounded-xl bg-muted/40 animate-pulse" /></div>
        ) : (
          <>
            <div className={tab === 'brief' ? '' : 'hidden'}>
              <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Episode title</span>
                <input
                  className={fieldCls}
                  value={title}
                  onChange={(e) => { setTitle(e.target.value); scheduleSave({ title: e.target.value }); }}
                  placeholder="Give this episode a name"
                />
              </label>
              <div className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Target length</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoLength}
                    onClick={() => {
                      const next = !autoLength;
                      setAutoLength(next);
                      scheduleSave({ target_minutes: next ? 0 : minutes });
                    }}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-ring ${autoLength ? 'bg-primary' : 'bg-muted'}`}
                    title="Let the writers' room choose the ideal length"
                  >
                    <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all" style={{ left: autoLength ? '22px' : '2px' }} />
                  </button>
                  <span className="text-sm font-medium text-foreground">{autoLength ? 'Auto' : `Up to ${minutes} min`}</span>
                </div>
                {autoLength ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">The writers&apos; room picks the ideal length for one idea.</p>
                ) : (
                  <input
                    type="range" min={3} max={20} value={minutes}
                    onChange={(e) => { const m = Number(e.target.value); setMinutes(m); scheduleSave({ target_minutes: m }); }}
                    className="mt-2 w-full sm:w-56"
                    style={{ accentColor: 'hsl(var(--primary))' }}
                  />
                )}
              </div>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">What&apos;s this episode about?</span>
              <textarea
                className={`${fieldCls} min-h-[160px] resize-y`}
                dir="auto"
                value={brief}
                onChange={(e) => { setBrief(e.target.value); scheduleSave({ brief: e.target.value }); }}
                placeholder="Drop your idea, the key points, the topic — anything. Have an analogy in mind? Write it here: it becomes the spine of the whole episode."
              />
              <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                {savedFlash ? <span style={{ color: '#10b981' }}>Saved</span> : <span>Autosaves as you type.</span>}
              </span>
            </label>

            {/* Sources */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sources (optional)</h3>
              <p className="mb-3 text-xs text-muted-foreground">Add reference material — a link, a PDF, notes — and the hosts will ground the episode in it.</p>

              <div className="mb-3 flex flex-col gap-2 sm:flex-row">
                <div className="flex flex-1 items-center gap-2">
                  <Link2 size={16} strokeWidth={1.9} className="shrink-0 text-muted-foreground" aria-hidden />
                  <input
                    className={fieldCls}
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addUrl(); }}
                    placeholder="Paste a URL…"
                  />
                  <PodcastButton variant="outline" onClick={addUrl} disabled={addingUrl || !urlInput.trim()}>
                    {addingUrl ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Plus size={15} strokeWidth={2} aria-hidden />}
                    Add
                  </PodcastButton>
                </div>
                <PodcastButton variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Upload size={15} strokeWidth={2} aria-hidden />}
                  Upload file
                </PodcastButton>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf,.md,.txt,.docx,.doc,.pptx,.html,.csv"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); }}
                />
              </div>

              {episode.sources.length > 0 && (
                <div className="space-y-1.5">
                  {episode.sources.map((src) => {
                    const st = SRC_STATUS[src.status] ?? SRC_STATUS.pending;
                    const Icon = src.kind === 'url' ? Link2 : src.kind === 'note' ? FileText : FileText;
                    return (
                      <div key={src.id} className="group flex items-center gap-2 rounded-lg border px-3 py-2" style={{ borderColor: 'hsl(var(--border))' }}>
                        <Icon size={15} strokeWidth={1.8} className="shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{src.title || src.source_url || 'Source'}</span>
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: st.color }}>
                          {src.status === 'processing' && <Loader2 size={12} className="animate-spin" aria-hidden />}
                          {st.label}
                        </span>
                        <button onClick={() => deleteSource(src)} title="Remove" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-ring">
                          <Trash2 size={14} strokeWidth={1.9} aria-hidden />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Generate → runs the writers' room and jumps to the Script tab */}
            <div className="flex items-center gap-3 rounded-xl border border-dashed border-primary/30 px-4 py-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Mic size={17} strokeWidth={1.9} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">Generate the script</p>
                <p className="text-xs text-muted-foreground">The multi-agent writers&apos; room turns this brief into a full two-host script you can edit line by line.</p>
              </div>
              <PodcastButton onClick={startGeneration} disabled={starting}>
                {starting ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Sparkles size={15} strokeWidth={2} aria-hidden />}
                Generate
              </PodcastButton>
            </div>
          </div>
            </div>
            {visited.script && show && (
              <div className={tab === 'script' ? '' : 'hidden'}>
                <PodcastScriptEditor
                  showId={showId}
                  episodeId={episodeId}
                  show={show}
                  onEpisodeChange={onEpisodeChange}
                  onApproved={() => { setTab('audio'); }}
                />
              </div>
            )}
            {visited.audio && (
              <div className={tab === 'audio' ? 'relative left-1/2 w-[95vw] -translate-x-1/2' : 'hidden'}>
                <PodcastStudioTab showId={showId} episodeId={episodeId} episode={episode} />
              </div>
            )}
          </>
        )}
      </div>
    </PodcastChrome>
  );
}
