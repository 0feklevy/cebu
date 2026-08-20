'use client';

/**
 * The creator's dubbing page — choose target languages, see the price BEFORE running, watch
 * per-language progress, delete.
 *
 * Two things this screen exists to prevent, and the reason the cost line is the most prominent
 * element on it:
 *
 *   • Dubbing is billed per minute of source media PER LANGUAGE. Ticking three languages on a
 *     40-minute course is three 40-minute charges, and it is roughly $264 at the headline rate.
 *     That multiplication is exactly the arithmetic people get wrong, so the running total is
 *     shown next to the button that spends it, not on an invoice a month later.
 *
 *   • A watermarked plan produces dubs that are paid for and unpublishable. When the account is on
 *     one — or has simply never declared which it is on — the run button is disabled and says why,
 *     rather than letting someone spend real money on output no viewer will ever see.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, Globe, Loader2, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { DubbingLanguageOption, DubCostEstimate, ProjectDub } from 'shared/src/generated/client-v1';

interface Props {
  projectId: string;
  onClose: () => void;
}

/** One language's rolled-up state across every video in the project. */
interface LanguageRow {
  code: string;
  name: string;
  endonym: string;
  /** queued | processing | completed | failed | partial, or null when never requested. */
  status: string | null;
  /** Every video in this language is finished AND servable. */
  ready: boolean;
  total: number;
  done: number;
  error: string | null;
}

/**
 * Roll a project's per-video dub rows up to one row per language.
 *
 * Exported and pure so the rollup can be tested without rendering: "is Hebrew ready?" is a
 * question about every video at once, and answering it per video is what would let a half-dubbed
 * language look finished.
 */
export function rollUpByLanguage(
  dubs: ProjectDub[],
  supported: DubbingLanguageOption[],
  videoCount: number,
): LanguageRow[] {
  return supported.map((lang) => {
    const rows = dubs.filter((d) => d.language === lang.code);
    const done = rows.filter((d) => d.servable).length;
    const failed = rows.find((d) => d.status === 'failed');
    const total = Math.max(videoCount, rows.length);

    let status: string | null = null;
    if (rows.length === 0) status = null;
    else if (failed) status = 'failed';
    else if (done === total && total > 0) status = 'completed';
    else if (rows.some((d) => d.status === 'processing')) status = 'processing';
    else if (done > 0) status = 'partial';
    else status = 'queued';

    return {
      code: lang.code,
      name: lang.name,
      endonym: lang.endonym,
      status,
      ready: total > 0 && done === total,
      total,
      done,
      error: failed?.error ?? null,
    };
  });
}

const money = (usd: number): string =>
  usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  processing: 'Dubbing…',
  completed: 'Ready',
  partial: 'Partly done',
  failed: 'Failed',
};

const STATUS_COLOR: Record<string, string> = {
  queued: '#64748b',
  processing: '#0ea5e9',
  completed: '#16a34a',
  partial: '#d97706',
  failed: '#ef4444',
};

export function DubbingSettings({ projectId, onClose }: Props) {
  const [languages, setLanguages] = useState<DubbingLanguageOption[]>([]);
  const [dubs, setDubs] = useState<ProjectDub[]>([]);
  const [estimate, setEstimate] = useState<DubCostEstimate | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listProjectDubs(projectId);
      setDubs(res.dubs);
      setLanguages(res.supported_languages);
      setEstimate(res.estimate);
      setError(null);
    } catch (err) {
      setError((err as Error).message || 'Could not load dubbing settings.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // Poll only while something is actually in flight, so a settled page costs nothing.
  const inFlight = dubs.some((d) => d.status === 'queued' || d.status === 'processing');
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  const videoCount = new Set(dubs.map((d) => d.video_file_id)).size || 1;
  const rows = rollUpByLanguage(dubs, languages, videoCount);

  // The one number that matters: what THIS selection would cost, right now.
  const perLanguage = estimate?.usd_per_language ?? 0;
  const selectedCost = perLanguage * selected.size;
  const blocked = estimate?.watermarked ?? true;

  const toggle = (code: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const run = async (): Promise<void> => {
    if (selected.size === 0 || blocked) return;
    setRunning(true);
    setError(null);
    try {
      for (const code of selected) await api.createProjectDub(projectId, code);
      setSelected(new Set());
      await load();
    } catch (err) {
      setError((err as Error).message || 'Could not start dubbing.');
    } finally {
      setRunning(false);
    }
  };

  const remove = async (code: string): Promise<void> => {
    setDeleting(code);
    setError(null);
    try {
      await api.deleteProjectDub(projectId, code);
      await load();
    } catch (err) {
      setError((err as Error).message || 'Could not delete this language.');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div
      style={{
        position: 'absolute', inset: 0, zIndex: 5, display: 'flex', flexDirection: 'column',
        backgroundColor: 'hsl(var(--card))', fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Header */}
      <div style={{
        flexShrink: 0, padding: '14px 20px', borderBottom: '1px solid hsl(var(--shell-border))',
        display: 'flex', alignItems: 'center', gap: 10, background: 'hsl(var(--shell))',
      }}>
        <button
          type="button"
          className="focus-ring"
          aria-label="Back to settings"
          onClick={onClose}
          style={{
            width: 30, height: 30, borderRadius: 8, border: 'none', backgroundColor: 'transparent',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'hsl(var(--shell-muted))',
          }}
        >
          <ArrowLeft size={16} strokeWidth={2} aria-hidden />
        </button>
        <Globe size={16} strokeWidth={2} aria-hidden style={{ color: '#0ea5e9' }} />
        <span style={{ fontSize: 15, fontWeight: 700, color: 'hsl(var(--shell-foreground))' }}>
          Languages &amp; dubbing
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, margin: 0 }}>
          Translate this video into other languages. Viewers get a language picker in the player,
          with dubbed audio and matching captions. The original stays untouched.
        </p>

        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'hsl(var(--muted-foreground))', fontSize: 13 }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} aria-hidden />
            Loading languages…
          </div>
        )}

        {error && (
          <div role="alert" style={{
            fontSize: 12, color: '#b91c1c', background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '10px 12px',
          }}>
            {error}
          </div>
        )}

        {/*
          The plan gate. Shown before the language list rather than beside the button, because it
          is not a warning about the run — it is the reason the run cannot happen at all.
        */}
        {!loading && estimate?.watermark_notice && (
          <div role="alert" style={{
            display: 'flex', gap: 10, fontSize: 12, color: '#92400e',
            background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.3)',
            borderRadius: 8, padding: '10px 12px', lineHeight: 1.6,
          }}>
            <AlertTriangle size={16} strokeWidth={2} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{estimate.watermark_notice}</span>
          </div>
        )}

        {!loading && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map((row) => {
              const checked = selected.has(row.code);
              const requested = row.status !== null;
              return (
                <li key={row.code}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                    border: '1px solid hsl(var(--border))', borderRadius: 10,
                    background: checked ? 'rgba(14,165,233,0.06)' : 'transparent',
                  }}>
                    {/*
                      A real <input type="checkbox"> with a <label>, not a styled div: the label
                      gives it its accessible name and makes the whole row clickable, and the
                      native control is keyboard-operable without any handler of ours.
                    */}
                    <input
                      type="checkbox"
                      id={`dub-lang-${row.code}`}
                      checked={checked}
                      disabled={requested || blocked}
                      onChange={() => toggle(row.code)}
                      style={{ width: 16, height: 16, accentColor: '#0ea5e9', cursor: requested ? 'default' : 'pointer' }}
                    />
                    <label
                      htmlFor={`dub-lang-${row.code}`}
                      style={{ flex: 1, minWidth: 0, cursor: requested ? 'default' : 'pointer' }}
                    >
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                        {row.name}
                      </span>
                      <span style={{ display: 'block', fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>
                        {row.endonym} · /{row.code}
                      </span>
                    </label>

                    {row.status && (
                      <span style={{
                        fontSize: 11, fontWeight: 600, color: STATUS_COLOR[row.status] ?? '#64748b',
                        display: 'flex', alignItems: 'center', gap: 5,
                      }}>
                        {row.status === 'processing' && (
                          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} aria-hidden />
                        )}
                        {row.status === 'completed' && <Check size={12} strokeWidth={2.5} aria-hidden />}
                        {STATUS_LABEL[row.status] ?? row.status}
                        {row.status === 'partial' && ` (${row.done}/${row.total})`}
                      </span>
                    )}

                    {requested && (
                      <button
                        type="button"
                        className="focus-ring"
                        onClick={() => void remove(row.code)}
                        disabled={deleting === row.code}
                        aria-label={`Delete the ${row.name} dub`}
                        title={`Delete the ${row.name} dub`}
                        style={{
                          width: 28, height: 28, borderRadius: 7, border: 'none', cursor: 'pointer',
                          backgroundColor: 'transparent', color: '#ef4444',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        {deleting === row.code
                          ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} aria-hidden />
                          : <Trash2 size={13} strokeWidth={1.9} aria-hidden />}
                      </button>
                    )}
                  </div>

                  {row.error && (
                    <p style={{ fontSize: 11, color: '#ef4444', margin: '4px 0 0 40px' }}>{row.error}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Footer: the price, then the button that spends it. */}
      {!loading && (
        <div style={{
          flexShrink: 0, padding: '14px 22px', borderTop: '1px solid hsl(var(--shell-border))',
          background: 'hsl(var(--shell))', display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{ fontSize: 13, fontWeight: 700, color: 'hsl(var(--shell-foreground))' }}
              data-testid="dub-cost-estimate"
            >
              {selected.size === 0
                ? `${money(estimate?.usd_per_minute_per_language ?? 0)} per minute, per language`
                : `Estimated ${money(selectedCost)} for ${selected.size} language${selected.size > 1 ? 's' : ''}`}
            </div>
            <div style={{ fontSize: 11, color: 'hsl(var(--shell-muted))' }}>
              {selected.size === 0
                ? 'Billed per minute of source video, for each language you add.'
                : `${money(perLanguage)} per language × ${selected.size} · charged when the dub runs.`}
            </div>
          </div>
          <button
            type="button"
            className="focus-ring"
            onClick={() => void run()}
            disabled={selected.size === 0 || running || blocked}
            style={{
              flexShrink: 0, padding: '9px 16px', borderRadius: 9, border: 'none',
              fontSize: 13, fontWeight: 700, color: '#fff',
              backgroundColor: selected.size === 0 || running || blocked ? '#94a3b8' : '#0ea5e9',
              cursor: selected.size === 0 || running || blocked ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 7,
            }}
          >
            {running && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} aria-hidden />}
            {running ? 'Starting…' : 'Translate'}
          </button>
        </div>
      )}
    </div>
  );
}
