/**
 * The creator's inbox: lists what listeners asked with the context to answer it, replies in one
 * box, marks everything seen on open, and tells the header when the badge moved.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListenerQuestion } from 'shared/src/generated/client-v1';

const calls = vi.hoisted(() => ({
  list: [] as Array<{ status?: string; before?: string }>,
  seen: 0,
  replies: [] as Array<{ id: string; text: string }>,
  rows: [] as ListenerQuestion[],
}));

vi.mock('../lib/api', () => ({
  api: {
    listListenerQuestions: async (_p: string, opts: { status?: string; before?: string }) => {
      calls.list.push(opts);
      const filtered = opts.status === 'unanswered' ? calls.rows.filter((r) => r.creator_reply == null) : calls.rows;
      return { questions: filtered, next_before: null };
    },
    markListenerQuestionsSeen: async () => { calls.seen += 1; return { ok: true }; },
    replyListenerQuestion: async (_p: string, id: string, text: string) => {
      calls.replies.push({ id, text });
      return { id, creator_reply: text || null, creator_replied_at: text ? '2026-09-03T12:00:00.000Z' : null };
    },
  },
}));

import { ListenerInboxDialog } from '../components/ListenerInboxDialog';

const row = (over: Partial<ListenerQuestion>): ListenerQuestion => ({
  id: 'q-1', position_ms: 65_000, question: 'Why is the sky blue?', answer: 'Rayleigh scattering.', status: 'answered',
  language: null, source: 'text', creator_reply: null, creator_replied_at: null, seen_at: null,
  chapter: 'Why the sky is blue', created_at: '2026-09-03T10:00:00.000Z', ...over,
});

beforeEach(() => {
  calls.list.length = 0; calls.seen = 0; calls.replies.length = 0;
  calls.rows = [row({}), row({ id: 'q-2', source: 'voice', position_ms: 5_000, chapter: 'Intro', creator_reply: 'Because of Rayleigh.', creator_replied_at: '2026-09-03T11:00:00.000Z', language: 'he' })];
});
afterEach(cleanup);

describe('ListenerInboxDialog', () => {
  it('opens on the unanswered questions, with the moment, the chapter and how it was asked, and marks all seen', async () => {
    const onChanged = vi.fn();
    render(<ListenerInboxDialog projectId="p1" open onClose={() => {}} onChanged={onChanged} />);
    expect(await screen.findByText('Why is the sky blue?')).toBeTruthy();
    expect(screen.queryByText('Because of Rayleigh.')).toBeNull();          // answered: filtered out
    expect(screen.getByText('01:05')).toBeTruthy();
    expect(screen.getByText('Why the sky is blue')).toBeTruthy();
    expect(screen.getByText('Typed')).toBeTruthy();
    expect(calls.list[0]?.status).toBe('unanswered');
    await waitFor(() => expect(calls.seen).toBe(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('"All" shows the answered ones too, with the reply and the spoken marker', async () => {
    render(<ListenerInboxDialog projectId="p1" open onClose={() => {}} />);
    await screen.findByText('Why is the sky blue?');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByDisplayValue('Because of Rayleigh.')).toBeTruthy();
    expect(screen.getByText('Spoken')).toBeTruthy();
    expect(screen.getByText('he')).toBeTruthy();
  });

  it('replies from the box; the row shows the reply and the header is told', async () => {
    const onChanged = vi.fn();
    render(<ListenerInboxDialog projectId="p1" open onClose={() => {}} onChanged={onChanged} />);
    await screen.findByText('Why is the sky blue?');
    const box = screen.getByLabelText('Your reply');
    const send = screen.getByRole('button', { name: 'Reply' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Short wavelengths scatter more.' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.replies).toEqual([{ id: 'q-1', text: 'Short wavelengths scatter more.' }]));
    expect(await screen.findByText(/Replied /)).toBeTruthy();
    expect(onChanged.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('the model’s answer is folded away, never mistaken for the creator’s', async () => {
    render(<ListenerInboxDialog projectId="p1" open onClose={() => {}} />);
    await screen.findByText('Why is the sky blue?');
    const details = screen.getByText('What the assistant answered').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText('Rayleigh scattering.')).toBeTruthy();
  });

  it('says so when nothing waits for a reply', async () => {
    calls.rows = [];
    render(<ListenerInboxDialog projectId="p1" open onClose={() => {}} />);
    expect(await screen.findByText('Nothing waiting for a reply.')).toBeTruthy();
  });
});
