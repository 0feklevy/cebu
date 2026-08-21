'use client';

/**
 * The creator's dubbing page — choose target languages, see the price BEFORE running, watch real
 * progress, delete.
 *
 * Four things this screen exists to prevent, and the reasons they are shaped the way they are:
 *
 *   • Dubbing is billed per minute of source media PER LANGUAGE. Ticking three languages on a
 *     40-minute course is three 40-minute charges, and it is roughly $264 at the headline rate.
 *     That multiplication is exactly the arithmetic people get wrong, so the running total is
 *     shown next to the button that spends it, not on an invoice a month later.
 *
 *   • A watermarked plan produces dubs that are paid for and unpublishable. When the account is on
 *     one — or has simply never declared which it is on — the run button is disabled and says why,
 *     rather than letting someone spend real money on output no viewer will ever see.
 *
 *   • THE SOURCE LANGUAGE IS NEVER A TARGET. Dubbing a video into the language it is already
 *     spoken in is a complete billable run that returns a degraded copy. The row is shown and
 *     explained rather than hidden — a language somebody expected to see and cannot find is a bug
 *     report, whereas one that explains itself is an answer — and the block panel above the list
 *     says where that language came from and lets it be corrected, because acting on a detection
 *     without offering a way to argue with it is how you remove someone's language silently.
 *
 *   • NINETY-FOUR LANGUAGES IS A LIST NOBODY CAN READ. Alphabetical by English name put Spanish
 *     seventy-six rows below Afrikaans. The search box and the sort control are not conveniences
 *     here; without them the feature's reach is whatever fits on one screen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, Globe, Loader2, Search, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { DubbingLanguageOption, DubCostEstimate, ProjectDub } from 'shared/src/generated/client-v1';
import { orderLanguages, rollUpByLanguage, type DubSortKey } from './languageList';

interface Props {
  projectId: string;
  onClose: () => void;
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
  // Tokens, not hex. The same mistake the `/c/` pages made — hardcoded colours that look right in
  // light mode and are unreadable in dark — and this panel had fourteen of them.
  queued: 'hsl(var(--muted-foreground))',
  processing: 'hsl(var(--primary))',
  completed: 'hsl(var(--success, 142 71% 40%))',
  partial: 'hsl(var(--warning, 38 92% 45%))',
  failed: 'hsl(var(--destructive))',
};

/** How the panel explains where the source language came from. */
const ORIGIN_NOTE: Record<string, string> = {
  declared: 'you set this',
  detected: 'detected from this video’s captions',
  vendor: 'detected from the audio during a dub',
};

const SORTS: ReadonlyArray<{ key: DubSortKey; label: string }> = [
  { key: 'popular', label: 'Most used' },
  { key: 'name', label: 'A–Z' },
  { key: 'active', label: 'In progress first' },
];

export function DubbingSettings({ projectId, onClose }: Props) {
  const [languages, setLanguages] = useState<DubbingLanguageOption[]>([]);
  const [dubs, setDubs] = useState<ProjectDub[]>([]);
  const [estimate, setEstimate] = useState<DubCostEstimate | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<DubSortKey>('popular');

  const [sourceCode, setSourceCode] = useState<string | null>(null);
  const [sourceOrigin, setSourceOrigin] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ code: string; confidence: number } | null>(null);
  const [sourceReason, setSourceReason] = useState<string | null>(null);
  const [savingSource, setSavingSource] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.listProjectDubs(projectId);
      setDubs(res.dubs);
      setLanguages(res.supported_languages);
      setEstimate(res.estimate);
      setSourceCode(res.source_language ?? null);
      setSourceOrigin(res.source_language_origin ?? null);
      setSuggestion(res.source_language_suggestion ?? null);
      setSourceReason(res.source_language_reason ?? null);
      setError(null);
    } catch (err) {
      setError((err as Error).message || 'Could not load dubbing settings.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // Poll only while something is actually in flight, so a settled page costs nothing.
  //
  // Five seconds rather than ten: the bar now advances between polls on the server side, so the
  // poll interval IS the frame rate of the progress display. Ten seconds looked like a stall.
  const inFlight = dubs.some((d) => d.progress?.active ?? (d.status === 'queued' || d.status === 'processing'));
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  const videoCount = new Set(dubs.map((d) => d.video_file_id)).size || 1;
  const allRows = useMemo(
    () => rollUpByLanguage(dubs, languages, videoCount),
    [dubs, languages, videoCount],
  );
  const rows = useMemo(() => orderLanguages(allRows, query, sort), [allRows, query, sort]);

  // The one number that matters: what THIS selection would cost, right now.
  const perLanguage = estimate?.usd_per_language ?? 0;
  const selectedCost = perLanguage * selected.size;
  const blocked = estimate?.watermarked ?? true;
  // A language can be selected and then filtered out of view. Saying so is the difference between
  // a surprising invoice and an informed one.
  const hiddenSelected = selected.size - rows.filter((r) => selected.has(r.code)).length;

  const toggle = (code: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const saveSource = async (code: string): Promise<void> => {
    setSavingSource(true);
    setError(null);
    try {
      await api.setProjectSourceLanguage(projectId, code === '' ? null : code);
      // A changed source changes which row is un-selectable, and may invalidate a selection made
      // before the change — so reload rather than patching state locally.
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(code);
        return next;
      });
      await load();
    } catch (err) {
      setError((err as Error).message || 'Could not save the original language.');
    } finally {
      setSavingSource(false);
    }
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

  const sourceName = languages.find((l) => l.code === sourceCode)?.name ?? sourceCode;
  const suggestedName = languages.find((l) => l.code === suggestion?.code)?.name ?? suggestion?.code;

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
        <Globe size={16} strokeWidth={2} aria-hidden style={{ color: 'hsl(var(--primary))' }} />
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
            fontSize: 12, color: 'hsl(var(--destructive))', background: 'hsl(var(--destructive) / 0.08)',
            border: '1px solid hsl(var(--destructive) / 0.25)', borderRadius: 8, padding: '10px 12px',
          }}>
            {error}
          </div>
        )}

        {/*
          THE ORIGINAL LANGUAGE. First, because everything below depends on it: it is the one
          language that cannot be a target, and until it is known the list is offering a paid run
          that produces a worse copy of the video. It always says where the value came from — a
          detection the creator can overrule reads very differently from a fact they cannot.
        */}
        {!loading && (
          <div
            data-testid="dub-source-language"
            style={{
              border: '1px solid hsl(var(--border))', borderRadius: 10, padding: '12px 14px',
              display: 'flex', flexDirection: 'column', gap: 8,
              background: sourceCode ? 'transparent' : 'hsl(var(--warning, 38 92% 45%) / 0.07)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'hsl(var(--foreground))' }}>
                Original language
              </span>
              {sourceCode ? (
                <span style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                  <strong style={{ color: 'hsl(var(--foreground))' }}>{sourceName}</strong>
                  {sourceOrigin && ORIGIN_NOTE[sourceOrigin] ? ` · ${ORIGIN_NOTE[sourceOrigin]}` : ''}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                  {sourceReason === 'no_transcript'
                    ? 'not known yet — this video has no transcript to read'
                    : suggestion
                      ? `possibly ${suggestedName}, but not clearly enough to rely on`
                      : 'not known yet'}
                </span>
              )}
            </div>

            <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', margin: 0, lineHeight: 1.6 }}>
              {sourceCode
                ? 'This one is never offered as a target — dubbing a video into its own language costs the same as any other language and returns a worse copy of what you already have.'
                : 'Set this and we will stop offering it as a target. Leave it blank and every language stays available, including the one the video is already in.'}
            </p>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>Change:</span>
              <select
                className="focus-ring"
                aria-label="The language this video is already in"
                value={sourceCode ?? suggestion?.code ?? ''}
                disabled={savingSource}
                onChange={(e) => void saveSource(e.target.value)}
                style={{
                  flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 8, fontSize: 12,
                  border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))',
                  color: 'hsl(var(--foreground))', cursor: savingSource ? 'wait' : 'pointer',
                }}
              >
                <option value="">Not set — detect it automatically</option>
                {[...languages]
                  .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
                  .map((l) => (
                    <option key={l.code} value={l.code}>{l.name} · {l.endonym}</option>
                  ))}
              </select>
              {savingSource && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} aria-hidden />}
            </label>
          </div>
        )}

        {/*
          The plan gate. Shown before the language list rather than beside the button, because it
          is not a warning about the run — it is the reason the run cannot happen at all.
        */}
        {!loading && estimate?.watermark_notice && (
          <div role="alert" style={{
            display: 'flex', gap: 10, fontSize: 12, color: 'hsl(var(--warning, 38 92% 35%))',
            background: 'hsl(var(--warning, 38 92% 45%) / 0.10)', border: '1px solid hsl(var(--warning, 38 92% 45%) / 0.3)',
            borderRadius: 8, padding: '10px 12px', lineHeight: 1.6,
          }}>
            <AlertTriangle size={16} strokeWidth={2} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{estimate.watermark_notice}</span>
          </div>
        )}

        {/* Search and sort. Without these, a 94-row list is whatever fits on one screen. */}
        {!loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 160 }}>
              <Search
                size={13}
                aria-hidden
                style={{
                  position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)',
                  color: 'hsl(var(--muted-foreground))', pointerEvents: 'none',
                }}
              />
              <input
                type="search"
                className="focus-ring"
                data-testid="dub-language-search"
                aria-label="Search languages"
                placeholder={`Search ${allRows.length} languages…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{
                  width: '100%', padding: '7px 10px 7px 27px', borderRadius: 8, fontSize: 12,
                  border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))',
                  color: 'hsl(var(--foreground))',
                }}
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>
              Sort
              <select
                className="focus-ring"
                data-testid="dub-language-sort"
                aria-label="Sort languages"
                value={sort}
                onChange={(e) => setSort(e.target.value as DubSortKey)}
                style={{
                  padding: '6px 8px', borderRadius: 8, fontSize: 12,
                  border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))',
                  color: 'hsl(var(--foreground))', cursor: 'pointer',
                }}
              >
                {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
          </div>
        )}

        {!loading && rows.length === 0 && (
          <p style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', margin: 0 }}>
            No language matches “{query}”. Try the English name, the language’s own name, or its
            two-letter code.
          </p>
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
                    background: checked ? 'hsl(var(--primary) / 0.06)' : 'transparent',
                    opacity: row.isSource ? 0.62 : 1,
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
                      disabled={requested || blocked || row.isSource}
                      onChange={() => toggle(row.code)}
                      style={{
                        width: 16, height: 16, accentColor: 'hsl(var(--primary))',
                        cursor: requested || row.isSource ? 'default' : 'pointer',
                      }}
                    />
                    <label
                      htmlFor={`dub-lang-${row.code}`}
                      style={{ flex: 1, minWidth: 0, cursor: requested || row.isSource ? 'default' : 'pointer' }}
                    >
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'hsl(var(--foreground))' }}>
                        {row.name}
                      </span>
                      <span style={{ display: 'block', fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>
                        {row.endonym} · /{row.code}
                        {row.isSource && ' · this video is already in this language'}
                      </span>
                    </label>

                    {row.status && (
                      <span style={{
                        fontSize: 11, fontWeight: 600,
                        color: STATUS_COLOR[row.status] ?? 'hsl(var(--muted-foreground))',
                        display: 'flex', alignItems: 'center', gap: 5,
                      }}>
                        {row.status === 'processing' && (
                          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} aria-hidden />
                        )}
                        {row.status === 'completed' && <Check size={12} strokeWidth={2.5} aria-hidden />}
                        {STATUS_LABEL[row.status] ?? row.status}
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
                          backgroundColor: 'transparent', color: 'hsl(var(--destructive))',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        {deleting === row.code
                          ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} aria-hidden />
                          : <Trash2 size={13} strokeWidth={1.9} aria-hidden />}
                      </button>
                    )}
                  </div>

                  {/*
                    WHERE THE WORK ACTUALLY IS.
                    This bar used to be drawn from `done / total videos`. Almost every project has
                    one video, so it read 0/1 for the whole run and then 1/1 — a boolean rendered
                    as a bar, reporting the one thing the person watching already knew.

                    It now reads the server's stage model: which of the seven steps is running, and
                    how long it has been running. The percentage creeps within a step and can only
                    cross into the next one when that step actually finishes, so the bar can be
                    optimistic about timing but never about progress. The words underneath are the
                    real payload — "Translating and matching the voices" answers the question the
                    bar only gestures at.

                    The bar is `aria-hidden` and the label beside it carries the same information as
                    text, because a progress bar a screen reader announces as a percentage of
                    nothing is worse than no bar at all.
                  */}
                  {row.status && row.status !== 'failed' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, margin: '6px 0 0 40px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div
                          aria-hidden
                          style={{
                            flex: 1, height: 4, borderRadius: 999,
                            background: 'hsl(var(--muted))', overflow: 'hidden',
                          }}
                        >
                          <div
                            data-testid={`dub-progress-${row.code}`}
                            style={{
                              width: `${row.percent}%`,
                              height: '100%', borderRadius: 999,
                              background: row.ready ? 'hsl(var(--primary))' : 'hsl(var(--primary) / 0.55)',
                              transition: 'width 600ms linear',
                            }}
                          />
                        </div>
                        <span style={{
                          fontSize: 10, color: 'hsl(var(--muted-foreground))',
                          fontVariantNumeric: 'tabular-nums', minWidth: 30, textAlign: 'right',
                        }}>
                          {row.percent}%
                        </span>
                      </div>
                      <span style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
                        {row.stageLabel ?? STATUS_LABEL[row.status] ?? row.status}
                        {row.total > 1 && ` · ${row.done}/${row.total} videos finished`}
                      </span>
                    </div>
                  )}

                  {row.error && (
                    <p style={{ fontSize: 11, color: 'hsl(var(--destructive))', margin: '4px 0 0 40px' }}>{row.error}</p>
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
              {hiddenSelected > 0 && ` · ${hiddenSelected} hidden by your search`}
            </div>
          </div>
          <button
            type="button"
            className="focus-ring"
            onClick={() => void run()}
            disabled={selected.size === 0 || running || blocked}
            style={{
              flexShrink: 0, padding: '9px 16px', borderRadius: 9, border: 'none',
              fontSize: 13, fontWeight: 700,
              color: selected.size === 0 || running || blocked
                ? 'hsl(var(--muted-foreground))'
                : 'hsl(var(--primary-foreground))',
              backgroundColor: selected.size === 0 || running || blocked
                ? 'hsl(var(--muted))'
                : 'hsl(var(--primary))',
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
