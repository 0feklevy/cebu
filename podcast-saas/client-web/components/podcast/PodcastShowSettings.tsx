'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { api } from '../../lib/api';
import { PodcastButton } from './PodcastChrome';
import { PodcastVoicePicker } from './PodcastVoicePicker';
import type { PodcastShow } from 'shared/src/generated/client-v1';
import type { UpdatePodcastShow } from 'shared/src/types/podcast';

const fieldCls =
  'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary focus-ring';

export function PodcastShowSettings({
  show,
  onClose,
  onSaved,
  onShowUpdate,
}: {
  show: PodcastShow;
  onClose: () => void;
  onSaved: (updated: PodcastShow) => void;
  onShowUpdate?: (updated: PodcastShow) => void;   // propagate a change (e.g. voice pick) without closing
}) {
  const [form, setForm] = useState({
    title: show.title ?? '',
    description: show.description ?? '',
    language: show.language,
    niche_pack: show.niche_pack,
    teacher_name: show.teacher_name,
    learner_name: show.learner_name,
    teacher_persona: show.teacher_persona ?? '',
    learner_persona: show.learner_persona ?? '',
    user_instructions: show.style_config?.user_instructions ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [voicePickerRole, setVoicePickerRole] = useState<'teacher' | 'learner' | null>(null);
  const [teacherVoice, setTeacherVoice] = useState<string | null>(show.teacher_voice_id);
  const [learnerVoice, setLearnerVoice] = useState<string | null>(show.learner_voice_id);

  useEffect(() => {
    setMounted(true);
    // Don't close on Escape while the nested voice picker is open — it handles its own Escape.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving && !voicePickerRole) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving, voicePickerRole]);

  const save = async () => {
    setSaving(true);
    try {
      const body: UpdatePodcastShow = {
        title: form.title.trim() || undefined,
        description: form.description.trim() || null,
        language: form.language,
        niche_pack: form.niche_pack,
        teacher_name: form.teacher_name.trim() || undefined,
        learner_name: form.learner_name.trim() || undefined,
        teacher_persona: form.teacher_persona.trim() || null,
        learner_persona: form.learner_persona.trim() || null,
        style_config: {
          ...(show.style_config ?? {}),
          user_instructions: form.user_instructions.trim() || undefined,
        },
      };
      const updated = await api.updatePodcastShow(show.id, body);
      onSaved(updated);
    } catch (err) {
      console.error('Save show settings failed', err);
      window.alert('Could not save settings — please try again.');
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[800] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => { if (!saving) onClose(); }} />
      <div role="dialog" aria-modal="true" aria-label="Show settings" className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-modal">
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="text-base font-semibold text-foreground">Show settings</h2>
          <button onClick={() => { if (!saving) onClose(); }} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-ring" aria-label="Close">
            <X size={17} strokeWidth={2} aria-hidden />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 fine-scrollbar">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Show title</span>
            <input className={fieldCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Science, simplified" />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</span>
            <textarea className={`${fieldCls} min-h-[64px] resize-y`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What is this series about?" />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent pack</span>
            <select className={fieldCls} value={form.niche_pack} onChange={(e) => setForm({ ...form, niche_pack: e.target.value as PodcastShow['niche_pack'] })}>
              <option value="general">General</option>
              <option value="science">Science</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Teacher name</span>
              <input className={fieldCls} value={form.teacher_name} onChange={(e) => setForm({ ...form, teacher_name: e.target.value })} />
              <span className="mt-1 block text-[11px] text-muted-foreground">Explains the material.</span>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Learner name</span>
              <input className={fieldCls} value={form.learner_name} onChange={(e) => setForm({ ...form, learner_name: e.target.value })} />
              <span className="mt-1 block text-[11px] text-muted-foreground">Asks the questions, cracks the jokes.</span>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Extra instructions for the writers&apos; room</span>
            <textarea className={`${fieldCls} min-h-[64px] resize-y`} value={form.user_instructions} onChange={(e) => setForm({ ...form, user_instructions: e.target.value })} placeholder="Anything that should shape every episode of this show (tone, running jokes, things to avoid…)." />
          </label>

          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Voices</span>
            <div className="space-y-2">
              {([['teacher', form.teacher_name, teacherVoice], ['learner', form.learner_name, learnerVoice]] as const).map(([r, nm, vid]) => (
                <div key={r} className="flex items-center gap-2 rounded-lg border px-3 py-2" style={{ borderColor: 'hsl(var(--border))' }}>
                  <span className="min-w-0 flex-1 text-sm text-foreground"><strong>{nm}</strong> <span className="text-muted-foreground">({r})</span></span>
                  <span className="text-[11px]" style={{ color: vid ? '#10b981' : 'hsl(var(--muted-foreground))' }}>{vid ? 'voice set' : 'default'}</span>
                  <button type="button" onClick={() => setVoicePickerRole(r)} className="inline-flex h-7 items-center rounded-md border border-primary/40 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-ring">Change</button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button onClick={() => { if (!saving) onClose(); }} className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-muted-foreground hover:bg-muted focus-ring">Cancel</button>
          <PodcastButton onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</PodcastButton>
        </div>
      </div>

      {voicePickerRole && (
        <PodcastVoicePicker
          showId={show.id}
          role={voicePickerRole}
          roleName={voicePickerRole === 'teacher' ? form.teacher_name : form.learner_name}
          onClose={() => setVoicePickerRole(null)}
          onSelected={(updated) => {
            setTeacherVoice(updated.teacher_voice_id);
            setLearnerVoice(updated.learner_voice_id);
            setVoicePickerRole(null);
            onShowUpdate?.(updated);   // reflect immediately in the parent, even if the user cancels Settings
          }}
        />
      )}
    </div>,
    document.body,
  );
}
