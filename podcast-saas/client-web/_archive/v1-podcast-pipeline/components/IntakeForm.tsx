'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../lib/firebase';
import { api } from '../lib/api';
import { CorpusUploader } from './CorpusUploader';
import { HostPicker } from './HostPicker';
import { usePlatform } from './PlatformGate';
import type { StylePreset, Format, Pacing, EmotionalStyle } from 'shared';

type Step = 'topic' | 'style' | 'hosts' | 'references' | 'format' | 'review';
const STEPS: Step[] = ['topic', 'style', 'hosts', 'references', 'format', 'review'];

interface FormState {
  topic: string;
  style_preset: StylePreset;
  host_a_id: string;
  host_b_id: string;
  format: Format;
  target_duration_min: number;
  pacing: Pacing;
  emotional_style: EmotionalStyle;
  corpus_files: File[];
  corpus_urls: string[];
}

const STYLE_PRESETS: { value: StylePreset; label: string; desc: string }[] = [
  { value: 'educational-deep-dive', label: 'Deep Dive', desc: 'Thorough exploration of a complex topic' },
  { value: 'interview', label: 'Interview', desc: 'Expert answers curious host questions' },
  { value: 'debate', label: 'Debate', desc: 'Two perspectives clash on a topic' },
  { value: 'storytelling', label: 'Storytelling', desc: 'Narrative-driven journey through a topic' },
  { value: 'news-analysis', label: 'News Analysis', desc: 'Break down current events with context' },
  { value: 'comedy', label: 'Comedy', desc: 'Fun, light-hearted take on a topic' },
];

export function IntakeForm() {
  const router = useRouter();
  const { loading: authLoading } = useAuth();
  const { settings: platformSettings } = usePlatform();
  const [step, setStep] = useState<Step>('topic');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>({
    topic: '',
    style_preset: 'educational-deep-dive',
    host_a_id: '',
    host_b_id: '',
    format: '16:9',
    target_duration_min: 12,
    pacing: 'standard',
    emotional_style: 'warm',
    corpus_files: [],
    corpus_urls: [],
  });

  const stepIndex = STEPS.indexOf(step);

  const isPresetId = (id: string) => id.startsWith('preset-');
  const toApiId = (id: string) => (!id || isPresetId(id) ? undefined : id);

  const canNext = () => {
    if (step === 'topic') return form.topic.trim().length > 10;
    return true;
  };

  const next = () => { if (stepIndex < STEPS.length - 1) setStep(STEPS[stepIndex + 1]); };
  const back = () => { if (stepIndex > 0) setStep(STEPS[stepIndex - 1]); };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const projectRes = await api.createProject({
        topic: form.topic,
        style_preset: form.style_preset,
        host_a_id: toApiId(form.host_a_id),
        host_b_id: toApiId(form.host_b_id),
        format: form.format,
        target_duration_min: form.target_duration_min,
        pacing: form.pacing,
        emotional_style: form.emotional_style,
      });
      const projectId = projectRes.id;

      for (const file of form.corpus_files) {
        const fd = new FormData();
        fd.append('file', file);
        await api.addCorpus(projectId, fd, true);
      }
      for (const url of form.corpus_urls) {
        const isYt = url.includes('youtube.com') || url.includes('youtu.be');
        await api.addCorpus(projectId, {
          source_type: isYt ? 'youtube' : 'web',
          source_url: url,
        });
      }

      router.push(`/projects/${projectId}/stream`);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* ─── Header ─────────────────────────────────────────── */}
      <div className="shrink-0 h-14 border-b border-border bg-card flex items-center px-6 gap-4">
        <a
          href="/"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </a>

        {/* Step indicator */}
        <div className="flex-1 flex items-center justify-center gap-1.5">
          {STEPS.map((s, i) => {
            const done = i < stepIndex;
            const active = i === stepIndex;
            return (
              <div key={s} className="flex items-center gap-1.5">
                <div
                  className={`flex items-center justify-center rounded-full text-[10px] font-semibold transition-all duration-200 ${
                    done
                      ? 'w-5 h-5 bg-primary text-primary-foreground'
                      : active
                      ? 'w-6 h-6 bg-primary text-primary-foreground shadow-sm ring-4 ring-primary/15'
                      : 'w-5 h-5 bg-muted text-muted-foreground'
                  }`}
                >
                  {done ? (
                    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden>
                      <path d="M1.5 4.5l2 2L7.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`w-5 h-px transition-colors duration-200 ${i < stepIndex ? 'bg-primary' : 'bg-border'}`} />
                )}
              </div>
            );
          })}
        </div>

        <span className="text-xs text-muted-foreground shrink-0 w-20 text-right hidden sm:block capitalize">
          {step.replace('-', ' ')}
        </span>
      </div>

      {/* ─── Content ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto w-full px-6 py-10">

          {step === 'topic' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-2xl font-bold text-foreground">What's your podcast about?</h2>
                <p className="text-sm text-muted-foreground mt-1.5">
                  Be specific — a strong, detailed topic produces a much better script.
                </p>
              </div>
              <textarea
                autoFocus
                className="w-full h-44 rounded-xl border border-input bg-card px-4 py-3.5 text-sm text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/50 shadow-sm"
                placeholder="e.g. The surprising history of how caffeine evolved as a plant defense mechanism, and why humans became so dependent on it…"
                value={form.topic}
                onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                <span>{form.topic.length} characters</span>
                {form.topic.length > 0 && form.topic.trim().length <= 10 && (
                  <span className="text-amber-500">— add more detail to continue</span>
                )}
              </p>
            </div>
          )}

          {step === 'style' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-2xl font-bold text-foreground">Choose your style</h2>
                <p className="text-sm text-muted-foreground mt-1.5">
                  This shapes the tone and structure of the conversation.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {STYLE_PRESETS.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => setForm((f) => ({ ...f, style_preset: s.value }))}
                    className={`p-4 rounded-xl border text-left transition-all duration-150 ${
                      form.style_preset === s.value
                        ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20'
                        : 'border-border bg-card hover:border-primary/30 hover:bg-muted/40'
                    }`}
                  >
                    <div className="font-semibold text-sm text-foreground mb-0.5">{s.label}</div>
                    <div className="text-xs text-muted-foreground leading-relaxed">{s.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 'hosts' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-2xl font-bold text-foreground">Pick your hosts</h2>
                <p className="text-sm text-muted-foreground mt-1.5">
                  Optional — choose hosts to shape the conversation dynamic, or skip to use defaults.
                </p>
              </div>
              <HostPicker
                selectedAId={form.host_a_id}
                selectedBId={form.host_b_id}
                onSelectA={(id) => setForm((f) => ({ ...f, host_a_id: id }))}
                onSelectB={(id) => setForm((f) => ({ ...f, host_b_id: id }))}
              />
            </div>
          )}

          {step === 'references' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-2xl font-bold text-foreground">Add source material</h2>
                <p className="text-sm text-muted-foreground mt-1.5">
                  Optional — upload PDFs, paste URLs, or add a YouTube link. The AI will use this as context.
                </p>
              </div>
              <CorpusUploader
                files={form.corpus_files}
                urls={form.corpus_urls}
                onFilesChange={(files) => setForm((f) => ({ ...f, corpus_files: files }))}
                onUrlsChange={(urls) => setForm((f) => ({ ...f, corpus_urls: urls }))}
              />
            </div>
          )}

          {step === 'format' && (
            <div className="space-y-7">
              <div>
                <h2 className="text-2xl font-bold text-foreground">Format & duration</h2>
                <p className="text-sm text-muted-foreground mt-1.5">Set the output format for your video podcast.</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Aspect ratio</label>
                <div className="flex gap-2">
                  {(['16:9', '9:16', '1:1'] as Format[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => setForm((v) => ({ ...v, format: f }))}
                      className={`px-5 py-2 rounded-lg border text-sm font-medium transition-all ${
                        form.format === f
                          ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary/20'
                          : 'border-border bg-card text-foreground hover:border-primary/30'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Duration</label>
                <div className="grid grid-cols-3 gap-3">
                  {([
                    { label: 'Short', min: 5, hint: '~3–6 min', desc: 'Quick takes, punchy insights' },
                    { label: 'Medium', min: 12, hint: '~10–15 min', desc: 'Balanced depth, comfortable listen' },
                    { label: 'Long', min: 25, hint: '~20–30 min', desc: 'Full exploration, premium feel' },
                  ] as const).map((d) => (
                    <button
                      key={d.label}
                      onClick={() => setForm((f) => ({ ...f, target_duration_min: d.min }))}
                      className={`p-4 rounded-xl border text-left transition-all duration-150 ${
                        form.target_duration_min === d.min
                          ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20'
                          : 'border-border bg-card hover:border-primary/30 hover:bg-muted/40'
                      }`}
                    >
                      <div className="font-semibold text-sm text-foreground">{d.label}</div>
                      <div className="text-xs text-primary/80 font-medium mt-0.5">{d.hint}</div>
                      <div className="text-xs text-muted-foreground mt-1 leading-relaxed">{d.desc}</div>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Exact runtime is determined by TTS rendering.</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Pacing</label>
                <div className="flex gap-2">
                  {(['relaxed', 'standard', 'energetic'] as Pacing[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setForm((v) => ({ ...v, pacing: p }))}
                      className={`px-4 py-2 rounded-lg border text-sm capitalize transition-all ${
                        form.pacing === p
                          ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary/20'
                          : 'border-border bg-card text-foreground hover:border-primary/30'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Emotional style</label>
                <div className="flex gap-2 flex-wrap">
                  {(['analytical', 'warm', 'playful', 'serious'] as EmotionalStyle[]).map((e) => (
                    <button
                      key={e}
                      onClick={() => setForm((v) => ({ ...v, emotional_style: e }))}
                      className={`px-4 py-2 rounded-lg border text-sm capitalize transition-all ${
                        form.emotional_style === e
                          ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary/20'
                          : 'border-border bg-card text-foreground hover:border-primary/30'
                      }`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-2xl font-bold text-foreground">Review & generate</h2>
                <p className="text-sm text-muted-foreground mt-1.5">
                  Everything look right? Hit generate to start your podcast.
                </p>
              </div>

              <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
                <div className="px-5 py-3.5 border-b border-border bg-muted/30">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Your podcast
                  </p>
                </div>
                <div className="px-5 py-4 space-y-4">
                  <p className="text-sm text-muted-foreground leading-relaxed italic line-clamp-3">
                    "{form.topic}"
                  </p>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-2.5 text-sm border-t border-border pt-4">
                    {[
                      ['Style', form.style_preset.replace(/-/g, ' ')],
                      ['Format', form.format],
                      ['Duration', form.target_duration_min <= 5 ? 'Short' : form.target_duration_min <= 12 ? 'Medium' : 'Long'],
                      ['Pacing', form.pacing],
                      ['Tone', form.emotional_style],
                      ['Sources', `${form.corpus_files.length + form.corpus_urls.length} items`],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">{k}</span>
                        <span className="font-medium capitalize text-foreground">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {error && (
                <div className="rounded-lg bg-destructive/8 border border-destructive/20 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {/* ─── Footer nav ──────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border bg-card">
        <div className="max-w-2xl mx-auto w-full px-6 py-4 flex items-center justify-between">
          <button
            onClick={back}
            disabled={stepIndex === 0}
            className="h-9 px-4 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Back
          </button>

          {step === 'review' ? (
            platformSettings?.generation_paused ? (
              <div className="text-right">
                <p className="text-sm font-medium text-destructive">Generation is paused</p>
                {platformSettings.generation_paused_message && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {platformSettings.generation_paused_message}
                  </p>
                )}
              </div>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="h-9 px-6 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm disabled:opacity-60 inline-flex items-center gap-2"
              >
                {submitting && (
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground animate-spin" />
                )}
                {submitting ? 'Generating…' : 'Generate Script'}
              </button>
            )
          ) : (
            <button
              onClick={next}
              disabled={!canNext()}
              className="h-9 px-5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              Continue
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path d="M2 6h8M6 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
