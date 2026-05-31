'use client';

import * as Dialog from '@radix-ui/react-dialog';

const STEPS = [
  {
    n: '01',
    title: 'Upload your videos',
    body: 'Drag and drop video files up to several GB each. Multiple videos are supported — they appear as separate tracks on the timeline.',
  },
  {
    n: '02',
    title: 'Mark sections on the timeline',
    body: 'Click and drag on any track to select a time range. Flag each section as Video, Simulation, Intro, Outro, Cut, or a custom type.',
  },
  {
    n: '03',
    title: 'Build your interactive structure',
    body: 'Sections define the skeleton of your interactive experience. Export or hand off the structure to power branching, overlays, and more.',
  },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HowItWorksDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[900] bg-slate-950/55 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[901] w-[calc(100vw-32px)] max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-6 shadow-modal data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:p-8">
          <div className="flex items-start justify-between mb-6">
            <div>
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-primary/70 mb-1">
                How it works
              </p>
              <Dialog.Title className="text-2xl font-bold text-foreground">
                Three steps to your interactive video
              </Dialog.Title>
            </div>
            <Dialog.Close className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-ring">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </Dialog.Close>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-lg border border-border bg-card p-5 shadow-sm-soft">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center mb-3">
                  <span className="font-mono text-xs font-bold text-primary">{s.n}</span>
                </div>
                <h3 className="font-semibold text-foreground mb-1.5">{s.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
