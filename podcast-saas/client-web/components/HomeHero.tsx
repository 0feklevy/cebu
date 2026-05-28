'use client';

import { useState } from 'react';
import { CreateProjectDialog } from './CreateProjectDialog';

export function HomeHero() {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <section className="relative overflow-hidden pt-24 pb-20 px-6">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 80% 50% at 50% -10%, hsl(243 74% 59% / 0.09) 0%, transparent 70%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(circle, hsl(243 74% 59% / 0.04) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />

        <div className="relative max-w-2xl mx-auto text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/6 px-3.5 py-1 text-xs font-medium text-primary mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse inline-block" />
            Interactive Video Editor
          </span>

          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] text-foreground mb-6">
            Upload, mark, and build
            <br />
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  'linear-gradient(135deg, hsl(243 74% 59%), hsl(280 75% 60%))',
              }}
            >
              interactive video experiences
            </span>
          </h1>

          <p className="text-base text-muted-foreground max-w-md mx-auto leading-relaxed mb-10">
            Drag in your video files — even multi-gigabyte ones. Select sections on the timeline
            and flag them as video, simulation, intro, or custom types.
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
      </section>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
