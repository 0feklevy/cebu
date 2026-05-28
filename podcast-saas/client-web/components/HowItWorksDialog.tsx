'use client';

import * as Dialog from '@radix-ui/react-dialog';

const STEPS = [
  {
    n: '01',
    title: 'Describe your topic',
    body: 'Upload a PDF, paste a URL, or write a brief. The AI reads and structures your material automatically.',
  },
  {
    n: '02',
    title: 'Watch the script form',
    body: 'Three-pass AI generation in real time — structural analysis, full draft, then broadcast-quality rewrite.',
  },
  {
    n: '03',
    title: 'Edit and approve',
    body: "Refine any dialogue turn, swap speakers, or regenerate a line. Approve the script when you're ready.",
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
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl bg-background rounded-2xl border border-border shadow-xl p-8 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <div className="flex items-start justify-between mb-6">
            <div>
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-primary/70 mb-1">
                How it works
              </p>
              <Dialog.Title className="text-2xl font-bold text-foreground">
                Three steps to your podcast
              </Dialog.Title>
            </div>
            <Dialog.Close className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </Dialog.Close>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {STEPS.map((s) => (
              <div
                key={s.n}
                className="rounded-xl border border-border bg-card p-5 shadow-sm"
              >
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
