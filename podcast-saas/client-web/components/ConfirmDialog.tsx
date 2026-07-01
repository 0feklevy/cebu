'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title:       string;
  description: string;
  confirmLabel?: string;
  onConfirm:   () => void;
  onCancel:    () => void;
  danger?:     boolean;
  busy?:       boolean;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
  danger = true,
  busy = false,
}: Props) {
  // Portal to <body> so the dialog's fixed positioning + z-index are never
  // broken by an ancestor with transform/filter/overflow (e.g. hover-translate
  // cards or scroll containers on the home page).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  if (!mounted) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        onClick={onCancel}
        style={{
          position: 'fixed', inset: 0, zIndex: 9000,
          backgroundColor: 'rgba(15,23,42,0.45)',
          backdropFilter: 'blur(6px)',
        }}
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed', zIndex: 9001,
          top: '50%', left: '50%',
          transform: 'translate(-50%,-50%)',
          width: 'min(360px, calc(100vw - 32px))',
          backgroundColor: 'hsl(var(--card))',
          borderRadius: 10,
          boxShadow: '0 16px 48px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
          padding: '24px 24px 20px',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        {/* Icon */}
        <div style={{
          width: 40, height: 40, borderRadius: '50%',
          backgroundColor: danger ? '#fef2f2' : '#eff6ff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 4,
        }}>
          {danger ? (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
              <path d="M9 1L1 17h16L9 1z" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M9 7v4M9 13v1" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
              <circle cx="9" cy="9" r="8" stroke="#3b82f6" strokeWidth="1.5" />
              <path d="M9 5v4M9 12v1" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
        </div>

        <div>
          <p style={{ fontSize: 15, fontWeight: 700, color: 'hsl(var(--foreground))', margin: 0, marginBottom: 6 }}>{title}</p>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0, lineHeight: 1.5 }}>{description}</p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="focus-ring"
            onClick={onCancel}
            disabled={busy}
            style={{
              flex: 1, height: 38, borderRadius: 9,
              border: '1.5px solid #e5e7eb', backgroundColor: 'hsl(var(--card))',
              color: '#374151', fontSize: 13, fontWeight: 600,
              cursor: busy ? 'default' : 'pointer', transition: 'background 0.12s',
              opacity: busy ? 0.6 : 1,
            }}
            onMouseEnter={e => { if (!busy) e.currentTarget.style.backgroundColor = 'hsl(var(--muted))'; }}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'hsl(var(--card))')}
          >
            Cancel
          </button>
          <button
            type="button"
            className="focus-ring"
            onClick={onConfirm}
            disabled={busy}
            style={{
              flex: 1, height: 38, borderRadius: 9, border: 'none',
              background: danger
                ? 'linear-gradient(135deg,#ef4444,#dc2626)'
                : 'linear-gradient(135deg,#3b82f6,#6366f1)',
              color: '#fff', fontSize: 13, fontWeight: 600,
              cursor: busy ? 'default' : 'pointer', transition: 'opacity 0.12s',
              opacity: busy ? 0.7 : 1,
            }}
            onMouseEnter={e => { if (!busy) e.currentTarget.style.opacity = '0.88'; }}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
