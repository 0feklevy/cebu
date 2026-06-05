'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, X } from 'lucide-react';
import { api } from '../lib/api';
import { LockPriceControl } from './LockPriceControl';

/** Header button that opens a small popover to lock/price a video. Hidden when Stripe is off. */
export function ProjectLockButton({ projectId }: { projectId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [paid, setPaid] = useState(false);
  const [open, setOpen] = useState(false);
  const [canPortal, setCanPortal] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setCanPortal(true); }, []);
  useEffect(() => {
    (async () => {
      try {
        const status = await api.getBillingStatus();
        setEnabled(status.enabled);
        if (status.enabled) {
          const access = await api.getContentAccess('project', projectId).catch(() => null);
          if (access) setPaid(access.accessType === 'paid');
        }
      } catch { /* ignore */ }
    })();
  }, [projectId]);

  if (!enabled) return null;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold shell-muted transition-colors shell-hover focus-ring hover:text-[hsl(var(--shell-foreground))]"
        style={paid ? { borderColor: '#f59e0b', color: '#f59e0b' } : { borderColor: 'hsl(var(--shell-border))' }}
        title="Pricing"
      >
        <Lock size={13} strokeWidth={1.8} aria-hidden />
        {paid ? 'Locked' : 'Lock'}
      </button>

      {open && canPortal && createPortal(
        <div className="floating-panel fixed right-3 top-[58px] z-[10000] w-[min(340px,calc(100vw-24px))] overflow-hidden rounded-xl sm:right-4">
          <div className="flex items-center justify-between border-b border-border bg-muted px-4 py-2.5">
            <p className="text-sm font-semibold text-foreground">Pricing</p>
            <button onClick={() => setOpen(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <X size={14} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
          <div className="p-3">
            <LockPriceControl contentType="project" contentId={projectId} bordered={false} onChanged={(at) => setPaid(at === 'paid')} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
