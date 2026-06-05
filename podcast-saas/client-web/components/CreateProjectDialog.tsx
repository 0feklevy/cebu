'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { api } from '../lib/api';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProjectDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    onOpenChange(false);
    setTimeout(() => { setTitle(''); setError(null); }, 300);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.createProject({ topic: title.trim() } as Parameters<typeof api.createProject>[0]);
      onOpenChange(false);
      router.push(`/projects/${res.id}/editor`);
    } catch (err) {
      setError((err as Error).message ?? 'Something went wrong');
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[900] bg-slate-950/55 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[901] max-h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-white p-5 shadow-modal data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:p-6">
          <div className="flex items-center justify-between mb-5">
            <Dialog.Title className="text-lg font-semibold text-foreground">New project</Dialog.Title>
            <Dialog.Close onClick={handleClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-ring">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
                <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </Dialog.Close>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground block mb-1.5">Project title</label>
              <input
                autoFocus
                type="text"
                className="w-full h-10 rounded-lg border border-input bg-white px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/25 placeholder:text-muted-foreground/50"
                placeholder="e.g. Product demo, lecture on photosynthesis…"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={handleClose}
                className="h-9 px-4 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors focus-ring"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim() || submitting}
                className="h-9 px-5 rounded-lg text-white text-sm font-semibold transition-all shadow-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2 focus-ring"
                style={{ background: 'linear-gradient(135deg,#a855f7,#6366f1)' }}
              >
                {submitting && (
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground animate-spin" />
                )}
                Create project
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
