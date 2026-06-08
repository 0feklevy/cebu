'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Sparkles, Play, Pause, Check, ChevronLeft, Upload, FileText, Trash2, Wrench } from 'lucide-react';
import {
  getAvatarConfig, saveAvatarConfig, listAnamResources, getByokStatus,
  listAvatarTools, listKnowledgeDocs, uploadKnowledgeDoc, deleteKnowledgeDoc,
  type AvatarPersonaConfig, type AnamResource, type AnamTool, type KnowledgeDoc,
} from './avatarApi';
import { CHARACTER_META } from './characters';
import './avatar.css';

interface Props { open: boolean; onClose: () => void; projectId: string; videoTitle?: string | null; embedded?: boolean }

interface AnamAvatar {
  id: string;
  displayName?: string;
  variantName?: string;
  imageUrl?: string;
  videoUrl?: string;
  voiceId?: string;
  defaultVoiceId?: string;
  voice?: { id?: string };
  defaultVoice?: { id?: string };
  [key: string]: unknown;
}
interface AnamVoice { id: string; displayName?: string; sampleUrl?: string; previewSampleUrl?: string; gender?: string; country?: string; description?: string; provider?: string; tags?: string[]; displayTags?: string[]; }

const LANGUAGES = [
  ['', 'Auto / persona default'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'],
  ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'],
  ['ru', 'Russian'], ['hi', 'Hindi'], ['ar', 'Arabic'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
] as const;
const AVATAR_MODELS = ['', 'cara-2', 'cara-3', 'cara-4-latest'];

function fmtSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function cleanLabel(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stringProp(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nestedId(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value && typeof value === 'object') return stringProp(value as Record<string, unknown>, 'id');
  return undefined;
}

function linkedVoiceId(avatar: AnamAvatar): string | undefined {
  const rec = avatar as Record<string, unknown>;
  const direct = ['voiceId', 'defaultVoiceId', 'voice_id', 'default_voice_id', 'defaultVoiceID'];
  for (const key of direct) {
    const value = stringProp(rec, key);
    if (value) return value;
  }
  const nested = ['voice', 'defaultVoice', 'default_voice'];
  for (const key of nested) {
    const value = nestedId(rec, key);
    if (value) return value;
  }
  const voices = rec.voices;
  if (Array.isArray(voices)) {
    const first = voices[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object') return stringProp(first as Record<string, unknown>, 'id');
  }
  return undefined;
}

function voiceForAvatar(avatar: AnamAvatar, voices: AnamVoice[]): AnamVoice | undefined {
  const explicit = linkedVoiceId(avatar);
  if (explicit) return voices.find((voice) => voice.id === explicit) ?? { id: explicit, displayName: avatar.displayName };

  const avatarName = cleanLabel(avatar.displayName);
  if (!avatarName) return undefined;
  return (
    voices.find((voice) => cleanLabel(voice.displayName) === avatarName) ??
    voices.find((voice) => cleanLabel(voice.displayName).startsWith(`${avatarName} `)) ??
    voices.find((voice) => cleanLabel(voice.description).includes(avatarName))
  );
}

// Per-video Avatar persona settings — a light "next page" above Video settings.
// Everything you would configure in the Anam Personas dashboard, saved per video.
export function AvatarSettingsModal({ open, onClose, projectId, videoTitle, embedded = false }: Props) {
  const [cfg, setCfg] = useState<AvatarPersonaConfig>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [byok, setByok] = useState<{ byokEnabled: boolean; hasKey: boolean }>({ byokEnabled: false, hasKey: false });
  const [avatars, setAvatars] = useState<AnamAvatar[]>([]);
  const [voices, setVoices] = useState<AnamVoice[]>([]);
  const [llms, setLlms] = useState<AnamResource[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [personaMsg, setPersonaMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tools, setTools] = useState<AnamTool[]>([]);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [vSearch, setVSearch] = useState('');
  const [vGender, setVGender] = useState('');
  const [vProvider, setVProvider] = useState('');
  const [vCountry, setVCountry] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([
      getAvatarConfig(projectId).then((r) => setCfg(r.config ?? {})).catch(() => setCfg({})),
      getByokStatus().then(setByok).catch(() => {}),
      listAnamResources(projectId, 'avatars').then((r) => setAvatars(r.data as unknown as AnamAvatar[])).catch(() => {}),
      listAnamResources(projectId, 'voices').then((r) => setVoices(r.data as unknown as AnamVoice[])).catch(() => {}),
      listAnamResources(projectId, 'llms').then((r) => setLlms(r.data)).catch(() => {}),
      listAvatarTools(projectId).then((r) => setTools(r.tools)).catch(() => {}),
      listKnowledgeDocs(projectId).then((r) => setDocs(r.data)).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [open, projectId]);

  const refreshDocs = useCallback(() => { listKnowledgeDocs(projectId).then((r) => setDocs(r.data)).catch(() => {}); }, [projectId]);

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    try {
      for (const f of list) { try { await uploadKnowledgeDoc(projectId, f); } catch (e) { alert(`${f.name}: ${(e as Error).message}`); } }
      refreshDocs();
    } finally { setUploading(false); }
  }, [projectId, refreshDocs]);

  const removeDoc = useCallback(async (docId: string) => {
    await deleteKnowledgeDoc(projectId, docId).catch(() => {});
    setDocs((d) => d.filter((x) => x.id !== docId));
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => { document.removeEventListener('keydown', h); audioRef.current?.pause(); };
  }, [open, onClose]);

  const set = useCallback(<K extends keyof AvatarPersonaConfig>(k: K, v: AvatarPersonaConfig[K]) => {
    setCfg((c) => ({ ...c, [k]: v })); setSaved(false);
  }, []);

  const selectAvatar = useCallback((avatar?: AnamAvatar) => {
    setCfg((current) => {
      if (!avatar) {
        return {
          ...current,
          avatarId: '',
          avatarName: '',
          avatarVariantName: '',
          avatarImageUrl: '',
          voiceId: '',
          voiceName: '',
        };
      }
      const pairedVoice = voiceForAvatar(avatar, voices);
      return {
        ...current,
        avatarId: avatar.id,
        avatarName: avatar.displayName ?? '',
        avatarVariantName: avatar.variantName ?? '',
        avatarImageUrl: avatar.imageUrl ?? '',
        voiceId: pairedVoice?.id ?? '',
        voiceName: pairedVoice?.displayName ?? '',
      };
    });
    setSaved(false);
  }, [voices]);

  const selectVoice = useCallback((voice?: AnamVoice) => {
    setCfg((current) => ({
      ...current,
      voiceId: voice?.id ?? '',
      voiceName: voice?.displayName ?? '',
    }));
    setSaved(false);
  }, []);

  const playVoice = useCallback((v: AnamVoice) => {
    const url = v.previewSampleUrl || v.sampleUrl;
    if (!url) return;
    if (playingVoice === v.id) { audioRef.current?.pause(); setPlayingVoice(null); return; }
    audioRef.current?.pause();
    const a = new Audio(url);
    audioRef.current = a;
    a.onended = () => setPlayingVoice(null);
    a.play().then(() => setPlayingVoice(v.id)).catch(() => setPlayingVoice(null));
  }, [playingVoice]);

  const save = async () => {
    setSaving(true);
    try {
      const clean: AvatarPersonaConfig = {};
      for (const [k, v] of Object.entries(cfg)) {
        if (v === '' || v === undefined || v === null) continue;
        (clean as Record<string, unknown>)[k] = v;
      }
      const res = await saveAvatarConfig(projectId, clean);
      if (res.personaId) setCfg((c) => ({ ...c, personaId: res.personaId }));
      setPersonaMsg(res.personaError
        ? { ok: false, text: `Saved, but couldn't build the Anam persona: ${res.personaError}` }
        : { ok: true, text: res.personaId ? `Saved as Anam persona ${res.personaId.slice(0, 8)}…` : 'Saved' });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) { alert((e as Error).message); } finally { setSaving(false); }
  };

  if (!open) return null;
  const character = cfg.characterId ?? 'einstein';

  const providers = [...new Set(voices.map((v) => v.provider).filter(Boolean) as string[])].sort();
  const countries = [...new Set(voices.map((v) => v.country).filter(Boolean) as string[])].sort();
  const q = vSearch.trim().toLowerCase();
  const filteredVoices = voices.filter((v) =>
    (!vGender || v.gender === vGender) &&
    (!vProvider || v.provider === vProvider) &&
    (!vCountry || v.country === vCountry) &&
    (!q || `${v.displayName ?? ''} ${v.description ?? ''} ${(v.displayTags ?? []).join(' ')}`.toLowerCase().includes(q)),
  );

  const inner = (
    <div className={`avset__page${embedded ? ' avset__page--embedded' : ''}`}>
        {/* Header — wizard page: back to Video settings */}
        <div className="avset__header">
          <button className="avset__back" onClick={onClose} title="Back to Video settings"><ChevronLeft size={18} /> Video settings</button>
          <span className="avset__dot" />
          <span className="avset__title">Ask-the-Avatar persona</span>
          {videoTitle && <span className="avset__chip">{videoTitle.slice(0, 40)}</span>}
          {!embedded && <button className="avset__x" onClick={onClose} aria-label="Close"><X size={15} /></button>}
        </div>

        {byok.byokEnabled && !byok.hasKey && (
          <div className="avset__warn">Bring-your-own-key is on but you haven&apos;t set your Anam key yet — add it in Home → Settings → AI, or this video falls back to the shared key.</div>
        )}

        <div className="avset__body avset__body--split">
          {loading ? <div className="avset__loading"><span className="avatar-spinner" /></div> : (
            <>
              <div className="avset__side">
                <div className="avset__panel">
                  <div className="avset__panel-head">
                    <span className="avset__panel-kicker">Section 1</span>
                    <h3>Conversation</h3>
                  </div>

                  <label className="avset__field">
                    <span>First greeting</span>
                    <input value={cfg.greeting ?? ''} onChange={(e) => set('greeting', e.target.value)} placeholder="e.g. Hello! Ask me anything about this video." />
                  </label>

                  <label className="avset__field">
                    <span>System prompt / personality <em>(blank = the character&apos;s built-in prompt)</em></span>
                    <textarea rows={5} value={cfg.systemPrompt ?? ''} onChange={(e) => set('systemPrompt', e.target.value)} placeholder="You are a friendly tutor for this video. Speak warmly, keep answers short…" />
                  </label>

                  <label className="avset__field">
                    <span>Knowledge</span>
                    <textarea rows={4} value={cfg.knowledge ?? ''} onChange={(e) => set('knowledge', e.target.value)} placeholder="Paste key facts, definitions, or context…" />
                  </label>

                  <div className="avset__section">
                    <div className="avset__seclabel">Knowledge documents <em>— searchable during conversation</em></div>
                    <div
                      className={`avset__drop${dragOver ? ' is-over' : ''}`}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => { e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files); }}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Upload size={20} />
                      <p><b>Drag files here</b> or click to browse</p>
                      <span>PDF, TXT, MD, DOCX, CSV · up to 50 MB each</span>
                      <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.docx,.csv" multiple hidden
                        onChange={(e) => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ''; }} />
                    </div>
                    {uploading && <div className="avset__uploading"><span className="avatar-spinner" /> Uploading &amp; indexing…</div>}
                    {docs.length > 0 && (
                      <div className="avset__docs">
                        {docs.map((d) => (
                          <div key={d.id} className="avset__doc">
                            <FileText size={15} className="avset__doc-ico" />
                            <span className="avset__doc-name">{d.filename}</span>
                            <span className="avset__doc-size">{fmtSize(d.fileSize)}</span>
                            <button className="avset__doc-del" onClick={() => removeDoc(d.id)} title="Remove"><Trash2 size={13} /></button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="avset__panel">
                  <button className="avset__adv avset__adv--panel" onClick={() => setShowAdvanced((s) => !s)}>{showAdvanced ? '▾' : '▸'} Advanced</button>
                  {showAdvanced && (
                    <div className="avset__advanced">
                      <label className="avset__field">
                        <span>Personality <em>(pre-built brain &amp; knowledge — your starting point)</em></span>
                        <select value={character} onChange={(e) => set('characterId', e.target.value)}>
                          {Object.values(CHARACTER_META).map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
                        </select>
                      </label>
                      <label className="avset__field">
                        <span>Language</span>
                        <select value={cfg.languageCode ?? ''} onChange={(e) => set('languageCode', e.target.value)}>
                          {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </label>
                      <label className="avset__field">
                        <span>LLM brain {llms.length === 0 && <em>— uses persona default</em>}</span>
                        <select value={cfg.llmId ?? ''} onChange={(e) => set('llmId', e.target.value)}>
                          <option value="">Persona default</option>
                          {llms.map((l) => <option key={l.id as string} value={l.id as string}>{(l.name as string) || (l.id as string)}</option>)}
                        </select>
                      </label>
                      <label className="avset__field">
                        <span>Avatar model</span>
                        <select value={cfg.avatarModel ?? ''} onChange={(e) => set('avatarModel', e.target.value)}>
                          {AVATAR_MODELS.map((m) => <option key={m} value={m}>{m || 'Default'}</option>)}
                        </select>
                      </label>

                      <div className="avset__row2">
                        <label className="avset__check"><input type="checkbox" checked={!!cfg.skipGreeting} onChange={(e) => set('skipGreeting', e.target.checked)} /> Skip greeting</label>
                        <label className="avset__check"><input type="checkbox" checked={!!cfg.uninterruptibleGreeting} onChange={(e) => set('uninterruptibleGreeting', e.target.checked)} /> Greeting can&apos;t be interrupted</label>
                        <label className="avset__field">
                          <span>Max session length (sec)</span>
                          <input type="number" min={60} max={3600} value={cfg.maxSessionLengthSeconds ?? ''} onChange={(e) => set('maxSessionLengthSeconds', e.target.value ? Number(e.target.value) : undefined)} placeholder="600" />
                        </label>
                        <label className="avset__field">
                          <span>End-of-speech sensitivity ({(cfg.voiceSensitivity ?? 0.5).toFixed(2)})</span>
                          <input type="range" min={0} max={1} step={0.05} value={cfg.voiceSensitivity ?? 0.5} onChange={(e) => set('voiceSensitivity', Number(e.target.value))} />
                        </label>
                      </div>

                      <div className="avset__section">
                        <div className="avset__seclabel"><Wrench size={13} style={{ verticalAlign: '-2px' }} /> Tools <em>{tools.length === 0 ? '— none available' : ''}</em></div>
                        <div className="avset__tools">
                          {tools.map((t) => {
                            const on = (cfg.toolIds ?? []).includes(t.id);
                            return (
                              <label key={t.id} className={`avset__tool${on ? ' is-on' : ''}`}>
                                <input type="checkbox" checked={on} onChange={(e) => {
                                  const cur = new Set(cfg.toolIds ?? []);
                                  if (e.target.checked) cur.add(t.id); else cur.delete(t.id);
                                  set('toolIds', [...cur]);
                                }} />
                                <span className="avset__tool-meta">
                                  <span className="avset__tool-name">{t.name}</span>
                                  <span className="avset__tool-desc">{t.description}</span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="avset__main">
                <div className="avset__panel">
                  <div className="avset__panel-head">
                    <span className="avset__panel-kicker">Section 2</span>
                    <h3>Avatar &amp; voice</h3>
                  </div>

                  <div className="avset__section">
                    <div className="avset__seclabel">Avatar <em>{avatars.length === 0 ? '— none available; uses persona default' : `(${avatars.length})`}</em></div>
                    <div className="avset__avatars">
                      <button className={`avset__avatar avset__avatar--default${!cfg.avatarId ? ' is-sel' : ''}`} onClick={() => selectAvatar()}>
                        <span className="avset__avatar-def">Persona<br />default</span>
                        {!cfg.avatarId && <span className="avset__sel"><Check size={13} /></span>}
                      </button>
                      {avatars.map((a) => (
                        <button key={a.id} className={`avset__avatar${cfg.avatarId === a.id ? ' is-sel' : ''}`} onClick={() => selectAvatar(a)} title={a.displayName}>
                          {a.imageUrl ? <img src={a.imageUrl} alt={a.displayName ?? ''} loading="lazy" /> : <span className="avset__avatar-def">{a.displayName}</span>}
                          <span className="avset__avatar-name">{a.displayName}{a.variantName ? ` · ${a.variantName}` : ''}</span>
                          {cfg.avatarId === a.id && <span className="avset__sel"><Check size={13} /></span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="avset__section">
                    <div className="avset__seclabel">
                      Voice <em>{voices.length === 0 ? '— none available; uses persona default' : `(${filteredVoices.length}/${voices.length})`}</em>
                      <span className="avset__voice-actions">
                        <button className="avset__mini" onClick={() => alert('Voice cloning (record) is coming soon — for now pick from the library or import a provider voice in the Anam dashboard.')}>● Record to clone</button>
                        <button className="avset__mini" onClick={() => window.open('https://lab.anam.ai', '_blank')}>Import from provider</button>
                      </span>
                    </div>
                    <div className="avset__vfilters">
                      <input className="avset__vsearch" placeholder="Search voices…" value={vSearch} onChange={(e) => setVSearch(e.target.value)} />
                      <select value={vGender} onChange={(e) => setVGender(e.target.value)}><option value="">All genders</option><option value="MALE">Male</option><option value="FEMALE">Female</option></select>
                      <select value={vProvider} onChange={(e) => setVProvider(e.target.value)}><option value="">All providers</option>{providers.map((p) => <option key={p} value={p}>{p}</option>)}</select>
                      <select value={vCountry} onChange={(e) => setVCountry(e.target.value)}><option value="">All languages</option>{countries.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                    </div>
                    <div className="avset__voices">
                      <button className={`avset__voice${!cfg.voiceId ? ' is-sel' : ''}`} onClick={() => selectVoice()}>
                        <span className="avset__voice-name">Persona default</span>
                        {!cfg.voiceId && <Check size={15} className="avset__voice-check" />}
                      </button>
                      {filteredVoices.map((v) => (
                        <div key={v.id} className={`avset__voice${cfg.voiceId === v.id ? ' is-sel' : ''}`} onClick={() => selectVoice(v)}>
                          <button className="avset__voice-play" onClick={(e) => { e.stopPropagation(); playVoice(v); }} title="Preview voice" disabled={!(v.previewSampleUrl || v.sampleUrl)}>
                            {playingVoice === v.id ? <Pause size={13} /> : <Play size={13} />}
                          </button>
                          <div className="avset__voice-meta">
                            <span className="avset__voice-name">{v.displayName}</span>
                            <span className="avset__voice-sub">{[v.gender, v.country].filter(Boolean).join(' · ')}{v.description ? ` — ${v.description.slice(0, 60)}` : ''}</span>
                          </div>
                          {cfg.voiceId === v.id && <Check size={15} className="avset__voice-check" />}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="avset__footer">
          <span className="avset__hint"><Sparkles size={12} /> Saved per video on the server{cfg.personaId ? ` · persona ${cfg.personaId.slice(0, 8)}…` : ''}.</span>
          {personaMsg && saved && <span className={personaMsg.ok ? 'avset__saved' : 'avset__warnmsg'}>{personaMsg.ok ? '✓ ' : '⚠ '}{personaMsg.text}</span>}
          <button className="avset__btn avset__btn--ghost" onClick={onClose}>Cancel</button>
          <button className="avset__btn avset__btn--primary" onClick={save} disabled={saving || loading}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
    </div>
  );

  if (embedded) return inner;
  return <div className="avset" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>{inner}</div>;
}
