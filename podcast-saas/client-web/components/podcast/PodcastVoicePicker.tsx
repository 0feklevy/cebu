'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Play, Search, X } from 'lucide-react';
import { api } from '../../lib/api';
import type { PodcastShow, SharedVoice } from 'shared/src/generated/client-v1';

const fieldCls = 'rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary focus-ring';

export function PodcastVoicePicker({
  showId, role, roleName, onClose, onSelected,
}: {
  showId: string;
  role: 'teacher' | 'learner';
  roleName: string;
  onClose: () => void;
  onSelected: (show: PodcastShow) => void;
}) {
  const [search, setSearch] = useState('');
  const [gender, setGender] = useState('');
  const [accent, setAccent] = useState('');
  const [useCase, setUseCase] = useState('');
  const [voices, setVoices] = useState<SharedVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  // Stop preview playback when the picker closes/unmounts.
  useEffect(() => () => { audioRef.current?.pause(); }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api.searchPodcastVoices({ search, gender, accent, use_case: useCase })
        .then((r) => { if (!cancelled) setVoices(r.voices); })
        .catch(() => { if (!cancelled) setVoices([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, gender, accent, useCase]);

  const playPreview = (v: SharedVoice) => {
    if (!v.preview_url) return;
    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.onended = () => setPlayingId(null);
    audioRef.current.onerror = () => setPlayingId(null);
    audioRef.current.src = v.preview_url;
    audioRef.current.play().catch(() => setPlayingId(null));
    setPlayingId(v.voice_id);
  };

  const select = async (v: SharedVoice) => {
    setSelecting(v.voice_id);
    try {
      const show = await api.selectPodcastVoice(showId, { role, public_owner_id: v.public_owner_id, voice_id: v.voice_id, name: v.name });
      onSelected(show);
    } catch (err) {
      console.error('Select voice failed', err);
      window.alert('Could not set that voice — check the ElevenLabs key/plan in admin.');
    } finally {
      setSelecting(null);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[810] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Choose a voice" className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-modal">
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="text-base font-semibold text-foreground">Voice for <span className="text-primary">{roleName}</span> ({role})</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-ring" aria-label="Close"><X size={17} aria-hidden /></button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
          <div className="relative flex-1 min-w-[160px]">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search voices…" className={`${fieldCls} w-full pl-8`} style={{ borderColor: 'hsl(var(--border))' }} />
          </div>
          <select value={gender} onChange={(e) => setGender(e.target.value)} className={fieldCls} style={{ borderColor: 'hsl(var(--border))' }}>
            <option value="">Any gender</option><option value="male">Male</option><option value="female">Female</option><option value="neutral">Neutral</option>
          </select>
          <select value={accent} onChange={(e) => setAccent(e.target.value)} className={fieldCls} style={{ borderColor: 'hsl(var(--border))' }}>
            <option value="">Any accent</option><option value="american">American</option><option value="british">British</option><option value="australian">Australian</option><option value="indian">Indian</option>
          </select>
          <select value={useCase} onChange={(e) => setUseCase(e.target.value)} className={fieldCls} style={{ borderColor: 'hsl(var(--border))' }}>
            <option value="">Any use-case</option><option value="conversational">Conversational</option><option value="narrative_story">Narration</option><option value="social_media">Social media</option><option value="informative_educational">Educational</option>
          </select>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 fine-scrollbar">
          {loading ? (
            <div className="grid gap-2 sm:grid-cols-2">{[1, 2, 3, 4].map((i) => <div key={i} className="h-16 rounded-xl bg-muted/40 animate-pulse" />)}</div>
          ) : voices.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No voices found. Try different filters — or make sure an ElevenLabs key is configured in admin.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {voices.map((v) => (
                <div key={v.voice_id} className="flex items-center gap-2 rounded-xl border p-2.5" style={{ borderColor: 'hsl(var(--border))' }}>
                  <button onClick={() => playPreview(v)} disabled={!v.preview_url} title="Preview" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary disabled:opacity-30 focus-ring">
                    {playingId === v.voice_id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Play size={13} strokeWidth={2.5} aria-hidden />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">{v.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{[v.gender, v.accent, v.use_case, v.descriptive].filter(Boolean).join(' · ') || 'voice'}</p>
                  </div>
                  <button onClick={() => select(v)} disabled={selecting !== null} className="gradient-action inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold text-white transition-all hover:brightness-110 active:translate-y-px focus-ring disabled:opacity-50">
                    {selecting === v.voice_id ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Check size={12} strokeWidth={3} aria-hidden />}
                    Use
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
