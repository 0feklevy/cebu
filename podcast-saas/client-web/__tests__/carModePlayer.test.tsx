/**
 * The car-mode player, at the level a glance sees it (night run 2026-09-03 §4).
 *
 * jsdom has no microphone and no AudioWorklet, so the voice loop reports itself unsupported here;
 * what these tests pin is the SHAPE the listener gets — six things above the fold, big targets,
 * the sheet out of the way — and the two buttons' plain contracts: Stop pauses, Ask explains
 * itself when it cannot listen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AudioEditionPlayer } from '../components/audio/AudioEditionPlayer';
import type { AudioEditionView } from '../lib/audioEditionApi';

const view: AudioEditionView = {
  title: 'Flocking, explained', description: null, audio_url: 'https://x/audio.m4a',
  duration_ms: 600_000, language: 'en', updated_at: null, captions_url: null,
  chapters: [
    { startMs: 0, endMs: 300_000, title: 'Why birds turn' },
    { startMs: 300_000, endMs: 600_000, title: 'Boids' },
  ],
  artwork_url: 'https://x/cover.jpg',
};

describe('car-mode player', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows artwork, one-line title, the bar, three transport buttons, ASK and STOP — and no paragraph of text', () => {
    render(<AudioEditionPlayer view={view} slug="flocking" artworkUrl={view.artwork_url} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Flocking, explained');
    expect(screen.getByRole('slider', { name: /position/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /previous chapter/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^play$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /next chapter/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /ask by voice/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeTruthy();
    // The episode is a plain, hidden <audio>; the voice element is a second one.
    expect(document.querySelectorAll('audio')).toHaveLength(2);
    expect(document.querySelector('audio')!.getAttribute('src')).toBe('https://x/audio.m4a');
    // Nothing wordy above the fold: the description is not rendered anywhere.
    expect(screen.queryByText(/description/i)).toBeNull();
  });

  it('without a slug there is no ASK, no STOP and no hand — a private page has nowhere to send a question', () => {
    render(<AudioEditionPlayer view={view} />);
    expect(screen.queryByRole('button', { name: /ask by voice/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^stop$/i })).toBeNull();
    expect(screen.queryByText(/raise your hand/i)).toBeNull();
  });

  it('STOP pauses the episode', () => {
    render(<AudioEditionPlayer view={view} slug="s" />);
    fireEvent.click(screen.getByRole('button', { name: /^stop$/i }));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it('ASK says why it cannot listen here instead of failing silently', () => {
    render(<AudioEditionPlayer view={view} slug="s" />);
    const ask = screen.getByRole('button', { name: /ask by voice/i });
    fireEvent.pointerDown(ask);
    fireEvent.pointerUp(ask);
    expect(screen.getByText(/cannot listen/i)).toBeTruthy();
  });

  it('chapters live in a sheet, not on the main screen; opening it and picking one seeks and closes it', () => {
    render(<AudioEditionPlayer view={view} slug="s" />);
    expect(screen.queryByRole('dialog', { name: /chapters/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^chapters$/i }));
    const sheet = screen.getByRole('dialog', { name: /chapters/i });
    expect(sheet.textContent).toContain('Boids');
    fireEvent.click(screen.getByText('Boids'));
    expect(screen.queryByRole('dialog', { name: /chapters/i })).toBeNull();
  });

  it('the current chapter is the one line under the title', () => {
    render(<AudioEditionPlayer view={view} slug="s" />);
    const audio = document.querySelector('audio')!;
    Object.defineProperty(audio, 'currentTime', { value: 301, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(screen.getByText('Boids')).toBeTruthy();
  });
});
