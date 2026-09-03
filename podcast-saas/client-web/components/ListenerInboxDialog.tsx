'use client';

/**
 * The creator's listener-question inbox (owner ruling 2026-09-03):
 *   Listener → question → Creator Inbox → answer.
 *
 * Every question a listener asked on the podcast, newest first, with what the creator needs to
 * answer it: where in the lesson (the chapter and the mm:ss), how it was asked (typed or spoken),
 * the language, the model's answer (folded — it is context, not the creator's voice), and one box
 * to reply in. A reply is what the listener sees back on the episode, at that position. Opening
 * the inbox marks everything seen; the header's badge is the unanswered count.
 *
 * Kept simple on purpose: no threads, no assignment, no notifications — a list and a reply box.
 */
import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, Mic, MessageSquare, X } from 'lucide-react';
import { api } from '../lib/api';
import { formatClock } from '../lib/audioEditionApi';
import type { ListenerQuestion } from 'shared/src/generated/client-v1';

type Filter = 'unanswered' | 'all';

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
  /** Called after any change that moves the header's badge (a reply, marking seen). */
  onChanged?: () => void;
}

export function ListenerInboxDialog({ projectId, open, onClose, onChanged }: Props) {
  const [filter, setFilter] = useState<Filter>('unanswered');
  const [rows, setRows] = useState<ListenerQuestion[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);

  const load = useCallback(async (append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listListenerQuestions(projectId, { status: filter, limit: 50, before: append ? nextBefore ?? undefined : undefined });
      setRows((prev) => (append ? [...prev, ...page.questions] : page.questions));
      setNextBefore(page.next_before);
    } catch (e) {
      setError((e as Error).message || 'Could not load the questions.');
    } finally {
      setLoading(false);
    }
  }, [filter, nextBefore, projectId]);

  useEffect(() => {
    if (!open) return;
    void load(false);
    // Opening the inbox is what "seen" means; the badge follows.
    api.markListenerQuestionsSeen(projectId).then(() => onChanged?.()).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filter, projectId]);

  const reply = useCallback(async (q: ListenerQuestion) => {
    const text = (drafts[q.id] ?? q.creator_reply ?? '').trim();
    setSending(q.id);
    setError(null);
    try {
      const result = await api.replyListenerQuestion(projectId, q.id, text);
      setRows((prev) => prev.map((r) => (r.id === q.id ? { ...r, creator_reply: result.creator_reply, creator_replied_at: result.creator_replied_at } : r)));
      setDrafts((d) => { const { [q.id]: _gone, ...rest } = d; return rest; });
      onChanged?.();
    } catch (e) {
      setError((e as Error).message || 'Could not send the reply.');
    } finally {
      setSending(null);
    }
  }, [drafts, onChanged, projectId]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[900] bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[901] flex h-dvh w-screen -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden bg-card shadow-2xl sm:h-[min(760px,calc(100dvh-32px))] sm:w-[calc(100vw-32px)] sm:max-w-[820px] sm:rounded-2xl sm:border sm:border-border">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3.5">
            <div className="flex items-center gap-2">
              <MessageSquare size={16} strokeWidth={1.9} aria-hidden className="text-primary" />
              <Dialog.Title className="text-[15px] font-semibold text-foreground">Listener questions</Dialog.Title>
            </div>
            <div className="flex items-center gap-2">
              <div role="group" aria-label="Show" className="flex rounded-lg border border-border p-0.5">
                {(['unanswered', 'all'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                    className={`h-7 rounded-md px-2.5 text-xs font-semibold transition-colors focus-ring ${filter === f ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {f === 'unanswered' ? 'Unanswered' : 'All'}
                  </button>
                ))}
              </div>
              <Dialog.Close onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring">
                <X size={16} aria-hidden />
              </Dialog.Close>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {error && <p role="alert" className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
            {loading && rows.length === 0 ? (
              <div className="flex h-40 items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" size={22} aria-label="Loading" /></div>
            ) : rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {filter === 'unanswered' ? 'Nothing waiting for a reply.' : 'No listener has asked a question yet.'}
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {rows.map((q) => (
                  <li key={q.id} className="rounded-xl border border-border bg-background p-4">
                    <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1" title={q.source === 'voice' ? 'Spoken (transcribed)' : 'Typed'}>
                        {q.source === 'voice' ? <Mic size={12} aria-hidden /> : <MessageSquare size={12} aria-hidden />}
                        {q.source === 'voice' ? 'Spoken' : 'Typed'}
                      </span>
                      <span className="font-mono">{formatClock(q.position_ms)}</span>
                      {q.chapter && <span className="truncate">{q.chapter}</span>}
                      {q.language && <span className="rounded bg-muted px-1.5 py-0.5 uppercase">{q.language}</span>}
                      <time dateTime={q.created_at} className="ml-auto">{new Date(q.created_at).toLocaleString()}</time>
                    </div>
                    <p className="text-sm font-medium text-foreground">{q.question}</p>
                    {q.answer && (
                      <details className="mt-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none">What the assistant answered</summary>
                        <p className="mt-1 whitespace-pre-wrap">{q.answer}</p>
                      </details>
                    )}
                    <div className="mt-3">
                      <label className="sr-only" htmlFor={`reply-${q.id}`}>Your reply</label>
                      <textarea
                        id={`reply-${q.id}`}
                        rows={2}
                        value={drafts[q.id] ?? q.creator_reply ?? ''}
                        onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                        placeholder="Reply to the listener — they see it on the episode, at this moment"
                        className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground outline-none focus:border-primary/45 focus:ring-2 focus:ring-ring/20"
                      />
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="text-[11px] text-muted-foreground">
                          {q.creator_replied_at ? `Replied ${new Date(q.creator_replied_at).toLocaleString()}` : 'Not replied yet'}
                        </span>
                        <button
                          type="button"
                          onClick={() => void reply(q)}
                          disabled={sending === q.id || (drafts[q.id] === undefined)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:brightness-110 focus-ring disabled:opacity-50"
                        >
                          {sending === q.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
                          {(drafts[q.id] ?? '').trim() === '' && q.creator_reply ? 'Clear reply' : q.creator_reply ? 'Update reply' : 'Reply'}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {nextBefore && !loading && (
              <div className="mt-4 flex justify-center">
                <button type="button" onClick={() => void load(true)} className="h-8 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground hover:text-foreground focus-ring">
                  Load older
                </button>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
