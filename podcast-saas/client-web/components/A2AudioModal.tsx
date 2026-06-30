'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Music, Wand2, X, Play, Pause, Loader2, Sparkles, Upload, Trash2, Volume2 } from 'lucide-react';
import type { AudioFile, TimelineSection } from 'shared/src/generated/client-v1';
import { api } from '../lib/api';
import { auth } from '../lib/firebase';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

async function generateAudio(projectId: string, body: { prompt: string; type: 'sfx' | 'music'; duration_seconds?: number }): Promise<AudioFile> {
  const token = await auth.currentUser?.getIdToken().catch(() => null);
  const res = await fetch(`${BASE}/api/v1/projects/${projectId}/audio/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as { message?: string } & AudioFile;
  if (!res.ok) throw new Error(json.message ?? `Generate failed: ${res.status}`);
  return json as AudioFile;
}

function formatDur(s: number | null | undefined): string {
  if (!s) return '--:--';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

// ── Mini audio preview player ─────────────────────────────────────────────────

function AudioPreviewPlayer({ url, label }: { url: string; label: string }) {
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const a = new Audio(url);
    a.onended = () => setPlaying(false);
    ref.current = a;
    return () => { a.pause(); a.src = ''; };
  }, [url]);

  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else { void a.play().then(() => setPlaying(true)).catch(() => {}); }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
      style={{ background: playing ? '#dcfce7' : '#f0fdf4', border: '1px solid #bbf7d0', color: '#059669' }}
      title={playing ? `Pause ${label}` : `Preview ${label}`}
    >
      {playing ? <Pause size={13} strokeWidth={2} /> : <Play size={13} strokeWidth={2} />}
    </button>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  videoFileId: string;
  globalOffsetSec: number;
  audioFiles: AudioFile[];
  onInserted: (section: TimelineSection) => void;
  onAudioFilesChange: (files: AudioFile[]) => void;
  // Edit mode — existing section
  editSection?: TimelineSection | null;
  onSectionUpdate?: (section: TimelineSection) => void;
  onSectionDelete?: (id: string) => void;
  onClose: () => void;
}

type Tab = 'library' | 'generate';

export function A2AudioModal({
  projectId, videoFileId, globalOffsetSec,
  audioFiles, onInserted, onAudioFilesChange,
  editSection, onSectionUpdate, onSectionDelete,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>(editSection ? 'library' : 'library');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  // Generate state
  const [genType, setGenType] = useState<'sfx' | 'music'>('sfx');
  const [genPrompt, setGenPrompt] = useState('');
  const [genDur, setGenDur] = useState<number | ''>('');
  const [genError, setGenError] = useState('');
  const [genResult, setGenResult] = useState<AudioFile | null>(null);

  // Edit state (gain)
  const [gain, setGain] = useState<number>(editSection?.broll_volume ?? 1);
  const [gainBusy, setGainBusy] = useState(false);

  const filtered = audioFiles.filter(f =>
    !search || f.filename.toLowerCase().includes(search.toLowerCase())
  );

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const uploaded = await api.uploadAudioFile(projectId, fd);
      onAudioFilesChange([uploaded, ...audioFiles]);
    } catch { /* ignore */ }
    finally { setBusy(false); e.target.value = ''; }
  }, [projectId, audioFiles, onAudioFilesChange]);

  const handleDeleteFile = useCallback(async (f: AudioFile) => {
    try {
      await api.deleteAudioFile(projectId, f.id);
      onAudioFilesChange(audioFiles.filter(x => x.id !== f.id));
    } catch { /* ignore */ }
  }, [projectId, audioFiles, onAudioFilesChange]);

  const handleInsert = useCallback(async (audioFile: AudioFile) => {
    setBusy(true);
    try {
      const dur = audioFile.duration_sec ?? 10;
      const section = await api.insertAudioCutaway(projectId, {
        audio_file_id:     audioFile.id,
        global_offset_sec: globalOffsetSec,
        duration_sec:      dur,
        video_file_id:     videoFileId,
      });
      onInserted(section);
      onClose();
    } catch { /* ignore */ }
    finally { setBusy(false); }
  }, [projectId, globalOffsetSec, videoFileId, onInserted, onClose]);

  const handleGenerate = useCallback(async () => {
    if (!genPrompt.trim()) { setGenError('Enter a description'); return; }
    setGenError('');
    setGenResult(null);
    setBusy(true);
    try {
      const file = await generateAudio(projectId, {
        prompt: genPrompt.trim(),
        type: genType,
        ...(genDur ? { duration_seconds: Number(genDur) } : {}),
      });
      setGenResult(file);
      onAudioFilesChange([file, ...audioFiles]);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Generation failed');
    } finally { setBusy(false); }
  }, [genPrompt, genType, genDur, projectId, audioFiles, onAudioFilesChange]);

  const handleCommitGain = useCallback(async (v: number) => {
    if (!editSection || !onSectionUpdate) return;
    setGainBusy(true);
    try {
      const updated = await api.updateSection(projectId, editSection.id, { broll_volume: v });
      onSectionUpdate(updated);
    } catch { /* ignore */ }
    finally { setGainBusy(false); }
  }, [editSection, onSectionUpdate, projectId]);

  const handleDeleteSection = useCallback(async () => {
    if (!editSection || !onSectionDelete) return;
    try {
      await api.deleteSection(projectId, editSection.id);
      onSectionDelete(editSection.id);
      onClose();
    } catch { onSectionDelete(editSection.id); onClose(); }
  }, [editSection, onSectionDelete, projectId, onClose]);

  // Close on backdrop click
  const backdropRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div
        ref={backdropRef}
        className="fixed inset-0"
        style={{ zIndex: 800, background: 'rgba(0,0,0,0.18)' }}
        onClick={onClose}
      />
      <div
        className="fixed overflow-hidden rounded-xl border bg-card shadow-2xl"
        style={{
          right: 24, bottom: 164, width: 380,
          zIndex: 801, borderColor: '#bbf7d0',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          maxHeight: 'calc(100vh - 200px)',
          display: 'flex', flexDirection: 'column',
        }}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3 shrink-0" style={{ borderColor: '#dcfce7', backgroundColor: '#f0fdf4' }}>
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: '#d1fae5', color: '#047857' }}>
              <Music size={16} strokeWidth={2} />
            </span>
            <div>
              <p className="text-xs font-semibold text-emerald-900">
                {editSection ? (editSection.label || 'Audio Section') : 'Add Music / Sound Effect'}
              </p>
              <p className="text-[10px] font-medium uppercase tracking-widest text-emerald-600">
                {editSection ? `A2 · ${Math.round((editSection.end_sec - editSection.start_sec))}s` : 'A2 track'}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md text-emerald-700 hover:bg-emerald-100 transition-colors" title="Close">
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        {/* Edit mode: gain control */}
        {editSection && (
          <div className="px-4 py-3 border-b shrink-0" style={{ borderColor: '#ecfdf5', background: '#fafffe' }}>
            <div className="flex items-center gap-2 mb-1">
              <Volume2 size={13} strokeWidth={2} style={{ color: '#059669' }} />
              <span className="text-[11px] font-semibold text-emerald-800">Volume</span>
              <span className="ml-auto text-[11px] font-mono font-bold text-emerald-700">{Math.round(gain * 100)}%</span>
            </div>
            <input
              type="range" min={0} max={1} step={0.01} value={gain}
              onChange={e => setGain(parseFloat(e.target.value))}
              onPointerUp={() => void handleCommitGain(gain)}
              className="w-full" style={{ accentColor: '#10b981' }}
              disabled={gainBusy}
            />
            <div className="flex items-center justify-between mt-2 gap-2">
              <span className="text-[10px] text-gray-500">{formatDur(editSection.end_sec - editSection.start_sec)}</span>
              <button
                type="button" onClick={handleDeleteSection}
                className="flex h-7 items-center gap-1 rounded-md border border-red-100 px-2 text-[11px] font-semibold text-red-600 hover:bg-red-50 transition-colors"
              >
                <Trash2 size={12} strokeWidth={1.9} /> Delete
              </button>
            </div>
            <p className="mt-2 text-[10px] font-medium text-emerald-700">Replace audio:</p>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b shrink-0" style={{ borderColor: '#dcfce7' }}>
          {([['library', 'My Library'], ['generate', 'Generate']] as [Tab, string][]).map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="flex-1 py-2.5 text-[11px] font-semibold transition-colors"
              style={{
                color: tab === t ? '#047857' : '#6b7280',
                borderBottom: tab === t ? '2px solid #10b981' : '2px solid transparent',
                background: tab === t ? '#f0fdf4' : 'transparent',
              }}
            >
              {t === 'library' ? <Music size={11} className="inline mr-1" /> : <Wand2 size={11} className="inline mr-1" />}
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* ── My Library tab ── */}
          {tab === 'library' && (
            <div className="p-3 space-y-2">
              {/* Search + upload */}
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Search…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="flex-1 rounded-md border px-2.5 py-1.5 text-xs outline-none"
                  style={{ borderColor: '#d1fae5', background: '#fafffe', color: '#1f2937' }}
                />
                <label className="flex h-8 cursor-pointer items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors">
                  <Upload size={12} strokeWidth={2} />
                  Upload
                  <input type="file" accept="audio/*" className="sr-only" onChange={handleUpload} disabled={busy} />
                </label>
              </div>

              {/* File list */}
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center text-gray-400">
                  <Music size={28} strokeWidth={1.2} style={{ color: '#bbf7d0' }} />
                  <p className="text-xs font-medium">No audio files yet</p>
                  <p className="text-[10px]">Upload or generate music/SFX below</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {filtered.map(f => (
                    <div
                      key={f.id}
                      className="flex items-center gap-2 rounded-lg border p-2.5 transition-colors hover:bg-emerald-50"
                      style={{ borderColor: '#d1fae5' }}
                    >
                      <AudioPreviewPlayer url={f.url ?? ''} label={f.filename} />
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-[11px] font-semibold text-gray-800">{f.filename}</p>
                        <p className="text-[10px] text-gray-400">{formatDur(f.duration_sec)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleDeleteFile(f)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={11} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleInsert(f)}
                        className="shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50"
                        style={{ background: '#10b981', color: '#fff', border: '1px solid #059669' }}
                      >
                        {editSection ? 'Replace' : 'Add'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Generate tab ── */}
          {tab === 'generate' && (
            <div className="p-3 space-y-3">
              {/* Type selector */}
              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-emerald-800">Type</p>
                <div className="flex gap-2">
                  {([['sfx', '🎧 Sound Effect'], ['music', '🎵 Background Music']] as ['sfx' | 'music', string][]).map(([t, label]) => (
                    <button
                      key={t} type="button"
                      onClick={() => setGenType(t)}
                      className="flex-1 rounded-md border py-2 text-[11px] font-semibold transition-colors"
                      style={{
                        borderColor: genType === t ? '#10b981' : '#d1fae5',
                        background:  genType === t ? '#dcfce7' : '#fafffe',
                        color:       genType === t ? '#047857' : '#6b7280',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Prompt */}
              <div>
                <p className="mb-1 text-[11px] font-semibold text-emerald-800">Description</p>
                <textarea
                  rows={3}
                  placeholder={genType === 'music'
                    ? 'e.g. calm piano background, upbeat electronic, cinematic orchestral…'
                    : 'e.g. thunder rumble, crowd cheering, keyboard typing, notification chime…'}
                  value={genPrompt}
                  onChange={e => setGenPrompt(e.target.value)}
                  className="w-full rounded-md border px-2.5 py-2 text-xs resize-none outline-none"
                  style={{ borderColor: '#d1fae5', background: '#fafffe', color: '#1f2937', lineHeight: 1.5 }}
                />
              </div>

              {/* Duration */}
              <div>
                <p className="mb-1 text-[11px] font-semibold text-emerald-800">Duration <span className="font-normal text-gray-400">(optional, max 22s)</span></p>
                <div className="flex gap-2">
                  {[5, 10, 15, 22].map(d => (
                    <button
                      key={d} type="button"
                      onClick={() => setGenDur(genDur === d ? '' : d)}
                      className="rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors"
                      style={{
                        borderColor: genDur === d ? '#10b981' : '#d1fae5',
                        background:  genDur === d ? '#dcfce7' : '#fafffe',
                        color:       genDur === d ? '#047857' : '#6b7280',
                      }}
                    >
                      {d}s
                    </button>
                  ))}
                  <input
                    type="number" min={1} max={22} placeholder="custom"
                    value={typeof genDur === 'number' ? genDur : ''}
                    onChange={e => setGenDur(e.target.value ? Number(e.target.value) : '')}
                    className="flex-1 rounded-md border px-2 py-1 text-[11px] text-center outline-none"
                    style={{ borderColor: '#d1fae5', background: '#fafffe', color: '#1f2937' }}
                  />
                </div>
              </div>

              {/* Error */}
              {genError && (
                <p className="rounded-md border border-red-100 bg-red-50 px-2.5 py-2 text-[11px] text-red-600">{genError}</p>
              )}

              {/* Generate button */}
              <button
                type="button"
                disabled={busy || !genPrompt.trim()}
                onClick={() => void handleGenerate()}
                className="flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-[12px] font-semibold transition-all disabled:opacity-50"
                style={{ background: busy ? '#d1fae5' : '#10b981', color: '#fff', border: '1px solid #059669' }}
              >
                {busy ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : <Sparkles size={14} strokeWidth={2} />}
                {busy ? 'Generating…' : 'Generate'}
              </button>

              {/* Result preview */}
              {genResult && !busy && (
                <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: '#bbf7d0', background: '#f0fdf4' }}>
                  <div className="flex items-center gap-2">
                    <AudioPreviewPlayer url={genResult.url ?? ''} label={genResult.filename} />
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-[11px] font-semibold text-emerald-900">{genResult.filename}</p>
                      <p className="text-[10px] text-emerald-600">{formatDur(genResult.duration_sec)} · Generated</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleInsert(genResult)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-[11px] font-semibold transition-all disabled:opacity-50"
                    style={{ background: '#047857', color: '#fff', border: '1px solid #065f46' }}
                  >
                    <Music size={12} strokeWidth={2} />
                    {editSection ? 'Replace current audio' : 'Add to A2 track'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
