/**
 * Raise your hand — the flow, and the one anchoring rule that makes it worth having.
 *
 * The question is about the moment the hand went UP, not the moment typing finished. A listener
 * hears something confusing at 1:23, presses the hand, and types for forty seconds while the
 * audio plays on — the creator must see 1:23, because that is where the confusing sentence lives.
 * Losing that anchor quietly turns the whole feature into a comment box.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
// The player also reads the creator's replies on mount (migration 083). That read is not what this
// file tests, and it must not be the first fetch these assertions see — stub it at the module.
vi.mock('../lib/audioEditionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/audioEditionApi')>()),
  listCreatorReplies: async () => [],
}));

import { AudioEditionPlayer } from '../components/audio/AudioEditionPlayer';
import type { AudioEditionView } from '../lib/audioEditionApi';

const view: AudioEditionView = {
  title: 'Lesson', description: null, audio_url: 'https://x/audio.mp3',
  duration_ms: 600_000, chapters: [], captions_url: null, language: 'en', updated_at: null,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('raise your hand', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn(async () => jsonResponse({ status: 'saved', answer: null, message: null })) as unknown as typeof fetch; });
  afterEach(() => { cleanup(); globalThis.fetch = realFetch; });

  it('does not exist at all without a slug — no address, no hand', () => {
    render(<AudioEditionPlayer view={view} />);
    expect(screen.queryByText(/raise your hand/i)).toBeNull();
  });

  it('anchors the question to the moment the hand went UP, not when typing finished', async () => {
    render(<AudioEditionPlayer view={view} slug="my-lesson" />);

    // The audio is at 83s when the hand goes up…
    const audio = document.querySelector('audio')!;
    Object.defineProperty(audio, 'currentTime', { value: 83, configurable: true });
    fireEvent.timeUpdate(audio);
    fireEvent.click(screen.getByText(/raise your hand/i));

    // …and keeps PLAYING while the listener types — forty more seconds pass.
    Object.defineProperty(audio, 'currentTime', { value: 123, configurable: true });
    fireEvent.timeUpdate(audio);

    fireEvent.change(screen.getByPlaceholderText(/what would you like to ask/i), { target: { value: 'why do they turn together?' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^ask$/i })); });

    const sent = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]?.body));
    expect(sent.position_ms).toBe(83_000);
    expect(sent.question).toBe('why do they turn together?');
  });

  it('renders an ANSWER when the server answers', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ status: 'answered', answer: 'Because each bird follows its neighbours.', message: null })) as unknown as typeof fetch;
    render(<AudioEditionPlayer view={view} slug="s" />);
    fireEvent.click(screen.getByText(/raise your hand/i));
    fireEvent.change(screen.getByPlaceholderText(/what would you like to ask/i), { target: { value: 'why?' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^ask$/i })); });

    expect(screen.getByText(/each bird follows its neighbours/i)).toBeTruthy();
  });

  it('says what SAVED means — the creator sees it at the anchored moment', async () => {
    render(<AudioEditionPlayer view={view} slug="s" />);
    const audio = document.querySelector('audio')!;
    Object.defineProperty(audio, 'currentTime', { value: 61, configurable: true });
    fireEvent.timeUpdate(audio);
    fireEvent.click(screen.getByText(/raise your hand/i));
    fireEvent.change(screen.getByPlaceholderText(/what would you like to ask/i), { target: { value: 'q' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^ask$/i })); });

    expect(screen.getByText(/creator will see your question at 01:01/i)).toBeTruthy();
  });

  it('keeps the typed question when the send is REFUSED — retyping is the failure', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ message: 'Too many questions — please slow down.' }, 429)) as unknown as typeof fetch;
    render(<AudioEditionPlayer view={view} slug="s" />);
    fireEvent.click(screen.getByText(/raise your hand/i));
    const box = screen.getByPlaceholderText(/what would you like to ask/i) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'my careful question' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^ask$/i })); });

    expect(screen.getByText(/slow down/i)).toBeTruthy();
    expect(box.value).toBe('my careful question');
  });

  it('clears the box after an ACCEPTED question, ready for the next one', async () => {
    render(<AudioEditionPlayer view={view} slug="s" />);
    fireEvent.click(screen.getByText(/raise your hand/i));
    const box = screen.getByPlaceholderText(/what would you like to ask/i) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'q' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^ask$/i })); });
    expect(box.value).toBe('');
  });

  it('cannot send an empty question', () => {
    render(<AudioEditionPlayer view={view} slug="s" />);
    fireEvent.click(screen.getByText(/raise your hand/i));
    expect((screen.getByRole('button', { name: /^ask$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
