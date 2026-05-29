'use client';

import { useState } from 'react';
import { CreateProjectDialog } from './CreateProjectDialog';

const FEATURES = [
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="2" y="5" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 8l5 2-5 2V8z" fill="currentColor" />
      </svg>
    ),
    title: 'Multi-clip timeline',
    desc: 'Upload multiple video clips and they appear in one seamless timeline row with smart dividers.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="2" y="8" width="16" height="4" rx="1" stroke="currentColor" strokeWidth="1.4" />
        <rect x="4" y="10.5" width="4" height="3" rx="0.5" fill="currentColor" fillOpacity="0.4" />
        <rect x="9" y="10.5" width="7" height="3" rx="0.5" fill="currentColor" fillOpacity="0.7" />
        <path d="M2 6.5h16" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" />
      </svg>
    ),
    title: 'Section flagging',
    desc: 'Drag to mark video and simulation sections directly on the timeline. Edit labels and timing inline.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M10 3v14M3 10h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeOpacity="0.3" />
        <circle cx="10" cy="10" r="4" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="10" cy="10" r="1.5" fill="currentColor" />
      </svg>
    ),
    title: 'Dual-buffer playback',
    desc: 'Seamless clip transitions using a standby buffer — no flicker, no stutter between videos.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M4 16l4-8 3 5 2-3 3 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="2" y="14" width="16" height="1" rx="0.5" fill="currentColor" fillOpacity="0.15" />
      </svg>
    ),
    title: 'Audio waveform',
    desc: 'See the audio waveform per clip extracted server-side — visually navigate your content.',
  },
];

export function HomeHero() {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <section className="relative overflow-hidden">
        {/* Background */}
        <div aria-hidden className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: 'radial-gradient(ellipse 80% 50% at 50% -10%, hsl(243 74% 59% / 0.09) 0%, transparent 70%)' }}
        />
        <div aria-hidden className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: 'radial-gradient(circle, hsl(243 74% 59% / 0.04) 1px, transparent 1px)', backgroundSize: '28px 28px' }}
        />

        {/* Hero text */}
        <div className="relative max-w-2xl mx-auto text-center pt-20 pb-12 px-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/6 px-3.5 py-1 text-xs font-medium text-primary mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse inline-block" />
            Interactive Video Editor
          </span>

          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] text-foreground mb-5">
            Build interactive
            <br />
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: 'linear-gradient(135deg, hsl(243 74% 59%), hsl(280 75% 60%))' }}
            >
              video experiences
            </span>
          </h1>

          <p className="text-base text-muted-foreground max-w-lg mx-auto leading-relaxed mb-8">
            Upload your video clips, arrange them on a timeline, flag sections as video or simulation,
            and preview the final interactive experience — all in one editor.
          </p>

          <button
            onClick={() => setCreateOpen(true)}
            className="h-11 px-6 bg-primary text-primary-foreground font-semibold rounded-lg inline-flex items-center gap-2 hover:bg-primary/90 transition-all shadow-sm hover:shadow-md active:translate-y-px"
          >
            New project
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
              <path d="M1 6.5h11M7 1.5l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Features grid */}
        <div className="relative max-w-3xl mx-auto px-6 pb-16">
          <div className="grid grid-cols-2 gap-3">
            {FEATURES.map(f => (
              <div
                key={f.title}
                className="rounded-xl border border-border/60 bg-card/50 p-4 flex gap-3 hover:border-primary/20 hover:bg-card transition-all"
              >
                <div
                  className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-primary"
                  style={{ backgroundColor: 'hsl(243 74% 59% / 0.08)' }}
                >
                  {f.icon}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground mb-0.5">{f.title}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Timeline illustration */}
        <div className="relative max-w-3xl mx-auto px-6 pb-16">
          <div
            className="rounded-xl border border-border/60 overflow-hidden"
            style={{ backgroundColor: '#fff' }}
          >
            {/* Fake toolbar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40" style={{ backgroundColor: '#fafafa' }}>
              <div className="w-16 h-5 rounded bg-primary/80 flex items-center justify-center">
                <span className="text-[9px] font-semibold text-white">+ Add video</span>
              </div>
              <div className="w-20 h-5 rounded border border-border/60 flex items-center justify-center">
                <span className="text-[9px] text-muted-foreground">Show final video</span>
              </div>
            </div>
            {/* Fake timeline */}
            <div className="p-3" style={{ backgroundColor: '#f9fafb' }}>
              <div className="flex gap-0">
                {/* Label */}
                <div className="w-20 shrink-0 border-r border-border/40 pr-2 flex flex-col justify-center" style={{ height: 40 }}>
                  <div className="flex items-center gap-1">
                    <span className="text-[8px] font-bold text-muted-foreground/60 uppercase">V1</span>
                    <span className="text-[8px] text-indigo-400 font-semibold">2 clips</span>
                  </div>
                  <span className="text-[8px] text-muted-foreground/50 font-mono">1:42</span>
                </div>
                {/* Clip 1 */}
                <div className="flex-[3] relative border-r-2 border-indigo-400" style={{ height: 40, backgroundColor: '#e0f2fe' }}>
                  <div className="absolute inset-0 flex" style={{ opacity: 0.4 }}>
                    {[...Array(8)].map((_, i) => (
                      <div key={i} className="flex-1 border-r border-black/5" style={{ backgroundImage: 'linear-gradient(180deg, #94a3b8 0%, #64748b 100%)' }} />
                    ))}
                  </div>
                  {/* Section mark */}
                  <div className="absolute top-1 bottom-1" style={{ left: '25%', width: '30%', backgroundColor: 'rgba(59,130,246,0.25)', border: '1.5px solid #3b82f6', borderRadius: 3 }}>
                    <span className="absolute inset-0 flex items-center justify-center text-[7px] font-bold text-blue-700">Intro</span>
                  </div>
                </div>
                {/* Clip divider badge */}
                <div className="relative" style={{ width: 2, backgroundColor: '#6366f1', height: 40 }}>
                  <div style={{ position: 'absolute', top: 3, left: 3, fontSize: 7, fontWeight: 700, color: '#6366f1', backgroundColor: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 2, padding: '0 2px' }}>2</div>
                </div>
                {/* Clip 2 */}
                <div className="flex-[2] relative" style={{ height: 40, backgroundColor: '#f0f7ff' }}>
                  <div className="absolute inset-0 flex" style={{ opacity: 0.4 }}>
                    {[...Array(5)].map((_, i) => (
                      <div key={i} className="flex-1 border-r border-black/5" style={{ backgroundImage: 'linear-gradient(180deg, #a5b4fc 0%, #818cf8 100%)' }} />
                    ))}
                  </div>
                  {/* Sim section */}
                  <div className="absolute top-1 bottom-1" style={{ left: '20%', width: '40%', backgroundColor: 'rgba(245,158,11,0.25)', border: '1.5px solid #f59e0b', borderRadius: 3 }}>
                    <span className="absolute inset-0 flex items-center justify-center text-[7px] font-bold text-amber-700">Sim</span>
                  </div>
                </div>
                {/* Playhead */}
                <div className="absolute" style={{ left: 'calc(80px + 45%)', top: 0, bottom: 0, width: 2, backgroundColor: '#ef4444', opacity: 0.9, height: 40 }} />
              </div>
              {/* Audio track */}
              <div className="flex gap-0 mt-0">
                <div className="w-20 shrink-0 border-r border-border/40 flex items-center px-2" style={{ height: 16, backgroundColor: '#f0fdf4' }}>
                  <span className="text-[8px] font-bold text-emerald-400/60 uppercase">A1</span>
                </div>
                <div className="flex-1" style={{ height: 16, backgroundColor: '#f0fdf4' }}>
                  <svg className="w-full h-full" viewBox="0 0 200 16" preserveAspectRatio="none">
                    {[...Array(100)].map((_, i) => {
                      const h = 1 + Math.abs(Math.sin(i * 0.4 + 1) * Math.sin(i * 0.1)) * 5;
                      return <line key={i} x1={i * 2 + 1} y1={8 - h} x2={i * 2 + 1} y2={8 + h} stroke="#10b981" strokeWidth="1" strokeOpacity="0.5" />;
                    })}
                  </svg>
                </div>
              </div>
            </div>
          </div>
          <p className="text-center text-[10px] text-muted-foreground/50 mt-2">Interactive timeline — drag clips, flag sections, scrub to any point</p>
        </div>
      </section>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
