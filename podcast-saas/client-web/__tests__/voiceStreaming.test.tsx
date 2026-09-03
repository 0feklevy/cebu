/**
 * The interactive answer on the client (owner ruling 2026-09-03 — Tap to ask like NotebookLM's
 * interrupt): the first sentence plays while the model is still writing, sentences play back to
 * back in order, the microphone stays open so a word over the answer interrupts it, and an answer
 * that never got audio still speaks through the device voice.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import type { VoiceStreamEvent } from 'shared/src/audio/listener';

const vad = vi.hoisted(() => ({
  started: 0, paused: 0,
  onSpeechStart: null as null | (() => void),
  onSpeechEnd: null as null | ((a: Float32Array) => void),
}));
vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: async (opts: { onSpeechStart: () => void; onSpeechEnd: (a: Float32Array) => void }) => {
      vad.onSpeechStart = opts.onSpeechStart;
      vad.onSpeechEnd = opts.onSpeechEnd;
      return { start: () => { vad.started += 1; }, pause: () => { vad.paused += 1; }, destroy: () => {} };
    },
  },
}));

import { useVoiceLoop } from '../components/audio/useVoiceLoop';

/** The stream the test drives by hand: events are pushed in, in order. */
const stream = {
  emit: null as null | ((e: VoiceStreamEvent) => void),
  close: null as null | (() => void),
  aborted: false,
};

function Harness() {
  const episode = useRef<HTMLAudioElement | null>(null);
  const voice = useRef<HTMLAudioElement | null>(null);
  const loop = useVoiceLoop({
    handsFree: false,
    episode,
    voice,
    submit: async () => ({ status: 'answered', question: 'q', answer: 'one-shot', message: null, audio_base64: null, audio_mime: null }),
    submitStream: (_wav, _dur, onEvent, signal) => new Promise<void>((resolve) => {
      stream.emit = (e) => act(() => { onEvent(e); });
      stream.close = () => resolve();
      signal.addEventListener('abort', () => { stream.aborted = true; resolve(); });
    }),
  });
  return (
    <div>
      <p data-testid="state">{loop.state.kind}</p>
      <p data-testid="heard">{loop.heard ?? ''}</p>
      <p data-testid="note">{loop.note ?? ''}</p>
      <audio data-testid="episode" ref={episode} />
      <audio data-testid="voice" ref={voice} />
      <button onClick={loop.askTap}>ask</button>
    </div>
  );
}

const kind = () => screen.getByTestId('state').textContent;
/** Answer clips played so far. The earcon uses the same element, so tests count from a baseline. */
const voicePlays = () => played.filter((p) => p === 'voice').length;
const voiceEl = () => screen.getByTestId('voice') as HTMLAudioElement;
const played: string[] = [];

beforeEach(() => {
  vad.started = 0; vad.paused = 0; vad.onSpeechStart = null; vad.onSpeechEnd = null;
  stream.emit = null; stream.close = null; stream.aborted = false;
  played.length = 0;
  (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = class {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({}) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLAudioElement) {
    played.push(this.dataset.testid === 'voice' ? 'voice' : 'episode');
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:answer');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Tap, speak, stop speaking — the loop is now waiting on the stream. */
async function askAndSpeak() {
  await act(async () => { screen.getByText('ask').click(); });
  await waitFor(() => expect(vad.onSpeechEnd).not.toBeNull());
  await act(async () => { vad.onSpeechEnd!(new Float32Array(16000)); });
  await waitFor(() => expect(kind()).toBe('thinking'));
}

const audioEvent = (seq: number, text: string): VoiceStreamEvent =>
  ({ type: 'audio', seq, audio_base64: btoa('mp3-' + seq), audio_mime: 'audio/mpeg', text });

describe('the interactive answer', () => {
  it('speaks the first sentence while the model is still writing, then the rest in order', async () => {
    render(<Harness />);
    await askAndSpeak();

    stream.emit!({ type: 'heard', question: 'why is the sky blue' });
    await waitFor(() => expect(screen.getByTestId('heard').textContent).toBe('why is the sky blue'));

    const base = voicePlays();   // the earcon already used this element

    // The FIRST sentence arrives while the answer is still being written: it plays at once.
    stream.emit!(audioEvent(0, 'Shorter wavelengths scatter more.'));
    await waitFor(() => expect(kind()).toBe('speaking'));
    expect(voicePlays() - base).toBe(1);

    // The second arrives while the first is playing: it waits its turn.
    stream.emit!(audioEvent(1, 'Red light passes through.'));
    expect(voicePlays() - base).toBe(1);
    await act(async () => { voiceEl().onended?.(new Event('ended')); });
    expect(voicePlays() - base).toBe(2);

    // `done` closes the stream; the last sentence finishing ends the answer.
    stream.emit!({ type: 'done', status: 'answered', question: 'q', answer: 'Shorter wavelengths scatter more. Red light passes through.', message: null, audio_chunks: 2 });
    expect(kind()).toBe('speaking');
    await act(async () => { voiceEl().onended?.(new Event('ended')); });
    await waitFor(() => expect(kind()).toBe('resuming'));
    expect(screen.getByTestId('note').textContent).toContain('Shorter wavelengths');
  });

  it('the microphone stays open through the answer, so a word over it interrupts', async () => {
    render(<Harness />);
    await askAndSpeak();
    const pausedAfterCapture = vad.paused;
    stream.emit!(audioEvent(0, 'The first sentence.'));
    await waitFor(() => expect(kind()).toBe('speaking'));
    expect(vad.paused).toBe(pausedAfterCapture);          // never released mid-exchange

    // Speaking over the answer stops it and starts a new capture — no second tap.
    await act(async () => { vad.onSpeechStart!(); });
    await waitFor(() => expect(kind()).toBe('listening'));
    expect(stream.aborted).toBe(true);
  });

  it('an answer that never got audio is still spoken — by the device voice', async () => {
    const speak = vi.fn();
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { speak, cancel: vi.fn() };
    (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(public text: string) {} };
    render(<Harness />);
    await askAndSpeak();
    const base = voicePlays();
    stream.emit!({ type: 'done', status: 'answered', question: 'q', answer: 'Because of scattering.', message: null, audio_chunks: 0 });
    await waitFor(() => expect(kind()).toBe('speaking'));
    expect(speak).toHaveBeenCalledTimes(1);
    expect(voicePlays() - base).toBe(0);
  });

  it('a refusal shows its reason and gives the episode back without speaking', async () => {
    render(<Harness />);
    await askAndSpeak();
    stream.emit!({ type: 'done', status: 'saved', question: 'q', answer: null, message: 'Daily limit reached.', audio_chunks: 0 });
    await waitFor(() => expect(kind()).toBe('resuming'));
    expect(screen.getByTestId('note').textContent).toBe('Daily limit reached.');
  });

  it('a transport error never strands the listener', async () => {
    render(<Harness />);
    await askAndSpeak();
    stream.emit!({ type: 'error', message: 'The connection dropped mid-answer.' });
    await waitFor(() => expect(kind()).toBe('resuming'));
    expect(screen.getByTestId('note').textContent).toBe('The connection dropped mid-answer.');
  });

  it('a stream that closes with nothing at all still ends the exchange', async () => {
    render(<Harness />);
    await askAndSpeak();
    await act(async () => { stream.close!(); await Promise.resolve(); });
    await waitFor(() => expect(kind()).toBe('resuming'));
  });
});
